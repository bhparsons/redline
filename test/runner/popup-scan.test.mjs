// test/runner/popup-scan.test.mjs — #285 step 1: probeAnyRunner() must scan
// the port list CONCURRENTLY, not one port at a time.
//
// Before the fix, probeAnyRunner() awaited probeInfo() in a `for` loop — ten
// ports at a 1.5s timeout each meant up to 15s before the popup could say "no
// runner is running" (Blake, 2026-08-15: "the 15-second search is pretty
// bad"). The fix fires every probe at once, but RUNNER_PORTS' list order
// still has to be the tiebreaker: with two runners live, the earliest-listed
// port must be the answer, not whichever happened to respond first — a race
// would hand a user with two runners a different one on every popup open
// (the same non-determinism #126 fixed for tab-vs-scan).
//
// popup.js only runs in Chrome; this follows popup-status.test.mjs's vm-stub
// pattern (readyState 'loading' defers the real bootstrap) but additionally
// injects a mocked fetch and node's real AbortSignal into the context, since
// probeAnyRunner and probeInfo are exposed on window.__popupTest specifically
// to be driven that way.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
const popupSrc = readFileSync(path.join(EXT_DIR, 'popup.js'), 'utf8');

// A fetch mock for probeInfo's pair of calls per port: GET base/health, then
// (only if health answered ok) GET base/api/info. `behaviors` maps
// port -> { ok, delayMs, reject, root }. A port with no entry never answers
// truthily (ok:false after `defaultDelay`ms) — a real probe finding nothing
// listening there.
function makeRunnerFetch(behaviors, { defaultDelay = 5 } = {}) {
  return async function fetchMock(url) {
    const m = /:(\d+)\/(health|api\/info)$/.exec(url);
    const port = m ? Number(m[1]) : null;
    const endpoint = m ? m[2] : null;
    const b = (port !== null && behaviors[port]) || { ok: false, delayMs: defaultDelay };
    await new Promise((resolve) => setTimeout(resolve, b.delayMs));
    if (b.reject) throw new Error(`simulated network error on port ${port}`);
    if (b.ok === false) return { ok: false, json: async () => ({}) };
    if (endpoint === 'health') return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => ({ root: b.root || `/r${port}` }) };
  };
}

// Loads popup.js into a vm with the readyState:'loading' bootstrap guard
// (from popup-status.test.mjs) plus a mocked fetch and node's real
// AbortSignal, so probeAnyRunner can run for real against controlled timing.
// window.__rvPorts is set BEFORE the script runs — RUNNER_PORTS is captured
// once at load, same as ports.js's real handoff.
function loadPopupWithFetch(fetchImpl, ports) {
  const win = { __rvPorts: Object.freeze(ports.slice()) };
  const ctx = vm.createContext({
    window: win,
    document: { readyState: 'loading', addEventListener() {}, hidden: false },
    navigator: {},
    URL,
    fetch: fetchImpl,
    AbortSignal,
  });
  vm.runInContext(popupSrc, ctx);
  return win.__popupTest;
}

test('__popupTest exposes probeAnyRunner and probeInfo for the scan tests', () => {
  const t = loadPopupWithFetch(makeRunnerFetch({}), [5175]);
  assert.equal(typeof t.probeAnyRunner, 'function');
  assert.equal(typeof t.probeInfo, 'function');
});

// The core #285 requirement: order beats speed.
test('probeAnyRunner prefers the earliest live port, not whichever answers first', async () => {
  const fetchImpl = makeRunnerFetch({
    5175: { ok: true, delayMs: 30, root: '/r5175' }, // listed first, answers LAST
    5176: { ok: true, delayMs: 5, root: '/r5176' },  // listed second, answers FIRST
  });
  const { probeAnyRunner } = loadPopupWithFetch(fetchImpl, [5175, 5176]);
  const result = await probeAnyRunner();
  assert.equal(result.port, 5175, 'the earlier-listed live runner wins even though 5176 answered first');
  assert.equal(result.base, 'http://127.0.0.1:5175');
  assert.equal(result.source, 'scan');
});

test('probeAnyRunner resolves null, never throws, when nothing answers', async () => {
  const fetchImpl = makeRunnerFetch({}); // every port defaults to ok:false
  const { probeAnyRunner } = loadPopupWithFetch(fetchImpl, [5175, 5176, 5177]);
  const result = await probeAnyRunner();
  assert.equal(result, null);
});

// probeInfo already swallows its own errors, so this exercises the belt-and-
// suspenders allSettled wrapping too: even if a rejection slipped past
// probeInfo's try/catch, the batch must still resolve to the live runner.
test('a rejected probe does not sink the whole scan', async () => {
  const fetchImpl = makeRunnerFetch({
    5175: { reject: true, delayMs: 5 },
    5176: { ok: true, delayMs: 10, root: '/r5176' },
  });
  const { probeAnyRunner } = loadPopupWithFetch(fetchImpl, [5175, 5176]);
  const result = await probeAnyRunner();
  assert.equal(result.port, 5176);
  assert.equal(result.info.root, '/r5176');
});

// The actual complaint: "the 15-second search is pretty bad." Five ports that
// each take 40ms to answer "no" would cost 200ms in a sequential loop; fired
// concurrently the whole scan should land close to a single probe's delay.
test('probes overlap — worst case stays near one timeout, not the sum of all of them', async () => {
  const ports = [5175, 5176, 5177, 5178, 5179];
  const behaviors = Object.fromEntries(ports.map((p) => [p, { ok: false, delayMs: 40 }]));
  const fetchImpl = makeRunnerFetch(behaviors);
  const { probeAnyRunner } = loadPopupWithFetch(fetchImpl, ports);
  const start = Date.now();
  const result = await probeAnyRunner();
  const elapsed = Date.now() - start;
  assert.equal(result, null);
  // Serial would be 5 * 40ms = 200ms; concurrent should stay well under that.
  assert.ok(elapsed < 150, `expected a concurrent scan well under the serial 200ms, got ${elapsed}ms`);
});
