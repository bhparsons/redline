// test/runner/overlay-stream-url.test.mjs — the SSE stream was never opened.
//
// `runner` is {origin, servedByRunner}. The stream was built as
// `runner + '/api/events?…'` — an OBJECT plus a string — which stringifies to
// "[object Object]/api/events?…". The browser resolved that against the
// document base, got a 404, fired onerror, and the overlay marked the stream
// dead and fell back to its 4 s poll. Silently, and correctly, every time.
//
// So #162's live push has never once worked outside the test suite. It shipped
// in bc66281 and was found on 2026-08-02, by reading the line rather than by
// anything failing.
//
// It survived because the boot harness's EventSource stub SWALLOWED its
// argument. Every liveness test passed with a URL no server could serve. The
// stub now records what it was handed, which is the only reason this file can
// exist — a stub that cannot fail is not a test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_overlay-boot.mjs';

test('the SSE stream is opened against the runner origin, not a stringified object', async () => {
  const b = boot({ comments: [] });
  await b.settle();

  assert.ok(b.eventSourceUrls.length > 0, 'the overlay must open a stream at boot');
  const url = b.eventSourceUrls[0];

  // The failure verbatim. Asserted as its own line so a regression names
  // itself instead of arriving as a confusing URL mismatch.
  assert.ok(
    !url.includes('[object Object]'),
    `the stream URL stringified an object: ${url}`,
  );

  // An absolute URL against the runner, not a path resolved against whatever
  // page happens to be open — the overlay runs on a document the runner serves
  // AND on one it does not, and only one of those makes a bare path correct.
  assert.match(url, /^https?:\/\/[^/]+\/api\/events\?page=/, `not an absolute runner URL: ${url}`);
  assert.match(url, /page=/, 'the stream must name the page it is watching');
});

test('every URL the overlay ever hands EventSource is absolute', async () => {
  const b = boot({ comments: [] });
  await b.settle();
  // Re-arm the stream the way a reconnect does, so this covers the paths that
  // reopen it as well as the one that opens it at boot.
  await b.tick();
  await b.settle();

  assert.ok(b.eventSourceUrls.length > 0);
  for (const url of b.eventSourceUrls) {
    assert.match(url, /^https?:\/\//, `relative or malformed stream URL: ${url}`);
  }
});
