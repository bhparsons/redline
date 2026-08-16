// test/runner/cost-attribution.test.mjs — #118: a run's dollars must be
// attributable to the model that spent them.
//
// Two gaps this pins shut, both found while building design/cost-model.md:
//
//   1. A BATCH run left `archetype`/`model` null (they have no single value
//      across N comments) and recorded nothing else, so `run.usage.costUsd`
//      could not be tied to a tier at all. It now also carries `models[]` and
//      `archetypes[]` — the sorted, de-duplicated SET each comment routed to.
//      The scalars deliberately stay null: inventing one would put one
//      comment's model on the whole run in the overlay's provenance line.
//
//   2. A scope-gated run (WP7) paid for its agent call in the PENDING pass,
//      then recorded the confirmed run with no usage and no context manifest
//      at all — a run that cost real money reported $0. The pending record now
//      carries that usage/manifest through to the confirmed run.
//
// Self-contained: fixture dir in a tmpdir, runner on an OS-assigned port, stub
// OpenRouter that returns a real-shaped usage envelope. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { promptText } from '../../runner/lib/agent.mjs';
import { estimateCost } from '../../runner/eval/score.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;
delete process.env.REDLINE_OTEL_ENDPOINT;

const DOC = [
  '<!doctype html><html><head><title>t</title></head><body>',
  '<section data-rev="r-secA"><h2 data-rev="r-a1">Section A</h2><p data-rev="r-a2">alpha body</p></section>',
  '<section data-rev="r-secB"><p data-rev="r-b1">beta body</p></section>',
  '</body></html>',
].join('\n');

// One envelope shaped like OpenRouter's, so usage.cost / cached_tokens travel
// the same path a live run takes.
function envelope(content, { cost, promptTokens, completionTokens, cachedTokens }) {
  return {
    choices: [{ message: { role: 'assistant', content } }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cost,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    },
  };
}

function startStub() {
  const state = { queue: [], usage: { cost: 0.01, promptTokens: 1000, completionTokens: 100, cachedTokens: 0 } };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const text = promptText(parsed.messages);
      const send = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      // Router and tactical calls get garbage so every comment takes the
      // keyword-classifier fallback and the standard lane — the shape this
      // test is about. They never consume the queue.
      if (text.startsWith('# Redline comment router') || text.startsWith('# Redline tactical edit')) {
        return send({ choices: [{ message: { role: 'assistant', content: 'not json' } }] });
      }
      const next = state.queue.shift() ?? { decisions: [] };
      return send(envelope(JSON.stringify(next), state.usage));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    state,
    url: `http://127.0.0.1:${server.address().port}/chat/completions`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

async function makeRoot(agentUrl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-cost-attr-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'k', endpoint: agentUrl, timeoutMs: 5000 },
    telemetry: { endpoint: null }, // never export from tests
    models: {
      tactical: 'test/tactical-model',
      redesign: 'test/redesign-model',
      research: 'test/research-model',
      accessibility: 'test/accessibility-model',
      content: 'test/content-model',
    },
  }, null, 2));
  return dir;
}

const post = (url, payload) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

test('#118 run cost is attributable to the model that spent it', async (t) => {
  const stub = await startStub();
  const root = await makeRoot(stub.url);
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await stub.close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;

  const comment = async (body, anchor) => {
    const res = await post(`${base}/api/comment`, { page: 'doc.html', body, anchor });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };
  const decide = (cid, edits) => ({
    decisions: [{ id: cid, decision: 'addressed', summary: 'Did the thing.' }],
    edits,
  });

  await t.test('a batch run names the SET of models and archetypes it spent on', async () => {
    // Three comments, three keyword archetypes → three distinct models, one
    // of them used twice so the de-duplication is exercised.
    const c1 = await comment('Add ARIA labels so screen readers announce this.',
      { blockId: 'r-a2', quote: 'alpha body' });
    const c2 = await comment('Rewrite this paragraph in a warmer tone.',
      { blockId: 'r-b1', quote: 'beta body' });
    const c3 = await comment('Rewrite this heading in a warmer tone.',
      { blockId: 'r-a1', quote: 'Section A' });
    stub.state.queue = [
      decide(c1, [{ blockId: 'r-a2', newInner: 'alpha body a11y' }]),
      decide(c2, [{ blockId: 'r-b1', newInner: 'beta body warm' }]),
      decide(c3, [{ blockId: 'r-a1', newInner: 'Section A warm' }]),
    ];

    const res = await post(`${base}/api/run`, { page: 'doc.html', commentIds: [c1, c2, c3] });
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.status, 'ok');

    // The scalars stay null — a batch has no single archetype or model.
    assert.equal(run.archetype, null);
    assert.equal(run.model, null);

    // …but the SET is recorded, sorted and de-duplicated, and it matches what
    // perComment actually routed to. Three comments, two archetypes.
    assert.deepEqual(run.archetypes, ['accessibility', 'content']);
    assert.deepEqual(run.models, ['test/accessibility-model', 'test/content-model']);
    assert.deepEqual(
      run.models,
      [...new Set(run.perComment.map((p) => p.model))].sort(),
      'run.models is exactly the set perComment routed to',
    );

    // And the cost it explains is real: three agent calls at the stub's rate.
    assert.equal(run.usage.costUsd, 0.03);
    assert.equal(run.usage.inputTokens, 3000);
  });

  await t.test('a scope-gated run records what the pending pass already paid', async () => {
    // An edit anchored in section A that lands in section B trips the gate.
    const cid = await comment('Fix this', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.queue = [decide(cid, [{ blockId: 'r-b1', newInner: 'beta body reworded' }])];

    const pending = await (await post(`${base}/api/run`, { page: 'doc.html', commentId: cid })).json();
    assert.equal(pending.pendingConfirmation, true);

    const res = await post(`${base}/api/run/confirm`, { page: 'doc.html', runId: pending.runId, allow: true });
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.status, 'ok');
    assert.equal(run.lane, 'confirmed');

    // The confirmed pass makes NO agent call — the money was spent in the
    // pending pass, and this is the record that has to carry it.
    assert.equal(run.usage.costUsd, 0.01, 'the pending pass cost lands on the confirmed run');
    assert.equal(run.usage.inputTokens, 1000);
    assert.ok(run.context?.prompt?.chars > 0, 'the pending pass manifest lands too (#94)');
    assert.equal(run.context.usage.promptTokens, 1000);
  });
});

test('#118 estimateCost prefers the charged cost over the price table', () => {
  // A price table cannot model cache reads (0.1x) or writes (1.25x); the
  // provider's own number already has them in it, so it wins outright.
  const charged = estimateCost({
    model: 'anthropic/claude-sonnet-5',
    usage: { inputTokens: 15070, outputTokens: 2799, costUsd: 0.0346742 },
  });
  assert.equal(charged, 0.034674, 'charged cost wins, rounded to micro-dollars');

  // Absent a charged cost the table still estimates from real token counts.
  const estimated = estimateCost({
    model: 'anthropic/claude-sonnet-5',
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
  });
  assert.equal(estimated, 2, 'sonnet-5 input is $2/M, verified 2026-07-24');
});
