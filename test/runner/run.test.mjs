// test/runner/run.test.mjs — /api/run: agent adapter + archetype routing
// (Session 4), rewired in Session 5 to the full apply loop.
//
// Self-contained like the other runner tests: fixture dir in a tmpdir, the
// runner on an OS-assigned port, and a stub OpenRouter chat-completions
// server (node http, port 0) wired in via the redline.config.json endpoint
// override — NO real network calls anywhere. Covers the /api/run happy path
// (archetype → model routing, prompt contents, run record + applied edit),
// fenced-JSON parsing, classify units, config load/precedence/validation,
// locateBlock, every agent-failure lane (502, no key material leaked, doc
// restored, failed run recorded), and 404s. The deeper apply/validate/undo/
// status/telemetry coverage lives in apply.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import {
  loadConfig,
  DEFAULT_MODELS,
  DEFAULT_ENDPOINT,
  DEFAULT_RUNNER_PORT,
  DEFAULT_TIMEOUT_MS,
  CONFIG_FILENAME,
} from '../../runner/lib/config.mjs';
import { classify, ARCHETYPES } from '../../runner/lib/classify.mjs';
import { runAgent, stripFences, validateAgentPayload, promptText } from '../../runner/lib/agent.mjs';
import { locateBlock } from '../../runner/lib/surgery.mjs';

// The runner loads redline.config.json with process.env — pin the env so a
// developer's real OPENROUTER_* vars can't leak into these assertions.
// (test.mjs runs each file in its own process, so this is safe.)
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;

const CONFIG_KEY = 'cfg-test-key';
const UPSTREAM_SECRET = 'upstream-secret-detail-must-not-leak';

// Static payload for the adapter unit tests below. The end-to-end tests set
// stub.state.result per test so decisions reference the real comment id —
// Session 5's run loop fails any run whose decisions don't cover exactly the
// sent comment.
const AGENT_RESULT = {
  decisions: [
    { id: 'c-000000000000', decision: 'addressed', summary: 'Did the thing.', note: 'Details.' },
  ],
  edits: [
    { blockId: 'r-0001', newInner: 'alpha <strong>bravo</strong> charlie' },
  ],
};

function resultFor(commentId, edits = []) {
  return {
    decisions: [{ id: commentId, decision: 'addressed', summary: 'Did the thing.', note: 'Details.' }],
    edits,
  };
}

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<div data-rev="r-0002"><div>nested inner</div> tail</div>\n'
  + '<p>plain paragraph</p>\n</body></html>\n';

// --- stub OpenRouter server -------------------------------------------------

function startStub() {
  const state = { mode: 'ok', result: AGENT_RESULT, requests: [], hung: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      state.requests.push({ headers: req.headers, body: JSON.parse(body) });
      const reply = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const chat = (content) => reply({ choices: [{ message: { role: 'assistant', content } }] });
      switch (state.mode) {
        case 'ok': return chat(JSON.stringify(state.result));
        case 'fenced': return chat('```json\n' + JSON.stringify(state.result) + '\n```');
        case 'http500':
          res.writeHead(500, { 'content-type': 'text/plain' });
          return res.end(UPSTREAM_SECRET);
        case 'garbage': return chat('sure! here is my edit { not json');
        case 'shape': return chat(JSON.stringify({ decisions: 'nope' }));
        case 'badenvelope': return reply({ nothing: 'here' });
        case 'hang': return state.hung.push(res); // never respond
        default: return chat(JSON.stringify(state.result));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        server,
        url: `http://127.0.0.1:${server.address().port}/chat/completions`,
        close: () => new Promise((r) => {
          for (const res of state.hung) res.destroy();
          server.closeAllConnections?.();
          server.close(r);
        }),
      });
    });
  });
}

async function makeFixtureDir(stubUrl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-run-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: CONFIG_KEY, endpoint: stubUrl, timeoutMs: 600 },
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

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function createComment(base, page, body, anchor) {
  const res = await postJson(`${base}/api/comment`, { page, body, anchor });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}

