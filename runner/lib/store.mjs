// runner/lib/store.mjs — sidecar persistence for <page>.review.json.
//
// The runner is the ONLY writer of sidecars. Writes are atomic (tmp file +
// rename) so a crash never leaves a torn sidecar. Client-supplied page params
// go through the same traversal/dotfile guards as file serving (resolvePath)
// and must name an existing .html file under the served root. The reviewed
// HTML document is never touched by anything in this module.
//
// Concurrency: sidecars carry a top-level `rev` integer bumped on every save.
// Legacy sidecars without one read as rev 0 — tolerated forever, never
// migrated by a read alone (load() stamps rev in memory only; disk gains the
// field on the first save). save() re-reads the on-disk rev before its rename
// and refuses (code REV_CONFLICT) when it moved past the caller's expectation;
// update() retries the whole read-modify-write on that conflict. This is the
// cross-PROCESS guard: withLock covers concurrent calls inside one runner,
// but a second runner whose root overlaps this one (see the single-instance
// lock in server.mjs and its limitation note) shares no in-memory lock — the
// rev check is what keeps its writes from clobbering ours.

import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { resolvePath } from './paths.mjs';

export function newId(prefix = 'c') {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

export function now() {
  return new Date().toISOString();
}

// Resolve a client-supplied page param ("doc.html", "sub/page.html") to an
// absolute path under root. Returns null unless it passes the same
// traversal/dotfile guards as the file server, ends in .html, and exists as
// a regular file.
export async function resolvePage(root, page) {
  if (typeof page !== 'string' || page.length === 0 || page.length > 1024) return null;
  const abs = resolvePath(root, '/' + page.replace(/^\/+/, ''));
  if (abs === null) return null;
  if (path.extname(abs).toLowerCase() !== '.html') return null;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

export function sidecarPath(htmlPath) {
  return `${htmlPath}.review.json`;
}

// error.code thrown by save() when the on-disk rev moved past expectedRev.
export const REV_CONFLICT = 'ESIDECARREV';

function normalizeRev(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

// Load the sidecar for a resolved page path. Missing sidecar → fresh state.
// Corrupt JSON throws (the API layer turns that into a 500 rather than
// silently discarding an author's comments). The returned object carries the
// rev this read saw (`data.rev`, 0 for missing/legacy sidecars) — in memory
// only; a load never writes anything to disk.
export async function load(htmlPath) {
  let raw;
  try {
    raw = await fs.readFile(sidecarPath(htmlPath), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { comments: [], rev: 0 };
    throw err;
  }
  const data = JSON.parse(raw);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`sidecar is not an object: ${sidecarPath(htmlPath)}`);
  }
  if (!Array.isArray(data.comments)) data.comments = [];
  data.rev = normalizeRev(data.rev);
  return data;
}

// Atomic write: tmp file next to the target, then rename over it. Shared by
// the sidecar save below and every document write (apply.mjs, history.mjs) —
// a crash never leaves a torn file.
export async function atomicWriteFile(filePath, text) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Rev currently on disk. Missing sidecar → 0; unparseable content → 0 (save
// then overwrites it, exactly as the pre-rev save did).
async function diskRev(htmlPath) {
  let raw;
  try {
    raw = await fs.readFile(sidecarPath(htmlPath), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? normalizeRev(parsed.rev) : 0;
  } catch {
    return 0;
  }
}

// Atomic save of the sidecar. Re-reads the on-disk rev first: when
// expectedRev is given and the disk moved past it (another PROCESS wrote in
// between), throws with code REV_CONFLICT instead of clobbering — the caller
// re-reads and re-applies (see update()). Every successful save writes
// rev = on-disk rev + 1 (stamped onto `data` so the caller's copy stays true).
export async function save(htmlPath, data, expectedRev) {
  const current = await diskRev(htmlPath);
  if (expectedRev !== undefined && current !== expectedRev) {
    const err = new Error(
      `sidecar rev moved on disk (expected ${expectedRev}, found ${current}): ${sidecarPath(htmlPath)}`);
    err.code = REV_CONFLICT;
    throw err;
  }
  data.rev = current + 1;
  await atomicWriteFile(sidecarPath(htmlPath), JSON.stringify(data, null, 2) + '\n');
  announceSave(htmlPath, data.rev);
}

// ---- save notifications (#162) ---------------------------------------------
//
// Every sidecar mutation funnels through save(), so this is the ONE place that
// knows something changed — one hook rather than twelve instrumented
// endpoints. The store stays ignorant of HTTP: it announces a (path, rev) pair
// and the SSE hub subscribes from outside. Keeping the dependency pointing that
// way is why store.mjs can still be tested with no server in sight.
const saveListeners = new Set();

/** Register a save observer. Returns an unregister function. */
export function onSave(listener) {
  saveListeners.add(listener);
  return () => saveListeners.delete(listener);
}

// A listener must never be able to fail a write that already landed on disk.
function announceSave(htmlPath, rev) {
  for (const listener of saveListeners) {
    try { listener(htmlPath, rev); } catch { /* an observer cannot break a save */ }
  }
}

// ---- per-annotation ops (#88) ----------------------------------------------
//
// Every sidecar mutation is expressible as a small op against ONE annotation
// or run record, so a hosted store can implement the same vocabulary
// row-based instead of document-based. applyOps() is pure: it mutates `data`
// in memory and stamps each touched record with the rev the enclosing save
// will land at (data.rev + 1 — under update() the rev-checked save guarantees
// exactly that, retrying the whole cycle otherwise). Those per-record stamps
// are what changesSince() filters on.
//
// Ops:
//   {op:'addComment', comment}                       — append a new comment
//   {op:'reply', commentId, entry}                   — append a thread entry
//   {op:'setStatus', commentId, status, by?}         — set status (+/- statusUpdatedBy)
//   {op:'setAiEdits', commentId, value}              — in the AI-edits batch? (#96)
//   {op:'setHold', on, at, by?, commentIds?}         — page hold mode (#190)
//   {op:'setAnchorBlock', commentId, blockId}        — rescue: stamp anchor.blockId
//   {op:'resolve', commentId, status, resolution?}   — run outcome; absent
//                                                      resolution DELETES it (undo)
//   {op:'addRun', run}                               — append a run record
//   {op:'setRunStatus', runId, status}               — flip a run (undo)
//
// A declined scope confirmation (#124) once went to a separate top-level
// costLedger[] to keep it out of runs[]; #128 retired that array and writes the
// declined run into runs[] as a zero-edit status:'declined' record (undo-inert,
// but visible in the run log). runs[] is once again a page's whole spend, so
// there is no ledger op.
//
// An op naming a record that does not exist is reported in `missing`, never
// thrown — run outcomes tolerate comments deleted mid-run, exactly like the
// inline mutations they replace. An unknown op.op IS thrown: that is a
// programmer error, not a data race.
export function applyOps(data, ops) {
  const landing = normalizeRev(data.rev) + 1;
  const applied = [];
  const missing = [];
  if (!Array.isArray(data.comments)) data.comments = [];
  const comment = (id) => data.comments.find((c) => c.id === id);
  const touch = (record, op) => {
    record.rev = landing;
    applied.push(op);
  };

  for (const op of ops) {
    switch (op.op) {
      case 'addComment': {
        data.comments.push(op.comment);
        touch(op.comment, op);
        break;
      }
      case 'reply': {
        const c = comment(op.commentId);
        if (!c) { missing.push(op); break; }
        if (!Array.isArray(c.replies)) c.replies = [];
        c.replies.push(op.entry);
        touch(c, op);
        break;
      }
      case 'setStatus': {
        const c = comment(op.commentId);
        if (!c) { missing.push(op); break; }
        c.status = op.status;
        if (op.by !== undefined && op.by !== null) c.statusUpdatedBy = op.by;
        else delete c.statusUpdatedBy;
        touch(c, op);
        break;
      }
      case 'setAiEdits': {
        const c = comment(op.commentId);
        if (!c) { missing.push(op); break; }
        // Absent === in the batch (the default), so we only persist the OFF
        // state and delete the field to return to default — sidecars stay
        // minimal and old comments read as AI-included without migration.
        if (op.value === false) c.aiEdits = false;
        else delete c.aiEdits;
        touch(c, op);
        break;
      }
      // Hold mode (#190). Page-level, not per-comment, and in the SIDECAR
      // rather than in memory for two reasons: it must survive a reload, and
      // it must be visible to every client and to the watching agent without a
      // second endpoint — a sidecar change bumps rev, which is already the one
      // signal everything listens to.
      //
      // `since` is what makes the count mean "held back since hold went on"
      // rather than "not yet done" (decision 15), so turning hold on when it
      // is already on must NOT move it. `lastRelease` is how a watcher that
      // learns of the release from a rev bump — rather than from the response
      // to its own call — finds out WHICH comments were handed over. State,
      // not a delta, exactly as events.mjs argues.
      case 'setHold': {
        const current = data.hold ?? null;
        if (op.on) {
          if (current !== null && current.on === true) break; // already held; keep `since`
          data.hold = { on: true, since: op.at, ...(op.by ? { by: op.by } : {}) };
        } else {
          if (current === null || current.on !== true) {
            data.hold = { on: false, since: null, lastRelease: current?.lastRelease ?? null };
            break;
          }
          data.hold = {
            on: false,
            since: null,
            lastRelease: {
              at: op.at,
              heldSince: current.since ?? null,
              commentIds: Array.isArray(op.commentIds) ? op.commentIds : [],
              ...(op.by ? { by: op.by } : {}),
            },
          };
        }
        touch(data.hold, op);
        break;
      }
      case 'setAnchorBlock': {
        const c = comment(op.commentId);
        if (!c || c.anchor === null || typeof c.anchor !== 'object') { missing.push(op); break; }
        c.anchor.blockId = op.blockId;
        touch(c, op);
        break;
      }
      // Re-anchor a comment to a wholly new anchor (#157). The API layer has
      // already validated op.anchor; the op just replaces it.
      case 'setAnchor': {
        const c = comment(op.commentId);
        if (!c) { missing.push(op); break; }
        c.anchor = op.anchor;
        touch(c, op);
        break;
      }
      case 'resolve': {
        const c = comment(op.commentId);
        if (!c) { missing.push(op); break; }
        c.status = op.status;
        if (op.resolution !== undefined) c.resolution = op.resolution;
        else delete c.resolution;
        touch(c, op);
        break;
      }
      case 'addRun': {
        if (!Array.isArray(data.runs)) data.runs = [];
        data.runs.push(op.run);
        touch(op.run, op);
        break;
      }
      case 'setRunStatus': {
        const r = Array.isArray(data.runs) ? data.runs.find((x) => x.runId === op.runId) : undefined;
        if (!r) { missing.push(op); break; }
        r.status = op.status;
        touch(r, op);
        break;
      }
      default:
        throw new Error(`applyOps: unknown op "${op?.op}"`);
    }
  }
  return { applied, missing };
}

// Changes since a sync cursor (#88). The cursor is a rev previously returned
// by this function (or a save); records touched by applyOps after that rev
// carry a bigger stamp and are returned. Cursor 0/absent → a full fetch
// (`full: true`, everything, including legacy records that predate stamping —
// unstamped records read as rev 0 and only ever appear in a full fetch).
export async function changesSince(htmlPath, cursor) {
  const data = await load(htmlPath);
  const since = Number.isInteger(cursor) && cursor > 0 ? cursor : 0;
  const runs = Array.isArray(data.runs) ? data.runs : [];
  if (since === 0) {
    return { rev: data.rev, full: true, comments: data.comments, runs };
  }
  const changed = (record) => normalizeRev(record.rev) > since;
  return {
    rev: data.rev,
    full: false,
    comments: data.comments.filter(changed),
    runs: runs.filter(changed),
  };
}

// Serialize load-modify-save cycles per page so concurrent API calls never
// lose each other's writes. In-memory, so single-PROCESS only — the rev check
// in save()/update() is the cross-process complement.
const locks = new Map();
export function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const entry = run.catch(() => {}).finally(() => {
    if (locks.get(key) === entry) locks.delete(key);
  });
  locks.set(key, entry);
  return run;
}

export const UPDATE_MAX_ATTEMPTS = 10;

// The one safe way to mutate a sidecar: load → mutator(data) → rev-checked
// save, under the per-page in-process lock, retrying the WHOLE cycle when a
// concurrent process moved the sidecar between our read and our write (the
// late writer re-reads and re-applies its mutation on top — no records lost).
// The mutator may be async, must be safe to re-run against fresh data, and
// may call the provided skip() to finish without saving (e.g. target comment
// not found); update() resolves to the mutator's return value either way.
export function update(htmlPath, mutator) {
  return withLock(htmlPath, async () => {
    for (let attempt = 0; attempt < UPDATE_MAX_ATTEMPTS; attempt++) {
      const data = await load(htmlPath);
      let skipped = false;
      const result = await mutator(data, { skip: () => { skipped = true; } });
      if (skipped) return result;
      try {
        await save(htmlPath, data, data.rev);
        return result;
      } catch (err) {
        if (err.code !== REV_CONFLICT) throw err;
        // Another process saved between our load and save — go around again.
      }
    }
    throw new Error(
      `sidecar kept changing underneath ${UPDATE_MAX_ATTEMPTS} attempts: ${sidecarPath(htmlPath)}`);
  });
}
