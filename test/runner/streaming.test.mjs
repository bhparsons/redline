// test/runner/streaming.test.mjs — #139: read the reply as it is written.
//
// The standard lane used to ask for the whole reply and wait, with a deadline
// on TOTAL elapsed time. That deadline cannot tell a long reply from a hung
// one, so avoiding the first meant tolerating the second: #130 raised it to
// 300 s, which is five minutes of holding the page for a connection that may
// have died in the first second.
//
// Reading the reply in pieces separates the two. The only clock after the first
// chunk is the GAP between chunks, so a reply that keeps arriving is never cut
// off however long it runs, and a silent connection is abandoned in a minute.
//
// It also changes what a give-up is worth. A non-streaming abort yields
// nothing at all — no text, and no generation id — which is exactly why a
// timed-out call could only ever be recorded as $0 (#125). A streamed abort
// hands back the partial text, the usage if it arrived, and the id, which is
// the one thing `GET /api/v1/generation?id=` needs.
//
// Self-contained: a stub SSE endpoint on an OS-assigned port. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  completeChat, runAgent, MODEL_MAX, STREAM_IDLE_MS,
} from '../../runner/lib/agent.mjs';
import { collectJson } from '../helpers/json-body.mjs';

const configFor = (url, timeoutMs = 5000) => ({ agent: { endpoint: url, apiKey: 'k', timeoutMs } });

const REPLY = {
  decisions: [{ id: 'c-1', decision: 'addressed', summary: 'Reworded.' }],
  edits: [{ blockId: 'r-a2', newInner: 'alpha reworded' }],
};