// --- /api/run end-to-end -----------------------------------------------------

test('POST /api/run', async (t) => {
  const stub = await startStub();
  const root = await makeFixtureDir(stub.url);
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const htmlBefore = await fs.readFile(docPath);
  const runOn = (commentId) => postJson(`${base}/api/run`, { page: 'doc.html', commentId });

  const accessibilityId = await createComment(base, 'doc.html',
    'Add ARIA labels so screen readers can announce this properly.',
    { blockId: 'r-0001', quote: 'bravo', prefix: 'alpha ', suffix: ' charlie' });

  await t.test('happy path: archetype routing, prompt contents, applied edit + run record', async () => {
    stub.state.mode = 'ok';
    stub.state.result = resultFor(accessibilityId,
      [{ blockId: 'r-0001', newInner: 'alpha <strong>bravo</strong> charlie' }]);
    const res = await runOn(accessibilityId);
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.match(run.runId, /^run-[0-9a-f]{12}$/);
    assert.equal(run.archetype, 'accessibility');
    assert.equal(run.model, 'test/accessibility-model');
    assert.equal(run.status, 'ok');
    assert.equal(run.commentId, accessibilityId);
    assert.deepEqual(run.decisions, stub.state.result.decisions);
    assert.deepEqual(run.edits, [{
      blockId: 'r-0001',
      beforeInner: 'alpha bravo charlie',
      afterInner: 'alpha <strong>bravo</strong> charlie',
    }]);
    assert.ok(!Number.isNaN(Date.parse(run.createdAt)));

    const reqSeen = stub.state.requests.at(-1);
    assert.equal(reqSeen.headers.authorization, `Bearer ${CONFIG_KEY}`, 'config key on the wire');
    assert.equal(reqSeen.body.model, 'test/accessibility-model');
    const prompt = promptText(reqSeen.body.messages);
    assert.ok(prompt.includes('alpha bravo charlie'), 'prompt carries the block inner HTML');
    assert.ok(prompt.includes('r-0001'), 'prompt carries the blockId');
    assert.ok(prompt.includes('Add ARIA labels'), 'prompt carries the comment body');
    assert.ok(prompt.includes('doc.html'), 'prompt carries the page');
    assert.ok(prompt.includes('accessibility'), 'prompt carries the archetype');
    assert.ok(!prompt.includes('{{'), 'no unrendered placeholders');

    // The edit landed exactly at the block; sidecar carries record + resolution.
    const htmlAfter = await fs.readFile(docPath, 'utf8');
    assert.equal(htmlAfter,
      htmlBefore.toString('utf8').replace('alpha bravo charlie', 'alpha <strong>bravo</strong> charlie'));
    const sidecar = JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
    assert.equal(sidecar.runs.length, 1);
    assert.equal(sidecar.runs[0].runId, run.runId);
    const comment = sidecar.comments.find((c) => c.id === accessibilityId);
    assert.equal(comment.status, 'addressed');
    assert.deepEqual(comment.resolution,
      { runId: run.runId, decision: 'addressed', summary: 'Did the thing.', note: 'Details.' });
  });

  await t.test('each archetype routes to its configured model', async () => {
    stub.state.mode = 'ok';
    const cases = [
      ['Please fact-check these figures and cite sources.', 'research', 'test/research-model'],
      ['The layout feels cramped; rework the grid and increase the padding.', 'redesign', 'test/redesign-model'],
      ['Rewrite this paragraph in a warmer tone.', 'content', 'test/content-model'],
      ['Change "bravo" to "delta".', 'tactical', 'test/tactical-model'],
    ];
    for (const [body, archetype, model] of cases) {
      const id = await createComment(base, 'doc.html', body, { blockId: 'r-0001', quote: 'bravo' });
      stub.state.result = resultFor(id); // no edits — routing is what's under test
      const out = await (await runOn(id)).json();
      assert.equal(out.archetype, archetype, body);
      assert.equal(out.model, model, body);
      assert.equal(stub.state.requests.at(-1).body.model, model);
    }
  });

  await t.test('fenced JSON from the agent still parses', async () => {
    stub.state.mode = 'fenced';
    stub.state.result = resultFor(accessibilityId);
    const res = await runOn(accessibilityId);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
    stub.state.mode = 'ok';
  });

  await t.test('comment without blockId: prompt notes no stable block id', async () => {
    stub.state.mode = 'ok';
    const id = await createComment(base, 'doc.html', 'Change "plain" to "simple".',
      { quote: 'plain paragraph', prefix: 'the ', suffix: ' here' });
    stub.state.result = {
      decisions: [{ id, decision: 'declined', summary: 'No stable block id.' }],
      edits: [],
    };
    const res = await runOn(id);
    assert.equal(res.status, 200);
    const prompt = promptText(stub.state.requests.at(-1).body.messages);
    assert.ok(prompt.includes('no stable block id'), 'plain-text note present');
    assert.ok(prompt.includes('plain paragraph'), 'anchor quote present');
    assert.ok(prompt.includes('the '), 'anchor prefix present');
    // The decision maps onto the comment status.
    const sidecar = JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
    assert.equal(sidecar.comments.find((c) => c.id === id).status, 'declined');
  });

  await t.test('agent failures → 502, safe messages, doc restored, failed run recorded', async () => {
    const docBeforeFailures = await fs.readFile(docPath);
    const runsBefore = JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8')).runs.length;
    const modes = [
      ['http500', 'http'],
      ['garbage', 'parse'],
      ['shape', 'shape'],
      ['badenvelope', 'shape'],
      ['hang', 'timeout'], // config timeoutMs=600 keeps this fast
    ];
    for (const [mode, errorType] of modes) {
      stub.state.mode = mode;
      const res = await runOn(accessibilityId);
      assert.equal(res.status, 502, `mode=${mode}`);
      const text = await res.text();
      const body = JSON.parse(text);
      assert.equal(body.errorType, errorType, `mode=${mode}`);
      assert.equal(body.run.status, 'failed', `mode=${mode}`);
      assert.ok(!text.includes(CONFIG_KEY), `no API key leaked (mode=${mode})`);
      assert.ok(!text.includes(UPSTREAM_SECRET), `no upstream body leaked (mode=${mode})`);
      const docNow = await fs.readFile(docPath);
      assert.equal(Buffer.compare(docBeforeFailures, docNow), 0, `doc restored (mode=${mode})`);
    }
    stub.state.mode = 'ok';
    const sidecar = JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
    assert.equal(sidecar.runs.length, runsBefore + modes.length, 'each failure recorded');
    assert.ok(sidecar.runs.slice(-modes.length).every((r) => r.status === 'failed'));
  });

  await t.test('unknown page and unknown comment → 404; bad commentId → 400; GET → 405', async () => {
    assert.equal((await postJson(`${base}/api/run`, { page: 'nope.html', commentId: 'c-x' })).status, 404);
    assert.equal((await postJson(`${base}/api/run`, { page: 'doc.html', commentId: 'c-doesnotexist' })).status, 404);
    assert.equal((await postJson(`${base}/api/run`, { page: 'doc.html' })).status, 400);
    assert.equal((await postJson(`${base}/api/run`, { page: 'doc.html', commentId: 42 })).status, 400);
    assert.equal((await fetch(`${base}/api/run`)).status, 405);
  });

  await t.test('redline.config.json is never served (key never in an HTTP response)', async () => {
    const res = await fetch(`${base}/${CONFIG_FILENAME}`);
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes(CONFIG_KEY));
  });
});

