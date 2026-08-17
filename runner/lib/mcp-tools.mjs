// runner/lib/mcp-tools.mjs — the Redline tools an MCP client can call.
//
// Ten tools, each a thin wrapper over one runner endpoint (see
// docs/AGENT-CONTRACT.md). Nothing here writes a document or a sidecar: every
// mutation is an HTTP call the runner validates, applies and records. The
// module holds no trust of its own — moving a rule in here instead of the
// runner would put it outside the loop the browser and the CLI go through.
//
// Every mutating call carries provenance: creator "agent" plus an agent name
// (tool argument → REDLINE_AGENT_NAME → "claude-code"). The runner accepts it
// on comment/reply/status/propose-edits only; instrument and undo act on the
// document as a whole and record nothing per-actor, so they do not send it.
//
// Connections are cached per served directory for the life of the process, so
// a session that auto-starts a runner keeps ONE and shuts it down on close.
//
// #50 added the last three. They are EXPOSURE, not new capability: the
// endpoints and their api-client wrappers already existed and only this list
// was missing, which is why an agent could apply edits but not revert them,
// and could write a document but not make it commentable.

import { connectToPage, closeSessions, ApiError } from './api-client.mjs';
import { WatchSession, MODES } from './watch-session.mjs';

const DEFAULT_AGENT_NAME = 'claude-code';

/** Bad arguments (the caller's mistake) vs. a runtime failure (the tool ran
 *  and could not do the job) — the entry point maps them to JSON-RPC -32602
 *  and an isError tool result respectively. */
export class ParamError extends Error {}

const sessions = new Map();

export async function closeAll() {
  // Release claims BEFORE the runners go: a claim released after its runner
  // stops leaves the page showing a watcher that is not there until the TTL
  // expires.
  const held = [...watches.values()];
  watches.clear();
  await Promise.all(held.map((s) => s.stop().catch(() => {})));
  return closeSessions(sessions);
}

function requireString(args, key, { optional = false } = {}) {
  const value = args[key];
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new ParamError(`${key} is required`);
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ParamError(`${key} must be a non-empty string`);
  }
  return value;
}

function actorFor(args, env) {
  const name = requireString(args, 'agentName', { optional: true })
    ?? (typeof env.REDLINE_AGENT_NAME === 'string' && env.REDLINE_AGENT_NAME.trim().length > 0
      ? env.REDLINE_AGENT_NAME.trim()
      : DEFAULT_AGENT_NAME);
  return { creator: 'agent', agentName: name };
}

// Connect to the runner serving this tool call's document. `file` is a path to
// the .html document (or a page id relative to `dir`).
async function open(args, env) {
  const file = requireString(args, 'file');
  const dir = requireString(args, 'dir', { optional: true });
  const base = typeof env.REDLINE_RUNNER_URL === 'string' && env.REDLINE_RUNNER_URL.length > 0
    ? env.REDLINE_RUNNER_URL : null;
  try {
    return await connectToPage(file, { dir: dir ?? undefined, base, env, sessions });
  } catch (err) {
    throw new Error(err.message);
  }
}

// ---- tools ------------------------------------------------------------------

// #165: the sidecar records `aiEdits` only when it is false — absence means the
// comment is in the AI batch. That convention is fine for the overlay, which
// reads `c.aiEdits !== false`, and ambiguous for an agent reading raw JSON: a
// missing key looks like missing information rather than a default. Normalize
// to an explicit boolean on every comment so the agent can tell an edit request
// from a note without knowing the storage rule.
function withAiEdits(comment) {
  return { ...comment, aiEdits: comment.aiEdits !== false };
}

async function listComments(args, env) {
  const { client, page, base } = await open(args, env);
  const { comments } = await client.comments(page, { sessionId: args.sessionId });
  const normalized = comments.map(withAiEdits);
  return {
    page,
    runner: base,
    count: normalized.length,
    noteCount: normalized.filter((c) => !c.aiEdits).length,
    comments: normalized,
  };
}

async function readSource(args, env) {
  const { client, page, base } = await open(args, env);
  const source = await client.source(page);
  if (args.blocksOnly === true) {
    return { page, runner: base, bytes: source.bytes, blocks: source.blocks };
  }
  return { page, runner: base, ...source };
}

async function addComment(args, env) {
  const body = requireString(args, 'body');
  const quote = requireString(args, 'quote');
  const blockId = requireString(args, 'blockId', { optional: true });
  const { client, page, base } = await open(args, env);
  const anchor = { quote };
  if (blockId) anchor.blockId = blockId;
  for (const key of ['prefix', 'suffix']) {
    const value = requireString(args, key, { optional: true });
    if (value !== null) anchor[key] = value;
  }
  // #185: born with its audience. Absent leaves the runner's per-creator
  // default (an agent comment is a note) in charge.
  if (args.aiEdits !== undefined && typeof args.aiEdits !== 'boolean') {
    throw new ParamError('aiEdits must be true or false');
  }
  const comment = noteOurWrite(base, page, await client.addComment({
    page, body, anchor,
    ...(args.aiEdits === undefined ? {} : { aiEdits: args.aiEdits }),
    ...actorFor(args, env),
  }));
  return { page, runner: base, comment };
}

