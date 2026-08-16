// test/runner/output-ceiling.test.mjs — #130: the standard lane's output ceiling.
//
// The bug was not a number, it was an ABSENCE. `completeChat` defaulted
// maxTokens to 4096; the router passed 300 on purpose and the tactical lane
// passed 4096 on purpose, but the standard lane — whose reply is full
// replacement inner HTML for every block it touches — passed nothing and
// inherited a ceiling chosen for nobody. Two consequences, both tested here:
//
//   1. Large multi-block edits were cut off mid-JSON. The runner never read
//      `finish_reason`, so the unterminated reply failed JSON.parse and
//      surfaced as errorType 'parse' + HTTP 502 — a budget WE set, reported to
//      the author as an upstream gateway failure.
//   2. Those output tokens were generated and billed. Usage accrued only when
//      the call succeeded, so the one failure that costs money and produces
//      nothing recorded $0 — the same blind spot #124/#128 closed for declined
//      confirmations.
//
// The structural fix is that maxTokens is now REQUIRED: a future lane cannot
// silently inherit anyone else's ceiling, because there is nothing to inherit.
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
import {
  promptText, completeChat, isTruncated, STANDARD_MAX_TOKENS, MODEL_MAX,
} from '../../runner/lib/agent.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;
delete process.env.REDLINE_OTEL_ENDPOINT;
process.env.REDLINE_TRACE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-ceiling-trace-'));

const DOC = [
  '<!doctype html><html><head><title>t</title></head><body>',
  '<section data-rev="r-secA"><h2 data-rev="r-a1">Section A</h2><p data-rev="r-a2">alpha body</p></section>',
  '</body></html>',
].join('\n');

const ROUTER_USAGE = { prompt_tokens: 400, completion_tokens: 20, cost: 0.00024 };
// A truncated reply is billed for what it DID generate — here, the full
// ceiling, which is what running into it looks like.
const TRUNCATED_USAGE = { prompt_tokens: 9000, completion_tokens: 16384, cost: 0.42 };
const OK_USAGE = { prompt_tokens: 1000, completion_tokens: 100, cost: 0.01 };

const STANDARD_ROUTE = {
  archetype: 'redesign', scope: 'section', tier: 'standard', canTactical: false, skills: [],
};

function startStub() {
  const state = { revise: null, truncate: false, reviseRequest: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const text = promptText(parsed.messages);
      const send = (content, usage, finishReason) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: { role: 'assistant', content },
            ...(finishReason ? { finish_reason: finishReason } : {}),
          }],
          usage,
        }));
      };
      if (text.startsWith('# Redline comment router')) {
        return send(JSON.stringify(STANDARD_ROUTE), ROUTER_USAGE, 'stop');
      }
      state.reviseRequest = parsed;
      if (state.truncate) {
        // What a real cut-off reply looks like: valid JSON up to the point the
        // ceiling stopped generation, and nothing after it.
        return send('{"decisions":[{"id":"c-1","decision":"addressed","summary":"Rew',
          TRUNCATED_USAGE, 'length');
      }
      return send(JSON.stringify(state.revise), OK_USAGE, 'stop');
    });
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

test('#130 the standard lane chooses its output ceiling, and says so when it hits it', async (t) => {
  await t.test('maxTokens is required — no lane can inherit a default', async () => {
    // The actual defect, in one assertion: before this, omitting maxTokens was
    // legal and silently meant 4096.
    await assert.rejects(
      () => completeChat({ prompt: 'x', model: 'm', config: { agent: {} } }),
      /maxTokens is required/,
    );
    for (const bad of [0, -1, 4096.5, '16384', null, 'unlimited']) {
      await assert.rejects(
        () => completeChat({ prompt: 'x', model: 'm', config: { agent: {} }, maxTokens: bad }),
        /maxTokens is required/,
        `maxTokens ${JSON.stringify(bad)} must be rejected`,
      );
    }
  });

  await t.test('isTruncated reads both finish_reason spellings, and nothing else', () => {
    assert.equal(isTruncated({ choices: [{ finish_reason: 'length' }] }), true);
    assert.equal(isTruncated({ choices: [{ native_finish_reason: 'length' }] }), true,
      'OpenRouter also normalizes the upstream reason into native_finish_reason');
    assert.equal(isTruncated({ choices: [{ finish_reason: 'stop' }] }), false);
    assert.equal(isTruncated({ choices: [{}] }), false, 'absent is not truncated');
    assert.equal(isTruncated({ choices: [] }), false);
    assert.equal(isTruncated(null), false);
    assert.equal(isTruncated({}), false);
  });

  const stub = await startStub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-ceiling-'));
  await fs.writeFile(path.join(root, 'doc.html'), DOC);
  await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'k', endpoint: stub.url, timeoutMs: 5000 },
    telemetry: { endpoint: null },
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

  await t.test('the standard lane sends the chosen ceiling on the wire', async () => {
    stub.state.truncate = false;
    const cid = await comment('Reword this paragraph.', { blockId: 'r-a2', quote: 'alpha body' });
    stub.state.revise = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'Reworded.' }],
      edits: [{ blockId: 'r-a2', newInner: 'alpha body reworded' }],
    };
    const run = await (await post(`${base}/api/run`, { page: 'doc.html', commentId: cid })).json();
    assert.equal(run.status, 'ok');
    assert.equal(STANDARD_MAX_TOKENS, MODEL_MAX,
      'the standard lane imposes no ceiling of its own (Blake, 2026-07-27)');
    assert.ok(!('max_tokens' in stub.state.reviseRequest),
      'the field is how you impose a ceiling, so imposing none means not sending it');
    assert.equal(run.usage.maxTokens, MODEL_MAX,
      'the run still records WHICH ceiling was in force — "none of ours" is a fact too');
  });

  await t.test('a truncated reply reports as truncation, not as a gateway failure', async () => {
    stub.state.truncate = true;
    const cid = await comment('Rewrite every section.', { blockId: 'r-a2', quote: 'alpha body' });
    const res = await post(`${base}/api/run`, { page: 'doc.html', commentId: cid });

    assert.equal(res.status, 500, 'our ceiling stopped our request — 502 blamed the provider');
    // A hard failure wraps the record in an error envelope: {error, errorType, run}.
    const body = await res.json();
    assert.equal(body.run.status, 'failed');
    assert.equal(body.errorType, 'truncated',
      'not "parse": the JSON is unterminated because generation was cut off, which is a different bug');
    assert.match(body.error, /model's own output maximum/,
      'under MODEL_MAX there is no number of ours to name — say whose limit it was');
  });

  await t.test('the truncated call is billed, so the run records its cost', async () => {
    const { runs } = await sidecar();
    const failed = runs.find((r) => r.status === 'failed');
    assert.ok(failed, 'the failed run is in the run log');
    assert.equal(failed.usage.costUsd, TRUNCATED_USAGE.cost,
      'spend with nothing to show for it is the spend most worth seeing');
    assert.equal(failed.usage.outputTokens, TRUNCATED_USAGE.completion_tokens);
    assert.equal(failed.usage.maxTokens, MODEL_MAX);
  });

  await t.test('the document is untouched and the comment stays open', async () => {
    const html = await fs.readFile(path.join(root, 'doc.html'), 'utf8');
    assert.match(html, /alpha body reworded/, 'the earlier successful edit survives');
    const { comments } = await sidecar();
    const last = comments.at(-1);
    assert.notEqual(last.status, 'addressed', 'a truncated run resolves nothing');
  });
});