// --- classify units -----------------------------------------------------------

test('classify heuristics', async (t) => {
  await t.test('archetype list is the five lanes', () => {
    assert.deepEqual([...ARCHETYPES].sort(),
      ['accessibility', 'content', 'redesign', 'research', 'tactical']);
  });

  await t.test('one representative body per archetype + default', () => {
    assert.equal(classify('This fails WCAG contrast; add alt text too.'), 'accessibility');
    assert.equal(classify('Can you verify this claim and add a citation?'), 'research');
    assert.equal(classify('Restructure the layout into two columns with more whitespace.'), 'redesign');
    assert.equal(classify('This is too wordy — condense and clarify.'), 'content');
    assert.equal(classify('Change the date to 2026-07-21.'), 'tactical');
    assert.equal(classify(''), 'tactical');
    assert.equal(classify(undefined), 'tactical');
  });

  await t.test('a11y wins over redesign when both vocabularies appear', () => {
    assert.equal(classify('Fix the color contrast of this style.'), 'accessibility');
  });
});

// --- config units --------------------------------------------------------------

test('loadConfig', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-cfg-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, CONFIG_FILENAME);
  const write = (obj) => fs.writeFile(configPath, typeof obj === 'string' ? obj : JSON.stringify(obj));

  await t.test('missing file → full defaults', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-cfg-empty-'));
    try {
      const cfg = await loadConfig(empty, {});
      assert.equal(cfg.runnerPort, DEFAULT_RUNNER_PORT);
      assert.equal(cfg.agent.adapter, 'openrouter');
      assert.equal(cfg.agent.apiKey, null);
      assert.equal(cfg.agent.endpoint, DEFAULT_ENDPOINT);
      assert.equal(cfg.agent.timeoutMs, DEFAULT_TIMEOUT_MS);
      assert.deepEqual(cfg.models, DEFAULT_MODELS);
      for (const archetype of ARCHETYPES) {
        assert.equal(typeof cfg.models[archetype], 'string', `default model for ${archetype}`);
      }
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  await t.test('env key wins over config key; config key used when env absent', async () => {
    await write({ agent: { apiKey: 'from-config' } });
    assert.equal((await loadConfig(dir, {})).agent.apiKey, 'from-config');
    assert.equal((await loadConfig(dir, { OPENROUTER_API_KEY: 'from-env' })).agent.apiKey, 'from-env');
  });

  await t.test('endpoint override: config beats default, env beats config', async () => {
    await write({ agent: { endpoint: 'http://127.0.0.1:9999/stub' } });
    assert.equal((await loadConfig(dir, {})).agent.endpoint, 'http://127.0.0.1:9999/stub');
    assert.equal(
      (await loadConfig(dir, { OPENROUTER_ENDPOINT: 'http://127.0.0.1:8888/env' })).agent.endpoint,
      'http://127.0.0.1:8888/env');
  });

  await t.test('partial models merge over defaults', async () => {
    await write({ models: { tactical: 'x/y' } });
    const cfg = await loadConfig(dir, {});
    assert.equal(cfg.models.tactical, 'x/y');
    assert.equal(cfg.models.redesign, DEFAULT_MODELS.redesign);
  });

  await t.test('invalid JSON and invalid shapes throw clear startup errors', async () => {
    const bad = [
      '{nope',                                        // invalid JSON
      '[1,2]',                                        // not an object
      { runnerPortt: 1 },                             // unknown top-level key
      { runnerPort: 'abc' },                          // bad type
      { runnerPort: 70000 },                          // out of range
      { agent: { adapter: 'openai' } },               // unsupported adapter
      { agent: { apiKey: 42 } },                      // bad key type
      { agent: { endpoint: 'not a url' } },           // bad endpoint
      { agent: { timeoutMs: -5 } },                   // bad timeout
      { agent: { extra: true } },                     // unknown agent key
      { models: { tactical: 42 } },                   // bad model type
      { models: { llm: 'x/y' } },                     // unknown archetype
    ];
    for (const cfg of bad) {
      await write(cfg);
      await assert.rejects(() => loadConfig(dir, {}), new RegExp(CONFIG_FILENAME),
        `config=${JSON.stringify(cfg)}`);
    }
  });
});

