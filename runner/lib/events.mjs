// runner/lib/events.mjs — server-sent events for sidecar changes (#162).
//
// Cross-tab sync began as a 4 s poll of /api/status comparing the sidecar's
// `rev` (#106). Correct, but slow by construction, and every version skew it
// met presented as SILENCE — a runner predating the `rev` field made the
// comparison read "unchanged" forever, so the feature just stopped working with
// no error anywhere. A stream that connects and announces itself fails loudly.
//
// WHAT IS PUSHED, AND WHY IT MATTERS. Only `{page, rev}` — never content.
//
//   - It is STATE, not a delta, so dropped messages are self-healing: a missed
//     event is harmless because the next one carries the current rev, and a
//     reconnect triggers a refetch. A delta/op-log stream would need sequence
//     numbers, gap detection and replay buffers.
//   - It carries nothing permission-sensitive. Clients refetch through the
//     normal endpoints, which already enforce whatever auth exists, so stream
//     authorization stays a single "may this user see this page?" check at
//     connect time and cannot drift out of sync with endpoint permissions.
//
// That second property is what lets this survive to multi-user unchanged.
//
// Deliberately NOT here (deferred to the multi-user phase, see #162): per-user
// authorization on connect, a shared bus so more than one runner process can
// fan out (this hub is in-memory and reaches only its own process), and
// presence/cursors — which need client→server push that SSE does not provide.

// Intermediaries close idle connections; a comment line keeps them open and
// costs 8 bytes. Well under the common 30–60 s proxy idle timeout.
const HEARTBEAT_MS = 20000;

// SSE frames: `data:` lines terminated by a blank line. A leading comment
// (`: …`) is ignored by EventSource and is the idiomatic keep-alive.
function frame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createEventHub({ heartbeatMs = HEARTBEAT_MS } = {}) {
  // htmlPath -> Set<res>. Keyed by the RESOLVED path, the same key the lease
  // ledger and the sidecar store use, so a page cannot be subscribed under two
  // spellings and miss its own events.
  const channels = new Map();
  let heartbeat = null;

  function startHeartbeat() {
    if (heartbeat !== null) return;
    heartbeat = setInterval(() => {
      for (const clients of channels.values()) {
        for (const res of clients) { try { res.write(': ping\n\n'); } catch { /* dropped below */ } }
      }
    }, heartbeatMs);
    // Never hold the process open for a heartbeat — a runner with an idle
    // stream open must still exit on SIGTERM.
    heartbeat.unref?.();
  }

  function stopHeartbeatIfIdle() {
    if (heartbeat !== null && channels.size === 0) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  /** Attach an SSE stream for one page. Returns an unsubscribe function; the
   *  caller wires it to the request's close event. */
  function subscribe(htmlPath, res, { rev = null } = {}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx buffers proxied responses by default, which would hold every
      // event until the buffer filled — i.e. forever, for 40-byte messages.
      'x-accel-buffering': 'no',
    });

    let clients = channels.get(htmlPath);
    if (clients === undefined) {
      clients = new Set();
      channels.set(htmlPath, clients);
    }
    clients.add(res);
    startHeartbeat();

    let done = false;
    const unsubscribe = () => {
      if (done) return;
      done = true;
      const set = channels.get(htmlPath);
      if (set !== undefined) {
        set.delete(res);
        if (set.size === 0) channels.delete(htmlPath);
      }
      stopHeartbeatIfIdle();
      try { res.end(); } catch { /* already gone */ }
    };

    // Announce with the CURRENT rev. This is what makes version skew loud
    // rather than silent: a client knows at once that the stream works and
    // where it stands, instead of inferring both from an absence of messages.
    //
    // Guarded, and AFTER unsubscribe exists: a client can die between the
    // connect and this write, and an exception here would escape into the
    // request handler for what is only a client that left early.
    try {
      res.write(frame('hello', { rev }));
    } catch {
      unsubscribe();
    }
    return unsubscribe;
  }

  /** Fan a sidecar revision out to everyone watching that page. Never throws:
   *  a broken client must not take down the save that triggered it. */
  function publish(htmlPath, rev) {
    const clients = channels.get(htmlPath);
    if (clients === undefined || clients.size === 0) return 0;
    const text = frame('rev', { rev });
    let delivered = 0;
    for (const res of [...clients]) {
      try {
        res.write(text);
        delivered += 1;
      } catch {
        // Half-dead socket: drop it here rather than waiting for a close event
        // that may never arrive.
        clients.delete(res);
      }
    }
    if (clients.size === 0) channels.delete(htmlPath);
    stopHeartbeatIfIdle();
    return delivered;
  }

  /** End every stream. Server shutdown MUST call this — an open SSE response
   *  is an open socket, and http.Server.close() waits for those, so without it
   *  a runner with a watching tab never exits (and a test never finishes). */
  function closeAll() {
    for (const clients of channels.values()) {
      for (const res of [...clients]) { try { res.end(); } catch { /* already gone */ } }
    }
    channels.clear();
    stopHeartbeatIfIdle();
  }

  return {
    subscribe,
    publish,
    closeAll,
    /** Watchers on a page — for tests and for /api/info diagnostics. */
    countFor: (htmlPath) => (channels.get(htmlPath)?.size ?? 0),
    get size() { return [...channels.values()].reduce((n, s) => n + s.size, 0); },
  };
}