async function runRevision(args, env) {
  const single = requireString(args, 'commentId', { optional: true });
  const many = args.commentIds;
  if (many !== undefined) {
    if (!Array.isArray(many) || many.length === 0 || many.some((id) => typeof id !== 'string' || !id)) {
      throw new ParamError('commentIds must be a non-empty array of comment ids');
    }
  }
  if ((single === null) === (many === undefined)) {
    throw new ParamError('provide exactly one of commentId or commentIds');
  }
  const { client, page, base } = await open(args, env);
  const run = await client.run(many === undefined ? { page, commentId: single } : { page, commentIds: many });
  return { page, runner: base, run };
}

async function proposeEdits(args, env) {
  const commentId = requireString(args, 'commentId', { optional: true });
  if (args.edits !== undefined && !Array.isArray(args.edits)) throw new ParamError('edits must be an array');
  if (args.attributeEdits !== undefined && !Array.isArray(args.attributeEdits)) throw new ParamError('attributeEdits must be an array');
  if (args.theme !== undefined && typeof args.theme !== 'string') throw new ParamError('theme must be a string of CSS declarations');
  if (args.inserts !== undefined && !Array.isArray(args.inserts)) throw new ParamError('inserts must be an array');
  if (args.decisions !== undefined && !Array.isArray(args.decisions)) {
    throw new ParamError('decisions must be an array');
  }
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') {
    throw new ParamError('dryRun must be a boolean');
  }
  // #195: the scope waiver. Declaring intent up front is what lets a deliberate
  // sweep ask once WITH its intent stated instead of reading as an accident.
  if (args.scope !== undefined && (args.scope === null || typeof args.scope !== 'object' || Array.isArray(args.scope))) {
    throw new ParamError('scope must be an object');
  }
  const { client, page, base } = await open(args, env);
  const result = await client.proposeEdits({
    page,
    ...(commentId ? { commentId } : {}),
    ...(args.decisions ? { decisions: args.decisions } : {}),
    ...(args.edits ? { edits: args.edits } : {}),
    ...(args.attributeEdits ? { attributeEdits: args.attributeEdits } : {}),
    ...(args.theme !== undefined ? { theme: args.theme } : {}),
    ...(args.inserts ? { inserts: args.inserts } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    dryRun: args.dryRun !== false,
    ...actorFor(args, env),
  });
  // A run reports decisions, not comments, so the cursor has to be read rather
  // than taken from the response.
  const watch = watches.get(watchKey(base, page));
  if (watch) {
    const decided = (args.decisions ?? []).map((d) => d?.id).filter((id) => typeof id === 'string');
    for (const id of new Set([...decided, ...(commentId ? [commentId] : [])])) {
      await watch.advanceCursor(id);
    }
  }
  return { page, runner: base, ...result };
}

// Replace one block's inner HTML, free (#186). /api/edit has done exactly this
// since WP10 and was reachable over HTTP only, so the phase's headline case — a
// local session edits your document with no model call — meant an agent
// hand-rolling HTTP around the very client that exists to stop that.
//
// Deliberately kept even though redline_propose_edits can already apply a
// single-block edit with dryRun:false: the propose payload is decisions +
// edits + attributeEdits + theme + inserts + scope, and asking for that shape
// to change one sentence is why the CLI equivalent needed a JSON file. One
// verb, three arguments. The judgement the spec left open (#186 "keep only if
// the clarity is worth the surface area") is: yes, for the one-block case.
async function directEdit(args, env) {
  const blockId = requireString(args, 'blockId');
  if (typeof args.newInner !== 'string') throw new ParamError('newInner must be a string');
  const { client, page, base } = await open(args, env);
  const run = await client.edit({ page, blockId, newInner: args.newInner, ...actorFor(args, env) });
  return { page, runner: base, ...run };
}

// Answer a scope-gate pause (#195). The gate fires when a write reaches past
// the section its comment is anchored to, or touches the page theme; until now
// only the overlay could resolve one, so an agent that tripped the gate was
// stuck waiting on a human who might not be looking at the document.
//
// The author's surface is still the document (decision 13) — this does not move
// confirmation into chat. It gives an agent a way to withdraw its own over-broad
// write, and to proceed when the human already told it to in conversation.
async function confirmScope(args, env) {
  const runId = requireString(args, 'runId');
  if (typeof args.allow !== 'boolean') throw new ParamError('allow must be true or false');
  const { client, page, base } = await open(args, env);
  const result = await client.confirmRun({ page, runId, allow: args.allow });
  return { page, runner: base, ...result };
}

async function updateStatus(args, env) {
  const commentId = requireString(args, 'commentId');
  const status = requireString(args, 'status');
  const { client, page, base } = await open(args, env);
  const comment = noteOurWrite(base, page,
    await client.setStatus(commentId, { page, status, ...actorFor(args, env) }));
  return { page, runner: base, comment };
}

