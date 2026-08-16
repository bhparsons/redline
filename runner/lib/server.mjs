// runner/lib/server.mjs — the runner's HTTP server.
//
// Static file serving under a single root with path-traversal protection,
// an overlay injection placeholder stamped into served HTML (files on disk
// stay clean), and GET /health for extension runner-detection. Binds
// 127.0.0.1 only — this is a local tool, never exposed to the network.
//
// /health stays a bare {ok:true} (the extension asserts it byte-for-byte).
// The identity an agent-side discovery pass needs — root, bound port, pid,
// startedAt, version — is GET /api/info, served from api.mjs out of the `meta`
// object built here once the port is known.

import http from 'node:http';
import { promises as fs, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, closeEventStreams, initEventStream } from './api.mjs';
import { loadConfig, CONFIG_FILENAME } from './config.mjs';
import { listDirectory, renderIndex } from './directory.mjs';
import { resolvePath } from './paths.mjs';
import { instrumentFile } from './instrument.mjs';

// This package's version, reported by GET /api/info so a client can tell which
// runner it attached to. Read once; an unreadable package.json is not fatal.
function packageVersion() {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return String(JSON.parse(readFileSync(pkg, 'utf8')).version ?? '0');
  } catch {
    return null;
  }
}

// Single-instance lock file, written into the served root at startup. A
// DOT-file on purpose: resolvePath() rejects dotfiles, so it is never
// servable over HTTP.
export const LOCK_FILENAME = '.redline.lock';

// Placeholder the Chrome extension will look for; replaced by real overlay
// injection in a later session.
export const INJECTION_PLACEHOLDER = '<!-- redline:overlay-injection-point -->';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

// Map a request URL to an absolute file path under root. Returns null for
// anything that escapes root or touches a dot segment/dotfile (".git",
// ".history", "..", encoded or not — decoding happens before the check).
// Moved to paths.mjs (#167) to break the store → server → api import cycle.
export { resolvePath } from './paths.mjs';

// Stamp the injection placeholder into an HTML payload: before the last
// </body> if present, else appended at EOF.
export function injectPlaceholder(html) {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + '\n' + INJECTION_PLACEHOLDER + '\n';
  return html.slice(0, idx) + INJECTION_PLACEHOLDER + '\n' + html.slice(idx);
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(obj));
}

async function handle(root, config, req, res, meta) {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  // JSON API (comments live in sidecars; api.mjs validates everything).
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    await handleApi(root, req, res, config, meta);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  let filePath = resolvePath(root, req.url);
  if (filePath === null) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  // Never serve the runner config — it can carry the OpenRouter API key,
  // which must not appear in any HTTP response.
  if (path.basename(filePath) === CONFIG_FILENAME) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  try {
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      // index.html wins where the author supplied one; otherwise the runner's
      // own directory index, so the served root is browsable instead of 404
      // (#129). The index page is the runner's UI, not a reviewed document —
      // it gets no injection placeholder.
      const indexFile = path.join(filePath, 'index.html');
      try {
        stat = await fs.stat(indexFile);
        filePath = indexFile;
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
        const rel = path.relative(root, filePath).split(path.sep).join('/');
        const listing = await listDirectory(root, rel);
        const page = renderIndex({ rootName: path.basename(root), listing });
        send(res, 200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' },
          req.method === 'HEAD' ? undefined : page);
        return;
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    if (ext === '.html') {
      // Auto-stamp on serve (Blake's decision, 2026-08-03): if the file has
      // unstamped blocks, stamp them on disk before serving. This eliminates
      // the separate `node runner/instrument.mjs` step. Idempotent — already
      // stamped files are a no-op. Errors are swallowed so a stamping failure
      // never blocks serving the document.
      try { await instrumentFile(filePath); } catch { /* serve anyway */ }
      const html = injectPlaceholder(await fs.readFile(filePath, 'utf8'));
      send(res, 200, { 'content-type': mime }, req.method === 'HEAD' ? undefined : html);
    } else {
      const body = await fs.readFile(filePath);
      send(res, 200, { 'content-type': mime, 'content-length': stat.size }, req.method === 'HEAD' ? undefined : body);
    }
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') {
      sendJson(res, 404, { error: 'not found' });
    } else {
      sendJson(res, 500, { error: 'internal error' });
    }
  }
}

