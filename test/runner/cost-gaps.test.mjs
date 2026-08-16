// test/runner/cost-gaps.test.mjs — #124: three places a run spent real money
// and nothing wrote it down.
//
//   1. THE ROUTER CALL. Every comment makes one classification call before the
//      revise call. Its usage was never accrued and never spanned, so it
//      appeared nowhere: 0.5% of a sonnet standard run (noise), 38% of a
//      gemini-flash tactical one. It now lands on `run.usage.routerCostUsd` —
//      a SEPARATE field, deliberately not folded into `costUsd`, so a lane
//      comparison is not inflated by a fixed overhead that belongs to no lane.
//   2. THE TACTICAL MANIFEST. #94 built the context manifest inside the
//      standard-lane block, so `run.context` was null on every tactical run —
//      the lane we most want traffic on was the one we could say least about.
//   3. THE DECLINED CONFIRMATION. The pending pass makes a full agent call
//      ($0.056 on a 22 KB page); declining discarded the result and wrote
//      nothing at all. #124 first parked it in a top-level `costLedger[]`;
//      #128 (approved 2026-07-24) surfaces it INTO `runs[]` as a zero-edit
//      status:'declined' run — visible in the run log, undo-inert, and carrying
//      its spend. costLedger[] is retired.
//
// Plus one gap of the same family found on the way in: a tactical call whose
// REPLY was unusable (escalation, bad JSON) was billed but not accrued,
// because the runner read usage off the successful result instead of off the
// response envelope.
//
// Self-contained: fixture dir in a tmpdir, runner on an OS-assigned port, a
// stub OpenRouter with a per-personality usage envelope. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { promptText, usageFromEnvelope } from '../../runner/lib/agent.mjs';
import { collectJson } from '../helpers/json-body.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;
delete process.env.REDLINE_OTEL_ENDPOINT;
process.env.REDLINE_TRACE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-gaps-trace-'));

const DOC = [
  '<!doctype html><html><head><title>t</title></head><body>',
  '<section data-rev="r-secA"><h2 data-rev="r-a1">Section A</h2><p data-rev="r-a2">alpha body</p></section>',
  '<section data-rev="r-secB"><p data-rev="r-b1">beta body</p></section>',
  '</body></html>',
].join('\n');

// Distinct costs per personality so a mis-attribution is visible, not masked
// by everything costing the same.
const ROUTER_USAGE = { prompt_tokens: 400, completion_tokens: 20, cost: 0.00024 };
const REVISE_USAGE = { prompt_tokens: 1000, completion_tokens: 100, cost: 0.01 };
const TACTICAL_USAGE = { prompt_tokens: 300, completion_tokens: 30, cost: 0.002 };

const TACTICAL_ROUTE = {
  archetype: 'tactical', scope: 'block', tier: 'simple', canTactical: true, skills: [],
};
const STANDARD_ROUTE = {
  archetype: 'redesign', scope: 'section', tier: 'standard', canTactical: false, skills: [],
};

function startStub() {
  const state = { route: STANDARD_ROUTE, tactical: null, revise: null, routerCalls: 0 };
  const server = http.createServer(async (req, res) => {
    const parsed = await collectJson(req, res, 'cost-gaps-stub');
    if (parsed === null) return; // anomalous request logged + answered, never a crash (#244)
    const text = promptText(parsed.messages);
    const send = (reply, usage) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }],
        usage,
      }));
    };
    if (text.startsWith('# Redline comment router')) {
      state.routerCalls += 1;
      return send(state.route === null ? 'not json' : state.route, ROUTER_USAGE);
    }
    if (text.startsWith('# Redline tactical edit')) return send(state.tactical, TACTICAL_USAGE);
    return send(state.revise, REVISE_USAGE);
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

