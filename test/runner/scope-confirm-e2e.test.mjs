// test/runner/scope-confirm-e2e.test.mjs — WP7: the confirmation flow.
//
// End to end through a real runner + stub agent: a single-comment run whose
// edits reach outside the anchored section (or touch the theme) pauses with a
// pendingConfirmation instead of committing; POST /api/run/confirm applies the
// stashed result verbatim (allow) or discards it (decline). An agent waiver
// skips the pause. While a run is pending the page is locked.

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
  '<section data-rev="r-secB"><p data-rev="r-b1">beta body</p></section>',
  '</body></html>',
].join('\n');

function startAgentStub() {
  const state = { result: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
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

async function makeRoot(agentUrl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-scope-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'k', endpoint: agentUrl, timeoutMs: 5000 },
    telemetry: { endpoint: null },
  }, null, 2));
  return dir;
}

const post = (url, payload) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

test('scope guardrail: pending → confirm/decline, waiver, and page lock', async (t) => {
  const stub = await startAgentStub();
  const root = await makeRoot(stub.url);
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await stub.close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const readDoc = () => fs.readFile(docPath, 'utf8');

  const comment = async (body, anchor) => {
    const res = await post(`${base}/api/comment`, { page: 'doc.html', body, anchor });
    return (await res.json()).id;
  };
  const runOn = (commentId) => post(`${base}/api/run`, { page: 'doc.html', commentId });
  const confirm = (runId, allow) => post(`${base}/api/run/confirm`, { page: 'doc.html', runId, allow });

  // An edit anchored in section A but targeting section B is out-of-section.
  const outOfSectionResult = (cid) => ({
    decisions: [{ id: cid, decision: 'addressed', summary: 'Reworded the other section.' }],
    edits: [{ blockId: 'r-b1', newInner: 'beta body reworded' }],
  });

  await t.test('an out-of-section edit pauses for confirmation, nothing written', async () => {
    const cid = await comment('Fix this', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.result = outOfSectionResult(cid);
    const res = await runOn(cid);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pendingConfirmation, true);
    assert.equal(body.scope.touchedThemeZone, false);
    assert.deepEqual([...body.scope.touchedBlocks], ['r-b1']);
    assert.match(await readDoc(), /beta body<\/p>/, 'doc is unchanged while pending');

    // A second run on the locked page is refused.
    const blocked = await runOn(cid);
    assert.equal(blocked.status, 409);

    // Decline: doc stays unchanged, lock released.
    const declined = await confirm(body.runId, false);
    assert.equal(declined.status, 200);
    assert.equal((await declined.json()).declined, true);
    assert.match(await readDoc(), /beta body<\/p>/, 'declined change never lands');
  });

  await t.test('confirming applies the stashed result verbatim and records the run', async () => {
    const cid = await comment('Fix this too', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.result = outOfSectionResult(cid);
    const pending = await (await runOn(cid)).json();
    assert.equal(pending.pendingConfirmation, true);

    const res = await confirm(pending.runId, true);
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.status, 'ok');
    assert.equal(run.runId, pending.runId);
    assert.equal(run.lane, 'confirmed');
    assert.match(await readDoc(), /beta body reworded/, 'the previewed edit lands on confirm');

    // #236: the run record has to say a human was stopped and asked, not just
    // that a run happened. Before the fix scopeGate was silently dropped on
    // the confirmed pass (the dry-run that fires the gate lives in the FIRST
    // pass; the confirm pass never re-derives it) — this run and one that
    // never touched the gate at all recorded identically.
    assert.ok(run.scopeGate, 'a gate-stopped run must carry the gate verdict, not just lane:"confirmed"');
    assert.equal(run.scopeGate.fired, true, 'this run WAS stopped and a human allowed it through');
    assert.equal(run.scopeGate.outOfSection, true, 'the reach that fired the gate is on the record');
  });

  await t.test('a run the gate never touched records that too — fired:false, not the field\'s absence', async () => {
    // The contrast that makes the assertion above mean something: an in-section
    // edit never pauses, and its record must say the gate looked and found
    // nothing broad — not merely lack an opinion. Same field, opposite value,
    // is what lets a reader (or the run-log chip) tell "never gated" apart
    // from "gated and allowed" without also having to know the lane name.
    const cid = await comment('Tighten this', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.result = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'Tightened.' }],
      edits: [{ blockId: 'r-a2', newInner: 'alpha body, tightened' }],
    };
    const res = await runOn(cid);
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.pendingConfirmation, undefined, 'stays inside the section — no pause');
    assert.notEqual(run.lane, 'confirmed');
    assert.ok(run.scopeGate, 'the gate still ran a dry-run and logged its verdict');
    assert.equal(run.scopeGate.fired, false);
  });

  await t.test('an agent waiver skips the pause and applies directly', async () => {
    const cid = await comment('Apply across the doc, I said so', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.result = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'Done doc-wide.' }],
      edits: [{ blockId: 'r-a1', newInner: 'Section A!' }],
      scope: { level: 'section', requiresConfirmation: false, summary: 'user authorized' },
    };
    const res = await runOn(cid);
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.pendingConfirmation, undefined, 'no pause when the agent waived');
    assert.equal(run.status, 'ok');
    assert.match(await readDoc(), /Section A!/);
  });

  await t.test('confirm with an unknown runId is a 404', async () => {
    const res = await confirm('run-nope', true);
    assert.equal(res.status, 404);
  });
});
