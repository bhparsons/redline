// test/runner/prompt-cache.test.mjs — #116: order the prompt stable-prefix
// first and put the cache breakpoint on the wire. #123: cache the CONTRACT
// only.
//
// Every run measured before #116 reported cachedTokens: 0 — the runner paid
// full price for the whole prompt every time, including the parts that never
// change. Two separate causes:
//
//   1. ORDER. The prompt rendered comment → section view → document →
//      contract, so the two largest and most stable sections sat AFTER
//      per-run content and no prefix could ever match.
//   2. MECHANISM. OpenRouter does not infer a prefix uniformly: OpenAI,
//      DeepSeek and Grok cache automatically, but Anthropic and Google Gemini
//      only cache what a request explicitly marks with
//      `cache_control: {type:'ephemeral'}` on a structured content block. Our
//      standard tier is anthropic/claude-sonnet-5, so ordering alone would
//      have changed nothing.
//
// #116 put the DOCUMENT in the cached prefix as well, and measured a 78%
// prompt-side saving against an unchanged page. In the real workflow the page
// is never unchanged — every successful run edits it — so run N+1 missed and
// paid a 1.25x cache-WRITE premium for an entry nothing would read: +21.7%
// against sending no cache_control at all. #123 moved the document (and the
// page name) after the breakpoint. What remains cached is the response
// contract: ~6.8 KB that is invariant across runs AND across pages, so one
// entry serves every revise call the runner makes.
//
// These tests pin the exact wire payload (message shape, block ordering,
// cache_control placement, byte-identical text) and the two properties that
// make caching pay: the cacheable prefix is identical across runs on
// DIFFERENT pages, and nothing that changes per run rides inside it.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import {
  buildMessages, promptText, cacheBreakpoint, needsCacheBreakpoint,
  CACHE_BREAKPOINT_MARKER, MIN_CACHE_PREFIX_CHARS,
} from '../../runner/lib/agent.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = path.join(REPO_ROOT, 'runner', 'prompts', 'revise.md');

const PAD = 'x'.repeat(MIN_CACHE_PREFIX_CHARS);
const CACHEABLE_MODEL = 'anthropic/claude-sonnet-5';
const AUTO_CACHE_MODEL = 'openai/gpt-5.2';

// --- units: where the prefix ends --------------------------------------------

test('cacheBreakpoint finds the end of the stable prefix', () => {
  const prompt = `${PAD}\n${CACHE_BREAKPOINT_MARKER}\nvolatile tail`;
  const cut = cacheBreakpoint(prompt);
  assert.equal(prompt.slice(0, cut).endsWith(CACHE_BREAKPOINT_MARKER), true);
  assert.equal(prompt.slice(cut), '\nvolatile tail');
});

test('cacheBreakpoint declines when there is nothing to cache', () => {
  assert.equal(cacheBreakpoint(`${PAD} no marker here`), null, 'no marker');
  assert.equal(cacheBreakpoint(`short ${CACHE_BREAKPOINT_MARKER} tail`), null,
    'prefix below every provider cache minimum');
  assert.equal(cacheBreakpoint(`${PAD}${CACHE_BREAKPOINT_MARKER}`), null,
    'marker at the very end leaves an empty volatile block');
  for (const odd of [null, undefined, 42, {}]) assert.equal(cacheBreakpoint(odd), null);
});

test('cacheBreakpoint takes the FIRST marker, so page content cannot drag the split forward', () => {
  // Since #123 every substituted value renders AFTER the template's sentinel,
  // so the first occurrence is always the template's own. A document that
  // happens to contain the sentinel can only add later ones, and they must
  // not pull page content into the "stable" prefix.
  const prompt = `${PAD}${CACHE_BREAKPOINT_MARKER}\ndocument text ${PAD}`
    + `${CACHE_BREAKPOINT_MARKER}\nvolatile tail`;
  assert.equal(cacheBreakpoint(prompt), prompt.indexOf(CACHE_BREAKPOINT_MARKER) + CACHE_BREAKPOINT_MARKER.length);
  assert.equal(prompt.slice(0, cacheBreakpoint(prompt)).includes('document text'), false);
});

