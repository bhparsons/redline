// test/runner/content-scan.test.mjs — #285 step 1: the file:// port scan in
// content.js must probe every port CONCURRENTLY, not one at a time.
//
// Before the fix, detectRunner()'s file:// branch awaited healthOk() in a
// `for` loop — ten ports at a 1.5s timeout each meant up to 15s of waiting
// before answering "no runner is running" (Blake, 2026-08-15). scanPorts()
// now fires every probe at once, but the port LIST ORDER still has to win:
// with two runners live, the earliest-listed port must be the answer, not
// whichever happens to respond first — a race would make the result
// non-deterministic across popup/tab opens.
//
// content.js only runs in Chrome; scanPorts/healthOk/detectRunner are exposed
// on window.__rvContentTest (mirroring overlay.js's window.__rvTest and
// popup.js's window.__popupTest) so node can drive them here with a mocked
// fetch and node's real AbortSignal, in a vm whose window.__redline is left
// unset — that keeps content.js's auto-run main() a no-op on load.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
const contentSrc = readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8');

// A fetch mock for healthOk's single call: GET http://127.0.0.1:<port>/health.
// `behaviors` maps port -> { ok, delayMs, reject }. A port with no entry
// never answers truthily (ok:false after `defaultDelay`ms) — the shape of a
// real probe finding nothing listening there.
function makeHealthFetch(behaviors, { defaultDelay = 5 } = {}) {
  return async function fetchMock(url) {
    const m = /:(\d+)\/health$/.exec(url);
    const port = m ? Number(m[1]) : null;
    const b = (port !== null && behaviors[port]) || { ok: false, delayMs: defaultDelay };
    await new Promise((resolve) => setTimeout(resolve, b.delayMs));
    if (b.reject) throw new Error(`simulated network error on port ${port}`);
    return { ok: b.ok !== false, json: async () => ({ ok: b.ok !== false }) };
  };
}

// Loads content.js into a vm with a mocked fetch and node's real AbortSignal.
// window.__redline is deliberately left unset so the file's trailing main()
// call short-circuits without touching `document`, which this stub never
// defines. ports (window.__rvPorts) must be set BEFORE the script runs —
// DEFAULT_PORTS is captured once at load, same as the real ports.js handoff.
function loadContent({ fetchImpl, ports = [] } = {}) {
  const win = {
    __rvPorts: Object.freeze(ports.slice()),
    location: { protocol: 'file:', hostname: '', origin: '' },
  };
  const ctx = vm.createContext({ window: win, fetch: fetchImpl, AbortSignal, URL });
  vm.runInContext(contentSrc, ctx);
  return win.__rvContentTest;
}

test('__rvContentTest exposes the scan hooks', () => {
  const t = loadContent({ fetchImpl: makeHealthFetch({}) });
  for (const fn of ['detectRunner', 'healthOk', 'scanPorts']) {
    assert.equal(typeof t[fn], 'function', `${fn} is a function`);
  }
});

// The core #285 requirement: order beats speed.
test('scanPorts prefers the earliest port in list order, not whichever answers first', async () => {
  const fetchImpl = makeHealthFetch({
    5175: { ok: true, delayMs: 30 }, // listed first, answers LAST
    5176: { ok: true, delayMs: 5 },  // listed second, answers FIRST
  });
  const { scanPorts } = loadContent({ fetchImpl });
  const port = await scanPorts([5175, 5176]);
  assert.equal(port, 5175, 'the earlier-listed live port wins even though 5176 answered first');
});

test('scanPorts resolves null, never throws, when nothing answers', async () => {
  const fetchImpl = makeHealthFetch({}); // every port defaults to ok:false
  const { scanPorts } = loadContent({ fetchImpl });
  const port = await scanPorts([5175, 5176, 5177]);
  assert.equal(port, null);
});

// healthOk already swallows its own errors, so this exercises the belt-and-
// suspenders allSettled wrapping too: even if a rejection slipped past
// healthOk's try/catch, the batch must still resolve to the live port.
test('a rejected probe does not sink the whole scan', async () => {
  const fetchImpl = makeHealthFetch({
    5175: { reject: true, delayMs: 5 },
    5176: { ok: true, delayMs: 10 },
  });
  const { scanPorts } = loadContent({ fetchImpl });
  const port = await scanPorts([5175, 5176]);
  assert.equal(port, 5176, 'the live port is still found after a rejected earlier probe');
});

// The actual complaint: "the 15-second search is pretty bad." Five ports that
// each take 40ms to answer "no" would cost 200ms in a sequential loop; fired
// concurrently the whole scan should land close to a single probe's delay.
test('probes overlap — worst case stays near one timeout, not the sum of all of them', async () => {
  const ports = [5175, 5176, 5177, 5178, 5179];
  const behaviors = Object.fromEntries(ports.map((p) => [p, { ok: false, delayMs: 40 }]));
  const fetchImpl = makeHealthFetch(behaviors);
  const { scanPorts } = loadContent({ fetchImpl });
  const start = Date.now();
  const port = await scanPorts(ports);
  const elapsed = Date.now() - start;
  assert.equal(port, null);
  // Serial would be 5 * 40ms = 200ms; concurrent should stay well under that.
  assert.ok(elapsed < 150, `expected a concurrent scan well under the serial 200ms, got ${elapsed}ms`);
});

// detectRunner()'s file:// branch end-to-end, through the real DEFAULT_PORTS
// handoff (window.__rvPorts), not just scanPorts in isolation.
test('detectRunner (file://) resolves through the concurrent scan', async () => {
  const fetchImpl = makeHealthFetch({ 5177: { ok: true, delayMs: 5 } });
  const { detectRunner } = loadContent({ fetchImpl, ports: [5175, 5176, 5177] });
  const runner = await detectRunner();
  // The vm realm's plain object isn't reference-equal to one built in this
  // realm's Object.prototype (same issue popup-status.test.mjs's `arr()`
  // helper works around for arrays) — compare fields, not the whole object.
  assert.equal(runner.origin, 'http://127.0.0.1:5177');
  assert.equal(runner.servedByRunner, false);
});

test('detectRunner (file://) returns null when the whole window is dead', async () => {
  const fetchImpl = makeHealthFetch({});
  const { detectRunner } = loadContent({ fetchImpl, ports: [5175, 5176, 5177] });
  const runner = await detectRunner();
  assert.equal(runner, null);
});