async function runStatus(args, env) {
  const { client, page, base } = await open(args, env);
  return { page, runner: base, ...(await client.status(page)) };
}

// Stamp data-rev block ids on a document that has none. Without this an agent
// could WRITE a page and then not comment on it: redline_read_source returns
// blocks: [] for an unstamped page and redline_add_comment has nothing to
// anchor to. Idempotent — the runner only rewrites the file when it adds
// something, so a second call reports added: 0.
async function instrumentDoc(args, env) {
  const { client, page, base } = await open(args, env);
  const result = await client.instrument({ page });
  return { page, runner: base, ...result };
}

async function reply(args, env) {
  const commentId = requireString(args, 'commentId');
  const body = requireString(args, 'body');
  const { client, page, base } = await open(args, env);
  const comment = noteOurWrite(base, page,
    await client.reply(commentId, { page, body, ...actorFor(args, env) }));
  return { page, runner: base, comment };
}

// Revert the most recent applied run. NOTE THE HAZARD, which the tool
// description repeats for the agent's benefit: the runner's /api/undo takes no
// run id, so this is LAST-RUN-WINS. If a human edited after the agent's run,
// this reverts the human's work. Shipping it that way is deliberate (Blake,
// 2026-07-29) — the run-id guard was considered and deferred rather than
// forgotten, so the honest mitigation for now is that the agent is told.
async function undo(args, env) {
  const expectRunId = requireString(args, 'expectRunId', { optional: true });
  const { client, page, base } = await open(args, env);
  const result = await client.undo({ page, ...(expectRunId ? { expectRunId } : {}) });
  return { page, runner: base, ...result };
}

// #169: setting the flag is NOT a field on redline_update_status. Status is the
// comment's lifecycle; aiEdits is whether a batch sweeps it up. They move
// independently — you mark something a note without resolving it — and folding
// them together would force a status change to make one.
async function setAiEdits(args, env) {
  const commentId = requireString(args, 'commentId');
  if (typeof args.aiEdits !== 'boolean') throw new ParamError('aiEdits must be true or false');
  const { client, page, base } = await open(args, env);
  const comment = noteOurWrite(base, page,
    await client.setAiEdits(commentId, { page, value: args.aiEdits }));
  return { page, runner: base, comment };
}

// ---- watching (#296, #297, #298) --------------------------------------------
//
// Four tools that replace five HTTP verbs, the listener subprocess, and every
// piece of state the agent used to carry. The bookkeeping lives in
// runner/lib/watch-session.mjs, which is awake for the whole MCP session; see
// its header for what leaked upward before and why.

const watches = new Map(); // `${base}|${page}` -> WatchSession

const watchKey = (base, page) => `${base}|${page}`;

/** Tell the watch on this page that WE just wrote to this comment, so its own
 *  write is not replayed to it as a delta. Every comment-mutating tool routes
 *  its result through here — not just redline_resolve_comment — because the
 *  orchestrator acknowledges with a plain reply before delegating, and that
 *  reply bumps the comment's rev like any other write. */
function noteOurWrite(base, page, comment) {
  watches.get(watchKey(base, page))?.noteWrite(comment);
  return comment;
}

/** The session this call is about. `file` is optional once watching: with
 *  exactly one page under watch there is nothing to disambiguate, and making
 *  the agent repeat the path on every wake is the kind of bookkeeping this
 *  whole change exists to delete. */
async function watchFor(args, env, { verb }) {
  if (args.file === undefined && watches.size === 1) {
    const [only] = watches.values();
    return only;
  }
  const { base, page } = await open(args, env);
  const found = watches.get(watchKey(base, page));
  if (!found) {
    throw new Error(watches.size === 0
      ? `not watching anything — call redline_watch_start before ${verb}`
      : `not watching ${page} — call redline_watch_start on it first`);
  }
  return found;
}

async function watchStart(args, env) {
  const mode = requireString(args, 'mode');
  if (!MODES.includes(mode)) {
    throw new ParamError(`mode must be one of ${MODES.join(' | ')}`);
  }
  const { client, page, base } = await open(args, env);
  const key = watchKey(base, page);
  const already = watches.get(key);
  if (already) {
    // Idempotent rather than an error: a session that reconnects should not
    // have to know whether it already claimed the page.
    already.mode = mode;
    return { page, runner: base, mode, resumed: true, ...(await already.baseline()) };
  }
  const session = new WatchSession({
    client, base, page, mode, agentName: actorFor(args, env).agentName,
  });
  let baseline;
  try {
    baseline = await session.start({ ttlMs: Number(args.ttlMs) || undefined });
  } catch (err) {
    // A 409 names the holder and gives no sessionId. First holder wins, there
    // is no eviction verb, and editing alongside another session is exactly
    // what presence exists to prevent — so this surfaces rather than retries.
    if (err instanceof ApiError && err.status === 409) {
      // The 409 names the holder and withholds their sessionId — knowing who
      // has the page is not the same as being able to act as them.
      const held = err.body?.holder ?? {};
      const who = held.agentName ? `${held.agentName} (pid ${held.pid ?? '?'})` : 'another session';
      const detail = new Error(`${page} is already claimed by ${who} — say so and stop; its claim expires on its own`);
      detail.status = 409;
      detail.body = err.body;
      throw detail;
    }
    throw err;
  }
  watches.set(key, session);
  return { page, runner: base, resumed: false, ...baseline };
}

