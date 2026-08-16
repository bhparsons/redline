// test/runner/tactical-lane.test.mjs — WP4: the tactical lane.
//
// Self-contained like the other runner tests. The stub OpenRouter server has
// three personalities keyed on the prompt's first line — router, tactical,
// revise — so the fast path (tactical succeeds, standard lane never runs),
// every escalation trigger (agent {escalate}, garbage JSON, wrong block,
// failed apply), and plain ineligibility are all covered end to end, plus
// the validateTacticalPayload / tacticalEligible / tacticalModel units.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { traceDir } from '../../runner/lib/trace.mjs';
import {
  validateTacticalPayload, tacticalEligible, tacticalModel,
  TACTICAL_MAX_BLOCK_CHARS,
} from '../../runner/lib/tactical.mjs';
import { promptText } from '../../runner/lib/agent.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;
process.env.REDLINE_TRACE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-tacl-trace-'));
// One user skill with an explicit distilled form — the tactical prompt must
// carry the distilled head, never the longform tail.
const USER_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-tacl-skills-'));
process.env.REDLINE_SKILLS_DIR = USER_DIR;
await fs.writeFile(path.join(USER_DIR, 'voice.md'),
  'VOICE-DISTILLED-HEAD\n<!-- distill-end -->\nVOICE-LONGFORM-TAIL\n');

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<p data-rev="r-0002">delta echo foxtrot</p>\n</body></html>\n';

const TACTICAL_ROUTE = {
  archetype: 'tactical', scope: 'block', tier: 'simple', canTactical: true, skills: ['voice'],
};

// Three-personality stub: state.route / state.tactical / state.revise.
function startStub() {
  const state = {
    route: TACTICAL_ROUTE, tactical: null, revise: null,
    routerRequests: [], tacticalRequests: [], reviseRequests: [],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const content = promptText(parsed.messages);
      const chat = (reply) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }],
        }));
      };
      if (content.startsWith('# Redline comment router')) {
        state.routerRequests.push(parsed);
        return chat(state.route === null ? 'not json' : state.route);
      }
      if (content.startsWith('# Redline tactical edit')) {
        state.tacticalRequests.push(parsed);
        return chat(state.tactical);
      }
      state.reviseRequests.push(parsed);
      return chat(state.revise);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      state,
      url: `http://127.0.0.1:${server.address().port}/chat/completions`,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('tactical lane end to end', async (t) => {
  const stub = await startStub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-tacl-'));
  await fs.writeFile(path.join(root, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'test-key', endpoint: stub.url, timeoutMs: 5000 },
    telemetry: { endpoint: null }, // never export from tests
    modelTiers: { simple: 'test/tier-simple', standard: 'test/tier-standard', complex: 'test/tier-complex' },
  }));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const createComment = async (body) => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html', body, anchor: { blockId: 'r-0001', quote: 'bravo' },
    });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };
  const runOn = (cid) => postJson(`${base}/api/run`, { page: 'doc.html', commentId: cid });
  const resetDoc = () => fs.writeFile(docPath, DOC_HTML);

  await t.test('fast path: tactical succeeds, standard lane never runs', async () => {
    const cid = await createComment('Uppercase the middle word.');
    stub.state.tactical = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'Uppercased.' }],
      blockEdits: [{ id: 'r-0001', newInner: 'alpha BRAVO charlie' }],
    };
    stub.state.revise = 'must never be called';
    const before = stub.state.reviseRequests.length;

    const res = await runOn(cid);
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.status, 'ok');
    assert.equal(run.lane, 'tactical');
    assert.deepEqual(run.edits, [{
      blockId: 'r-0001', beforeInner: 'alpha bravo charlie', afterInner: 'alpha BRAVO charlie',
    }]);
    assert.ok((await fs.readFile(docPath, 'utf8')).includes('alpha BRAVO charlie'), 'edit landed');
    assert.equal(stub.state.reviseRequests.length, before, 'no revise call');

    const tacticalReq = stub.state.tacticalRequests.at(-1);
    assert.equal(tacticalReq.model, 'test/tier-simple', 'tactical runs on the simple tier');
    const prompt = promptText(tacticalReq.messages);
    assert.ok(prompt.includes(run.runId), 'run id rendered into the prompt');
    assert.ok(prompt.includes('alpha bravo charlie'), 'block inner present');
    assert.ok(!prompt.includes('delta echo foxtrot'), 'full document NOT present');
    assert.ok(prompt.includes('VOICE-DISTILLED-HEAD'), 'distilled skill present');
    assert.ok(!prompt.includes('VOICE-LONGFORM-TAIL'), 'longform tail absent');

    // The tactical exchange got the CANONICAL bundle files.
    const files = (await fs.readdir(traceDir(run.runId))).sort();
    assert.deepEqual(files,
      ['agent-request.json', 'agent-response.json', 'prompt.md', 'run.json', 'validation.json']);
    assert.ok((await fs.readFile(path.join(traceDir(run.runId), 'prompt.md'), 'utf8'))
      .startsWith('# Redline tactical edit'));
    await resetDoc();
  });

  const escalationCases = [
    ['agent chose to escalate', { escalate: true }],
    ['garbage JSON', 'sure! here you go { not json'],
    ['wrong block targeted', {
      decisions: [{ id: 'PLACEHOLDER', decision: 'addressed', summary: 's' }],
      blockEdits: [{ id: 'r-0002', newInner: 'delta echo foxtrot!' }],
    }],
    ['revise-shaped reply', {
      decisions: [{ id: 'PLACEHOLDER', decision: 'addressed', summary: 's' }],
      edits: [{ blockId: 'r-0001', newInner: 'dropped silently without this guard' }],
    }],
    ['unbalanced edit fails apply', {
      decisions: [{ id: 'PLACEHOLDER', decision: 'addressed', summary: 's' }],
      blockEdits: [{ id: 'r-0001', newInner: 'alpha <b>bravo charlie' }],
    }],
  ];
  for (const [label, tacticalReply] of escalationCases) {
    await t.test(`escalation: ${label} → standard lane finishes the run`, async () => {
      const cid = await createComment('Uppercase the middle word.');
      stub.state.tactical = typeof tacticalReply === 'string'
        ? tacticalReply
        : JSON.parse(JSON.stringify(tacticalReply).split('PLACEHOLDER').join(cid));
      stub.state.revise = {
        decisions: [{ id: cid, decision: 'addressed', summary: 'Standard lane did it.' }],
        edits: [{ blockId: 'r-0001', newInner: 'alpha BRAVO charlie' }],
      };
      const res = await runOn(cid);
      assert.equal(res.status, 200);
      const run = await res.json();
      assert.equal(run.status, 'ok', label);
      assert.equal(run.lane, 'escalated', label);
      assert.ok((await fs.readFile(docPath, 'utf8')).includes('alpha BRAVO charlie'), 'standard edit landed');

      // Attempt evidence under tactical-*; canonical files from the revise call.
      const files = await fs.readdir(traceDir(run.runId));
      assert.ok(files.includes('tactical-response.json'), `${label}: tactical evidence kept`);
      assert.ok((await fs.readFile(path.join(traceDir(run.runId), 'prompt.md'), 'utf8'))
        .startsWith('# Redline revise run'), 'canonical prompt is the revise prompt');
      await resetDoc();
    });
  }

  await t.test('ineligible route → straight to standard, lane "standard"', async () => {
    const cid = await createComment('Uppercase the middle word.');
    stub.state.route = { ...TACTICAL_ROUTE, canTactical: false };
    stub.state.revise = {
      decisions: [{ id: cid, decision: 'addressed', summary: 's' }],
      edits: [],
    };
    const before = stub.state.tacticalRequests.length;
    const run = await (await runOn(cid)).json();
    assert.equal(run.lane, 'standard');
    assert.equal(stub.state.tacticalRequests.length, before, 'no tactical call');
    stub.state.route = TACTICAL_ROUTE;
  });
});