test('needsCacheBreakpoint: only providers whose caching is opt-in', () => {
  for (const model of ['anthropic/claude-sonnet-5', 'anthropic/claude-opus-4-8', 'google/gemini-2.5-flash']) {
    assert.equal(needsCacheBreakpoint(model), true, model);
  }
  for (const model of ['openai/gpt-5.2', 'deepseek/deepseek-chat', 'x-ai/grok-4', 'test/model', null, undefined, 7]) {
    assert.equal(needsCacheBreakpoint(model), false, String(model));
  }
});

// --- units: the wire payload -------------------------------------------------

test('buildMessages marks the prefix cacheable for an explicit-breakpoint model', () => {
  const prompt = `${PAD}\n${CACHE_BREAKPOINT_MARKER}\nvolatile tail`;
  const messages = buildMessages(prompt, CACHEABLE_MODEL);

  assert.equal(messages.length, 1, 'still one user message');
  assert.equal(messages[0].role, 'user');
  assert.ok(Array.isArray(messages[0].content), 'content is a block array');
  assert.equal(messages[0].content.length, 2, 'exactly one breakpoint');

  const [stable, volatile] = messages[0].content;
  assert.deepEqual(stable, {
    type: 'text',
    text: prompt.slice(0, cacheBreakpoint(prompt)),
    cache_control: { type: 'ephemeral' },
  });
  assert.deepEqual(volatile, { type: 'text', text: '\nvolatile tail' });
  assert.equal(volatile.cache_control, undefined, 'only the prefix is a breakpoint');
  assert.equal(stable.text + volatile.text, prompt, 'the text on the wire is byte-identical');
});

test('buildMessages leaves the request shape alone when no breakpoint is needed', () => {
  const prompt = `${PAD}\n${CACHE_BREAKPOINT_MARKER}\nvolatile tail`;
  // Auto-caching provider: reordering already does the work, so we do not
  // send a field its normalizer may not expect.
  assert.deepEqual(buildMessages(prompt, AUTO_CACHE_MODEL), [{ role: 'user', content: prompt }]);
  // No marker (the router and tactical prompts): plain string, as before.
  assert.deepEqual(buildMessages('no marker at all', CACHEABLE_MODEL),
    [{ role: 'user', content: 'no marker at all' }]);
  assert.deepEqual(buildMessages(prompt, null), [{ role: 'user', content: prompt }]);
});

test('promptText reads back either shape losslessly', () => {
  const prompt = `${PAD}\n${CACHE_BREAKPOINT_MARKER}\nvolatile tail`;
  assert.equal(promptText(buildMessages(prompt, CACHEABLE_MODEL)), prompt);
  assert.equal(promptText(buildMessages(prompt, AUTO_CACHE_MODEL)), prompt);
  assert.equal(promptText([]), '');
  assert.equal(promptText(null), '');
  assert.equal(promptText([{ role: 'user', content: [{ type: 'image_url' }, { type: 'text', text: 'a' }] }]), 'a');
});

// --- the template's section order --------------------------------------------