// --- locateBlock units -----------------------------------------------------------

test('locateBlock', async (t) => {
  await t.test('finds a simple block inner', () => {
    const block = locateBlock(DOC_HTML, 'r-0001');
    assert.equal(block.tag, 'p');
    assert.equal(block.inner, 'alpha bravo charlie');
    assert.equal(DOC_HTML.slice(block.innerStart, block.innerEnd), block.inner);
  });

  await t.test('handles nesting of the same tag', () => {
    assert.equal(locateBlock(DOC_HTML, 'r-0002').inner, '<div>nested inner</div> tail');
  });

  await t.test('missing, duplicate, malformed → null', () => {
    assert.equal(locateBlock(DOC_HTML, 'r-9999'), null);
    const dup = '<p data-rev="r-1">a</p><p data-rev="r-1">b</p>';
    assert.equal(locateBlock(dup, 'r-1'), null);
    assert.equal(locateBlock(DOC_HTML, '../etc'), null);
    assert.equal(locateBlock(DOC_HTML, ''), null);
  });
});

// --- agent adapter units -----------------------------------------------------------

test('agent adapter units', async (t) => {
  await t.test('stripFences', () => {
    assert.equal(stripFences('{"a":1}'), '{"a":1}');
    assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(stripFences('```\n{"a":1}\n```'), '{"a":1}');
    assert.equal(stripFences('  {"a":1}  '), '{"a":1}');
  });

  await t.test('validateAgentPayload shape checks', () => {
    assert.deepEqual(validateAgentPayload(AGENT_RESULT), { ...AGENT_RESULT, attributeEdits: [], inserts: [] });
    // edits/attributeEdits/inserts absent → empty; decisions may be empty
    assert.deepEqual(validateAgentPayload({ decisions: [] }), { decisions: [], edits: [], attributeEdits: [], inserts: [] });
    // inserts: exactly one of afterBlockId/beforeBlockId, html non-empty
    assert.deepEqual(
      validateAgentPayload({ decisions: [], inserts: [{ afterBlockId: 'r-1', html: '<p>x</p>' }] }),
      { decisions: [], edits: [], attributeEdits: [], inserts: [{ afterBlockId: 'r-1', html: '<p>x</p>' }] });
    assert.deepEqual(
      validateAgentPayload({ decisions: [], inserts: [{ beforeBlockId: 'r-1', html: '<p>x</p>' }] }),
      { decisions: [], edits: [], attributeEdits: [], inserts: [{ beforeBlockId: 'r-1', html: '<p>x</p>' }] });
    for (const bad of [
      null, [], 'x',
      { decisions: 'nope' },
      { decisions: [{ id: '', decision: 'addressed', summary: 's' }] },
      { decisions: [{ id: 'c-1', decision: 'done', summary: 's' }] },
      { decisions: [{ id: 'c-1', decision: 'addressed' }] },
      { decisions: [], edits: [{ blockId: 'bad id!', newInner: 'x' }] },
      { decisions: [], edits: [{ blockId: 'r-1' }] },
      { decisions: [], inserts: 'nope' },
      { decisions: [], inserts: [{ html: '<p>x</p>' }] },                                    // no anchor
      { decisions: [], inserts: [{ afterBlockId: 'r-1', beforeBlockId: 'r-2', html: 'x' }] }, // both anchors
      { decisions: [], inserts: [{ afterBlockId: 'bad id!', html: 'x' }] },
      { decisions: [], inserts: [{ afterBlockId: 'r-1' }] },                                  // no html
      { decisions: [], inserts: [{ afterBlockId: 'r-1', html: '' }] },                        // empty html
    ]) {
      assert.equal(validateAgentPayload(bad), null, JSON.stringify(bad));
    }
  });

  await t.test('network failure → typed error, never a throw', async () => {
    const result = await runAgent({
      prompt: 'x',
      model: 'test/model',
      config: { agent: { endpoint: 'http://127.0.0.1:1/nope', apiKey: null, timeoutMs: 2000 } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorType, 'network');
  });
});