// An SSE stub with a settable script. Each entry is either a frame object or
// {stallMs} — a deliberate silence, which is how a hung provider looks.
function startStub(script) {
  const seen = {};
  const server = http.createServer(async (req, res) => {
    // An aborted stream now asks what the call cost (#125). This stub does not
    // model that — timeout-cost.test.mjs does — so answer it and move on.
    if (req.url.includes('/generation')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const parsed = await collectJson(req, res, 'sse-stub');
    if (parsed === null) return; // anomalous request logged + answered, never a crash (#244)
    seen.body = parsed;
    seen.accept = req.headers.accept;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-generation-id': 'gen-header-123',
    });
    for (const step of script) {
      if (step.stallMs) {
        await new Promise((r) => setTimeout(r, step.stallMs));
        continue;
      }
      res.write(`data: ${JSON.stringify(step)}\n\n`);
      // A keepalive comment between frames: not data, but liveness.
      res.write(': OPENROUTER PROCESSING\n\n');
      await new Promise((r) => setTimeout(r, 5));
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    seen,
    url: `http://127.0.0.1:${server.address().port}/chat/completions`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

// Split a string into n SSE content deltas, the way a real provider would.
const deltas = (text, n) => {
  const size = Math.ceil(text.length / n);
  const out = [];
  for (let i = 0; i < text.length; i += size) {
    out.push({ id: 'gen-abc', model: 'test/m', choices: [{ delta: { content: text.slice(i, i + size) } }] });
  }
  return out;
};

test('#139 the standard lane reads its reply as it arrives', async (t) => {
  await t.test('a streamed reply reassembles into the same envelope shape', async () => {
    const text = JSON.stringify(REPLY);
    const stub = await startStub([
      ...deltas(text, 8),
      { choices: [{ delta: {}, finish_reason: 'stop', native_finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 900, completion_tokens: 120, cost: 0.004 } },
    ]);
    t.after(() => stub.close());

    const capture = {};
    const out = await runAgent({ prompt: 'p', model: 'test/m', config: configFor(stub.url), capture });

    assert.equal(out.ok, true, 'a reply split across eight frames is still one reply');
    assert.equal(stub.seen.body.stream, true, 'the request asked for a stream');
    assert.equal(stub.seen.accept, 'text/event-stream');
    assert.deepEqual(out.result.edits, REPLY.edits, 'the reassembled JSON parses and validates');
    // The whole design rests on this: downstream code reads an envelope and
    // never learns which transport produced it.
    assert.equal(capture.envelope.choices[0].message.content, text);
    assert.equal(capture.envelope.choices[0].finish_reason, 'stop');
    assert.equal(out.usage.costUsd, 0.004, 'usage rides the final frame and still lands');
    assert.equal(out.usage.outputTokens, 120);
  });

  await t.test('the generation id is captured before any token is generated', async () => {
    const stub = await startStub([...deltas(JSON.stringify(REPLY), 2),
      { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    t.after(() => stub.close());

    const capture = {};
    await runAgent({ prompt: 'p', model: 'test/m', config: configFor(stub.url), capture });
    // From the response HEADER, which arrives with the status line — i.e.
    // before the model has written anything. That is what makes it survive an
    // abort, and what #125 needs.
    assert.equal(capture.generationId, 'gen-header-123');
  });

  await t.test('a stalled stream is abandoned, and hands back what it has', async (t2) => {
    // The idle clock is STREAM_IDLE_MS (a minute) in production; the test
    // passes a short one so it can stall past it in under half a second.
    const text = JSON.stringify(REPLY);
    const stub = await startStub([...deltas(text, 4).slice(0, 2), { stallMs: 400 }]);
    t2.after(() => stub.close());

    const capture = {};
    const out = await completeChat({
      prompt: 'p', model: 'test/m', config: configFor(stub.url, 1000),
      maxTokens: MODEL_MAX, stream: true, capture, idleMs: 150,
    });

    assert.equal(out.ok, false);
    assert.equal(out.errorType, 'timeout', 'an incomplete reply is still a failure — there is nothing to apply');
    // But not an empty-handed one. Every one of these was unavailable before.
    assert.ok(out.partialContent.length > 0, 'the text that did arrive comes back');
    assert.ok(text.startsWith(out.partialContent), 'and it is a genuine prefix of the intended reply');
    assert.equal(out.generationId, 'gen-header-123', 'the id #125 needs to ask what this cost');
  });

  await t.test('a provider that ignores stream:true is still understood', async () => {
    // OpenRouter fronts many providers; one answering with an ordinary JSON
    // body is a good reply in an unexpected shape, not a failure. Discarding it
    // would mean failing a call we have already paid for.
    const server = http.createServer(async (req, res) => {
      // Drain through the guard: a bare `for await` rejects on a torn-down
      // socket and takes the process with it (#244).
      if (await collectJson(req, res, 'plain-json-stub') === null) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(REPLY) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.001 },
      }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/chat/completions`;
    const out = await runAgent({ prompt: 'p', model: 'test/m', config: configFor(url) });
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });

    assert.equal(out.ok, true);
    assert.deepEqual(out.result.edits, REPLY.edits);
    assert.equal(out.usage.costUsd, 0.001);
  });

  await t.test('truncation is still detected through the stream', async () => {
    const stub = await startStub([
      ...deltas('{"decisions":[{"id":"c-1","decision":"addr', 2),
      { choices: [{ delta: {}, finish_reason: 'length', native_finish_reason: 'max_tokens' }] },
      { usage: { prompt_tokens: 900, completion_tokens: 4096, cost: 0.066 } },
    ]);
    t.after(() => stub.close());

    const out = await runAgent({ prompt: 'p', model: 'test/m', config: configFor(stub.url) });
    assert.equal(out.ok, false);
    assert.equal(out.errorType, 'truncated',
      'the reassembled envelope carries finish_reason, so #130 still works through the new transport');
    assert.equal(out.usage.costUsd, 0.066, 'and the spend is still recorded');
  });

  await t.test('the router and tactical lanes keep the simple transport', async () => {
    const stub = await startStub([]);
    t.after(() => stub.close());
    // completeChat defaults to stream:false; only runAgent opts in. Small
    // replies gain nothing from a gap-based clock, and every existing caller
    // keeps the transport it was written against.
    await completeChat({
      prompt: 'p', model: 'test/m', config: configFor(stub.url), maxTokens: 300,
    }).catch(() => {});
    assert.ok(!('stream' in stub.seen.body), 'no stream flag on the non-streaming path');
  });
});
