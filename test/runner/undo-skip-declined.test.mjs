// test/runner/undo-skip-declined.test.mjs — #128: the load-bearing half.
//
// A declined scope confirmation now lands in runs[] (a zero-edit
// status:'declined' record) instead of a separate ledger, so it sits in the
// exact array /api/undo walks. Undo MUST skip it: it only reverts an
// 'ok' | 'partial' run, so a declined run on TOP of an applied run is walked
// past and the applied run beneath it is still reached and its snapshot
// restored. Get this wrong and undo either no-ops on a real edit or throws.
//
// Self-contained: fixture dir in a tmpdir, runner on an OS-assigned port, a
// stub OpenRouter. No network.

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
delete process.env.OPENROUTER_ENDPOINT;
delete process.env.REDLINE_OTEL_ENDPOINT;
process.env.REDLINE_TRACE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-undo-decl-trace-'));

const DOC = [
  '<!doctype html><html><head><title>t</title></head><body>',
  '<section data-rev="r-secA"><h2 data-rev="r-a1">Section A</h2><p data-rev="r-a2">alpha body</p></section>',
  '<section data-rev="r-secB"><p data-rev="r-b1">beta body</p></section>',
  '</body></html>',
].join('\n');

const USAGE = { prompt_tokens: 1000, completion_tokens: 100, cost: 0.01 };
// canTactical:false → the standard lane, which is the one that runs the scope
// dry-run gate.
const STANDARD_ROUTE = { archetype: 'redesign', scope: 'section', tier: 'standard', canTactical: false, skills: [] };

function startStub() {
  const state = { revise: null };
  const server = http.createServer(async (req, res) => {
    const parsed = await collectJson(req, res, 'undo-skip-stub');
    if (parsed === null) return; // anomalous request logged + answered, never a crash (#244)
    const text = promptText(parsed.messages);
    const send = (reply) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }],
        usage: USAGE,
      }));
    };
    if (text.startsWith('# Redline comment router')) return send(STANDARD_ROUTE);
    return send(state.revise);
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

test('#128 undo skips a declined run and restores the applied run beneath it', async (t) => {
  const stub = await startStub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-undo-decl-'));
  await fs.writeFile(path.join(root, 'doc.html'), DOC);
  await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'k', endpoint: stub.url, timeoutMs: 5000 },
    telemetry: { endpoint: null },
    modelTiers: { simple: 'test/tier-simple', standard: 'test/tier-standard', complex: 'test/tier-complex' },
  }, null, 2));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await stub.close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const readDoc = () => fs.readFile(path.join(root, 'doc.html'), 'utf8');
  const sidecar = async () => JSON.parse(await fs.readFile(path.join(root, 'doc.html.review.json'), 'utf8'));
  const comment = async (body, anchor) => {
    const res = await post(`${base}/api/comment`, { page: 'doc.html', body, anchor });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };

  // 1. An APPLIED run: an edit confined to its anchored block, so no scope gate.
  const c1 = await comment('Reword this.', { blockId: 'r-a2', quote: 'alpha body' });
  stub.state.revise = {
    decisions: [{ id: c1, decision: 'addressed', summary: 'Reworded.' }],
    edits: [{ blockId: 'r-a2', newInner: 'alpha body reworded' }],
  };
  const okRun = await (await post(`${base}/api/run`, { page: 'doc.html', commentId: c1 })).json();
  assert.equal(okRun.status, 'ok');
  assert.match(await readDoc(), /alpha body reworded/, 'the applied edit landed');

  // 2. A DECLINED run stacked on top: anchored in section A, edit lands in
  //    section B, so the scope gate fires; the author declines.
  const c2 = await comment('Fix this.', { blockId: 'r-a2', quote: 'alpha body reworded' });
  stub.state.revise = {
    decisions: [{ id: c2, decision: 'addressed', summary: 'Did the thing.' }],
    edits: [{ blockId: 'r-b1', newInner: 'beta body reworded' }],
  };
  const pending = await (await post(`${base}/api/run`, { page: 'doc.html', commentId: c2 })).json();
  assert.equal(pending.pendingConfirmation, true);
  const declined = await (await post(`${base}/api/run/confirm`, { page: 'doc.html', runId: pending.runId, allow: false })).json();
  assert.equal(declined.declined, true);

  // Now runs[] is [okRun, declinedRun], declined on top.
  const before = await sidecar();
  assert.deepEqual(before.runs.map((r) => r.status), ['ok', 'declined']);
  assert.match(await readDoc(), /alpha body reworded/, 'the decline changed nothing');
  assert.match(await readDoc(), /beta body</, 'section B untouched by the declined edit');

  // 3. UNDO: it must skip the declined run on top and revert the applied run.
  const undo = await (await post(`${base}/api/undo`, { page: 'doc.html' })).json();
  assert.equal(undo.runId, okRun.runId, 'undo reached the applied run, not the declined one');

  const doc = await readDoc();
  assert.doesNotMatch(doc, /alpha body reworded/, 'the applied edit was reverted');
  assert.match(doc, /alpha body</, 'r-a2 restored to its pre-run snapshot');

  const after = await sidecar();
  const okAfter = after.runs.find((r) => r.runId === okRun.runId);
  const declAfter = after.runs.find((r) => r.runId === pending.runId);
  assert.equal(okAfter.status, 'undone', 'the applied run is now marked undone');
  assert.equal(declAfter.status, 'declined', 'the declined run is left exactly as it was');
  // The comment the applied run addressed is reopened; the declined comment was
  // never resolved to begin with.
  assert.equal(after.comments.find((c) => c.id === c1).status, 'open');
});
