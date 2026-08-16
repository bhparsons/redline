// test/runner/router.test.mjs — WP3: tiered model config + small-model router.
//
// Self-contained like the other runner tests. The stub OpenRouter server
// answers ROUTER calls (recognized by the router prompt's first line) and
// revise calls separately, so both the router-success path (tier → model,
// skill narrowing, route provenance on the run record) and the fail-safe
// fallback (garbage route → keyword classifier, pre-router behavior) are
// covered end to end. Units: validateRoute, fallbackRoute, modelForRoute,
// and the modelTiers config key.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME, loadConfig } from '../../runner/lib/config.mjs';
import { TIERS, DEFAULT_MODEL_TIERS } from '../../runner/config/defaults.mjs';
import {
  validateRoute, fallbackRoute, modelForRoute, routeComment, SCOPES, FALLBACK_TIERS,
} from '../../runner/lib/router.mjs';
import { ARCHETYPES } from '../../runner/lib/classify.mjs';
import { promptText } from '../../runner/lib/agent.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;
// User skills for the narrowing test; isolates from any real ~/.redline.
const USER_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-router-skills-'));
process.env.REDLINE_SKILLS_DIR = USER_DIR;
await fs.writeFile(path.join(USER_DIR, 'voice.md'), 'USER-VOICE-RULES\n');
await fs.writeFile(path.join(USER_DIR, 'tables.md'), 'USER-TABLE-RULES\n');

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n</body></html>\n';

const GOOD_ROUTE = {
  archetype: 'redesign', scope: 'section', tier: 'complex', canTactical: false, skills: ['voice'],
};

// Stub with two personalities: state.route answers router calls (null →
// garbage, forcing the fallback), state.result answers revise calls.
function startStub() {
  const state = { route: null, result: null, routerRequests: [], reviseRequests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const chat = (content) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      };
      if (promptText(parsed.messages).startsWith('# Redline comment router')) {
        state.routerRequests.push(parsed);
        return chat(state.route === null ? 'not json' : JSON.stringify(state.route));
      }
      state.reviseRequests.push(parsed);
      return chat(JSON.stringify(state.result));
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

// --- end to end ---------------------------------------------------------------

test('routing end to end', async (t) => {
  const stub = await startStub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-router-'));
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
  const createComment = async (body) => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html', body, anchor: { blockId: 'r-0001', quote: 'bravo' },
    });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };

  await t.test('router success: tier picks the model, skills narrow the context, provenance recorded', async () => {
    const cid = await createComment('Rework this whole section layout.');
    stub.state.route = GOOD_ROUTE;
    stub.state.result = { decisions: [{ id: cid, decision: 'deferred', summary: 's' }], edits: [] };
    const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentId: cid });
    assert.equal(res.status, 200);
    const run = await res.json();

    assert.equal(run.archetype, 'redesign', 'archetype from the router, not the keyword classifier');
    assert.equal(run.model, 'test/tier-complex', 'tier → modelTiers model');
    assert.deepEqual(run.route, { ...GOOD_ROUTE, source: 'router' });

    const routerReq = stub.state.routerRequests.at(-1);
    assert.equal(routerReq.model, 'test/tier-simple', 'router runs on the simple tier');
    assert.ok(promptText(routerReq.messages).includes('Rework this whole section layout.'));
    assert.ok(promptText(routerReq.messages).includes('voice'), 'router sees the skill list');

    const revisePrompt = promptText(stub.state.reviseRequests.at(-1).messages);
    assert.ok(revisePrompt.includes('USER-VOICE-RULES'), 'router-named skill inlined');
    assert.ok(!revisePrompt.includes('USER-TABLE-RULES'), 'unnamed skill dropped');
    assert.ok(revisePrompt.includes('# Redesign rules'), 'archetype pack survives narrowing');
  });

  await t.test('router failure: keyword fallback, archetype models, no narrowing', async () => {
    const cid = await createComment('Please fact-check this claim and cite a source.');
    stub.state.route = null; // garbage route reply
    stub.state.result = { decisions: [{ id: cid, decision: 'deferred', summary: 's' }], edits: [] };
    const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentId: cid });
    assert.equal(res.status, 200);
    const run = await res.json();

    assert.equal(run.archetype, 'research', 'keyword classifier decided');
    assert.equal(run.route.source, 'fallback');
    assert.equal(run.route.tier, 'complex', 'research defaults to the complex tier');
    assert.equal(run.model, 'perplexity/sonar-pro', 'pre-router default model preserved on fallback');
    const revisePrompt = promptText(stub.state.reviseRequests.at(-1).messages);
    assert.ok(revisePrompt.includes('USER-VOICE-RULES'), 'no narrowing on fallback');
    assert.ok(revisePrompt.includes('USER-TABLE-RULES'), 'no narrowing on fallback');
  });

  await t.test('author-pinned archetype model beats the tier ladder', async () => {
    await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
      agent: { apiKey: 'test-key', endpoint: stub.url, timeoutMs: 5000 },
      telemetry: { endpoint: null },
      modelTiers: { complex: 'test/tier-complex' },
      models: { redesign: 'test/pinned-redesign' },
    }));
    // New server so the config reload is real.
    const second = await startServer({ root: await copyRoot(root), port: 0 });
    t.after(() => second.close());
    const b2 = `http://127.0.0.1:${second.port}`;
    const created = await postJson(`${b2}/api/comment`, {
      page: 'doc.html', body: 'Rework this whole section layout.',
      anchor: { blockId: 'r-0001', quote: 'bravo' },
    });
    const cid = (await created.json()).id;
    stub.state.route = GOOD_ROUTE;
    stub.state.result = { decisions: [{ id: cid, decision: 'deferred', summary: 's' }], edits: [] };
    const run = await (await postJson(`${b2}/api/run`, { page: 'doc.html', commentId: cid })).json();
    assert.equal(run.model, 'test/pinned-redesign', 'models.redesign pin wins over tier');
  });

  // A distinct root for the second server (the single-instance lock refuses
  // a live runner on the same directory).
  async function copyRoot(from) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-router2-'));
    for (const name of ['doc.html', CONFIG_FILENAME]) {
      await fs.copyFile(path.join(from, name), path.join(dir, name));
    }
    return dir;
  }
});

