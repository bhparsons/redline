// test/runner/concurrent-rollback.test.mjs — #288, the highest-severity finding
// of the trust-layer review.
//
// Leases are BLOCK-scoped so disjoint writers run in parallel — that is the
// design, and it works. But every snapshot and restore was the WHOLE FILE. So a
// run that failed did not undo itself; it rewound the document, taking with it
// every run that had landed since its snapshot was taken. The victim's edit was
// gone, the victim's run record still said `ok`, and nothing logged anything.
//
// These tests are written from the victim's side: A succeeds, B misbehaves, and
// A's work must still be there afterwards.
//
// THE WINDOW HAS TO BE REAL. A first version of this file exercised
// propose-edits and direct-edit, and passed with the fix REVERTED — because
// those paths snapshot microseconds before they restore, so there is no gap for
// anyone to write into. The dangerous paths are the ones where the snapshot and
// the restore are separated by something slow: a model call, or a human reading
// a confirmation card. That means a stubbed agent, which is what this fixture
// exists for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<section data-rev="r-sec1">\n'
  + '<p data-rev="r-alpha">alpha original</p>\n'
  + '<p data-rev="r-beta">beta original</p>\n'
  + '</section>\n'
  + '<section data-rev="r-sec2">\n'
  + '<p data-rev="r-gamma">gamma original</p>\n'
  + '</section>\n</body></html>\n';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-rollback-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ telemetry: { endpoint: null } }));
  const server = await startServer({ root: dir, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => { await server.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return {
    base, dir,
    post: (route, payload) => fetch(base + route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })),
    source: () => fs.readFile(path.join(dir, 'doc.html'), 'utf8'),
  };
}

/** An agent that hangs until released, so a run can be caught mid-flight. */
function slowStub() {
  let release;
  const held = new Promise((r) => { release = r; });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      await held;
      res.writeHead(200, { 'content-type': 'application/json' });
      // Names a block that does not exist, so applyEdits refuses and the run
      // fails AFTER the snapshot was taken and the window has been open.
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({
          decisions: [{ id: 'REPLACE_ME', decision: 'addressed', summary: 'x' }],
          edits: [{ blockId: 'r-does-not-exist', newInner: 'never lands' }],
        }) } }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/chat/completions`,
      release: () => release(),
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

test('a run that fails mid-flight does not rewind an edit made while it ran', async (t) => {
  // THE DEFECT, exactly (#288): the snapshot is taken when the run starts, the
  // restore happens when it fails, and the model call sits in between. Anything
  // that lands in that gap used to be erased by a rollback that had nothing to
  // do with it — and the victim's run record still said `ok`.
  const stub = await slowStub();
  t.after(() => stub.close());

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-window-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    telemetry: { endpoint: null },
    agent: { apiKey: 'stub-key', endpoint: stub.url, timeoutMs: 10_000 },
  }));
  const server = await startServer({ root: dir, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => { await server.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const post = (route, payload) => fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const source = () => fs.readFile(path.join(dir, 'doc.html'), 'utf8');

  const c = await post('/api/comment', {
    page: 'doc.html', body: 'rewrite gamma', anchor: { quote: 'gamma original', blockId: 'r-gamma' },
  });

  // Writer B starts a run and hangs inside the model call.
  const running = post('/api/run', { page: 'doc.html', commentId: c.body.id });
  await new Promise((r) => setTimeout(r, 300));

  // Writer A lands a real edit on a DIFFERENT block, inside B's window.
  const a = await post('/api/edit', {
    page: 'doc.html', blockId: 'r-alpha', newInner: 'alpha LANDED DURING THE RUN', creator: 'human',
  });
  assert.equal(a.status, 200, "A's edit is admitted — different block, no lease conflict");
  assert.match(await source(), /alpha LANDED DURING THE RUN/);

  // B's model finally answers with an edit that cannot apply, so B fails.
  stub.release();
  const failed = await running;
  assert.notEqual(failed.status, 200, 'the run failed');

  const after = await source();
  assert.match(after, /alpha LANDED DURING THE RUN/,
    "B's rollback must undo B, not rewind the document past A");
  assert.match(after, /gamma original/, "and B's own edit really did not land");
});

test('a failed run reverts its OWN blocks, leaving a concurrent edit standing', async (t) => {
  const f = await fixture(t);

  // A batch where the first edit is fine and the second is impossible: the run
  // fails as a unit, so its own first edit must come back out.
  const before = await f.source();
  const bad = await f.post('/api/propose-edits', {
    page: 'doc.html',
    edits: [
      { blockId: 'r-alpha', newInner: 'alpha touched by the doomed run' },
      { blockId: 'r-missing', newInner: 'this block does not exist' },
    ],
    dryRun: false,
    creator: 'agent', agentName: 'doomed',
  });
  assert.notEqual(bad.status, 200);

  const after = await f.source();
  assert.equal(after, before, 'an all-or-nothing failure leaves the document exactly as it was');
});

test('the run record and the document agree after a neighbour fails', async (t) => {
  const f = await fixture(t);

  await f.post('/api/edit', { page: 'doc.html', blockId: 'r-alpha', newInner: 'alpha by A', creator: 'human' });
  await f.post('/api/propose-edits', {
    page: 'doc.html', edits: [{ blockId: 'r-gone', newInner: 'x' }], dryRun: false, creator: 'agent', agentName: 'b',
  });

  const { comments: _c, runs } = await fetch(`${f.base}/api/comments?page=doc.html`).then((r) => r.json());
  const ok = runs.filter((r) => r.status === 'ok');
  assert.ok(ok.length >= 1, 'A recorded an ok run');
  // The defect was a record that said ok while the edit had been rewound. Both
  // halves must tell the same story.
  assert.match(await f.source(), /alpha by A/, 'the document matches what the ok run claims');
});