// --- units --------------------------------------------------------------------

test('tactical units', async (t) => {
  const CTX = { runId: 'run-1', commentId: 'c-1', blockId: 'r-1' };
  const goodDecision = { id: 'c-1', decision: 'addressed', summary: 's' };

  await t.test('validateTacticalPayload: good, escalate, and bad shapes', () => {
    assert.deepEqual(
      validateTacticalPayload({
        runId: 'run-1', decisions: [goodDecision],
        blockEdits: [{ id: 'r-1', newInner: 'x' }],
      }, CTX),
      { decisions: [goodDecision], edits: [{ blockId: 'r-1', newInner: 'x' }] });
    assert.deepEqual(
      validateTacticalPayload({ decisions: [goodDecision] }, CTX),
      { decisions: [goodDecision], edits: [] }, 'runId and blockEdits may be absent');
    assert.equal(validateTacticalPayload({ escalate: true }, CTX), 'escalate');
    for (const bad of [
      null, [], 'x',
      { runId: 'run-OTHER', decisions: [goodDecision] },
      { decisions: [] },
      { decisions: [goodDecision, goodDecision] },
      { decisions: [{ ...goodDecision, id: 'c-2' }] },
      { decisions: [{ ...goodDecision, decision: 'done' }] },
      { decisions: [goodDecision], blockEdits: [{ id: 'r-2', newInner: 'x' }] },
      { decisions: [goodDecision], blockEdits: [{ id: 'r-1', newInner: 'a' }, { id: 'r-1', newInner: 'b' }] },
      { decisions: [goodDecision], edits: [] },
      { decisions: [goodDecision], inserts: [] },
    ]) {
      assert.equal(validateTacticalPayload(bad, CTX), null, JSON.stringify(bad));
    }
  });

  await t.test('tacticalEligible: batch, route, block presence, size cap', () => {
    const route = { canTactical: true };
    const block = { inner: 'x'.repeat(100) };
    assert.ok(tacticalEligible({ batch: false, route, block }));
    assert.ok(!tacticalEligible({ batch: true, route, block }), 'batch never');
    assert.ok(!tacticalEligible({ batch: false, route: { canTactical: false }, block }));
    assert.ok(!tacticalEligible({ batch: false, route, block: null }), 'no located block');
    assert.ok(!tacticalEligible({
      batch: false, route, block: { inner: 'x'.repeat(TACTICAL_MAX_BLOCK_CHARS + 1) },
    }), 'oversized block');
  });

  await t.test('tacticalModel: author pin wins, else simple tier', () => {
    const config = { modelOverrides: { tactical: 'pinned/t' }, modelTiers: { simple: 'tier/s' } };
    assert.equal(tacticalModel({ archetype: 'tactical' }, config), 'pinned/t');
    assert.equal(tacticalModel({ archetype: 'content' }, config), 'tier/s');
  });
});
