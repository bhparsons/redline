// test/runner/cost.test.mjs — WP0: cost capture.
//
// The agent adapter must (a) ask OpenRouter to include usage on every request
// and (b) surface the charged cost as usage.costUsd — sourced from the
// envelope's usage.cost — so the runner can sum it onto the run record and the
// agent-request span. When no provider returns a cost, costUsd stays absent
// rather than being invented.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { completeChat, runAgent, STANDARD_MAX_TOKENS } from '../../runner/lib/agent.mjs';

// A one-shot OpenRouter stub: captures the last request body and replies with
// a caller-supplied envelope.
function startStub(envelope) {
  const seen = { body: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { seen.body = JSON.parse(body); } catch { seen.body = null; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(envelope));
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

const configFor = (url) => ({ agent: { endpoint: url, apiKey: 'stub-key', timeoutMs: 5000 } });

const REVISE_REPLY = JSON.stringify({
  decisions: [{ id: 'c-1', decision: 'addressed', summary: 'done' }],
  edits: [],
  inserts: [],
});

test('completeChat requests usage inclusion and extracts costUsd from usage.cost', async (t) => {
  const stub = await startStub({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 120, completion_tokens: 45, cost: 0.00234 },
  });
  t.after(() => stub.close());

  const res = await completeChat({ prompt: 'hi', model: 'stub/model', config: configFor(stub.url), maxTokens: STANDARD_MAX_TOKENS });
  assert.equal(res.ok, true);
  assert.deepEqual(stub.seen.body.usage, { include: true }, 'request opts into usage accounting');
  assert.equal(res.usage.inputTokens, 120);
  assert.equal(res.usage.outputTokens, 45);
  assert.equal(res.usage.costUsd, 0.00234, 'costUsd sourced from envelope usage.cost');
});

test('runAgent propagates costUsd on a valid revise reply', async (t) => {
  const stub = await startStub({
    choices: [{ message: { role: 'assistant', content: REVISE_REPLY } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
  });
  t.after(() => stub.close());

  const res = await runAgent({ prompt: 'hi', model: 'stub/model', config: configFor(stub.url) });
  assert.equal(res.ok, true);
  assert.equal(res.usage.costUsd, 0.0001);
});

test('costUsd is absent when the provider returns no cost', async (t) => {
  const stub = await startStub({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }, // no cost field
  });
  t.after(() => stub.close());

  const res = await completeChat({ prompt: 'hi', model: 'stub/model', config: configFor(stub.url), maxTokens: STANDARD_MAX_TOKENS });
  assert.equal(res.ok, true);
  assert.equal('costUsd' in res.usage, false, 'no cost is invented');
  assert.equal(res.usage.inputTokens, 10);
});

test('a non-numeric cost is ignored', async (t) => {
  const stub = await startStub({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 'free' },
  });
  t.after(() => stub.close());

  const res = await completeChat({ prompt: 'hi', model: 'stub/model', config: configFor(stub.url), maxTokens: STANDARD_MAX_TOKENS });
  assert.equal(res.ok, true);
  assert.equal('costUsd' in res.usage, false);
});