// ---- single-instance lock ---------------------------------------------------
//
// Two runners doing read-modify-write cycles on the same sidecar clobber each
// other's records (each process's withLock is in-memory only), so startup
// refuses when a live runner already holds this root.
//
// LIMITATION, stated honestly: this only guards two runners on the SAME root.
// Overlapping roots — one runner serving the repo root, another serving a
// subdirectory of it — write the same sidecar files without ever seeing each
// other's lock. That cross-process case is why layer 2 exists: the sidecar
// rev check in store.mjs (save/update) makes the late writer re-read and
// re-apply instead of clobbering.

// Is `pid` a live process? EPERM means "alive but not ours" — still live.
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Create <root>/.redline.lock, refusing when a LIVE runner holds it and
// replacing it when the recorded pid is dead (stale lock from a crash — a
// crash can't run the cleanup hooks). Two processes racing past a stale lock
// at the same instant can both "win" here; that residual race is also caught
// by the store.mjs rev guard.
async function acquireLock(lockPath, payload) {
  try {
    await fs.writeFile(lockPath, payload, { flag: 'wx' });
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch {
    // Unreadable/corrupt lock → treat as stale.
  }
  if (existing !== null && typeof existing === 'object'
      && Number.isInteger(existing.pid) && pidAlive(existing.pid)) {
    throw new Error(
      `another runner is already serving this directory (pid ${existing.pid}, `
      + `port ${existing.port ?? 'unknown'}) — stop it first, or serve a different `
      + `directory (lock: ${lockPath})`);
  }
  await fs.writeFile(lockPath, payload); // dead pid → stale lock, take it over
}

// Start the runner server. Resolves once listening; port 0 = OS-assigned.
// Returns { server, port, close() }. `config` is optional — when omitted,
// redline.config.json is loaded from the served root (defaults on absence,
// throws on an invalid file).
export async function startServer({ root, port = 0, config }) {
  // Subscribe the SSE hub to sidecar saves (#162). Here rather than at
  // api.mjs's module top level: store → server → api → store is a cycle, and a
  // top-level call runs while store.mjs is still paused at its own import.
  initEventStream();
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error(`not a directory: ${root}`);
  const cfg = config ?? await loadConfig(root);

  const lockPath = path.join(root, LOCK_FILENAME);
  const startedAt = new Date().toISOString();
  const lockPayload = (boundPort) =>
    JSON.stringify({ pid: process.pid, port: boundPort, startedAt }, null, 2) + '\n';
  await acquireLock(lockPath, lockPayload(port));

  // Clean shutdown removes the lock: close(), SIGINT/SIGTERM, process exit.
  // Sync + idempotent (the 'exit' hook allows no async work), and close()
  // deregisters everything so a later server in the same process — tests —
  // never has ITS lock unlinked by a stale hook of ours.
  let lockReleased = false;
  function releaseLockSync() {
    if (lockReleased) return;
    lockReleased = true;
    process.removeListener('exit', releaseLockSync);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone — nothing to release.
    }
  }
  function onSignal(signal) {
    releaseLockSync();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
  process.on('exit', releaseLockSync);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Runner identity for GET /api/info (discovery): the port is only known
  // after listen, so the object is filled in below and read per request.
  const meta = { port: null, startedAt, version: packageVersion() };

  const server = http.createServer((req, res) => {
    handle(root, cfg, req, res, meta).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    meta.port = server.address().port;
    // Now the real port is known (port 0 = OS-assigned) — restamp the lock.
    await fs.writeFile(lockPath, lockPayload(server.address().port));
  } catch (err) {
    releaseLockSync();
    throw err;
  }

  return {
    server,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      // SSE streams are open sockets and server.close() waits for every one of
      // them, so a runner with a single watching tab would never exit — and a
      // test would hang rather than fail. End them first (#162).
      closeEventStreams();
      server.close(() => {
        releaseLockSync();
        resolve();
      });
    }),
  };
}
