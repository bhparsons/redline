// test/runner/lease-admission-e2e.test.mjs — #38 through a real runner.
//
// The unit tests in leases.test.mjs pin the ledger's rules; these pin that the
// HTTP surface actually obeys them. The behaviour that matters is negative
// space: things that used to 409 and now go through.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.REDLINE_OTEL_ENDPOINT;

const DOC = [
  '<!doctype html><html><head><title>t</title></head><body>',
  '<section data-rev="r-secA"><h2 data-rev="r-a1">Section A</h2><p data-rev="r-a2">alpha body</p></section>',
  '<section data-rev="r-secB"><p data-rev="r-b1">beta body</p><p data-rev="r-b2">gamma body</p></section>',
  '</body></html>',
].join('\n');

// An agent stub that can be held open, so a run can be parked mid-flight while
// another request is made against the same page.
function startAgentStub() {
  const state = { result: null, gate: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      if (state.gate) await state.gate;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(state.result) } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    state,
    url: `http://127.0.0.1:${server.address().port}/chat/completions`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

const post = (url, payload) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

test('#38: leases admit disjoint work and refuse only real overlap', async (t) => {
  const stub = await startAgentStub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-lease-'));
  await fs.writeFile(path.join(root, 'doc.html'), DOC);
  await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'k', endpoint: stub.url, timeoutMs: 5000 },
    telemetry: { endpoint: null },
  }, null, 2));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await stub.close(); await fs.rm(root, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  const status = async () => (await fetch(`${base}/api/status?page=doc.html`)).json();
  const comment = async (body, anchor) => (await (await post(`${base}/api/comment`, { page: 'doc.html', body, anchor })).json()).id;
  const runOn = (commentId) => post(`${base}/api/run`, { page: 'doc.html', commentId });
  const edit = (blockId, newInner) => post(`${base}/api/edit`, { page: 'doc.html', blockId, newInner });

  await t.test('a direct edit on an UNLEASED block proceeds while a run is gated', async () => {
    // Park a run on the scope gate: anchored in A, edits B → out of section.
    const cid = await comment('Fix this', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.result = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'x' }],
      edits: [{ blockId: 'r-b1', newInner: 'beta reworded' }],
    };
    const pending = await (await runOn(cid)).json();
    assert.equal(pending.pendingConfirmation, true, 'precondition: gated');

    // r-b2 is untouched by that run. Before #38 this 409'd on the page lock.
    const ok = await edit('r-b2', 'gamma edited freely');
    assert.equal(ok.status, 200,
      'editing an unleased block no longer waits on an unrelated pending ask');
    assert.match(await fs.readFile(path.join(root, 'doc.html'), 'utf8'), /gamma edited freely/);

    // …but the block the pending run actually holds is still protected.
    const blocked = await edit('r-b1', 'should not land');
    assert.equal(blocked.status, 409);
    const body = await blocked.json();
    assert.equal(body.reason, 'awaiting-confirmation');
    assert.equal(body.runId, pending.runId);
    assert.doesNotMatch(await fs.readFile(path.join(root, 'doc.html'), 'utf8'), /should not land/);

    // Clean up the lease for the next subtest.
    await post(`${base}/api/run/confirm`, { page: 'doc.html', runId: pending.runId, allow: false });
  });

  await t.test('status reports which blocks are held and by which run', async () => {
    const cid = await comment('Gate me', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.result = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'x' }],
      edits: [{ blockId: 'r-b1', newInner: 'beta again' }],
    };
    const pending = await (await runOn(cid)).json();

    const s = await status();
    assert.equal(s.leases['r-b1'], pending.runId, 'the reach it widened to');
    assert.equal(s.leases['r-a2'], pending.runId, 'and the anchor it opened on');
    assert.equal(s.leases['r-b2'], undefined, 'nothing else is held');

    const run = s.runs.find((r) => r.runId === pending.runId);
    assert.equal(run.state, 'awaiting-confirmation');
    assert.equal(s.running, false, 'a gated run is not "running" — the #106 trap holds');

    await post(`${base}/api/run/confirm`, { page: 'doc.html', runId: pending.runId, allow: false });
  });

  await t.test('a resolved confirmation releases every lease it held', async () => {
    const s = await status();
    assert.deepEqual(s.leases, {});
    assert.deepEqual(s.runs, []);
    assert.equal(s.pendingConfirmation, undefined);
    assert.equal((await edit('r-b1', 'now editable')).status, 200);
  });

  await t.test('two gated runs can coexist on disjoint blocks', async () => {
    const c1 = await comment('One', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.result = {
      decisions: [{ id: c1, decision: 'addressed', summary: 'x' }],
      edits: [{ blockId: 'r-b1', newInner: 'b1 v2' }],
    };
    const p1 = await (await runOn(c1)).json();
    assert.equal(p1.pendingConfirmation, true);

    // A second comment anchored in B reaching A — disjoint from p1's {r-a2, r-b1}?
    // No: it would touch r-a1, which nothing holds. So it should be admitted.
    const c2 = await comment('Two', { blockId: 'r-b2', quote: 'gamma body' });
    stub.state.result = {
      decisions: [{ id: c2, decision: 'addressed', summary: 'x' }],
      edits: [{ blockId: 'r-a1', newInner: 'Heading v2' }],
    };
    const p2 = await (await runOn(c2)).json();
    assert.equal(p2.pendingConfirmation, true,
      'a second run reached the gate instead of 409ing on the first');
    assert.notEqual(p2.runId, p1.runId);

    const s = await status();
    assert.equal(s.runs.length, 2, 'both are on the ledger at once');
    assert.equal(s.pendingConfirmation.runId, p1.runId, 'the first is named for back-compat');

    // Each confirm targets its OWN run, by id.
    assert.equal((await post(`${base}/api/run/confirm`, { page: 'doc.html', runId: p2.runId, allow: false })).status, 200);
    assert.equal((await status()).runs.length, 1, 'declining one leaves the other holding');
    assert.equal((await post(`${base}/api/run/confirm`, { page: 'doc.html', runId: p1.runId, allow: false })).status, 200);
    assert.deepEqual((await status()).leases, {});
  });

  await t.test('confirming a runId that is not pending is a 404, not a misapply', async () => {
    const r = await post(`${base}/api/run/confirm`, { page: 'doc.html', runId: 'run-deadbeef', allow: true });
    assert.equal(r.status, 404);
  });
});
