// runner/lib/leases.mjs — the run registry and block-lease ledger (#38).
//
// WHY THIS EXISTS. Before it, `activeRuns` and `pendingConfirmations` were
// `Map`s keyed by `htmlPath`: one run per page, and every other write on that
// page refused. A comment on paragraph 4 blocked an unrelated comment on
// paragraph 9, for as long as it took a human to notice. Worse, a run PAUSED
// for scope confirmation held the whole page hostage until someone answered.
//
// The rule is disjointness, not turn-taking: a run acquires leases on the
// blocks it will actually write, and two runs whose block sets do not overlap
// proceed at the same time. Only overlap serializes. There is no arbiter that
// kills a run to make room — an overlapping run waits, and the human interrupts
// (#79).
//
// Ported from the pre-rebuild `lib/orchestrate.mjs` (chunk 3) on
// `archive/legacy-stack`, which had all of this and did not survive the
// rebuild. Three deliberate changes from that version:
//
//   1. It is a STANDALONE module, not a closure inside the run driver, so the
//      admission rules can be tested without spawning an agent or a server.
//   2. Admission is ONE decision function returning a structured refusal, not
//      an `if` re-implemented at each of the five call sites that guard writes.
//   3. A run awaiting confirmation KEEPS its leases. That is the whole point of
//      the gate: it is holding the blocks it proposes to write, and its stashed
//      edits stay valid precisely because nothing else may touch them.
//
// The refusal vocabulary EXTENDS the one #106 established (`reason:
// 'run-active' | 'awaiting-confirmation'`) with `'blocks-leased'`. It does not
// invent a second vocabulary — a caller that only understands the first two
// still gets a 409 it can render.

// HELD LEASES (#188, Phase 10). A run's lease lives for one HTTP request and is
// released in a `finally`. A collaborating session needs the other kind: "I am
// rewriting r-b810, hands off while I think." Those are the same leases, taken
// through the same admission rules, with two differences:
//
//   - they carry a TTL, because a crashed session must not lock a paragraph out
//     of its author's own document forever, and under first-holder-wins
//     (decision 5) the human waits rather than preempting — so expiry is the
//     only thing standing between a wedged agent and a document nobody can
//     edit. Expiry is LAZY: every entry point sweeps first, so an expired lease
//     never refuses a live caller and there is no timer to leak.
//   - they carry a `holder` (a #187 sessionId), because the lease belongs to
//     the SESSION, not to the agent turn or the delegate that writes under it
//     (decision 10).
//
// A run keeps `expiresAt: null` and `holder: null` — it never expires under a
// caller, and its lifetime is its request. That is deliberately unchanged.

/** Lease over every block on the page. A run that cannot enumerate its reach
 *  (a comprehensive rewrite, an undo, a re-instrument) takes this. */
export const PAGE = '*';

/** A run is either executing, or paused holding its blocks pending a human
 *  Allow/Decline. Both hold leases; only the first counts as `running`. */
export const RUNNING = 'running';
export const AWAITING = 'awaiting-confirmation';

/** The lane a held lease (#188) takes. Distinguishing it from a run's lane is
 *  what lets force-release refuse to yank the blocks a run is mid-write on. */
export const HOLD_LANE = 'session-hold';

// How long a held lease lives without a renewal. Thirty seconds is the
// ticket's own example — "hands off for the next 30 seconds while I think" —
// and decision 9 says lease late and release early, so a lease outliving one
// write is already unusual. The ceiling is five minutes: under
// first-holder-wins a longer hold is indistinguishable from a wedged session,
// and the author is left watching their own paragraph.
export const LEASE_DEFAULT_TTL_MS = 30_000;
export const LEASE_MIN_TTL_MS = 1_000;
export const LEASE_MAX_TTL_MS = 300_000;

/** Clamp a requested lease TTL into what the runner will honour. Absent or
 *  unusable → the default; the runner never grants an unbounded hold. */
export function normalizeLeaseTtl(raw) {
  if (!Number.isFinite(raw)) return LEASE_DEFAULT_TTL_MS;
  return Math.min(LEASE_MAX_TTL_MS, Math.max(LEASE_MIN_TTL_MS, Math.floor(raw)));
}

