// runner/lib/sessions.mjs — the session presence ledger (#187, Phase 10).
//
// WHY THIS EXISTS. Nothing in the runner knew whether an agent was watching a
// document. Two modules look like they would and do not: session-log.mjs is a
// post-hoc transcript held in the AGENT's process, which the runner never sees,
// and events.mjs explicitly defers presence because SSE gives no client→server
// push. So a second session could attach to a page a first was already editing,
// and neither would learn of the other until their writes collided.
//
// This is the smallest presence that fixes that: ONE watcher per page, no
// cursors, no user identity. Three verbs — claim, heartbeat, release.
//
// FOUR RULES, each with a reason:
//
//   1. Keyed by resolved htmlPath, the key the lease ledger and the sidecar
//      store already use. A page must not be claimable under two spellings and
//      miss its own conflict.
//   2. Per PAGE, not per runner (decision 11). One session may watch several
//      pages; two sessions may collaborate on different documents under one
//      runner. An agent watching a directory holds N claims, which is the
//      honest accounting.
//   3. Every claim EXPIRES. A session that crashes mid-watch cannot hold a page
//      forever — that failure is invisible from the browser, which sees only
//      silence. The heartbeat is the liveness signal and it comes from the
//      watcher subprocess, not from an agent turn: a conversational session
//      does not act on a timer, so a turn-based heartbeat would go quiet while
//      the session was perfectly alive (decision 12).
//   4. Expiry is LAZY. Every read sweeps first, so a claim that outlived its
//      TTL is never reported as held and never refuses a second claimant. No
//      timer, nothing to unref, nothing to leak in a test.
//
// The sessionId is a capability: it is what heartbeat and release require, and
// under #188 it is the unit of edit rights. A refused claimant is therefore told
// WHO holds the page (agentName, pid, when, until) and never the holder's
// sessionId — learning who has it must not hand over the ability to release it.
//
// In-memory and single-process, like the lease registry. Multi-runner fan-out
// is out of scope for the reason events.mjs gives: it would need a shared bus.

import crypto from 'node:crypto';

// #211: a derived handle for a session, computed from the sessionId by a
// one-way hash. The same FNV-1a approach the overlay uses for comment refs
// (shortRef), so a session can be named in conversation without publishing
// the key that would let anyone evict it.
const HANDLE_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
const HANDLE_LEN = 4;
function sessionHandle(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i += 1) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = '';
  for (let i = 0; i < HANDLE_LEN; i += 1) {
    out += HANDLE_ALPHABET[h % HANDLE_ALPHABET.length];
    h = Math.floor(h / HANDLE_ALPHABET.length);
  }
  return out;
}

/** How long a claim survives without a heartbeat. Long enough that a watcher
 *  on a slow machine, or one that missed a beat, is not evicted mid-turn;
 *  short enough that a crashed session frees the page while its author is
 *  still looking at it. The watcher beats well inside this. */
export const DEFAULT_TTL_MS = 60_000;
// The floor is a second, not a minute: a caller asking for a short TTL is
// promising to beat faster, and a test proving that expiry actually reaches the
// HTTP surface should not have to sleep for a minute to do it.
export const MIN_TTL_MS = 1_000;
export const MAX_TTL_MS = 600_000;

/** A ttlMs a caller asked for, clamped into what the runner will honour.
 *  Absent or unusable → the default; the runner never takes a caller's word for
 *  an unbounded lease. */
export function normalizeTtl(raw, fallback = DEFAULT_TTL_MS) {
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(raw)));
}

/** How many expired sessionIds to remember, so a late heartbeat can be told
 *  "your claim ran out" rather than "no such session". A tombstone is four
 *  strings; the cap only stops an unbounded runner uptime from accumulating
 *  them. */
const TOMBSTONE_LIMIT = 32;

