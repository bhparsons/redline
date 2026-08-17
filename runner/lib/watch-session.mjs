// runner/lib/watch-session.mjs — the watcher's bookkeeping, held by the MCP
// server instead of by the agent (#296, #297, #298).
//
// The watcher loop used to make the agent carry four things it should never
// have seen:
//
//   - a CAPABILITY: the sessionId from the claim, threaded through every lease,
//     every release, and the read that advances the author's receipt, with the
//     skill having to tell the agent not to print it;
//   - an ORDERING RULE: the lease goes around the READ, not the write, because
//     no write endpoint takes a sessionId — so a held lease 409s against its own
//     holder;
//   - a CURSOR: new work is comment.rev greater than the rev you last wrote at
//     ON THAT COMMENT, kept per comment, because a seen-set by id silently drops
//     every clarifying reply;
//   - a SECOND PROCESS: presence and the change stream lived in
//     examples/watch-collaborate.mjs, so the session that did the thinking was
//     not the session the page said was attached.
//
// None of that is protocol. It is bookkeeping that leaked upward because the
// only thing available to hold it was the agent's own attention. This module is
// awake for the whole MCP session, so it takes all four.
//
// It still writes nothing itself: every mutation is an HTTP call the runner
// validates, applies and records. The trust layer does not move.

const DEFAULT_TTL_MS = 60_000;
const HEARTBEAT_MS = 20_000;
// Most MCP clients cap a single tool call around 60s. Park under that and let
// the agent call again — the empty return is a keep-alive, NOT a poll interval:
// a comment landing 2s into the park returns at 2s, not at the timeout.
const DEFAULT_WAIT_MS = 50_000;
const MAX_WAIT_MS = 55_000;

export const MODES = ['reply-only', 'reply-and-edit'];

/** A comment the agent should act on: the author asked for a change and has not
 *  had one. `aiEdits` is stored ONLY when false, so absence means "in the batch"
 *  — never test it for === true. */
function isActionable(comment) {
  return comment.status === 'open' && comment.aiEdits !== false;
}

/** Runs paused on the scope gate. /api/status has no top-level list for them:
 *  a paused run is a `runs[]` entry that carries `pendingAt`, which the ledger
 *  attaches only in the awaiting state (runner/lib/leases.mjs statusFor). Keyed
 *  on that rather than on a state string so a renamed constant fails loudly in
 *  tests instead of silently reporting nothing pending. */
function pendingFrom(status) {
  return (status?.runs ?? []).filter((r) => r !== null && typeof r === 'object' && 'pendingAt' in r);
}

/** Read one SSE stream until `onRev` says stop or the signal aborts.
 *  The runner sends `{rev}` and nothing else (runner/lib/events.mjs): a missed
 *  frame is self-healing because the next one carries current state, which is
 *  also why this never tries to reconnect mid-park. */
