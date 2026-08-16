// test/runner/pending-confirmation-visibility.test.mjs — #106.
//
// A pending scope confirmation locks the page for EVERY tab, but only the tab
// that started the run was ever told about it: /api/status did not report it,
// and both 409s said the same thing, so a second tab's sends failed silently
// with no visible cause. These tests pin the three surfaces that fix it —
// GET /api/status, the 409 discriminator, and the human-readable reach — plus
// describeReach on its own, which is what makes the ask readable at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { describeReach } from '../../runner/lib/scope.mjs';
import { EXT_DIR } from './_overlay-load.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.REDLINE_OTEL_ENDPOINT;

// ---- describeReach ----------------------------------------------------------

test('describeReach names the reach in the document\'s own words', async (t) => {
  const source = [
    '<section data-rev="r-100"><h2 data-rev="r-101">Where the sediment went</h2>',
    '<p data-rev="r-102">Deposition stalled after the June breach closed. The channel refills faster than the dredge interval clears it.</p>',
    '<p data-rev="r-103">Move Marsh Bend from seasonal dredging &mdash; costed over ten years.</p>',
    '<p data-rev="r-104">Short one.</p></section>',
  ].join('\n');

  await t.test('a block is its opening phrase, cut on a word boundary', () => {
    const [item] = describeReach(source, { touchedBlocks: ['r-102'] });
    assert.equal(item.kind, 'block');
    assert.equal(item.blockId, 'r-102');
    assert.ok(item.text.startsWith('Deposition stalled after the June breach'));
    assert.ok(item.text.endsWith('…'), 'a truncated phrase is elided');
    assert.ok(!/\s…$/u.test(item.text), 'no space before the ellipsis');
    assert.ok(item.text.length <= 50);
  });

  await t.test('a short block is shown whole, with no ellipsis', () => {
    const [item] = describeReach(source, { touchedBlocks: ['r-104'] });
    assert.equal(item.text, 'Short one.');
  });

  await t.test('entities are decoded for display', () => {
    const [item] = describeReach(source, { touchedBlocks: ['r-103'] });
    assert.ok(item.text.includes('—'), 'the &mdash; is decoded, not shown raw');
    assert.ok(!item.text.includes('&mdash;'));
  });

  await t.test('a container is recognised by its heading', () => {
    const [item] = describeReach(source, { touchedBlocks: ['r-100'] });
    assert.equal(item.kind, 'section');
    assert.equal(item.text, 'Where the sediment went');
  });

  await t.test('the theme is a trailing entry naming its changed properties', () => {
    const items = describeReach(source, {
      touchedBlocks: ['r-102'],
      touchedThemeZone: true,
      themeCss: 'body { color: #333; font-size: 17px; }',
    });
    const theme = items[items.length - 1];
    assert.equal(theme.kind, 'theme');
    assert.equal(theme.blockId, null);
    assert.deepEqual(theme.props, ['color', 'font-size']);
  });

  await t.test('a block that no longer resolves yields text:null, never a fake phrase', () => {
    const [item] = describeReach(source, { touchedBlocks: ['r-9999'] });
    assert.equal(item.text, null);
    assert.equal(item.blockId, 'r-9999', 'the id survives so the UI can still name it');
  });

  await t.test('no touched blocks and no theme is an empty reach', () => {
    assert.deepEqual(describeReach(source, {}), []);
  });
});

// ---- the dialog renders words, not ids --------------------------------------

// A DOM stub just rich enough for overlay-util's el() and the scope dialog:
// createElement/createTextNode, className, textContent, appendChild.
function domContext() {
  const make = (tag) => ({
    tag,
    className: '',
    children: [],
    own: '',
    set textContent(v) { this.own = String(v); this.children = []; },
    get textContent() { return this.own + this.children.map((c) => c.textContent).join(''); },
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    addEventListener() {},
  });
  const win = { __REVIEW__: {}, addEventListener() {} };
  const ctx = vm.createContext({
    window: win,
    document: {
      readyState: 'loading',
      addEventListener() {},
      createElement: make,
      createTextNode: (t) => ({ tag: '#text', children: [], own: String(t), get textContent() { return this.own; } }),
      body: {},
    },
    navigator: { platform: 'MacIntel' },
    localStorage: { getItem: () => null, setItem() {} },
  });
  for (const file of ['overlay-util.js', 'overlay-scope.js']) {
    vm.runInContext(readFileSync(path.join(EXT_DIR, file), 'utf8'), ctx, { filename: file });
  }
  return { win, make };
}

test('#106: the scope dialog shows the sentence, never the data-rev id', async (t) => {
  const { win, make } = domContext();
  const host = make('div');
  const dialog = win.__rv.createScopeDialog({ host, onResolve() {}, onDismiss() {} });

  await t.test('a reach renders quoted openings, a bolded section, and the theme', () => {
    dialog.show({
      level: 'page',
      summary: 'This change changes the page-level theme.',
      touchedBlocks: ['r-0115', 'r-0120', 'r-0100'],
      touchedThemeZone: true,
      reach: [
        { blockId: 'r-0115', kind: 'block', text: 'Deposition stalled after the June breach…' },
        { blockId: 'r-0120', kind: 'block', text: 'Move Marsh Bend from seasonal dredging…' },
        { blockId: 'r-0100', kind: 'section', text: 'Where the sediment went' },
        { blockId: null, kind: 'theme', text: 'page theme', props: ['color'] },
      ],
    });
    const rendered = host.textContent;
    assert.ok(rendered.includes('“Deposition stalled after the June breach…”'));
    assert.ok(rendered.includes('Where the sediment went'));
    assert.ok(rendered.includes('page theme — color'));
    assert.ok(!rendered.includes('r-0115'), 'the internal id never reaches the reviewer');
    assert.ok(!rendered.includes('r-0100'));
  });

  await t.test('an unresolvable block falls back to its id rather than inventing text', () => {
    dialog.show({
      level: 'section',
      summary: 's',
      reach: [{ blockId: 'r-0999', kind: 'block', text: null }],
    });
    assert.ok(host.textContent.includes('r-0999'));
  });

  await t.test('an older runner with no reach still renders the id list', () => {
    dialog.show({ level: 'section', summary: 's', touchedBlocks: ['r-0115', 'r-0120'] });
    const rendered = host.textContent;
    assert.ok(rendered.includes('Affects 2 blocks'), 'the pre-#106 fallback survives');
    assert.ok(rendered.includes('r-0115'));
  });
});

