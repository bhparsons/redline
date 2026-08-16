// test/runner/speed-cost.test.mjs — WP7: speed/cost regression bounds.
//
// Protects the Milestone 1 speed target from silent regressions. Stub agents
// everywhere, so the bounds pin the RUNNER's own behavior:
//   - latency: a stub run must stay fast — a bound breach means the pipeline
//     grew a sleep, a retry loop, or a serial round-trip it didn't have;
//   - cost: the estimate is a deterministic function of prompt/response
//     size, so a bound breach means PROMPT BLOAT for that fixture/tier —
//     exactly the regression that made simple edits expensive before M1.
// Bounds are generous multiples of observed values (2026-07-22 baselines in
// the tables below) to avoid flakes; tighten them as WP5 live numbers land.
// Every assertion names the fixture, the metric, the value, and the bound.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { TIERS } from '../../runner/config/defaults.mjs';
import { promptText } from '../../runner/lib/agent.mjs';

const execFileP = promisify(execFile);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;
process.env.REDLINE_TRACE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-speedcost-trace-'));

// Upper bounds per STUB run. Latency is per fixture (any tier — the stub
// answers instantly, so tier choice cannot move it). Cost is per tier: the
// prompt is the dominant term and scales with the fixture doc + context, so
// one ceiling per tier catches bloat on every fixture at once.
// Baselines 2026-07-22: latency 3-15ms; cost simple <=0.0009, standard
// <=0.0083, complex <=0.0290.
const LATENCY_BOUND_MS = 2000;
const COST_BOUNDS_USD = { simple: 0.002, standard: 0.02, complex: 0.10 };

test('eval fixtures stay under the latency and cost bounds on every tier', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-speedcost-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const outPath = path.join(outDir, 'results.json');
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.OPENROUTER_ENDPOINT;

  await execFileP(process.execPath,
    [path.join(REPO_ROOT, 'runner', 'eval', 'run.mjs'), '--tier', 'all', '--out', outPath],
    { env, timeout: 120_000 });
  const results = JSON.parse(await fs.readFile(outPath, 'utf8'));

  for (const tier of TIERS) {
    const rows = results.tiers[tier].fixtures;
    assert.ok(rows.length >= 22, `tier ${tier}: full fixture set ran`);
    for (const r of rows) {
      assert.equal(r.runStatus, 'ok', `${tier}/${r.name}: run failed — ${r.notes.join('; ')}`);
      assert.ok(r.latencyMs <= LATENCY_BOUND_MS,
        `${tier}/${r.name}: latency ${r.latencyMs}ms exceeds the ${LATENCY_BOUND_MS}ms stub bound`);
      assert.ok(r.estCostUsd <= COST_BOUNDS_USD[tier],
        `${tier}/${r.name}: est. cost $${r.estCostUsd} exceeds the $${COST_BOUNDS_USD[tier]} ${tier}-tier bound`
        + ' (prompt bloat? see tmp trace bundles)');
      assert.equal(r.score, 1, `${tier}/${r.name}: stub quality regressed to ${r.score}`);
    }
  }
});

// ---- the tactical lane's own latency bound ----------------------------------
// tactical-typo is the canonical tactical fixture: with a router that says
// canTactical and a tactical-shaped stub reply, the run MUST take the
// tactical lane (not escalate) and finish fast.

const TACTICAL_LATENCY_BOUND_MS = 2000;
const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">You will recieve a confirmation email.</p>\n</body></html>\n';

function startLaneStub() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const content = promptText(JSON.parse(body).messages);
      const chat = (reply) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(reply) } }] }));
      };
      if (content.startsWith('# Redline comment router')) {
        return chat({ archetype: 'tactical', scope: 'block', tier: 'simple', canTactical: true, skills: [] });
      }
      if (content.startsWith('# Redline tactical edit')) {
        const cid = /"id": "(c-[0-9a-f]{12})"/.exec(content)?.[1] ?? 'c-unknown';
        return chat({
          decisions: [{ id: cid, decision: 'addressed', summary: 'Fixed the typo.' }],
          blockEdits: [{ id: 'r-0001', newInner: 'You will receive a confirmation email.' }],
        });
      }
      return chat({ decisions: [] }); // the revise lane must never be reached
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/chat/completions`,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

test('the canonical tactical fixture takes the tactical lane within its bound', async (t) => {
  const stub = await startLaneStub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-speedcost-lane-'));
  await fs.writeFile(path.join(root, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'test-key', endpoint: stub.url, timeoutMs: 5000 },
    telemetry: { endpoint: null },
  }));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (url, payload) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const created = await post(`${base}/api/comment`, {
    page: 'doc.html', body: 'Typo: recieve should be receive.',
    anchor: { blockId: 'r-0001', quote: 'recieve' },
  });
  const cid = (await created.json()).id;

  const t0 = Date.now();
  const res = await post(`${base}/api/run`, { page: 'doc.html', commentId: cid });
  const latencyMs = Date.now() - t0;
  assert.equal(res.status, 200);
  const run = await res.json();
  assert.equal(run.lane, 'tactical',
    `tactical-typo must take the tactical lane, got lane=${run.lane}`);
  assert.equal(run.status, 'ok');
  assert.ok(latencyMs <= TACTICAL_LATENCY_BOUND_MS,
    `tactical lane latency ${latencyMs}ms exceeds the ${TACTICAL_LATENCY_BOUND_MS}ms stub bound`);
  assert.ok((await fs.readFile(path.join(root, 'doc.html'), 'utf8')).includes('You will receive'),
    'the tactical edit landed');
});
