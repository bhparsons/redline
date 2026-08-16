// test/runner/popup-status.test.mjs — WP14: extension status dashboard.
//
// The popup only runs in Chrome, but its pure "probe results → UI state" logic
// is exposed on window.__popupTest (mirroring how overlay.js exposes
// window.__rvTest). We load popup.js in a vm with a document stub whose
// readyState is 'loading' — that defers the bootstrap so no live fetch/timer
// runs — and drive deriveState() against mocked runner/Phoenix/last-run
// results.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
const popupSrc = readFileSync(path.join(EXT_DIR, 'popup.js'), 'utf8');
// ports.js publishes window.__rvPorts and popup.html loads it FIRST; the stub
// has to load it in the same order or popup.js sees no port list at all (#126).
const portsSrc = readFileSync(path.join(EXT_DIR, 'ports.js'), 'utf8');

// Arrays/objects returned by deriveState are built inside the vm realm, so
// their prototype identity differs from this realm's — deepStrictEqual would
// reject them on that alone. Re-materialize arrays here before comparing.
const arr = (x) => Array.from(x);

function loadPopup() {
  const win = {};
  const ctx = vm.createContext({
    window: win,
    // readyState 'loading' → bootstrap registers a DOMContentLoaded listener
    // that never fires, so no live code runs under the stub.
    document: { readyState: 'loading', addEventListener() {}, hidden: false },
    navigator: {},
    URL,
  });
  vm.runInContext(portsSrc, ctx);
  vm.runInContext(popupSrc, ctx);
  return win.__popupTest;
}

test('__popupTest exposes the pure helpers and the port set', () => {
  const t = loadPopup();
  assert.ok(t, 'window.__popupTest is populated');
  for (const fn of ['deriveState', 'deriveApiKeyStatus', 'summarizeLastRun', 'statusLabel']) {
    assert.equal(typeof t[fn], 'function', `${fn} is a function`);
  }
  // The port set comes from ports.js — the ONE list, shared with content.js.
  assert.deepEqual(arr(t.RUNNER_PORTS),
    [5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182, 5183, 5184]);
  assert.equal(t.PHOENIX_ORIGIN, 'http://127.0.0.1:6006');
  // ONE command, and it must be paste-and-run: no placeholder to edit, and a
  // real executable. The pair it replaced were neither (#119).
  assert.equal(t.DEV_UP_COMMAND, 'scripts/dev-up.sh');
  assert.ok(!/[<>]/.test(t.DEV_UP_COMMAND), 'no placeholder to hand-edit');
});

test('runner not connected → down state with ONE start command', () => {
  const { deriveState } = loadPopup();
  const s = deriveState({ runner: null, phoenixUp: false, lastRun: null });
  assert.equal(s.connected, false);
  assert.equal(s.phoenix, 'not-running');
  assert.equal(s.apiKey, 'unknown');
  assert.equal(s.lastRun, null);
  assert.deepEqual(arr(s.actions), []);
  // Both down → still one row, one copy. dev-up.sh starts whichever is
  // missing, so a second command would be a second thing to paste for no gain.
  assert.equal(s.commands.length, 1);
  assert.equal(s.commands[0].id, 'dev-up');
  assert.equal(s.commands[0].command, 'scripts/dev-up.sh');
  assert.equal(s.commands[0].label, 'Start the runner and Phoenix');
});

test('runner connected → open-directory action, port/root surfaced, no runner command', () => {
  const { deriveState } = loadPopup();
  const s = deriveState({
    runner: { base: 'http://127.0.0.1:5177', port: 5177, info: { root: '/Users/x/docs' } },
    phoenixUp: true,
    lastRun: null,
  });
  assert.equal(s.connected, true);
  assert.equal(s.port, 5177);
  assert.equal(s.root, '/Users/x/docs');
  assert.equal(s.base, 'http://127.0.0.1:5177');
  assert.equal(s.phoenix, 'running');
  assert.deepEqual(arr(s.actions), ['open-directory']);
  // Phoenix up + runner up → nothing to start.
  assert.deepEqual(arr(s.commands), []);
});