test('#124 every call that spends money leaves a record', async (t) => {
  const stub = await startStub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-gaps-'));
  await fs.writeFile(path.join(root, 'doc.html'), DOC);
  await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'k', endpoint: stub.url, timeoutMs: 5000 },
    telemetry: { endpoint: null }, // never export from tests
    modelTiers: { simple: 'test/tier-simple', standard: 'test/tier-standard', complex: 'test/tier-complex' },
  }, null, 2));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await stub.close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;

  const comment = async (body, anchor) => {
    const res = await post(`${base}/api/comment`, { page: 'doc.html', body, anchor });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };
  const sidecar = async () =>
    JSON.parse(await fs.readFile(path.join(root, 'doc.html.review.json'), 'utf8'));

  await t.test('the router call lands on run.usage.routerCostUsd, outside the lane total', async () => {
    stub.state.route = STANDARD_ROUTE;
    const cid = await comment('Reword this paragraph.', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.revise = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'Reworded.' }],
      edits: [{ blockId: 'r-a2', newInner: 'alpha body reworded' }],
    };
    const before = stub.state.routerCalls;
    const run = await (await post(`${base}/api/run`, { page: 'doc.html', commentId: cid })).json();
    assert.equal(run.status, 'ok');
    assert.equal(stub.state.routerCalls - before, 1, 'exactly one routing call per comment');

    assert.equal(run.usage.routerCostUsd, ROUTER_USAGE.cost, 'the routing call is recorded');
    // The whole point of a separate field: the lane total is untouched, so a
    // lane comparison still compares lanes.
    assert.equal(run.usage.costUsd, REVISE_USAGE.cost, 'costUsd is the revise call alone');
    assert.equal(run.usage.inputTokens, REVISE_USAGE.prompt_tokens, 'router tokens stay out too');
  });

  await t.test('a tactical run carries a context manifest and its own router cost', async () => {
    stub.state.route = TACTICAL_ROUTE;
    const cid = await comment('Change "beta" to "gamma".', { blockId: 'r-b1', quote: 'beta body' });
    stub.state.tactical = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'Swapped.' }],
      blockEdits: [{ id: 'r-b1', newInner: 'gamma body' }],
    };
    const run = await (await post(`${base}/api/run`, { page: 'doc.html', commentId: cid })).json();
    assert.equal(run.status, 'ok');
    assert.equal(run.lane, 'tactical');

    // #94's manifest, on the lane that never had one.
    assert.ok(run.context !== null && run.context !== undefined, 'run.context is no longer null');
    assert.ok(run.context.prompt.chars > 0, 'prompt composition recorded');
    assert.equal(run.context.usage.promptTokens, TACTICAL_USAGE.prompt_tokens);
    assert.equal(run.context.usage.completionTokens, TACTICAL_USAGE.completion_tokens);
    assert.ok(run.context.usage.charsPerToken > 0, 'sent-vs-billed ratio recorded');
    // The manifest describes the TACTICAL prompt, not a standard one — the
    // lane's whole point is that it never sends the document.
    const standard = (await sidecar()).runs.find((r) => r.lane === 'standard');
    assert.ok(run.context.prompt.chars < standard.context.prompt.chars,
      `tactical prompt ${run.context.prompt.chars} < standard ${standard.context.prompt.chars}`);
    assert.deepEqual(run.perComment ?? undefined, undefined, 'single run, no perComment');

    assert.equal(run.usage.costUsd, TACTICAL_USAGE.cost);
    assert.equal(run.usage.routerCostUsd, ROUTER_USAGE.cost);
  });

  await t.test('an escalating tactical call is still billed, and still accrued', async () => {
    stub.state.route = TACTICAL_ROUTE;
    const cid = await comment('Change "alpha" to "omega".', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.tactical = { escalate: true }; // paid for, produced nothing
    stub.state.revise = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'Swapped.' }],
      edits: [{ blockId: 'r-a2', newInner: 'omega body' }],
    };
    const run = await (await post(`${base}/api/run`, { page: 'doc.html', commentId: cid })).json();
    assert.equal(run.status, 'ok');
    assert.equal(run.lane, 'escalated');
    // Both calls happened, so both are on the record. Reading usage off the
    // successful RESULT (rather than off the response envelope) lost the
    // tactical half of this.
    assert.equal(run.usage.costUsd, TACTICAL_USAGE.cost + REVISE_USAGE.cost);
    assert.equal(run.usage.routerCostUsd, ROUTER_USAGE.cost);
  });

  await t.test('a DECLINED scope confirmation records its spend as a zero-edit run in runs[] (#128)', async () => {
    stub.state.route = STANDARD_ROUTE;
    const cid = await comment('Fix this', { blockId: 'r-a2', quote: 'alpha body' });
    // An edit anchored in section A that lands in section B trips the gate.
    stub.state.revise = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'Did the thing.' }],
      edits: [{ blockId: 'r-b1', newInner: 'beta body reworded' }],
    };
    const pending = await (await post(`${base}/api/run`, { page: 'doc.html', commentId: cid })).json();
    assert.equal(pending.pendingConfirmation, true);

    const runsBefore = (await sidecar()).runs.length;
    const res = await post(`${base}/api/run/confirm`, { page: 'doc.html', runId: pending.runId, allow: false });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, declined: true, runId: pending.runId });

    const data = await sidecar();
    // #128: the declined run IS in runs[] now — the overlay's run log surfaces
    // it. costLedger[] is retired, so it must not reappear.
    assert.equal(data.runs.length, runsBefore + 1, 'a decline adds exactly one run record');
    assert.equal(data.costLedger, undefined, 'costLedger[] is retired');
    const run = data.runs.find((r) => r.runId === pending.runId);
    assert.ok(run, 'the declined run is in runs[]');
    assert.equal(run.status, 'declined');
    assert.equal(run.lane, 'declined');
    assert.equal(run.commentId, cid);
    // Zero-edit and never counted as an applied edit: this is what keeps the
    // run strip from implying a change landed.
    assert.deepEqual(run.edits, [], 'a declined run applied no edits');
    assert.deepEqual(run.decisions, [], 'and resolved no comment');
    assert.equal(run.model, 'test/tier-standard', 'attributable to the model that spent it');
    assert.equal(run.archetype, STANDARD_ROUTE.archetype);
    // The comment it named is NOT resolved — a decline is not a resolution.
    assert.equal(data.comments.find((c) => c.id === cid).status, 'open');
    // The money: the agent call the author never used, plus its routing call.
    assert.equal(run.usage.costUsd, REVISE_USAGE.cost);
    assert.equal(run.usage.routerCostUsd, ROUTER_USAGE.cost);
    assert.ok(run.context.prompt.chars > 0, 'and what it was spent on');
    assert.equal(run.context.usage.promptTokens, REVISE_USAGE.prompt_tokens);
    // Undo-inert: /api/undo only ever reverts 'ok' | 'partial', so it walks
    // past the declined run on top and reaches the applied run beneath it —
    // never the declined one. (A dedicated snapshot-restore test lives in
    // undo-skip-declined.test.mjs.)
    const undo = await post(`${base}/api/undo`, { page: 'doc.html' });
    assert.equal((await undo.json()).runId !== pending.runId, true, 'undo never reaches a declined run');
  });

  await t.test('an ALLOWED confirmation still carries the pending pass router cost', async () => {
    stub.state.route = STANDARD_ROUTE;
    const cid = await comment('Fix this too', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.revise = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'Did the thing.' }],
      edits: [{ blockId: 'r-b1', newInner: 'beta body reworded again' }],
    };
    const pending = await (await post(`${base}/api/run`, { page: 'doc.html', commentId: cid })).json();
    assert.equal(pending.pendingConfirmation, true);
    const routerCallsAtGate = stub.state.routerCalls;

    const run = await (await post(`${base}/api/run/confirm`,
      { page: 'doc.html', runId: pending.runId, allow: true })).json();
    assert.equal(run.status, 'ok');
    assert.equal(run.lane, 'confirmed');
    assert.equal(stub.state.routerCalls, routerCallsAtGate, 'the confirmed pass never re-routes');
    // …so if the confirmed record does not carry the pending pass's routing
    // cost, nothing does.
    assert.equal(run.usage.routerCostUsd, ROUTER_USAGE.cost);
    assert.equal(run.usage.costUsd, REVISE_USAGE.cost);
  });
});

test('#124 usageFromEnvelope reads the bill off a response, however it went', () => {
  assert.deepEqual(
    usageFromEnvelope({ usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.5 } }),
    { inputTokens: 10, outputTokens: 2, costUsd: 0.5 },
  );
  // A provider that reports tokens but no cost, and one that reports nothing.
  assert.deepEqual(usageFromEnvelope({ usage: { prompt_tokens: 10 } }), { inputTokens: 10 });
  for (const empty of [null, undefined, {}, { usage: null }, { usage: [] }, { usage: {} }]) {
    assert.equal(usageFromEnvelope(empty), null, JSON.stringify(empty));
  }
});
