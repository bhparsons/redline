// test/runner/timeout-cost.test.mjs — #125: a timed-out call is billed, so record it.
//
// The last hole in "every call that spends money is on a record". #124 closed
// the router call, #128 the declined confirmation, #130 the truncated reply.
// This one is the timeout, and it was the hardest because the number simply
// never reached us: we hung up before the reply finished, so no usage block
// ever arrived, while upstream the tokens were written and charged.
//
// It could not be fixed before #139. A non-streaming abort leaves nothing at
// all in hand — no text and, crucially, no generation id — and
// `GET /api/v1/generation?id=` is the only way to ask what a call cost after
// the fact. No id, nothing to look up. Streaming surfaces the id with the
// response headers, before a single token is written.
//
// Self-contained: stub SSE endpoint + stub generation endpoint. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  completeChat, generationUrl, fetchGenerationUsage, MODEL_MAX,
} from '../../runner/lib/agent.mjs';

const REPLY = '{"decisions":[{"id":"c-1","decision":"addressed","summary":"Done."}],"edits":[]}';

// Serves both the streaming completions endpoint and the generation lookup, so
// a test can stall the first and answer the second.
function startStub({ stallAfter = 2, generation = null, generationStatus = 200 } = {}) {
  const seen = { lookups: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.endsWith('/generation')) {
      seen.lookups.push(url.searchParams.get('id'));
      res.writeHead(generationStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(generation ?? {}));
      return;
    }
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-generation-id': 'gen-timeout-7',
    });
    const size = Math.ceil(REPLY.length / 6);
    for (let i = 0; i < stallAfter; i += 1) {
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: REPLY.slice(i * size, (i + 1) * size) } }],
      })}\n\n`);
      await new Promise((r) => setTimeout(r, 5));
    }
    // ...and then nothing. The connection stays open and silent, which is
    // exactly what a stuck provider looks like from here.
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    seen,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

const configFor = (base) => ({
  agent: { endpoint: `${base}/chat/completions`, apiKey: 'k', timeoutMs: 2000 },
});

const GENERATION = {
  data: {
    id: 'gen-timeout-7',
    total_cost: 0.0413,
    tokens_prompt: 14822,
    tokens_completion: 2140,
    native_tokens_completion: 2140,
  },
};

test('#125 a timed-out call has its true cost recovered by generation id', async (t) => {
  await t.test('the lookup URL is derived, never guessed', () => {
    assert.equal(generationUrl('https://openrouter.ai/api/v1/chat/completions'),
      'https://openrouter.ai/api/v1/generation');
    // Anything that is not the shape we know returns null rather than a
    // constructed URL: posting an API key at a guessed address is worse than
    // not knowing what a call cost.
    assert.equal(generationUrl('https://example.com/v1/responses'), null);
    assert.equal(generationUrl(''), null);
    assert.equal(generationUrl(undefined), null);
  });

  await t.test('a stalled stream records the cost the provider actually charged', async () => {
    const stub = await startStub({ generation: GENERATION });
    t.after(() => stub.close());

    const out = await completeChat({
      prompt: 'p', model: 'test/m', config: configFor(stub.base),
      maxTokens: MODEL_MAX, stream: true, idleMs: 150,
    });

    assert.equal(out.ok, false);
    assert.equal(out.errorType, 'timeout');
    // The point of the whole exercise: this used to be absent, and the run
    // recorded $0 for a call that cost four cents.
    assert.equal(out.usage.costUsd, 0.0413);
    assert.equal(out.usage.inputTokens, 14822);
    assert.equal(out.usage.outputTokens, 2140);
    assert.equal(out.usageSource, 'generation-lookup',
      'a cost asked for afterwards is real, but it is not the same kind of fact as one the reply reported');
    assert.deepEqual(stub.seen.lookups, ['gen-timeout-7'], 'asked once, by the id from the response header');
  });

  await t.test('a failed lookup leaves the run failed, not differently failed', async () => {
    // Diagnostics must never change an outcome. If the lookup 500s, we simply
    // do not learn the cost — the same position we were in before #125.
    const stub = await startStub({ generationStatus: 500 });
    t.after(() => stub.close());

    const out = await completeChat({
      prompt: 'p', model: 'test/m', config: configFor(stub.base),
      maxTokens: MODEL_MAX, stream: true, idleMs: 150,
    });

    assert.equal(out.ok, false);
    assert.equal(out.errorType, 'timeout', 'still a timeout, not a lookup error');
    assert.equal(out.usage, undefined, 'no invented number');
    assert.equal(out.usageSource, undefined);
    assert.equal(stub.seen.lookups.length, 2, 'retried once, then gave up');
  });

  await t.test('fetchGenerationUsage refuses to run without both halves', async () => {
    const stub = await startStub({ generation: GENERATION });
    t.after(() => stub.close());
    const config = configFor(stub.base);

    assert.equal(await fetchGenerationUsage({ config, generationId: '' }), null);
    assert.equal(await fetchGenerationUsage({ config, generationId: undefined }), null);
    assert.equal(await fetchGenerationUsage({
      config: { agent: { endpoint: 'https://example.com/v1/responses' } }, generationId: 'gen-1',
    }), null);
    assert.equal(stub.seen.lookups.length, 0, 'no request goes out when either half is missing');
  });

  await t.test('a partial reply comes back alongside the cost', async () => {
    const stub = await startStub({ stallAfter: 3, generation: GENERATION });
    t.after(() => stub.close());

    const out = await completeChat({
      prompt: 'p', model: 'test/m', config: configFor(stub.base),
      maxTokens: MODEL_MAX, stream: true, idleMs: 150,
    });

    assert.ok(out.partialContent.length > 0);
    assert.ok(REPLY.startsWith(out.partialContent), 'a genuine prefix of the intended reply');
    // Not applied — an incomplete reply is unusable JSON, and the runner is the
    // only writer. Recovering the WORK is #140, deliberately not this ticket.
    assert.equal(out.ok, false);
    assert.equal(out.usage.costUsd, 0.0413);
  });
});
