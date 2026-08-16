// test/runner/send-all-partial.test.mjs — WP8: partial-apply for Send-All.
//
// A batch processes each comment independently: successes land and are marked
// addressed; failures are marked failed with a SAFE reason and do NOT roll the
// batch back. Run status is 'partial' when any comment failed, 'ok' when none
// did. The whole batch is still ONE snapshot / ONE undo unit. Single-comment
// runs stay all-or-nothing (covered in run.test.mjs / apply.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { promptText } from '../../runner/lib/agent.mjs';
import { collectJson } from '../helpers/json-body.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.REDLINE_OTEL_ENDPOINT;

const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha</p>\n<p data-rev="r-0002">bravo</p>\n<p data-rev="r-0003">charlie</p>\n'
  + '</body></html>\n';

// Stub OpenRouter: one queued reply per agent call (a batch calls once per
// comment). mode 'ok' → the given result; 'http500' → a 500 (agent failure).
function startStub() {
  const state = { queue: [] };
  const server = http.createServer(async (req, res) => {
    const parsed = await collectJson(req, res, 'send-all-stub');
    if (parsed === null) return; // anomalous request logged + answered, never a crash (#244)
    const chat = (content) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    };
    // Router/tactical calls come first per comment — answer with garbage
    // (→ fallback route / tactical escalation) WITHOUT consuming the queue,
    // so the queue lines up one-to-one with the revise calls.
    const prompt = promptText(parsed.messages);
    if (prompt.startsWith('# Redline comment router') || prompt.startsWith('# Redline tactical edit')) {
      return chat('not json — force the fallback path');
    }
    const next = state.queue.shift() || { mode: 'ok', result: { decisions: [], edits: [] } };
    if (next.mode === 'http500') { res.writeHead(500); return res.end('upstream boom'); }
    return chat(JSON.stringify(next.result));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    state,
    url: `http://127.0.0.1:${server.address().port}/chat/completions`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

async function makeRoot(agentUrl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-partial-'));
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
const ok = (id, blockId, newInner) => ({ mode: 'ok', result: { decisions: [{ id, decision: 'addressed', summary: 's' }], edits: [{ blockId, newInner }] } });

test('Send-All partial apply: mixed, all-ok, all-fail, and partial undo', async (t) => {
  const stub = await startStub();
  const root = await makeRoot(stub.url);
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await stub.close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const sidecar = async () => JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
  const readDoc = () => fs.readFile(docPath, 'utf8');
  const comment = async (body, anchor) => (await (await post(`${base}/api/comment`, { page: 'doc.html', body, anchor })).json()).id;
  const runBatch = (commentIds) => post(`${base}/api/run`, { page: 'doc.html', commentIds });

  await t.test('a fully successful batch is status ok', async () => {
    const a = await comment('a', { blockId: 'r-0001', quote: 'alpha' });
    const b = await comment('b', { blockId: 'r-0002', quote: 'bravo' });
    stub.state.queue = [ok(a, 'r-0001', 'ALPHA'), ok(b, 'r-0002', 'BRAVO')];
    const run = await (await runBatch([a, b])).json();
    assert.equal(run.status, 'ok');
    assert.deepEqual(run.perComment.map((p) => p.status), ['ok', 'ok']);
    assert.match(await readDoc(), /ALPHA/);
    assert.match(await readDoc(), /BRAVO/);
  });

  await t.test('a mixed batch is partial: the success lands, the failure is marked', async () => {
    const a = await comment('a2', { blockId: 'r-0001', quote: 'ALPHA' });
    const b = await comment('b2', { blockId: 'r-0002', quote: 'BRAVO' });
    // First comment succeeds; second's agent 500s.
    stub.state.queue = [ok(a, 'r-0001', 'ALPHA!'), { mode: 'http500' }];
    const res = await runBatch([a, b]);
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.status, 'partial');
    assert.equal(run.perComment[0].status, 'ok');
    assert.equal(run.perComment[1].status, 'failed');
    assert.equal(typeof run.perComment[1].error, 'string');
    assert.ok(!run.perComment[1].error.includes('boom'), 'no upstream body in the reason');
    assert.match(await readDoc(), /ALPHA!/, 'the successful edit stays on disk');
    const data = await sidecar();
    assert.equal(data.comments.find((c) => c.id === a).status, 'addressed');
    assert.equal(data.comments.find((c) => c.id === b).status, 'failed');
  });

  await t.test('a fully failed batch is partial with nothing applied', async () => {
    const before = await readDoc();
    const a = await comment('a3', { blockId: 'r-0003', quote: 'charlie' });
    const b = await comment('b3', { blockId: 'r-0003', quote: 'charlie' });
    stub.state.queue = [{ mode: 'http500' }, { mode: 'http500' }];
    const run = await (await runBatch([a, b])).json();
    assert.equal(run.status, 'partial');
    assert.deepEqual(run.perComment.map((p) => p.status), ['failed', 'failed']);
    assert.equal(await readDoc(), before, 'nothing changed on disk when every comment failed');
  });

  await t.test('undo reverts a partial batch (the successful edits) as one unit', async () => {
    const a = await comment('a4', { blockId: 'r-0001', quote: 'ALPHA!' });
    const b = await comment('b4', { blockId: 'r-0002', quote: 'BRAVO' });
    const before = await readDoc();
    stub.state.queue = [ok(a, 'r-0001', 'ALPHA!!'), { mode: 'http500' }];
    const run = await (await runBatch([a, b])).json();
    assert.equal(run.status, 'partial');
    assert.match(await readDoc(), /ALPHA!!/);

    const undo = await (await post(`${base}/api/undo`, { page: 'doc.html' })).json();
    assert.equal(undo.status, 'undone');
    assert.equal(await readDoc(), before, 'the partial batch\'s applied edit is reverted wholesale');
    assert.equal((await sidecar()).comments.find((c) => c.id === a).status, 'open', 'the addressed comment reopens');
  });
});
