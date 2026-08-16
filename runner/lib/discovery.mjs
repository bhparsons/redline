// runner/lib/discovery.mjs — find the runner that serves a directory.
//
// Every runner writes <root>/.redline.lock at startup ({pid, port, startedAt},
// see server.mjs). Discovery walks UP from a target directory to the nearest
// lock, and only believes it after three checks:
//
//   1. the recorded pid is alive,
//   2. GET /health on the recorded port answers {ok:true},
//   3. GET /api/info reports the SAME root as the directory holding the lock.
//
// Any failure means "not this one" and the walk continues upward — a stale
// lock from a crash, a port some other process took over, or a runner serving
// a different tree can never be mistaken for the right runner.
//
// Root comparison goes through realpath on both sides: the runner records
// path.resolve(dir) while a caller may have walked up from /private/var/... —
// same directory, different string, on macOS.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LOCK_FILENAME } from './server.mjs';

export const PROBE_TIMEOUT_MS = 2000;

/** Is `pid` a live process? EPERM = alive but not ours — still live. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** realpath(p), or the resolved path when it can't be resolved. */
async function realOrResolved(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** Do two paths name the same directory? Symlink-tolerant. */
export async function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return (await realOrResolved(a)) === (await realOrResolved(b));
}

/** Every <dir>/.redline.lock from `startDir` up to the filesystem root,
 *  nearest first: [{root, lockPath, lock: {pid, port, startedAt}}]. Unreadable
 *  or unparseable locks are skipped — a corrupt lock is a stale lock. */
export async function findLocks(startDir) {
  const found = [];
  let dir = path.resolve(startDir);
  for (;;) {
    const lockPath = path.join(dir, LOCK_FILENAME);
    try {
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (lock !== null && typeof lock === 'object'
        && Number.isInteger(lock.pid) && Number.isInteger(lock.port)) {
        found.push({ root: dir, lockPath, lock });
      }
    } catch {
      // no lock here (or unreadable) — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/** GET /api/info from a runner on `port`, or null if nothing healthy answers. */
export async function probe(port, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!health.ok) return null;
    const body = await health.json();
    if (body?.ok !== true) return null;
    const info = await fetch(`${base}/api/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!info.ok) return null;
    const parsed = await info.json();
    if (typeof parsed?.root !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The live runner serving `dir` (or any directory above it), or null.
 * Returns {base, port, root, info, lockPath}.
 */
export async function discoverRunner(dir, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  for (const { root, lockPath, lock } of await findLocks(dir)) {
    if (!pidAlive(lock.pid)) continue;
    const info = await probe(lock.port, { timeoutMs });
    if (info === null) continue;
    if (!(await samePath(info.root, root))) continue;
    return { base: `http://127.0.0.1:${lock.port}`, port: lock.port, root: info.root, info, lockPath };
  }
  return null;
}

/**
 * The page path (root-relative, forward slashes) naming `absFile` on a runner
 * serving `root` — the identifier every /api/* call takes. Null when the file
 * is outside the root, which is exactly when the runner would 404 it.
 */
export async function pageForFile(root, absFile) {
  const realRoot = await realOrResolved(root);
  const realFile = await realOrResolved(absFile);
  const rel = path.relative(realRoot, realFile);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