async function readEventStream({ base, page, signal, onRev }) {
  const res = await fetch(`${base}/api/events?page=${encodeURIComponent(page)}`, { signal });
  if (!res.ok || !res.body) throw new Error(`/api/events: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        // `: ping` keep-alives and `event:` names are not data lines.
        if (!line.startsWith('data:')) continue;
        let payload = null;
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (typeof payload?.rev === 'number' && await onRev(payload.rev)) return;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export class WatchSession {
  constructor({ client, base, page, mode, agentName }) {
    this.client = client;
    this.base = base;
    this.page = page;
    this.mode = mode;
    this.agentName = agentName;
    this.sessionId = null;       // the capability — never returned to the agent
    this.cursor = new Map();     // commentId -> the rev we last acted at
    this.lastHold = false;
    this.lastRev = 0;
    this.timer = null;
  }

  get canEdit() {
    return this.mode === 'reply-and-edit';
  }

  /** Claim the page, record the baseline, and start beating from THIS process.
   *  Beating from a process rather than from the agent's turns is the point: a
   *  conversational session does not act on a timer, so a turn-driven heartbeat
   *  goes quiet while the model is thinking and the overlay reports a watcher
   *  that left. */
  async start({ ttlMs = DEFAULT_TTL_MS, pid = process.pid } = {}) {
    const claim = await this.client.claimSession({
      page: this.page, agentName: this.agentName, pid, ttlMs,
    });
    this.sessionId = claim.sessionId;
    const baseline = await this.baseline();
    this.timer = setInterval(() => {
      this.client.heartbeatSession(this.sessionId).catch(() => {
        // A lapsed claim surfaces on the next call that needs it. Throwing from
        // a timer would take the whole MCP server down with it.
      });
    }, HEARTBEAT_MS);
    this.timer.unref?.();
    return baseline;
  }

  /** Everything already on the page, and the cursor set past all of it. A
   *  watcher is here for what comes NEXT — silently rewriting a document's
   *  backlog is not what anyone meant by "watch this". */
  async baseline() {
    const [{ comments }, status] = await Promise.all([
      this.client.comments(this.page, { sessionId: this.sessionId }),
      this.client.status(this.page),
    ]);
    for (const c of comments) this.cursor.set(c.id, c.rev ?? 0);
    this.lastHold = status?.hold?.on === true;
    this.lastRev = status?.rev ?? 0;
    return {
      page: this.page,
      mode: this.mode,
      comments,
      existingCount: comments.length,
      actionableCount: comments.filter(isActionable).length,
      noteCount: comments.filter((c) => c.aiEdits === false).length,
      hold: status?.hold ?? { on: false },
      // /api/status reports ONE watcher (`session`, nullable) — presence is
      // single-holder, so this is who has the page, and it is us.
      session: status?.session ?? null,
      pendingConfirmations: pendingFrom(status),
    };
  }

  /** What has changed since this session last acted, or null when nothing has.
   *  Returning null is the ECHO FILTER: our own writes bump the page rev and
   *  would otherwise wake us for work we just did, but they also advance the
   *  cursor, so the delta comes back empty and the park simply continues. */
  async delta() {
    const [{ comments }, status] = await Promise.all([
      this.client.comments(this.page, { sessionId: this.sessionId }),
      this.client.status(this.page),
    ]);
    const fresh = comments.filter((c) => {
      const seen = this.cursor.get(c.id);
      return seen === undefined || (c.rev ?? 0) > seen;
    });
    const hold = status?.hold ?? { on: false };
    const holdOn = hold.on === true;
    const holdChanged = holdOn !== this.lastHold;
    const pending = pendingFrom(status);
    this.lastRev = status?.rev ?? this.lastRev;

    if (fresh.length === 0 && !holdChanged && pending.length === 0) return null;
    this.lastHold = holdOn;

    return {
      changed: true,
      page: this.page,
      rev: this.lastRev,
      // Hold means the author is writing several comments that belong together.
      // The runner reports it and does not enforce it — the watcher is the
      // enforcement, so it is surfaced before the work, not beside it.
      hold,
      holdChanged,
      pendingConfirmations: pending,
      comments: fresh,
      // Notes are context: read them for the block, never action them. With
      // hold on there is no actionable work at all until it clears.
      actionable: holdOn ? [] : fresh.filter(isActionable).map((c) => c.id),
      notes: fresh.filter((c) => c.aiEdits === false).map((c) => c.id),
    };
  }

  /** Park until something this session has not seen happens.
   *
   *  Checks the delta FIRST, so a comment that landed between two waits is
   *  never missed — which is also why no stream is held between calls. */
  async waitForChange({ timeoutMs = DEFAULT_WAIT_MS } = {}) {
    const budget = Math.max(1_000, Math.min(Number(timeoutMs) || DEFAULT_WAIT_MS, MAX_WAIT_MS));
    const startedAt = Date.now();

    const immediate = await this.delta();
    if (immediate) return { ...immediate, waitedMs: 0 };

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), budget);
    let found = null;
    try {
      await readEventStream({
        base: this.base,
        page: this.page,
        signal: controller.signal,
        onRev: async (rev) => {
          if (rev <= this.lastRev) return false;
          found = await this.delta();
          return found !== null;
        },
      });
    } catch (err) {
      // An abort is the timeout firing, which is a normal return, not a fault.
      if (err?.name !== 'AbortError' && !controller.signal.aborted) throw err;
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }

    const waitedMs = Date.now() - startedAt;
    if (found) return { ...found, waitedMs };
    return {
      changed: false,
      page: this.page,
      rev: this.lastRev,
      waitedMs,
      // Said in the payload because an agent that reads the first empty return
      // as "nothing is coming" stops watching.
      note: 'timed out with nothing new — call redline_wait_for_change again to keep watching',
    };
  }

  /** Mark a comment handled at its current rev, so our own write does not read
   *  back as new work. Called after a write, never before.
   *
   *  EVERY write this session makes has to come through here, not just the one
   *  in redline_resolve_comment. The orchestrator pattern acknowledges a comment
   *  with a plain reply before delegating it, and a reply bumps the comment's
   *  rev — so with only resolve_comment advancing the cursor, an orchestrator
   *  replayed its own acknowledgement as a delta forever and `wait_for_change`
   *  returned in 0 ms every time instead of parking. Found in a live session
   *  (2026-08-17). */
  noteWrite(comment) {
    if (comment && typeof comment.id === 'string') this.cursor.set(comment.id, comment.rev ?? 0);
    return comment;
  }

  /** Same, when the write did not hand back the updated comment (a run with
   *  decisions), so the current rev has to be read. */
  async advanceCursor(commentId) {
    const { comments } = await this.client.comments(this.page, { sessionId: this.sessionId });
    const found = comments.find((c) => c.id === commentId);
    if (found) this.cursor.set(commentId, found.rev ?? 0);
    return found ?? null;
  }

  /** Release the claim and every lease it held, and stop beating. Safe to call
   *  twice; never throws, because it runs on the process-exit path. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const sid = this.sessionId;
    this.sessionId = null;
    if (!sid) return { released: false };
    try {
      await this.client.releaseSession(sid);
      return { released: true };
    } catch {
      return { released: false };
    }
  }
}

export const _internals = { isActionable, readEventStream, DEFAULT_WAIT_MS, MAX_WAIT_MS, HEARTBEAT_MS };
