// test/runner/reasoning-effort.test.mjs — #83 part 2: per-model thinking effort.
//
// OpenRouter takes a top-level `reasoning` object on /chat/completions
// (`{effort}` | `{max_tokens}` | `{enabled}` | `{exclude}`), and both configured
// tier models list `reasoning` in their `supported_parameters`. Nothing in the
// runner sent one before this, which is not the same as "no thinking happened":
// OpenRouter reports anthropic/claude-sonnet-5 with `default_effort: "high"`,
// so every standard/complex run bought high-effort thinking by default.
//
// The trap these tests exist to nail down is the OTHER tier. Flash measured
// ZERO reasoning tokens per run (design/cost-model.md), and OpenRouter infers
// `enabled` from `effort`/`max_tokens` — so "lower the simple tier's effort" by
// sending it a reasoning object would switch thinking ON and RAISE the cheapest
// lane's bill. The correct floor for a model that does no reasoning is to send
// no reasoning field at all, and that is asserted here as a wire-level fact.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { completeChat, reasoningFor } from '../../runner/lib/agent.mjs';
import { DEFAULT_MODEL_TIERS, DEFAULT_MODEL_REASONING } from '../../runner/config/defaults.mjs';

const SONNET = 'anthropic/claude-sonnet-5';
const FLASH = 'google/gemini-2.5-flash';

// --- the map -----------------------------------------------------------------

test('reasoningFor lowers the model that reasons and leaves the one that does not', () => {
  assert.deepEqual(reasoningFor(SONNET), { effort: 'low' },
    'sonnet-5 defaults to effort "high" upstream — we ask for the floor instead');
  assert.equal(reasoningFor(FLASH), null,
    'flash emits 0 reasoning tokens; sending a reasoning object would turn thinking ON');
  assert.equal(reasoningFor('openai/gpt-5.2'), null, 'unmapped model → unchanged behavior');
  for (const odd of [null, undefined, 7, {}]) assert.equal(reasoningFor(odd), null);
});

test('the map covers the tier ladder without inventing entries for it', () => {
  // standard and complex resolve to the same model today, so a model-keyed map
  // is not lossy — but if the ladder ever grows a third model, an unmapped one
  // must fail open (no field) rather than inherit someone else's effort.
  assert.equal(DEFAULT_MODEL_TIERS.simple, FLASH);
  assert.equal(DEFAULT_MODEL_TIERS.standard, SONNET);
  assert.deepEqual(Object.keys(DEFAULT_MODEL_REASONING), [SONNET],
    'only the model with measured reasoning tokens carries an entry');
  for (const tier of Object.values(DEFAULT_MODEL_TIERS)) {
    const r = reasoningFor(tier);
    assert.ok(r === null || typeof r === 'object', tier);
  }
});

// --- the wire ----------------------------------------------------------------

function startStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      seen,
      url: `http://127.0.0.1:${server.address().port}/chat/completions`,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

test('the request body carries reasoning per model, and omits the field entirely otherwise', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const config = { agent: { endpoint: stub.url, apiKey: 'k', timeoutMs: 2000 } };
  const call = (model, extra = {}) => completeChat({ prompt: 'p', model, config, maxTokens: 100, ...extra });

  assert.equal((await call(SONNET)).ok, true);
  assert.deepEqual(stub.seen.at(-1).reasoning, { effort: 'low' });

  assert.equal((await call(FLASH)).ok, true);
  assert.equal('reasoning' in stub.seen.at(-1), false,
    'no reasoning KEY at all — an object here would enable thinking that costs money');

  // An explicit argument wins over the map, in both directions.
  await call(FLASH, { reasoning: { effort: 'high' } });
  assert.deepEqual(stub.seen.at(-1).reasoning, { effort: 'high' });
  await call(SONNET, { reasoning: null });
  assert.equal('reasoning' in stub.seen.at(-1), false, 'null suppresses the per-model default');

  // Nothing else about the request moved (#130 ceiling, #116 cache shape, cost).
  const body = stub.seen.at(-1);
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.temperature, 0.2);
});

test('the capture hook records the reasoning field, so a trace shows what was bought', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const capture = {};
  await completeChat({
    prompt: 'p', model: SONNET, maxTokens: 50, capture,
    config: { agent: { endpoint: stub.url, apiKey: 'k', timeoutMs: 2000 } },
  });
  assert.deepEqual(capture.request.reasoning, { effort: 'low' });
});