function normalizeBlocks(blocks) {
  if (blocks === PAGE) return PAGE;
  const set = new Set();
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (typeof b === 'string' && b.length > 0) set.add(b);
  }
  // A run that named no blocks has unknown reach; treating that as "leases
  // nothing" would let it race a run that does know. Unknown reach is total.
  return set.size === 0 ? PAGE : set;
}

function overlaps(a, b) {
  if (a === PAGE || b === PAGE) return true;
  for (const id of a) if (b.has(id)) return true;
  return false;
}

/** The blocks two lease sets share — for saying WHICH block you are waiting on
 *  rather than only that you are waiting. PAGE yields [] (there is no single
 *  contended block; the whole page is held). */
function intersect(a, b) {
  if (a === PAGE || b === PAGE) return [];
  return [...a].filter((id) => b.has(id));
}

export function createRunRegistry({ now = () => Date.now() } = {}) {
  // runId -> { runId, page, lane, blocks, state, startedAt, scope,
  //            expiresAt, ttlMs, holder }
  const runs = new Map();
  // #208: blocks where a lease acquire was refused, with who holds them and
  // when. Aged out after 30 seconds — a refusal from ten minutes ago is not
  // "an agent is waiting." Keyed by page → blockId → {by, at}.
  const contended = new Map();
  const CONTENTED_TTL_MS = 30_000;

  /** Drop every lease past its TTL, and return them. Runs (expiresAt null) are
   *  never swept: their lifetime is their request, and a slow model must not
   *  cost a run the blocks it is mid-write on. Called at the top of every entry
   *  point below — an expired lease must be invisible everywhere at once, not
   *  just wherever someone remembered to check. */
  function sweep() {
    const t = now();
    const dropped = [];
    for (const [id, r] of runs) {
      if (r.expiresAt !== null && t >= r.expiresAt) {
        runs.delete(id);
        dropped.push(r);
      }
    }
    // #208: age out old contention records.
    for (const [page, blocks] of contended) {
      for (const [blockId, rec] of blocks) {
        if (t - rec.at >= CONTENTED_TTL_MS) blocks.delete(blockId);
      }
      if (blocks.size === 0) contended.delete(page);
    }
    return dropped;
  }

  const runsOn = (page) => {
    sweep();
    return [...runs.values()].filter((r) => r.page === page);
  };

  /** Would `blocks` be admitted on `page`? Returns null when free, else the
   *  structured refusal. A run awaiting confirmation is reported as such even
   *  when a plain running lease also conflicts: it is the one a human can act
   *  on, so it is the more useful thing to name. */
  function conflict(page, blocks, { ignoreRunId = null } = {}) {
    const want = normalizeBlocks(blocks);
    const clashes = runsOn(page)
      .filter((r) => r.runId !== ignoreRunId)
      .filter((r) => overlaps(r.blocks, want));
    if (clashes.length === 0) return null;

    const pending = clashes.find((r) => r.state === AWAITING);
    const blocker = pending ?? clashes[0];
    const shared = intersect(blocker.blocks, want);
    return {
      reason: blocker.state === AWAITING ? AWAITING
        : (blocker.blocks === PAGE || want === PAGE) ? 'run-active'
          : 'blocks-leased',
      runId: blocker.runId,
      blocks: shared,
      state: blocker.state,
    };
  }

  /** Take leases for a run, or refuse. Never partially acquires: a refused run
   *  holds nothing, so there is no lease to leak if the caller gives up. */
  // `ignoreRunId` (#231): a write that NAMES a lease it already holds is
  // admitted past that one lease — lease → write → release, with no
  // release-before-write race. Every other holder still refuses as ever.
  function acquire({ runId, page, blocks, lane = null, ttlMs = null, holder = null, ignoreRunId = null }) {
    sweep();
    if (runs.has(runId)) throw new Error(`run ${runId} is already registered`);
    const clash = conflict(page, blocks, { ignoreRunId });
    if (clash !== null) {
      // #208: record the refused blocks so /api/status can report "an agent
      // was turned away" to the overlay.
      const blockerRun = runs.get(clash.runId);
      const by = blockerRun && blockerRun.holder ? blockerRun.holder
        : blockerRun && blockerRun.lane ? blockerRun.lane : 'unknown';
      if (!contended.has(page)) contended.set(page, new Map());
      const pageMap = contended.get(page);
      const blockList = clash.blocks === PAGE ? ['*'] : clash.blocks;
      const at = now();
      for (const blockId of blockList) {
        pageMap.set(blockId, { by, at });
      }
      return { ok: false, ...clash };
    }
    const startedAt = now();
    const run = {
      runId, page, lane, blocks: normalizeBlocks(blocks),
      state: RUNNING, startedAt, scope: null,
      // A run passes no ttlMs and never expires (#188). Only a HELD lease does.
      ttlMs: Number.isFinite(ttlMs) ? ttlMs : null,
      expiresAt: Number.isFinite(ttlMs) ? startedAt + ttlMs : null,
      holder,
    };
    runs.set(runId, run);
    return { ok: true, run };
  }

  /** Push a held lease's expiry out. Distinct from extend(), which WIDENS the
   *  block set: renewing says "still working", widening says "it turned out to
   *  be more blocks than I said". Renewing a run (no TTL) is a no-op success —
   *  a run has nothing to renew and refusing would be a lie. */
  function renew(runId, ttlMs = null) {
    sweep();
    const run = runs.get(runId);
    if (run === undefined) return { ok: false, reason: 'unknown-lease', runId };
    if (run.expiresAt === null) return { ok: true, run };
    const life = Number.isFinite(ttlMs) ? ttlMs : run.ttlMs;
    run.ttlMs = life;
    run.expiresAt = now() + life;
    return { ok: true, run };
  }

  /** Every held lease belonging to one session (#187's sessionId). A session
   *  that releases its claim, or whose claim expires, must not leave blocks
   *  held out of their author's hands until each lease's own TTL runs out. */
  function heldBy(holder) {
    sweep();
    return [...runs.values()].filter((r) => r.holder !== null && r.holder === holder);
  }

  /** Release on any terminal outcome — ok, failed, declined, thrown. Callers
   *  MUST do this in a `finally`; a leaked lease locks blocks until restart. */
  function release(runId) {
    return runs.delete(runId);
  }

  /** Widen a run's lease to cover blocks it turned out to touch.
   *
   *  A run is admitted on the blocks its comment is ANCHORED to, because that
   *  is all that is known before the agent replies. The dry run then reveals
   *  the true reach, which may be wider. Rather than write outside its lease —
   *  the one thing the ledger exists to prevent — the run asks for the extra
   *  blocks here. If another run holds any of them the extension is refused and
   *  the caller must fail the run rather than proceed: a late refusal is
   *  recoverable, a write racing another run is not.
   *
   *  Extending is all-or-nothing, so a refused extension leaves the original
   *  lease exactly as it was. */
  function extend(runId, blocks) {
    sweep();
    const run = runs.get(runId);
    if (run === undefined) return { ok: false, reason: 'unknown-run', runId };
    if (run.blocks === PAGE) return { ok: true, run }; // already total
    const want = normalizeBlocks(blocks);
    if (want === PAGE) {
      // Escalating to page-exclusive: only if nothing else is on the page.
      const clash = conflict(run.page, PAGE, { ignoreRunId: runId });
      if (clash !== null) return { ok: false, ...clash };
      run.blocks = PAGE;
      return { ok: true, run };
    }
    const added = [...want].filter((id) => !run.blocks.has(id));
    if (added.length === 0) return { ok: true, run };
    const clash = conflict(run.page, added, { ignoreRunId: runId });
    if (clash !== null) return { ok: false, ...clash };
    for (const id of added) run.blocks.add(id);
    return { ok: true, run };
  }

  /** Pause a run holding its leases, pending a human decision. */
  function markPending(runId, scope = null) {
    const run = runs.get(runId);
    if (run === undefined) return false;
    run.state = AWAITING;
    run.scope = scope;
    run.pendingAt = now();
    return true;
  }

  /** Resume a paused run (its Allow was accepted) — leases are unchanged, so
   *  there is no window in which another run could slip in between. */
  function resume(runId) {
    const run = runs.get(runId);
    if (run === undefined) return false;
    run.state = RUNNING;
    return true;
  }

  /** blockId -> holding runId across the page; the PAGE key marks a
   *  page-exclusive holder. This is what the leased-block map renders (#79). */
  function leasedBlocks(page) {
    const map = new Map();
    for (const r of runsOn(page)) {
      if (r.blocks === PAGE) map.set(PAGE, r.runId);
      else for (const b of r.blocks) map.set(b, r.runId);
    }
    return map;
  }

  /** Is a single block writable right now? The direct-edit guard (#121): an
   *  edit on an unleased block stays live while runs are in flight elsewhere. */
  function blockAvailable(page, blockId) {
    const clash = conflict(page, [blockId]);
    return clash === null ? { ok: true } : { ok: false, ...clash };
  }

  /** Does `runId` still hold leases covering every block in `blocks`?
   *
   *  The Allow-time re-base check (#121's "care needed"). A pending
   *  confirmation's edits were computed against the document at DRY-RUN time,
   *  and are only still valid because nothing else could touch those blocks.
   *  That invariant has to be ENFORCED at Allow time, not assumed — if the run
   *  no longer covers what it is about to write, the stash is stale and the
   *  write must be refused or re-based, never applied. */
  function covers(runId, blocks) {
    sweep();
    const run = runs.get(runId);
    if (run === undefined) return false;
    if (run.blocks === PAGE) return true;
    const want = normalizeBlocks(blocks);
    if (want === PAGE) return false; // unknown reach is never covered by a block set
    for (const id of want) if (!run.blocks.has(id)) return false;
    return true;
  }

  /** The lease-aware view for GET /api/status.
   *
   *  `running` keeps its established meaning — at least one run EXECUTING —
   *  and a gated run is deliberately not counted, exactly as #106 documented.
   *  Under leases that flag alone is ambiguous (one run can execute while
   *  another waits), so `runs[]` carries the per-run truth and is what a
   *  caller should branch on. `pendingConfirmation` stays for the overlay
   *  #106 shipped, naming the first pending run. */
  function statusFor(page) {
    const mine = runsOn(page);
    const executing = mine.filter((r) => r.state === RUNNING);
    const pending = mine.filter((r) => r.state === AWAITING);

    const leases = {};
    for (const [blockId, runId] of leasedBlocks(page)) leases[blockId] = runId;

    const out = {
      running: executing.length > 0,
      runs: mine.map((r) => ({
        runId: r.runId,
        state: r.state,
        lane: r.lane,
        blocks: r.blocks === PAGE ? PAGE : [...r.blocks],
        startedAt: r.startedAt,
        // Held leases only (#188). A run reports neither, so nothing that reads
        // this projection has to tell "no expiry" from "an old runner".
        ...(r.expiresAt !== null ? { expiresAt: r.expiresAt, ttlMs: r.ttlMs } : {}),
        ...(r.holder !== null ? { holder: r.holder } : {}),
        ...(r.state === AWAITING ? { scope: r.scope, pendingAt: r.pendingAt ?? null } : {}),
      })),
      leases,
    };
    // #208: contended blocks — where a lease acquire was refused, with who
    // holds them and when. Aged out by sweep().
    const pageContended = contended.get(page);
    if (pageContended && pageContended.size > 0) {
      out.contended = {};
      for (const [blockId, rec] of pageContended) {
        out.contended[blockId] = { by: rec.by, at: new Date(rec.at).toISOString() };
      }
    }
    if (executing.length > 0) out.runId = executing[0].runId;
    if (pending.length > 0) {
      const p = pending[0];
      out.pendingConfirmation = {
        runId: p.runId,
        scope: p.scope,
        createdAt: p.pendingAt ?? p.startedAt,
        blocks: p.blocks === PAGE ? PAGE : [...p.blocks],
      };
    }
    return out;
  }

  return {
    acquire, release, extend, renew, heldBy, sweep, conflict, markPending, resume,
    leasedBlocks, blockAvailable, covers, statusFor, runsOn,
    get: (runId) => { sweep(); return runs.get(runId) ?? null; },
    has: (runId) => { sweep(); return runs.has(runId); },
    get size() { sweep(); return runs.size; },
  };
}