test('revise.md caches the contract and nothing else (#123)', async () => {
  const template = await fs.readFile(TEMPLATE, 'utf8');
  const marker = template.indexOf(CACHE_BREAKPOINT_MARKER);
  assert.notEqual(marker, -1, 'the template carries the breakpoint sentinel');
  assert.equal(template.lastIndexOf(CACHE_BREAKPOINT_MARKER), marker, 'exactly one sentinel');

  const at = (needle) => {
    const i = template.indexOf(needle);
    assert.notEqual(i, -1, `template contains ${needle}`);
    return i;
  };
  // Invariant forever, and across pages: the response contract.
  for (const stable of ['## Your task', 'Respond with ONLY a single JSON object']) {
    assert.ok(at(stable) < marker, `${stable} must sit in the cacheable prefix`);
  }
  // Everything substituted per run — the document included (#123) — must sit
  // AFTER the breakpoint. NO placeholder may render inside the prefix, which
  // is what makes one cache entry serve every page.
  for (const volatile of [
    '## Document source', '{{DOC}}', '{{PAGE}}', '## Reviewer comment',
    '{{COMMENT}}', '{{ARCHETYPE}}', '{{BLOCK_HTML}}', '{{CONTEXT}}', '{{COMMENT_ID}}',
  ]) {
    assert.ok(at(volatile) > marker, `${volatile} must sit after the breakpoint`);
  }
  assert.equal(/\{\{[A-Z_]+\}\}/.test(template.slice(0, marker)), false,
    'the cacheable prefix carries no placeholder at all');
  // Worth caching at all: past the 4 KB floor that clears Sonnet's 1,024-token
  // minimum. If the contract ever shrinks below it, caching silently stops.
  assert.ok(marker > MIN_CACHE_PREFIX_CHARS,
    `contract prefix clears the cache minimum: ${marker} chars`);
  // The document still comes before the comment — an auto-caching provider
  // infers its own prefix, and recency should belong to the ask.
  assert.ok(at('{{DOC}}') < at('## Reviewer comment'));
  // Recency: the JSON-only contract is restated at the very end, since the
  // full contract is now far from the reply.
  assert.ok(at('## Reply now') > at('{{CONTEXT}}'));
  assert.ok(template.trimEnd().endsWith('`{{COMMENT_ID}}`.'), 'the last line pins the comment id');
});

// --- end to end: two runs, one identical cacheable prefix --------------------

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<p data-rev="r-0002">delta echo foxtrot</p>\n</body></html>\n';

function startStub() {
  const state = { revise: [], result: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const prompt = promptText(parsed.messages);
      if (prompt.startsWith('# Redline revise run')) state.revise.push(parsed);
      // Router calls get the same reply; it fails validateRoute, so the
      // runner falls back to its keyword classifier (source: 'fallback').
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(state.result) } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 90 } },
      }));
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

// A DIFFERENT page in the same root: the cacheable prefix must be identical
// for it too, so one cache entry serves every page the runner reviews (#123).
const OTHER_HTML = '<!doctype html>\n<html><head><title>other</title></head>\n<body>\n'
  + '<p data-rev="r-1001">golf hotel india</p>\n</body></html>\n';

async function fixture(stubUrl, model) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-cache-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, 'other.html'), OTHER_HTML);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'cfg-test-key', endpoint: stubUrl, timeoutMs: 2000 },
    telemetry: { endpoint: null },
    models: {
      tactical: model, redesign: model, research: model, accessibility: model, content: model,
    },
  }, null, 2));
  return dir;
}

const postJson = (url, payload) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

async function comment(base, body, anchor, page = 'doc.html') {
  const res = await postJson(`${base}/api/comment`, { page, body, anchor });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}