// --- units --------------------------------------------------------------------

test('router units', async (t) => {
  await t.test('validateRoute: good shape normalizes, unknown skills dropped', () => {
    const route = validateRoute({ ...GOOD_ROUTE, skills: ['voice', 'made-up'] }, ['voice', 'tables']);
    assert.deepEqual(route, { ...GOOD_ROUTE, skills: ['voice'], source: 'router' });
  });

  await t.test('validateRoute: bad shapes → null', () => {
    for (const bad of [
      null, [], 'x',
      { ...GOOD_ROUTE, archetype: 'llm' },
      { ...GOOD_ROUTE, scope: 'page' },
      { ...GOOD_ROUTE, tier: 'huge' },
      { ...GOOD_ROUTE, canTactical: 'yes' },
      { ...GOOD_ROUTE, skills: 'voice' },
      { ...GOOD_ROUTE, skills: [42] },
    ]) {
      assert.equal(validateRoute(bad, ['voice']), null, JSON.stringify(bad));
    }
  });

  await t.test('fallbackRoute mirrors the keyword classifier', () => {
    const tactical = fallbackRoute('Change the date.');
    assert.deepEqual(tactical, {
      archetype: 'tactical', scope: 'block', tier: 'simple',
      canTactical: true, skills: null, source: 'fallback',
    });
    const a11y = fallbackRoute('This fails WCAG contrast.');
    assert.equal(a11y.tier, 'standard');
    assert.equal(a11y.canTactical, false);
    assert.ok(fallbackRoute('Rewrite this in a warmer tone.').canTactical, 'content is tactical-eligible');
    // Tier defaults per the post-M1 eval decision (runner/config/defaults.mjs).
    assert.deepEqual(FALLBACK_TIERS, {
      tactical: 'simple', redesign: 'standard', research: 'complex',
      accessibility: 'standard', content: 'simple',
    });
    for (const archetype of ARCHETYPES) assert.ok(TIERS.includes(FALLBACK_TIERS[archetype]));
    assert.deepEqual(SCOPES, ['block', 'section', 'document']);
  });

  await t.test('modelForRoute: fallback keeps config.models; router uses pin then tier', () => {
    const config = {
      models: { research: 'legacy/research-model' },
      modelOverrides: { redesign: 'pinned/redesign' },
      modelTiers: { simple: 't/s', standard: 't/m', complex: 't/l' },
    };
    assert.equal(modelForRoute({ archetype: 'research', tier: 'standard', source: 'fallback' }, config),
      'legacy/research-model');
    assert.equal(modelForRoute({ archetype: 'redesign', tier: 'complex', source: 'router' }, config),
      'pinned/redesign');
    assert.equal(modelForRoute({ archetype: 'content', tier: 'complex', source: 'router' }, config),
      't/l');
  });

  await t.test('routeComment: unreachable endpoint → fallback, never a throw', async () => {
    const route = await routeComment({
      comment: { id: 'c-1', body: 'Fix the typo.' },
      config: {
        agent: { endpoint: 'http://127.0.0.1:1/nope', apiKey: null, timeoutMs: 1000 },
        modelTiers: { ...DEFAULT_MODEL_TIERS },
      },
      log: () => {},
    });
    assert.equal(route.source, 'fallback');
    assert.equal(route.archetype, 'tactical');
  });
});

// --- config -------------------------------------------------------------------

test('modelTiers config', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-tiers-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const write = (obj) => fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify(obj));

  await t.test('defaults from runner/config/defaults.mjs; partial merge; overrides tracked', async () => {
    assert.deepEqual((await loadConfig(dir, {})).modelTiers, DEFAULT_MODEL_TIERS);
    await write({ modelTiers: { simple: 'x/tiny' }, models: { research: 'x/r' } });
    const cfg = await loadConfig(dir, {});
    assert.equal(cfg.modelTiers.simple, 'x/tiny');
    assert.equal(cfg.modelTiers.standard, DEFAULT_MODEL_TIERS.standard);
    assert.deepEqual(cfg.modelOverrides, { research: 'x/r' }, 'file models tracked as pins');
  });

  await t.test('invalid modelTiers shapes throw at startup', async () => {
    for (const bad of [
      { modelTiers: [] },
      { modelTiers: { simple: 42 } },
      { modelTiers: { medium: 'x/y' } },
      { modelTiers: { simple: '' } },
    ]) {
      await write(bad);
      await assert.rejects(() => loadConfig(dir, {}), new RegExp(CONFIG_FILENAME), JSON.stringify(bad));
    }
  });
});
