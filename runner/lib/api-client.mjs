// runner/lib/api-client.mjs — the one HTTP client for the runner's API.
//
// The MCP server (runner/mcp-server.mjs) and the CLI (runner/lib/cli.mjs) both
// go through here, so a behavior difference between the two agent surfaces has
// to be deliberate rather than accidental. The contract it speaks is
// docs/AGENT-CONTRACT.md.
//
// Every method resolves the parsed body on 2xx and throws ApiError (carrying
// .status and .body) otherwise — the runner's error JSON is already safe to
// surface verbatim (fixed messages, no secrets, no upstream bodies).
//
// connectToPage() is the entry point an agent uses: give it a file path or a
// page name, it finds or starts the runner (lib/auto-runner.mjs), works out
// the root-relative page id, and hands back a bound client plus the stop()
// that ends the session.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureRunner } from './auto-runner.mjs';
import { pageForFile } from './discovery.mjs';

export class ApiError extends Error {
  constructor(status, body, route) {
    super(body?.error ? `${route}: ${body.error} (HTTP ${status})` : `${route}: HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body ?? null;
    this.route = route;
  }
}

export function createClient(base) {
  const request = async (method, route, { payload, timeoutMs } = {}) => {
    const init = { method };
    if (payload !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(payload);
    }
    // No timeout by default: /api/run is synchronous and takes as long as the
    // model does. Callers that want a bound wait pass one.
    if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetch(base + route, init);
    } catch (err) {
      throw new Error(`${route}: could not reach the runner at ${base} (${err.message})`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body — status still decides
    }
    if (!res.ok) throw new ApiError(res.status, body, route);
    return body;
  };

  const q = (page) => `?page=${encodeURIComponent(page)}`;

  return {
    base,
    request,
    info: () => request('GET', '/api/info'),
    source: (page) => request('GET', `/api/source${q(page)}`),
    // #235: a watcher passes its sessionId so its read advances the seenRev
    // receipt. The author's overlay never has one, so its poll never stamps.
    comments: (page, { sessionId } = {}) =>
      request('GET', `/api/comments${q(page)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`),
    status: (page) => request('GET', `/api/status${q(page)}`),
    trace: (runId, mode) => request('GET', `/api/trace?runId=${encodeURIComponent(runId)}${mode ? `&mode=${mode}` : ''}`),
    addComment: (payload) => request('POST', '/api/comment', { payload }),
    reply: (commentId, payload) =>
      request('POST', `/api/comment/${encodeURIComponent(commentId)}/reply`, { payload }),
    setStatus: (commentId, payload) =>
      request('POST', `/api/comment/${encodeURIComponent(commentId)}/status`, { payload }),
    setAiEdits: (commentId, payload) =>
      request('POST', `/api/comment/${encodeURIComponent(commentId)}/ai-edits`, { payload }),
    run: (payload) => request('POST', '/api/run', { payload }),
    // Presence (#187). The watcher subprocess owns the heartbeat, not an agent
    // turn — a conversational session does not act on a timer, so beating from
    // a turn would go silent while the session was alive.
    claimSession: (payload) => request('POST', '/api/session/claim', { payload }),
    heartbeatSession: (sessionId) => request('POST', '/api/session/heartbeat', { payload: { sessionId } }),
    releaseSession: (sessionId) => request('POST', '/api/session/release', { payload: { sessionId } }),
    // Held block leases (#188). Lease late and release early (decision 9):
    // hold a block for the instant of writing, never while thinking — under
    // first-holder-wins a lease held through a long delegate call locks the
    // author out of their own paragraph.
    acquireLease: (payload) => request('POST', '/api/lease', { payload }),
    renewLease: (payload) => request('POST', '/api/lease/renew', { payload }),
    releaseLease: (leaseId, { sessionId = null, force = false } = {}) => request(
      'DELETE',
      `/api/lease/${encodeURIComponent(leaseId)}?${force ? 'force=1' : `sessionId=${encodeURIComponent(sessionId ?? '')}`}`,
    ),
    proposeEdits: (payload) => request('POST', '/api/propose-edits', { payload }),
    // One block's inner, no model call (#186). /api/edit has done this since
    // WP10 and was reachable over HTTP only, so the phase's headline case — a
    // local session edits your document for free — meant hand-rolling HTTP
    // around the very client that exists to stop that.
    edit: (payload) => request('POST', '/api/edit', { payload }),
    // Answer a scope-gate pause (#195). Without this an agent could TRIP the
    // gate and then had no way to resolve it — its own write sat waiting on a
    // human who could only see it in the overlay.
    confirmRun: (payload) => request('POST', '/api/run/confirm', { payload }),
    undo: (payload) => request('POST', '/api/undo', { payload }),
    instrument: (payload) => request('POST', '/api/instrument', { payload }),
  };
}

/** Does `p` exist as a regular file? */
async function isFile(p) {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an agent's document argument into {dir, absFile|null, page|null}.
 *
 *   - a path that exists on disk ("docs/plan.html", "/abs/plan.html") → the
 *     runner is looked for from that file's directory upward, and the page id
 *     is computed from the root the runner reports;
 *   - anything else is taken as a page id already relative to a served root,
 *     and `dir` (default cwd) says which root that is.
 */
export async function resolveTarget(target, { dir = process.cwd() } = {}) {
  if (typeof target !== 'string' || target.trim().length === 0) {
    throw new Error('a page path or .html file is required');
  }
  const abs = path.resolve(dir, target);
  if (await isFile(abs)) {
    return { dir: path.dirname(abs), absFile: abs, page: null };
  }
  return { dir: path.resolve(dir), absFile: null, page: target.replace(/^\/+/, '') };
}

/**
 * Find or start the runner for `target` and bind a client to it.
 * Returns {client, base, page, root, spawned, stop}.
 *
 * `sessions` (optional Map) caches one connection per resolved directory, so a
 * long-lived caller — the MCP server, whose every tool call lands here — keeps
 * ONE auto-started runner for the whole session instead of spawning and
 * killing one per call. Cached connections are closed by closeSessions().
 */
export async function connectToPage(target, {
  dir, autoStart = true, base = null, env = process.env, sessions = null,
} = {}) {
  const resolved = await resolveTarget(target, dir ? { dir } : {});

  let connection;
  if (base) {
    // An explicit base URL skips discovery entirely (tests, and an agent told
    // exactly which runner to talk to). Nothing to stop afterwards.
    const client = createClient(base);
    const info = await client.info();
    connection = { base, port: info.port, root: info.root, spawned: false, stop: async () => {} };
  } else if (sessions) {
    // Store the PROMISE so two concurrent tool calls on one directory can't
    // both start a runner.
    let pending = sessions.get(resolved.dir);
    if (pending === undefined) {
      pending = ensureRunner({ dir: resolved.dir, autoStart, env });
      sessions.set(resolved.dir, pending);
    }
    try {
      connection = { ...(await pending), stop: async () => {} }; // closeSessions owns the real stop
    } catch (err) {
      sessions.delete(resolved.dir);
      throw err;
    }
  } else {
    connection = await ensureRunner({ dir: resolved.dir, autoStart, env });
  }

  let page = resolved.page;
  if (page === null) {
    page = await pageForFile(connection.root, resolved.absFile);
    if (page === null) {
      await connection.stop();
      throw new Error(
        `${resolved.absFile} is not inside the directory this runner serves (${connection.root})`);
    }
  }

  return {
    client: createClient(connection.base),
    base: connection.base,
    page,
    root: connection.root,
    spawned: connection.spawned,
    stop: connection.stop,
  };
}

/** Stop every runner a `sessions` map auto-started, and empty the map. Runners
 *  that were merely attached to are left running. Never throws. */
export async function closeSessions(sessions) {
  if (!sessions) return;
  const pending = [...sessions.values()];
  sessions.clear();
  await Promise.all(pending.map(async (p) => {
    try {
      await (await p).stop();
    } catch {
      // a connection that never came up has nothing to stop
    }
  }));
}
