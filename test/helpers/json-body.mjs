// test/helpers/json-body.mjs — crash-proof request-body collection for test
// stubs (#242).
//
// Every flaky-suite crash in this family had the same shape: a test's stub
// HTTP server did `JSON.parse(body)` inside its 'end' handler (or had no
// 'error' listener at all), so one anomalous request — a socket torn down by
// teardown's closeAllConnections(), a client abort under a starved event
// loop — threw an uncaught exception that node:test pinned on whichever test
// happened to be running, killed in-process servers, and cascaded into
// ECONNREFUSED noise in later subtests.
//
// A stub must never take the process down on a request it didn't expect.
// This helper resolves the parsed body on success and null otherwise, after
// LOGGING what actually arrived — so if the anomalous request ever reflects a
// real runner bug, the evidence is in the test output instead of a crash
// pointing at an innocent test.

/**
 * Collect and parse a JSON request body. Resolves the parsed value, or null
 * if the stream errored or the body was not valid JSON — in which case the
 * request is answered 400 (best-effort) and a diagnostic line is printed.
 * Callers should `return` on null; the response has been dealt with.
 */
export function collectJson(req, res, label = 'stub') {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('error', (err) => {
      console.error(`[${label}] request stream error: ${err?.code ?? err?.message ?? err}`);
      resolve(null);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        console.error(`[${label}] unparseable ${req.method} ${req.url} body `
          + `(${body.length} chars): ${JSON.stringify(body.slice(0, 200))}`);
        try {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"unparseable body"}');
        } catch { /* socket already gone — nothing to answer */ }
        resolve(null);
      }
    });
  });
}