// ---- cross-tab visibility, end to end ---------------------------------------

const DOC = [
  '<!doctype html><html><head><title>t</title></head><body>',
  '<section data-rev="r-secA"><h2 data-rev="r-a1">Section A</h2><p data-rev="r-a2">alpha body</p></section>',
  '<section data-rev="r-secB"><p data-rev="r-b1">beta body of the second section, long enough to be cut</p></section>',
  '</body></html>',
].join('\n');

function startAgentStub() {
  const state = { result: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(state.result) } }] }));
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

test('#106: a pending confirmation is visible to every tab', async (t) => {
  const stub = await startAgentStub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-pending-'));
  await fs.writeFile(path.join(root, 'doc.html'), DOC);
  await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'k', endpoint: stub.url, timeoutMs: 5000 },
    telemetry: { endpoint: null },
  }, null, 2));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await stub.close(); await fs.rm(root, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  const status = async () => (await fetch(`${base}/api/status?page=doc.html`)).json();
  const comment = async (body, anchor) => (await (await post(`${base}/api/comment`, { page: 'doc.html', body, anchor })).json()).id;
  const runOn = (commentId) => post(`${base}/api/run`, { page: 'doc.html', commentId });

  // Anchored in section A, edits section B → out of section → gated.
  const cid = await comment('Fix this', { blockId: 'r-a2', quote: 'alpha body' });
  stub.state.result = {
    decisions: [{ id: cid, decision: 'addressed', summary: 'Reworded the other section.' }],
    edits: [{ blockId: 'r-b1', newInner: 'beta body reworded' }],
  };

  await t.test('before the run, /api/status reports no pending confirmation', async () => {
    assert.equal((await status()).pendingConfirmation, undefined);
  });

  // The change signal an idle tab polls on. Without it a comment written in
  // another tab stayed invisible until something else forced a refresh —
  // pendingConfirmation and running both stay false when a comment is added,
  // so a flag comparison alone can never notice (found in the browser, not
  // by a test, which is why this one exists).
  await t.test('/api/status carries the sidecar rev, and it MOVES on a new comment', async () => {
    const before = (await status()).rev;
    assert.equal(typeof before, 'number');
    const s0 = await status();
    assert.equal(s0.running, false);
    assert.equal(s0.pendingConfirmation, undefined);

    await comment('a comment written by another tab', { blockId: 'r-a2', quote: 'alpha body' });

    const after = await status();
    assert.ok(after.rev > before,
      'a new comment moves rev even though running and pendingConfirmation do not');
  });

  const pending = await (await runOn(cid)).json();
  assert.equal(pending.pendingConfirmation, true, 'precondition: the run is gated');

  await t.test('/api/status exposes the pending confirmation to a tab that never ran it', async () => {
    const s = await status();
    assert.ok(s.pendingConfirmation, 'a second tab can see there is an ask');
    assert.equal(s.pendingConfirmation.runId, pending.runId);
    assert.ok(s.pendingConfirmation.scope, 'and what the ask is about');
    assert.equal(s.pendingConfirmation.scope.level, 'section');
    assert.deepEqual([...s.pendingConfirmation.scope.touchedBlocks], ['r-b1']);
  });

  await t.test('the status payload carries the reach in readable words, not ids', async () => {
    const { reach } = (await status()).pendingConfirmation.scope;
    assert.ok(Array.isArray(reach) && reach.length === 1);
    assert.equal(reach[0].blockId, 'r-b1');
    assert.ok(reach[0].text.startsWith('beta body of the second section'),
      'the reviewer is shown the sentence, not r-b1');
  });

  await t.test('the initiating tab and a polling tab are shown the SAME ask', async () => {
    const fromStatus = (await status()).pendingConfirmation.scope;
    assert.deepEqual(fromStatus.reach, pending.scope.reach);
    assert.equal(fromStatus.summary, pending.scope.summary);
  });

  await t.test('a blocked send says it is awaiting confirmation, not that a run is active', async () => {
    const blocked = await runOn(cid);
    assert.equal(blocked.status, 409);
    const body = await blocked.json();
    assert.equal(body.reason, 'awaiting-confirmation',
      'branchable without matching prose');
    assert.equal(body.runId, pending.runId);
    assert.ok(body.scope && Array.isArray(body.scope.reach),
      'the refusal alone is enough to render the ask');
  });

  await t.test('running is false while gated — status must not read as idle', async () => {
    const s = await status();
    assert.equal(s.running, false, 'the run left activeRuns when it paused');
    assert.ok(s.pendingConfirmation, 'so pendingConfirmation is the only signal a watcher has');
  });

  await t.test('resolving it clears the pending confirmation for every tab', async () => {
    const res = await post(`${base}/api/run/confirm`, { page: 'doc.html', runId: pending.runId, allow: false });
    assert.equal(res.status, 200);
    assert.equal((await status()).pendingConfirmation, undefined,
      'a tab still showing the dialog can tell it has been answered');
  });
});