export function createSessionRegistry({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  // sessionId -> {sessionId, page, agentName, pid, claimedAt, expiresAt, ttlMs}
  const sessions = new Map();
  // sessionIds swept for expiry, newest last. Insertion order is FIFO order.
  const expiredIds = new Set();

  function tombstone(sessionId) {
    expiredIds.add(sessionId);
    while (expiredIds.size > TOMBSTONE_LIMIT) {
      const oldest = expiredIds.values().next().value;
      expiredIds.delete(oldest);
    }
  }

  /** Drop everything past its TTL. Called at the top of every read and write,
   *  so an expired claim is never observable — the alternative, a sweep on a
   *  timer, would leave a window in which a dead session still refused a live
   *  one. */
  function sweep() {
    const t = now();
    const expired = [];
    for (const [id, s] of sessions) {
      if (t >= s.expiresAt) {
        sessions.delete(id);
        tombstone(id);
        expired.push(s);
      }
    }
    return expired;
  }

  /** The public view of a claim — everything except the sessionId.
   *  #211: includes a derived `handle` so the session can be named without
   *  publishing the key. #235: includes `seenRev` if the session has polled
   *  /api/comments, so the overlay can show "caught up" vs "N behind." */
  function describe(session) {
    return {
      page: session.page,
      agentName: session.agentName,
      pid: session.pid,
      handle: sessionHandle(session.sessionId),
      claimedAt: session.claimedAt,
      expiresAt: session.expiresAt,
      ttlMs: session.ttlMs,
      seenRev: session.seenRev ?? null,
    };
  }

  /** The live claim on `page`, or null. */
  function holderFor(page) {
    sweep();
    for (const s of sessions.values()) if (s.page === page) return s;
    return null;
  }

  /** Claim a page. Returns {ok:true, session} — the FULL record, sessionId
   *  included, to the claimant only — or {ok:false, reason:'page-claimed',
   *  holder} where holder is the sessionId-free view. */
  function claim({ page, agentName, pid = null, ttlMs: requested }) {
    const held = holderFor(page);
    if (held !== null) return { ok: false, reason: 'page-claimed', holder: describe(held) };
    const at = now();
    const life = normalizeTtl(requested, ttlMs);
    const session = {
      sessionId: `s-${crypto.randomBytes(8).toString('hex')}`,
      page,
      agentName,
      pid: Number.isInteger(pid) ? pid : null,
      claimedAt: new Date(at).toISOString(),
      expiresAt: at + life,
      ttlMs: life,
      seenRev: null, // #235: updated when the session polls /api/comments
    };
    sessions.set(session.sessionId, session);
    return { ok: true, session };
  }

  /** Push a claim's expiry out by its TTL. An unknown id and an EXPIRED id are
   *  reported apart: "your claim ran out" tells a watcher to re-claim, while
   *  "no such session" tells it it is talking to the wrong runner. Both are
   *  refusals, but they call for different behaviour. */
  function heartbeat(sessionId) {
    sweep();
    const session = sessions.get(sessionId);
    if (session === undefined) {
      return { ok: false, reason: expiredIds.has(sessionId) ? 'expired' : 'unknown-session' };
    }
    session.expiresAt = now() + session.ttlMs;
    return { ok: true, session };
  }

  /** Give up a claim. Idempotent in effect: releasing an already-expired or
   *  already-released claim is a refusal, never an error, because a watcher
   *  shutting down should not have to care which happened first. */
  function release(sessionId) {
    sweep();
    const session = sessions.get(sessionId);
    if (session === undefined) {
      return { ok: false, reason: expiredIds.has(sessionId) ? 'expired' : 'unknown-session' };
    }
    sessions.delete(sessionId);
    return { ok: true, session };
  }

  /** Every live claim, sessionId-free — what /api/info reports. */
  function all() {
    sweep();
    return [...sessions.values()].map(describe);
  }

  return {
    claim,
    heartbeat,
    release,
    holderFor,
    all,
    sweep,
    describe,
    get: (sessionId) => {
      sweep();
      return sessions.get(sessionId) ?? null;
    },
    /** Is this a live claim? #188 asks before attributing a lease to it. */
    isLive: (sessionId) => {
      sweep();
      return sessions.has(sessionId);
    },
    /** #235: record that a SPECIFIC session — identified by its capability
     *  `sessionId` — has read up to rev `rev` on `page`. Keyed on the session,
     *  not the page, on purpose: the read receipt answers "has the WATCHER
     *  seen this", and only the caller holding the sessionId is the watcher.
     *  The author's own /api/comments poll carries no sessionId, so it can no
     *  longer mark a watcher caught up (the bug this closes). A no-op — returns
     *  false — for an unknown/expired session or one watching a different page. */
    markSeen: (sessionId, page, rev) => {
      sweep();
      const s = sessions.get(sessionId);
      if (s === undefined || s.page !== page || typeof rev !== 'number') return false;
      s.seenRev = rev;
      return true;
    },
    get size() {
      sweep();
      return sessions.size;
    },
  };
}