test('every run sends the same cacheable prefix — the contract, and only the contract', async (t) => {
  const stub = await startStub();
  const root = await fixture(stub.url, CACHEABLE_MODEL);
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  // Three runs: two comments on one page (the second sees an EDITED page —
  // the workflow case #116 could never cache), then a comment on a DIFFERENT
  // page. All three must send the same cacheable prefix.
  const first = await comment(base, 'Add ARIA labels so a screen reader announces this.',
    { blockId: 'r-0001', quote: 'bravo' });
  stub.state.result = {
    decisions: [{ id: first, decision: 'addressed', summary: 'Labelled.' }],
    edits: [{ blockId: 'r-0001', newInner: 'alpha bravo charlie delta' }],
  };
  assert.equal((await postJson(`${base}/api/run`, { page: 'doc.html', commentId: first })).status, 200);

  const second = await comment(base, 'This needs an accessible name for screen reader users too.',
    { blockId: 'r-0002', quote: 'echo' });
  stub.state.result = { decisions: [{ id: second, decision: 'deferred', summary: 'Noted.' }], edits: [] };
  assert.equal((await postJson(`${base}/api/run`, { page: 'doc.html', commentId: second })).status, 200);

  const third = await comment(base, 'Give this an accessible name as well, please.',
    { blockId: 'r-1001', quote: 'hotel' }, 'other.html');
  stub.state.result = { decisions: [{ id: third, decision: 'deferred', summary: 'Noted.' }], edits: [] };
  assert.equal((await postJson(`${base}/api/run`, { page: 'other.html', commentId: third })).status, 200);

  assert.equal(stub.state.revise.length, 3, 'one revise call per run');
  const [a, b, c] = stub.state.revise;

  for (const req of [a, b, c]) {
    assert.equal(req.model, CACHEABLE_MODEL);
    assert.deepEqual(req.usage, { include: true }, 'cost reporting survives the new shape');
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, 'user');
    assert.equal(req.messages[0].content.length, 2);
    assert.deepEqual(req.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.equal(req.messages[0].content[1].cache_control, undefined);
  }

  const prefix = (req) => req.messages[0].content[0].text;
  const tail = (req) => req.messages[0].content[1].text;

  // THE point of #123: the prefix survives an EDIT to the page (run b) and a
  // change of page entirely (run c). One cache entry, read by every run.
  assert.equal(prefix(a), prefix(b), 'an edited page must not invalidate the prefix');
  assert.equal(prefix(a), prefix(c), 'a different page must not invalidate the prefix');
  assert.ok(prefix(a).length > MIN_CACHE_PREFIX_CHARS, `prefix is worth caching: ${prefix(a).length} chars`);
  assert.notEqual(tail(a), tail(b), 'the per-comment tail differs');

  // The prefix carries the contract and NOTHING page- or comment-specific.
  assert.ok(prefix(a).includes('Respond with ONLY a single JSON object'), 'contract is inside the prefix');
  assert.ok(!prefix(a).includes('alpha bravo charlie'), 'the document is NOT inside the prefix (#123)');
  assert.ok(!prefix(a).includes('doc.html'), 'the page name is NOT inside the prefix');
  assert.ok(!prefix(a).includes('Add ARIA labels'), 'no per-comment content in the prefix');
  // ...and everything volatile rides in the tail.
  assert.ok(tail(a).includes('alpha bravo charlie'), 'document source is in the tail');
  assert.ok(tail(a).includes('r-0002'), 'the whole document, not just the anchored block');
  assert.ok(tail(a).includes('Add ARIA labels'), 'the comment rides in the tail');
  assert.ok(tail(a).includes(first), 'the tail names the comment id');

  const whole = promptText(a.messages);
  assert.ok(!whole.includes('{{'), 'no unrendered placeholders');

  // The manifest records what the provider billed, so cachedShare is
  // observable per run (#94) — the acceptance signal for this ticket.
  const sidecar = JSON.parse(await fs.readFile(path.join(root, 'doc.html.review.json'), 'utf8'));
  const usage = sidecar.runs.at(-1).context.usage;
  assert.equal(usage.cachedTokens, 90);
  assert.equal(usage.cachedShare, 0.9);
});

test('an auto-caching provider keeps the plain string payload, still stable-first', async (t) => {
  const stub = await startStub();
  const root = await fixture(stub.url, AUTO_CACHE_MODEL);
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const id = await comment(base, 'Add ARIA labels so a screen reader announces this.',
    { blockId: 'r-0001', quote: 'bravo' });
  stub.state.result = { decisions: [{ id, decision: 'deferred', summary: 'Noted.' }], edits: [] };
  assert.equal((await postJson(`${base}/api/run`, { page: 'doc.html', commentId: id })).status, 200);

  const req = stub.state.revise.at(-1);
  assert.equal(typeof req.messages[0].content, 'string', 'unchanged wire shape');
  const prompt = req.messages[0].content;
  // Ordering still holds — an inferred prefix needs it just as much.
  assert.ok(prompt.indexOf('## Document source') < prompt.indexOf('## Reviewer comment'));
  assert.ok(prompt.indexOf('## Your task') < prompt.indexOf('## Reviewer comment'));
  assert.ok(prompt.indexOf('## Reviewer comment') < prompt.indexOf('## Context'));
});
