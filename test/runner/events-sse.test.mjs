// test/runner/events-sse.test.mjs — SSE change notification (#162).
//
// The hub's rules are unit-tested without sockets; the endpoint is then tested
// through a real server, because the parts most likely to break are the ones
// only a live connection exercises: that a save reaches a subscriber, that
// disconnects do not leak, and that an open stream does not stop the server
// from shutting down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventHub } from '../../runner/lib/events.mjs';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.REDLINE_OTEL_ENDPOINT;

// A minimal ServerResponse stand-in: records what was written.
function fakeRes() {
  return {
    chunks: [], headers: null, ended: false,
    writeHead(code, h) { this.code = code; this.headers = h; },
    write(s) { if (this.ended) throw new Error('write after end'); this.chunks.push(s); return true; },
    end() { this.ended = true; },
    get text() { return this.chunks.join(''); },
  };
}

test('event hub', async (t) => {
  await t.test('a subscriber gets SSE headers and an opening rev', () => {
    const hub = createEventHub();
    const res = fakeRes();
    hub.subscribe('/doc.html', res, { rev: 7 });
    assert.equal(res.code, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
    assert.equal(res.headers['x-accel-buffering'], 'no',
      'nginx would otherwise buffer 40-byte events indefinitely');
    assert.match(res.text, /^event: hello\ndata: \{"rev":7\}\n\n$/,
      'a client knows the stream works and where it stands immediately');
  });

  await t.test('publish reaches every subscriber on that page and no other', () => {
    const hub = createEventHub();
    const a1 = fakeRes(); const a2 = fakeRes(); const b1 = fakeRes();
    hub.subscribe('/a.html', a1); hub.subscribe('/a.html', a2); hub.subscribe('/b.html', b1);
    assert.equal(hub.publish('/a.html', 3), 2);
    assert.match(a1.text, /event: rev\ndata: \{"rev":3\}/);
    assert.match(a2.text, /event: rev\ndata: \{"rev":3\}/);
    assert.doesNotMatch(b1.text, /event: rev/, 'pages are isolated');
  });

  await t.test('publishing to a page nobody watches is a no-op, not an error', () => {
    assert.equal(createEventHub().publish('/nobody.html', 1), 0);
  });

  await t.test('unsubscribing stops delivery and frees the channel', () => {
    const hub = createEventHub();
    const res = fakeRes();
    const off = hub.subscribe('/a.html', res);
    off();
    assert.equal(hub.publish('/a.html', 2), 0);
    assert.equal(hub.size, 0, 'no leak: the empty channel is dropped');
    assert.equal(res.ended, true);
    off(); // idempotent — close fires more than once in practice
    assert.equal(hub.size, 0);
  });

  await t.test('a broken client is dropped rather than breaking the publish', () => {
    const hub = createEventHub();
    const good = fakeRes();
    const broken = fakeRes();
    hub.subscribe('/a.html', good);
    hub.subscribe('/a.html', broken);
    // Break it only AFTER it is subscribed, so this exercises publish() rather
    // than the opening write.
    broken.write = () => { throw new Error('EPIPE'); };
    assert.equal(hub.publish('/a.html', 5), 1, 'the healthy client still got it');
    assert.equal(hub.countFor('/a.html'), 1, 'the dead one was reaped');
  });

  await t.test('closeAll ends every stream', () => {
    const hub = createEventHub();
    const a = fakeRes(); const b = fakeRes();
    hub.subscribe('/a.html', a); hub.subscribe('/b.html', b);
    hub.closeAll();
    assert.equal(a.ended, true);
    assert.equal(b.ended, true);
    assert.equal(hub.size, 0);
  });
});

// ---- through a real server --------------------------------------------------

const DOC = '<!doctype html><html><body><p data-rev="r-0001">alpha</p></body></html>';

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-sse-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ telemetry: { endpoint: null } }, null, 2));
  return dir;
}

// Read SSE frames until `want` matches or the deadline passes.
async function readUntil(body, want, ms = 4000) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (want.test(buf)) return buf;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return buf;
}

test('GET /api/events streams sidecar revisions', async (t) => {
  const root = await makeRoot();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;

  await t.test('missing or unknown page is refused before the stream opens', async () => {
    assert.equal((await fetch(`${base}/api/events`)).status, 400);
    assert.equal((await fetch(`${base}/api/events?page=nope.html`)).status, 404);
  });

  await t.test('a save reaches a connected subscriber', async () => {
    const ac = new AbortController();
    const stream = await fetch(`${base}/api/events?page=doc.html`, { signal: ac.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);

    // Opening frame first, so the client knows the stream is live.
    const collected = readUntil(stream.body, /event: rev/);
    await new Promise((r) => setTimeout(r, 50)); // let the subscription land
    await fetch(`${base}/api/comment`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 'doc.html', body: 'hello', anchor: { blockId: 'r-0001', quote: 'alpha' } }),
    });

    const text = await collected;
    assert.match(text, /event: hello\ndata: \{"rev":0\}/, 'opens with the current rev');
    assert.match(text, /event: rev\ndata: \{"rev":1\}/, 'and pushes the save');
    ac.abort();
  });

  await t.test('a disconnected client is cleaned up', async () => {
    const ac = new AbortController();
    const stream = await fetch(`${base}/api/events?page=doc.html`, { signal: ac.signal });
    await readUntil(stream.body, /event: hello/);
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
    // A save with nobody listening must not throw — the proof is that the
    // request below succeeds and the server is still healthy afterwards.
    const res = await fetch(`${base}/api/comment`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 'doc.html', body: 'after disconnect', anchor: { blockId: 'r-0001', quote: 'alpha' } }),
    });
    assert.equal(res.status, 201, 'the save succeeded with nobody listening');
    assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
  });
});

// The failure this guards is a HANG, not an assertion: server.close() waits on
// open sockets, so a live SSE stream would keep the runner alive forever.
test('an open stream does not stop the server from closing', async () => {
  const root = await makeRoot();
  const { port, close } = await startServer({ root, port: 0 });
  const ac = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${port}/api/events?page=doc.html`, { signal: ac.signal });
  await readUntil(stream.body, /event: hello/);

  await Promise.race([
    close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('server.close() hung on an open SSE stream')), 5000)),
  ]);
  ac.abort();
  await fs.rm(root, { recursive: true, force: true });
});