async function waitForChange(args, env) {
  const session = await watchFor(args, env, { verb: 'waiting for a change' });
  if (args.timeoutMs !== undefined && typeof args.timeoutMs !== 'number') {
    throw new ParamError('timeoutMs must be a number');
  }
  const result = await session.waitForChange({ timeoutMs: args.timeoutMs });
  return { runner: session.base, ...result };
}

async function watchStop(args, env) {
  if (args.file === undefined && watches.size > 1) {
    const all = await Promise.all([...watches.values()].map((s) => s.stop()));
    const pages = [...watches.keys()];
    watches.clear();
    return { stopped: all.length, pages: pages.map((k) => k.split('|')[1]) };
  }
  const session = await watchFor(args, env, { verb: 'stopping' });
  const result = await session.stop();
  watches.delete(watchKey(session.base, session.page));
  return { page: session.page, runner: session.base, stopped: 1, ...result };
}

/** Finish a comment in one call: lease → re-read → apply → release → reply →
 *  status → re-anchor.
 *
 *  This is where the ordering rule dies. The lease goes around the READ and not
 *  the write, because no write endpoint takes a sessionId and a held lease 409s
 *  against its own holder. The agent never sees a lease id, never learns that
 *  rule, and cannot leave a lease held across a long think — because it never
 *  holds one across a turn boundary at all. */
async function resolveComment(args, env) {
  const commentId = requireString(args, 'commentId');
  const replyBody = requireString(args, 'reply');
  const status = requireString(args, 'status', { optional: true });
  const edits = args.edits;
  if (edits !== undefined && (!Array.isArray(edits) || edits.length === 0)) {
    throw new ParamError('edits must be a non-empty array of {blockId, newInner}');
  }
  if (args.anchor !== undefined && (args.anchor === null || typeof args.anchor !== 'object' || Array.isArray(args.anchor))) {
    throw new ParamError('anchor must be an object');
  }
  const session = await watchFor(args, env, { verb: 'resolving a comment' });
  if (edits && !session.canEdit) {
    // Mode is held by the server so an unauthorised write is REFUSED rather
    // than left to the agent to remember it promised not to.
    throw new ParamError(
      'this page is being watched in reply-only mode — the document is never written to. '
      + 'Omit `edits` to reply, or ask the author to restart the watch in reply-and-edit.');
  }
  const { client, page, base } = { client: session.client, page: session.page, base: session.base };
  const actor = actorFor(args, env);
  const out = { page, runner: base, commentId, applied: false };

  if (edits) {
    for (const e of edits) {
      if (!e || typeof e.blockId !== 'string' || typeof e.newInner !== 'string') {
        throw new ParamError('each edit must be {blockId: string, newInner: string}');
      }
    }
    const blockIds = [...new Set(edits.map((e) => e.blockId))];
    let lease = null;
    try {
      lease = await client.acquireLease({ page, blocks: blockIds, sessionId: session.sessionId, ttlMs: 30_000 });
      // Re-read under the lease so the caller learns the block moved BEFORE the
      // write lands on top of someone else's paragraph. /api/source carries no
      // rev, so the sidecar revision comes from /api/status.
      const [source, state] = await Promise.all([client.source(page), client.status(page)]);
      out.blocksReadAtRev = state?.rev ?? null;
      out.blocksRead = source.blocks
        .filter((b) => blockIds.includes(b.id))
        .map((b) => ({ id: b.id, tag: b.tag }));
    } finally {
      // Released before the write, always — including on the error path, or the
      // next attempt collides with our own abandoned lease.
      if (lease?.leaseId) {
        await client.releaseLease(lease.leaseId, { sessionId: session.sessionId }).catch(() => {});
      }
    }
    const result = await client.proposeEdits({
      page,
      commentId,
      edits,
      ...(args.scope !== undefined ? { scope: args.scope } : {}),
      ...(status ? { decisions: [{ id: commentId, decision: status, summary: replyBody.slice(0, 200) }] } : {}),
      dryRun: false,
      ...actor,
    });
    // A pause is RETURNED, never swallowed: nothing was written and the blocks
    // stay locked until someone answers with redline_confirm_scope.
    if (result?.pendingConfirmation) {
      return {
        ...out,
        pendingConfirmation: true,
        runId: result.runId,
        scope: result.scope,
        note: 'the scope gate paused this write — nothing was applied and the blocks are locked. '
          + 'Answer with redline_confirm_scope. Decline your own over-broad write unless the author '
          + 'asked for a change this wide in words.',
      };
    }
    out.applied = true;
    out.runId = result?.runId ?? null;
    out.edits = result?.edits ?? [];
  }

  const comment = await client.reply(commentId, { page, body: replyBody, ...actor });
  out.replied = true;
  // With edits the decision already carried the status; without them it has to
  // be set on its own.
  if (status && !edits) {
    out.comment = await client.setStatus(commentId, { page, status, ...actor });
  } else {
    out.comment = comment;
  }
  if (args.anchor) {
    out.comment = await client.setAnchor(commentId, { page, anchor: args.anchor });
    out.reanchored = true;
  }
  // Last, so our own reply and status do not read back as new work.
  const current = await session.advanceCursor(commentId);
  if (current) out.comment = current;
  return out;
}