test('connected but Phoenix down → phoenix start command still offered', () => {
  const { deriveState } = loadPopup();
  const s = deriveState({
    runner: { base: 'http://127.0.0.1:5175', port: 5175, info: { root: '/r' } },
    phoenixUp: false,
    lastRun: null,
  });
  assert.equal(s.phoenix, 'not-running');
  // Runner up, Phoenix down: same command, label naming only what is missing.
  assert.equal(s.commands.length, 1);
  assert.equal(s.commands[0].id, 'dev-up');
  assert.equal(s.commands[0].label, 'Start Phoenix');
  assert.deepEqual(arr(s.actions), ['open-directory']);
});

test('base is derived from port when the runner probe omits it', () => {
  const { deriveState } = loadPopup();
  const s = deriveState({ runner: { port: 5176, info: { root: '/r' } }, phoenixUp: true });
  assert.equal(s.base, 'http://127.0.0.1:5176');
});

// ---- #126: the popup must describe the ACTIVE TAB's runner ------------------

test('runnerOriginOfTab: only local http origins are candidate runners', () => {
  const { runnerOriginOfTab } = loadPopup();
  assert.equal(runnerOriginOfTab('http://127.0.0.1:5180/doc.html'), 'http://127.0.0.1:5180');
  assert.equal(runnerOriginOfTab('http://localhost:5175/a/b.html'), 'http://localhost:5175');
  // Default port 80 still has an origin — a runner could be behind a proxy.
  assert.equal(runnerOriginOfTab('http://127.0.0.1/doc.html'), 'http://127.0.0.1');
  // Not servable by a local runner.
  assert.equal(runnerOriginOfTab('https://127.0.0.1:5175/doc.html'), null);
  assert.equal(runnerOriginOfTab('http://example.com/doc.html'), null);
  assert.equal(runnerOriginOfTab('chrome://newtab/'), null);
  // A file:// page has no origin to ask — it falls back to the scan.
  assert.equal(runnerOriginOfTab('file:///Users/x/doc.html'), null);
  assert.equal(runnerOriginOfTab(''), null);
  assert.equal(runnerOriginOfTab(null), null);
  assert.equal(runnerOriginOfTab('not a url'), null);
});

test('basename: the worktree name, not the whole path', () => {
  const { basename } = loadPopup();
  assert.equal(basename('/Users/x/Projects/redline-rebuild'), 'redline-rebuild');
  assert.equal(basename('/Users/x/Projects/phase4/design/'), 'design');
  assert.equal(basename('/'), '/');
  assert.equal(basename(null), null);
});

test('a tab-resolved runner is reported as the tab\'s own', () => {
  const { deriveState } = loadPopup();
  const s = deriveState({
    runner: {
      base: 'http://127.0.0.1:5180', port: 5180,
      info: { root: '/Users/x/worktrees/phase3-ui' }, source: 'tab',
    },
    phoenixUp: true,
    lastRun: null,
  });
  assert.equal(s.source, 'tab');
  assert.equal(s.port, 5180);
  // The worktree is what distinguishes two runners at a glance.
  assert.equal(s.rootName, 'phase3-ui');
  assert.equal(s.root, '/Users/x/worktrees/phase3-ui');
});

// The exact #126 report: a tab on 5180 while 5175 also answers. Before the fix
// the popup said 5175 — the wrong worktree — with no hint it had guessed.
test('a scanned runner is labelled scanned, never presented as the tab\'s', () => {
  const { deriveState } = loadPopup();
  const s = deriveState({
    runner: {
      base: 'http://127.0.0.1:5175', port: 5175,
      info: { root: '/Users/x/redline-rebuild' }, source: 'scan',
    },
    phoenixUp: true,
    lastRun: null,
  });
  assert.equal(s.connected, true);
  assert.equal(s.source, 'scan');
  assert.equal(s.rootName, 'redline-rebuild');
});

test('an unlabelled runner degrades to scan, never silently to tab', () => {
  const { deriveState } = loadPopup();
  const s = deriveState({
    runner: { base: 'http://127.0.0.1:5175', port: 5175, info: { root: '/r' } },
    phoenixUp: true,
  });
  assert.equal(s.source, 'scan');
});

test('a disconnected popup has no source and no worktree to name', () => {
  const { deriveState } = loadPopup();
  const s = deriveState({ runner: null, phoenixUp: false, lastRun: null });
  assert.equal(s.source, null);
  assert.equal(s.rootName, null);
});

test('deriveApiKeyStatus: unknown when /api/info exposes no key flag', () => {
  const { deriveApiKeyStatus } = loadPopup();
  // A body with no key flag at all (e.g. an older runner) → unknown. The
  // current runner DOES send hasApiKey (see the flag cases below).
  assert.equal(deriveApiKeyStatus({ ok: true, root: '/r', port: 5175 }), 'unknown');
  assert.equal(deriveApiKeyStatus(null), 'unknown');
  assert.equal(deriveApiKeyStatus(undefined), 'unknown');
  assert.equal(deriveApiKeyStatus('nope'), 'unknown');
});

test('deriveApiKeyStatus: reads a presence flag without exposing the value', () => {
  const { deriveApiKeyStatus } = loadPopup();
  assert.equal(deriveApiKeyStatus({ hasApiKey: true }), 'configured');
  assert.equal(deriveApiKeyStatus({ hasApiKey: false }), 'missing');
  assert.equal(deriveApiKeyStatus({ apiKeyConfigured: true }), 'configured');
  assert.equal(deriveApiKeyStatus({ keyConfigured: false }), 'missing');
  assert.equal(deriveApiKeyStatus({ agent: { hasApiKey: true } }), 'configured');
  // A string status word.
  assert.equal(deriveApiKeyStatus({ apiKey: 'missing' }), 'missing');
  assert.equal(deriveApiKeyStatus({ apiKey: '' }), 'missing');
  // An opaque token means present — treated as configured, never surfaced.
  assert.equal(deriveApiKeyStatus({ apiKey: 'sk-abc123' }), 'configured');
});

test('api-key status flows through deriveState when connected', () => {
  const { deriveState } = loadPopup();
  const present = deriveState({
    runner: { base: 'http://127.0.0.1:5175', port: 5175, info: { root: '/r', hasApiKey: true } },
    phoenixUp: true,
  });
  assert.equal(present.apiKey, 'configured');
  const absent = deriveState({
    runner: { base: 'http://127.0.0.1:5175', port: 5175, info: { root: '/r', hasApiKey: false } },
    phoenixUp: true,
  });
  assert.equal(absent.apiKey, 'missing');
});

test('summarizeLastRun and last-run status flowing through deriveState', () => {
  const { deriveState, summarizeLastRun } = loadPopup();
  assert.equal(summarizeLastRun(null), null);
  assert.equal(summarizeLastRun('x'), null);
  const ok = summarizeLastRun({ runId: 'run-9', status: 'ok', page: 'a.html' });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.label, 'Completed');
  assert.equal(ok.runId, 'run-9');
  assert.equal(ok.page, 'a.html');

  const s = deriveState({
    runner: { base: 'http://127.0.0.1:5175', port: 5175, info: { root: '/r' } },
    phoenixUp: true,
    lastRun: { runId: 'run-9', status: 'error' },
  });
  assert.equal(s.lastRun.status, 'error');
  assert.equal(s.lastRun.label, 'Failed');
});

test('last run is ignored when the runner is down', () => {
  const { deriveState } = loadPopup();
  const s = deriveState({ runner: null, phoenixUp: true, lastRun: { status: 'ok' } });
  assert.equal(s.lastRun, null);
});

test('statusLabel maps known run statuses and passes unknowns through', () => {
  const { statusLabel } = loadPopup();
  assert.equal(statusLabel('ok'), 'Completed');
  assert.equal(statusLabel('running'), 'Running…');
  assert.equal(statusLabel('error'), 'Failed');
  assert.equal(statusLabel('undone'), 'Undone');
  assert.equal(statusLabel('timeout'), 'Timed out');
  assert.equal(statusLabel('weird-new-state'), 'weird-new-state');
  assert.equal(statusLabel(undefined), 'unknown');
});