// ---- schemas ----------------------------------------------------------------

const FILE_PROP = {
  file: {
    type: 'string',
    description: 'Path to the .html document (absolute, or relative to the current directory).',
  },
  dir: {
    type: 'string',
    description: 'Directory the runner serves. Only needed when `file` is a page id rather than a real path.',
  },
};
const AGENT_PROP = {
  agentName: {
    type: 'string',
    description: 'Name recorded as the author of this action (default "claude-code").',
  },
};

export const TOOLS = [
  {
    name: 'redline_watch_start',
    description: 'Attach this session to a document and become the watcher on it. Claims the page '
      + '(one watcher at a time, first holder wins) and returns the baseline in the same call: every '
      + 'comment already there, whether hold is on, and who else is present. Presence is then kept '
      + 'alive by this server, not by your turns, so it does not go quiet while you think. '
      + 'mode is the ONE question to ask the author first and never guess: "reply-only" means the '
      + 'document is NEVER written to — every comment gets a threaded reply and nothing else; '
      + '"reply-and-edit" means you write the edit, apply it, reply saying what changed, and set the '
      + 'status. Most people want reply-and-edit. Everything already on the page is context you '
      + 'LEAVE ALONE unless the author asks — say the count out loud and act only on what comes next. '
      + 'Then call redline_wait_for_change.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        mode: { type: 'string', description: 'reply-only | reply-and-edit. Ask the author; do not guess.' },
        ttlMs: { type: 'number', description: 'Claim lifetime in ms (default 60000). Rarely needed.' },
        ...AGENT_PROP,
      },
      required: ['file', 'mode'],
    },
  },
  {
    name: 'redline_wait_for_change',
    description: 'BLOCK until the document changes, then return WHAT changed: comments new or '
      + 'updated since you last acted on them, hold transitions, and any scope-gate pause waiting for '
      + 'an answer. This is the watcher loop — call it, act on what comes back, call it again. '
      + 'It does not poll: a comment landing two seconds in returns after two seconds. '
      + 'A return of {changed:false} is a KEEP-ALIVE, not "nothing is coming" — the call simply hit '
      + 'its time limit, so call it again to keep watching. Your own writes never wake you. '
      + 'When hold is on the author is writing several comments that belong together: take no new '
      + 'work until it clears. Comments with aiEdits:false are NOTES — read them for context, never '
      + 'action them, never mark them addressed.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        timeoutMs: { type: 'number', description: 'How long to park, ms (default 50000, max 55000).' },
      },
      required: [],
    },
  },
  {
    name: 'redline_resolve_comment',
    description: 'Finish one comment in a single call: take the lease, re-read the block, apply your '
      + 'edit, release, reply on the thread, set the status, and re-anchor if you rewrote the quoted '
      + 'text. No model call, no cost — YOU write the prose. Omit `edits` to reply without touching '
      + 'the document, which is the only thing this does in reply-only mode. '
      + 'Build newInner from the full source (redline_read_source), never from the block index text — '
      + 'that field is truncated plain text and an edit built from it silently strips markup. '
      + 'Several comments on one block become ONE call with one edit: written separately, the second '
      + 'is composed against text the first just changed. A question gets a reply and stays open — '
      + 'the author decides when their question is answered. If the write reaches past the comment\'s '
      + 'section or changes the page theme it comes back as {pendingConfirmation:true} with nothing '
      + 'written; answer that with redline_confirm_scope.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        commentId: { type: 'string', description: 'The comment you are finishing.' },
        reply: { type: 'string', description: 'What you changed and why, in the author\'s language. Always required.' },
        status: {
          type: 'string',
          description: 'addressed | declined | deferred. Omit to leave the comment open — correct for a '
            + 'question you answered but did not resolve.',
        },
        edits: {
          type: 'array',
          description: 'Block replacements: {blockId, newInner}. Omit to reply only.',
          items: {
            type: 'object',
            properties: { blockId: { type: 'string' }, newInner: { type: 'string' } },
            required: ['blockId', 'newInner'],
          },
        },
        anchor: {
          type: 'object',
          description: 'New anchor if your edit rewrote the quoted text: {quote, blockId?, prefix?, suffix?}. '
            + 'You know what you changed, so picking the new quote is your job.',
        },
        scope: {
          type: 'object',
          description: 'Declare a deliberate wide change up front: {requiresConfirmation:false, summary}. '
            + 'Only when the author asked for a change this wide in words.',
        },
        ...AGENT_PROP,
      },
      required: ['commentId', 'reply'],
    },
  },
  {
    name: 'redline_watch_stop',
    description: 'Stop watching: releases the claim and every lease this session held, so the page '
      + 'stops showing a watcher that has gone. Call it when the author says you are done. It also '
      + 'runs automatically when this server exits.',
    inputSchema: { type: 'object', properties: { ...FILE_PROP }, required: [] },
  },
  {
    name: 'redline_list_comments',
    description: 'List every review comment on an HTML document: id, body, status, anchor, replies, '
      + 'resolution. Start here to see what humans and other agents have already said. '
      + 'Each comment carries aiEdits: true means the author wants the text CHANGED in response to it; '
      + 'false means it is a NOTE — a question, an observation, or something to leave alone — and '
      + 'Send-All skips it. Respect that flag: do not edit a block on the strength of a note.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        // #235: a watching session passes the sessionId it got from claiming the
        // page, so its read advances the "caught up" receipt the author sees.
        sessionId: { type: 'string', description: 'Your session capability, if watching — advances the author-visible read receipt.' },
      },
      required: ['file'],
    },
  },
  {
    name: 'redline_read_source',
    description: 'Read an HTML document as the runner sees it: the raw source plus the index of '
      + 'stamped data-rev blocks (id, tag, text). Block ids are what comments anchor to and what '
      + 'edits name. Pass blocksOnly:true for just the index.',
    inputSchema: {
      type: 'object',
      properties: { ...FILE_PROP, blocksOnly: { type: 'boolean', description: 'Return only the block index.' } },
      required: ['file'],
    },
  },
  {
    name: 'redline_add_comment',
    description: 'Add a review comment anchored to a block. Recorded in the sidecar as an agent '
      + 'comment, and defaulted to a NOTE (aiEdits: false) — it stays out of the human\'s Send-All '
      + 'batch until they flag it in, so your observations never silently become paid revisions. '
      + 'Pass aiEdits:true only when you mean the text to be CHANGED; it is set at creation, so the '
      + 'comment is never briefly readable as the other kind.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        body: { type: 'string', description: 'The comment text — what should change and why.' },
        quote: { type: 'string', description: 'The exact document text the comment is about.' },
        blockId: { type: 'string', description: 'data-rev id of the block (from redline_read_source).' },
        prefix: { type: 'string', description: 'Up to 200 characters of text before the quote.' },
        suffix: { type: 'string', description: 'Up to 200 characters of text after the quote.' },
        aiEdits: {
          type: 'boolean',
          description: 'true = an edit request, false = a note. Omit for the agent default (note).',
        },
        ...AGENT_PROP,
      },
      required: ['file', 'body', 'quote'],
    },
  },
  {
    name: 'redline_run_revision',
    description: 'SPENDS THE AUTHOR\'S MONEY on an external model. Do NOT call this to action a '
      + 'comment yourself — use redline_direct_edit or redline_propose_edits, which cost nothing. '
      + 'This is the pay-per-use lane, and it belongs to the human pressing Send in the browser. '
      + 'A watching session that routes work here has substituted a paid stranger for itself: it '
      + 'reads the whole document and the model reads one section, which is why session-authored '
      + 'edits have measured better as well as free. Reach for it only when the author explicitly '
      + 'asks for an OpenRouter run. Runs one comment (commentId) or a batch (commentIds, up to 20, '
      + 'one undo unit): the runner routes, prompts its model, validates and applies the edits, '
      + 'then records the run with its cost. Synchronous — it takes as long as the model does.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        commentId: { type: 'string', description: 'A single comment to action.' },
        commentIds: { type: 'array', items: { type: 'string' }, description: 'A batch of comments (1-20).' },
      },
      required: ['file'],
    },
  },
  {
    name: 'redline_propose_edits',
    description: 'Propose your own edits to the document. No model call, no cost — with '
      + 'redline_direct_edit this is how a watching session does its work, and the one you want '
      + 'when you have read the document and know what to write. The RUNNER validates and applies '
      + 'them — never write the file yourself. Defaults to a dry run that reports whether the edits would '
      + 'be accepted; set dryRun:false to apply (snapshotted, undoable, recorded as a run). '
      + 'An apply that reaches past the section its comment is anchored to, or changes the page '
      + 'theme, PAUSES for the author and comes back as {pendingConfirmation: true, runId, scope} '
      + 'with the blocks still leased — answer it with redline_confirm_scope.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        commentId: { type: 'string', description: 'The comment these edits resolve (required if decisions are given).' },
        dryRun: { type: 'boolean', description: 'Validate only (default true).' },
        scope: {
          type: 'object',
          description: 'Your own read of how wide this change is: {level?, requiresConfirmation?, summary?}. '
            + 'Set requiresConfirmation:false ONLY when the author explicitly asked for a change this '
            + 'wide — it waives the pause and states your intent instead. true asks for a pause you '
            + 'would not otherwise get. The runner computes reach itself either way, so this can never '
            + 'hide a theme edit or an out-of-section reach.',
          properties: {
            level: { type: 'string', description: 'block | section | page.' },
            requiresConfirmation: { type: 'boolean' },
            summary: { type: 'string', description: 'One line the author will read on the confirmation card.' },
          },
        },
        edits: {
          type: 'array',
          description: 'Block replacements: {blockId, newInner} — newInner is the block\'s new inner HTML.',
          items: {
            type: 'object',
            properties: { blockId: { type: 'string' }, newInner: { type: 'string' } },
            required: ['blockId', 'newInner'],
          },
        },
        attributeEdits: {
          type: 'array',
          description: 'Block attribute edits: {blockId, class?, style?} — updates the block\'s own class/style '
            + 'without touching its inner HTML. Curated allowlists; out-of-list items need author confirmation.',
          items: {
            type: 'object',
            properties: { blockId: { type: 'string' }, class: { type: 'string' }, style: { type: 'string' } },
            required: ['blockId'],
          },
        },
        theme: {
          type: 'string',
          description: 'Page-level theme: plain CSS declarations for the document body '
            + '(e.g. "font-family: Georgia, serif; line-height: 1.6"). Applied inside a dedicated '
            + '<style data-rev-theme> zone. Allowlist: font-family, font-size, line-height, color, '
            + 'background-color. No selectors, braces, at-rules, or !important.',
        },
        inserts: {
          type: 'array',
          description: 'New blocks: {afterBlockId|beforeBlockId, html}. Never include data-rev — the runner mints ids.',
          items: {
            type: 'object',
            properties: {
              afterBlockId: { type: 'string' }, beforeBlockId: { type: 'string' }, html: { type: 'string' },
            },
            required: ['html'],
          },
        },
        decisions: {
          type: 'array',
          description: 'How the comment was resolved: {id, decision: addressed|declined|deferred, summary, note?}.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              decision: { type: 'string', enum: ['addressed', 'declined', 'deferred'] },
              summary: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['id', 'decision', 'summary'],
          },
        },
        ...AGENT_PROP,
      },
      required: ['file'],
    },
  },
  {
    name: 'redline_update_status',
    description: 'Set a comment\'s status: open (reopen), addressed, declined or deferred. '
      + 'Recorded with agent provenance. Resolving is a HUMAN act — the author accepting the '
      + 'work — so `resolved` is not offered here and the runner refuses it from an agent (#250). '
      + 'State your outcome as addressed/declined/deferred and leave acceptance to the author.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        commentId: { type: 'string', description: 'The comment to update.' },
        status: {
          type: 'string',
          enum: ['open', 'addressed', 'declined', 'deferred'],
          description: 'The new status. (resolved is human-only.)',
        },
        ...AGENT_PROP,
      },
      required: ['file', 'commentId', 'status'],
    },
  },
  {
    name: 'redline_run_status',
    description: 'Is a revision running on this document, and what was the last run? Use after '
      + 'redline_run_revision to read the outcome.',
    inputSchema: { type: 'object', properties: { ...FILE_PROP }, required: ['file'] },
  },
  {
    name: 'redline_instrument',
    description: 'Stamp data-rev block ids on a document so it can be commented on. Call this on any '
      + 'page you just created: an unstamped page returns no blocks from redline_read_source and '
      + 'cannot anchor a comment. Idempotent — running it again reports added: 0. Returns the count '
      + 'added and the total, plus the url to open in a browser.',
    inputSchema: { type: 'object', properties: { ...FILE_PROP }, required: ['file'] },
  },
  {
    name: 'redline_reply',
    description: 'Post a reply on an existing comment thread, recorded with agent provenance. Use it '
      + 'to say what you changed and why, rather than only flipping the status with '
      + 'redline_update_status — the reply is what the human reads later. It renders in a NARROW '
      + '(~320px) comment card, not a terminal: be brief, lead with the answer, no preamble; cite a '
      + 'file path, block id, or run id instead of pasting the detail it points to. Formatting that '
      + 'renders there: **bold**, *italic*, `code`, fenced code blocks, bullet and numbered lists, '
      + 'and > blockquotes. Tables do NOT fit a card — never use them.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        commentId: { type: 'string', description: 'The comment to reply to.' },
        body: { type: 'string', description: 'The reply text.' },
        ...AGENT_PROP,
      },
      required: ['file', 'commentId', 'body'],
    },
  },
  {
    name: 'redline_direct_edit',
    description: 'Replace ONE block\'s inner HTML. No model call, no cost — this is how you edit a '
      + 'document yourself. The runner entity-encodes, validates and snapshots it, and records a '
      + 'run with lane "direct-edit" and your agent name, so it is undoable like any other run. '
      + 'CRITICAL: build newInner from the FULL source string (redline_read_source without '
      + 'blocksOnly) and find the block in it yourself. The blocks[].text index is TRUNCATED PLAIN '
      + 'TEXT — building newInner from it silently strips inline markup and cuts long blocks short. '
      + 'For several blocks at once use redline_propose_edits, which lands them as ONE undo unit.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        blockId: { type: 'string', description: 'data-rev id of the block to replace.' },
        newInner: { type: 'string', description: 'The block\'s new inner HTML — not the whole element.' },
        ...AGENT_PROP,
      },
      required: ['file', 'blockId', 'newInner'],
    },
  },
  {
    name: 'redline_confirm_scope',
    description: 'Answer a scope-gate pause. When a write reaches past the section its comment is '
      + 'anchored to, or changes the page theme, the runner PAUSES it and returns '
      + '{pendingConfirmation: true, runId, scope} instead of applying — the blocks stay leased '
      + 'until someone answers. allow:true applies exactly what was previewed; allow:false '
      + 'discards it and writes nothing. Prefer declining your own over-broad write to leaving it '
      + 'pending: a pause holds the blocks. Only confirm when the human has already told you to '
      + 'make a change that wide — the author\'s surface is the document, not this tool. '
      + 'redline_run_status shows any pending ask and its runId.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        runId: { type: 'string', description: 'The paused run, from the pendingConfirmation response.' },
        allow: { type: 'boolean', description: 'true applies the previewed change; false discards it.' },
      },
      required: ['file', 'runId', 'allow'],
    },
  },
  {
    name: 'redline_undo',
    description: 'Revert an applied run on this document, restoring its pre-run snapshot and '
      + 'reopening the comments it resolved. ALWAYS PASS expectRunId — undo is otherwise '
      + 'LAST-RUN-WINS: it reverts whatever run is on top, INCLUDING one a human made after '
      + 'yours, and reports success. With expectRunId the runner refuses (409) unless the run '
      + 'you named is the one on top. Get the id from redline_run_revision or '
      + 'redline_propose_edits, or from redline_run_status. Fails with 409 while a run is '
      + 'active. One undo reverts a whole Send-All batch.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        expectRunId: {
          type: 'string',
          description: 'The run you mean to revert. The runner refuses if that is not the run '
            + 'on top. Omit only when reverting a run you are certain nothing has landed after.',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'redline_set_ai_edits',
    description: 'Mark a comment as an edit request (aiEdits: true) or as a note (false). A note '
      + 'stays out of the human\'s Send-All batch and out of any batch run, so it never becomes a '
      + 'paid revision. Use it to promote one of your own comments into a real edit request, or to '
      + 'mark one as handled after you edited the block yourself. Separate from '
      + 'redline_update_status on purpose: a comment\'s status and whether a batch picks it up '
      + 'move independently.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROP,
        commentId: { type: 'string', description: 'The comment to flag.' },
        aiEdits: {
          type: 'boolean',
          description: 'true = the text should be changed in response to it; false = it is a note.',
        },
      },
      required: ['file', 'commentId', 'aiEdits'],
    },
  },
];

const HANDLERS = {
  redline_list_comments: listComments,
  redline_read_source: readSource,
  redline_add_comment: addComment,
  redline_run_revision: runRevision,
  redline_propose_edits: proposeEdits,
  redline_direct_edit: directEdit,
  redline_confirm_scope: confirmScope,
  redline_update_status: updateStatus,
  redline_run_status: runStatus,
  redline_instrument: instrumentDoc,
  redline_reply: reply,
  redline_undo: undo,
  redline_set_ai_edits: setAiEdits,
  redline_watch_start: watchStart,
  redline_wait_for_change: waitForChange,
  redline_resolve_comment: resolveComment,
  redline_watch_stop: watchStop,
};

/** The browsable address of the page a result is about. Every handler already
 *  returns `page` and `runner`; joining them here rather than in ten places
 *  means no tool can forget, and an agent that has just created a document can
 *  tell the human where to look instead of leaving them to guess the port. */
function withUrl(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  if (typeof result.url === 'string') return result;
  const { page, runner } = result;
  if (typeof page !== 'string' || typeof runner !== 'string' || !page || !runner) return result;
  return { ...result, url: `${runner.replace(/\/+$/, '')}/${page.replace(/^\/+/, '')}` };
}

/** Run one tool. Throws ParamError for bad arguments; any other throw is a
 *  runtime failure the caller reports as an error result. */
export async function callTool(name, args, { env = process.env } = {}) {
  const handler = HANDLERS[name];
  if (!handler) throw new ParamError(`unknown tool ${JSON.stringify(name)}`);
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new ParamError('arguments must be an object');
  }
  try {
    return withUrl(await handler(args, env));
  } catch (err) {
    // The runner's own error JSON is safe to surface verbatim; keep its status
    // and diagnostic fields so the agent can act on them.
    if (err instanceof ApiError) {
      const detail = new Error(err.body?.error ?? err.message);
      detail.status = err.status;
      detail.body = err.body;
      throw detail;
    }
    throw err;
  }
}
