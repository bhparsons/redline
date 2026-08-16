// popup.js — the extension's status dashboard (WP14).
//
// On open (and on a gentle interval while open) the popup probes the local
// environment and renders a single derived UI state:
//   - runner: the one serving the ACTIVE TAB, found the way content.js finds
//     it — ping the tab's own origin. Only when the tab is not on a runner
//     origin does it fall back to scanning ports.js's list, and a scanned
//     answer says so (#126: with five runners up, a fixed ordered scan
//     reported whichever answered first, not the one you were looking at);
//   - phoenix: reachability of http://127.0.0.1:6006;
//   - api key: whatever /api/info chooses to expose (NEVER the value);
//   - last run: from /api/status for the page open in the active tab.
//
// The pure "probe results → UI state" logic lives in deriveState() and its
// helpers, exposed on window.__popupTest so node can unit-test the state
// machine against mocked probe results without a browser. All live code
// (DOM, fetch, chrome.*, timers) is guarded so loading this file in a vm with
// a document stub whose readyState is 'loading' never runs the bootstrap.

'use strict';

// Runner ports for the FALLBACK scan. The list itself lives in ports.js, which
// popup.html loads first and content.js shares — one list, so the two surfaces
// can no longer drift apart (#126).
const RUNNER_PORTS = (typeof window !== 'undefined' && window.__rvPorts) || [];

// Arize Phoenix's default UI port.
const PHOENIX_ORIGIN = 'http://127.0.0.1:6006';

const PROBE_TIMEOUT_MS = 1500;
const POLL_MS = 4000; // gentle — a few seconds, per the WP14 spec.

// Where to get the runner (repo README's rebuild section).
const RUNNER_INSTALL_URL =
  'https://github.com/bhparsons/html-redline-ui#rebuild-runner--chrome-extension';

// The ONE start command, shown when the runner or Phoenix is down.
//
// It has to be paste-and-run, which the previous pair were not: the runner
// command carried a literal `<dir>` placeholder, and `phoenix serve` is not a
// command on a machine that runs Phoenix through uvx (CLAUDE.md) — copying it
// produced an error, not a running Phoenix.
//
// dev-up.sh starts BOTH, idempotently, skipping whichever is already
// listening, and defaults to serving the current directory. So one line
// covers all three broken states and needs no editing before it runs.
const DEV_UP_COMMAND = 'scripts/dev-up.sh';

// ---- pure state machine (unit-tested via window.__popupTest) ----------------

// A human label for a run's status. Unknown statuses pass through verbatim so
// the popup never hides a state it doesn't recognize.
function statusLabel(status) {
  switch (status) {
    case 'ok': return 'Completed';
    case 'running': return 'Running…';
    case 'error': return 'Failed';
    case 'failed': return 'Failed';
    case 'undone': return 'Undone';
    case 'timeout': return 'Timed out';
    default: return typeof status === 'string' && status ? status : 'unknown';
  }
}

// Derive whether an API key is configured from an /api/info body, WITHOUT ever
// reading or exposing the key's value. /api/info does not currently report key
// state, so the common answer is 'unknown'; this reads a presence FLAG if a
// future /api/info adds one (boolean *hasApiKey / *apiKeyConfigured, or a
// status word), and treats an opaque non-empty token as "configured" (present)
// without surfacing it.
function deriveApiKeyStatus(info) {
  if (!info || typeof info !== 'object') return 'unknown';
  const agent = info.agent && typeof info.agent === 'object' ? info.agent : {};
  const flags = [
    info.hasApiKey, info.apiKeyConfigured, info.keyConfigured,
    agent.hasApiKey, agent.apiKeyConfigured,
  ];
  for (const f of flags) {
    if (f === true) return 'configured';
    if (f === false) return 'missing';
  }
  const raw = [info.apiKey, agent.apiKey];
  for (const s of raw) {
    if (s === true) return 'configured';
    if (s === false) return 'missing';
    if (typeof s === 'string') {
      const v = s.trim().toLowerCase();
      if (v === '') return 'missing';
      if (['missing', 'absent', 'unset', 'none', 'null'].includes(v)) return 'missing';
      // Any other non-empty string is a present token — never surfaced.
      return 'configured';
    }
  }
  return 'unknown';
}

// Reduce a /api/status lastRun record to what the popup renders. Returns null
// when there is nothing to show.
function summarizeLastRun(lastRun) {
  if (!lastRun || typeof lastRun !== 'object') return null;
  const status = typeof lastRun.status === 'string' ? lastRun.status : 'unknown';
  return {
    status,
    label: statusLabel(status),
    runId: typeof lastRun.runId === 'string' ? lastRun.runId : null,
    page: typeof lastRun.page === 'string' ? lastRun.page : null,
  };
}

// Last path segment of a served root — the worktree/folder name. Tolerates a
// trailing slash and a bare '/'. No node path module in a browser popup.
function basename(p) {
  if (typeof p !== 'string') return null;
  const parts = p.split('/').filter((s) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

// The origin a tab would talk to if it were showing a reviewed document —
// which is exactly how content.js:detectRunner() resolves it, so the popup and
// the overlay agree by construction rather than by coincidence (#126). Null
// for anything that can't be served by a local runner (https pages, chrome://,
// file:// — a file:// page has no origin to ask, and falls back to the scan).
// Pure, so node can test the decision without a browser.
function runnerOriginOfTab(url) {
  if (typeof url !== 'string' || url === '') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:') return null;
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null;
  return u.origin;
}

// The one place that turns raw probe results into the render model. Input:
//   { runner: {base, port, info, source}|null, phoenixUp: bool,
//     lastRun: <record>|null }
// Output: a flat, render-ready state object (also the test's contract).
function deriveState(probe) {
  const p = probe && typeof probe === 'object' ? probe : {};
  const runner = p.runner && typeof p.runner === 'object' ? p.runner : null;
  const connected = Boolean(runner);
  const phoenixUp = Boolean(p.phoenixUp);

  const state = {
    connected,
    phoenix: phoenixUp ? 'running' : 'not-running',
    port: null,
    root: null,
    rootName: null,
    base: null,
    // 'tab'  — this runner serves the page you are looking at.
    // 'scan' — nobody serves the active tab; this is just a runner that exists.
    // The distinction is the whole of #126: a scanned answer must never be
    // presented as though it described your tab.
    source: null,
    apiKey: 'unknown',
    runnerVersion: null,
    lastRun: null,
    actions: [],
    commands: [],
  };

  if (connected) {
    const info = runner.info && typeof runner.info === 'object' ? runner.info : {};
    state.port = Number.isInteger(runner.port) ? runner.port
      : (Number.isInteger(info.port) ? info.port : null);
    state.base = typeof runner.base === 'string' ? runner.base
      : (state.port != null ? `http://127.0.0.1:${state.port}` : null);
    state.root = typeof info.root === 'string' ? info.root : null;
    // The runner's own version, so extension/runner SKEW is visible here rather
    // than deduced from a feature quietly not working.
    state.runnerVersion = typeof info.version === 'string' ? info.version : null;
    // The worktree, not the path. With several worktrees up, the trailing
    // segment is the only part that differs at a glance.
    state.rootName = state.root ? basename(state.root) : null;
    state.source = runner.source === 'tab' ? 'tab' : 'scan';
    state.apiKey = deriveApiKeyStatus(info);
    state.lastRun = summarizeLastRun(p.lastRun);
    // Runner up → offer to open the served directory.
    if (state.base) state.actions.push('open-directory');
  }

  // ONE row, one copy, whatever is down (#119). Naming what it will fix beats
  // a generic label: the same command is the answer in all three cases, but
  // you still want to know which of them you are in.
  if (!connected || !phoenixUp) {
    const missing = !connected && !phoenixUp ? 'the runner and Phoenix'
      : (!connected ? 'the runner' : 'Phoenix');
    state.commands.push({
      id: 'dev-up',
      label: `Start ${missing}`,
      command: DEV_UP_COMMAND,
    });
  }

  return state;
}

if (typeof window !== 'undefined') {
  window.__popupTest = {
    deriveState, deriveApiKeyStatus, summarizeLastRun, statusLabel,
    runnerOriginOfTab, basename,
    RUNNER_PORTS, PHOENIX_ORIGIN, DEV_UP_COMMAND,
    // probeAnyRunner does live fetches, so it's only test-driven with a mocked
    // fetch/AbortSignal in the vm context (see popup-status.test.mjs's #285
    // scan tests) — never exercised by the pure deriveState tests above.
    probeAnyRunner, probeInfo,
  };
}

// ---- live probes (browser only) ---------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) return null;
  return res.json();
}

// A runner on `base` answering /health {ok:true} and /api/info {root}. Null
// otherwise. Mirrors runner/lib/discovery.mjs's probe() shape.
async function probeInfo(base) {
  try {
    const health = await fetchJson(`${base}/health`);
    if (!health || health.ok !== true) return null;
    const info = await fetchJson(`${base}/api/info`);
    if (!info || typeof info.root !== 'string') return null;
    return info;
  } catch {
    return null;
  }
}

// The URL of the active tab, or null when we can't see one.
async function activeTabUrl() {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return null;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    return tab && tab.url ? tab.url : null;
  } catch {
    return null;
  }
}

// The runner serving the active tab. This is the answer that matters: it is
// the runner the overlay in that tab is talking to, so comments, edits and the
// last run all belong to it.
async function probeTabRunner(tabUrl) {
  const origin = runnerOriginOfTab(tabUrl);
  if (origin === null) return null;
  const info = await probeInfo(origin);
  if (!info) return null;
  const port = Number.parseInt(new URL(origin).port, 10);
  return { base: origin, port: Number.isInteger(port) ? port : null, info, source: 'tab' };
}

// Fallback only: the first live runner across the known ports. Answers "is
// there a runner at all", never "this is your tab's runner" — deriveState
// carries source:'scan' so the UI can say which question it answered.
//
// Probes are fired CONCURRENTLY, not one at a time — ten ports at 1.5s each
// meant up to 15s before "no runner" (#285). RUNNER_PORTS is still an ORDERED
// list and that order is meaningful: when several runners are live, the
// EARLIEST port wins, never whichever happened to answer first (a race would
// hand a user with two runners up a different one on every popup open).
// allSettled (not all) so a rejected or timed-out probe can't sink the whole
// batch — probeInfo already swallows its own errors, this is
// belt-and-suspenders for anything that slips past it.
async function probeAnyRunner() {
  const results = await Promise.allSettled(RUNNER_PORTS.map(async (port) => {
    const base = `http://127.0.0.1:${port}`;
    const info = await probeInfo(base);
    return info ? { base, port, info, source: 'scan' } : null;
  }));
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) return result.value;
  }
  return null;
}

// Tab first, scan second.
async function probeRunner(tabUrl) {
  return (await probeTabRunner(tabUrl)) ?? (await probeAnyRunner());
}

// Is something listening on Phoenix's port? Any HTTP response (even non-2xx)
// counts as running; only a connection failure/timeout is "not running".
async function probePhoenix() {
  try {
    await fetch(PHOENIX_ORIGIN, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), mode: 'no-cors' });
    return true;
  } catch {
    return false;
  }
}

// The lastRun for the page open in the active tab, when that page is served by
// `base`. Uses only host-permitted tab URLs (127.0.0.1/*), so no extra
// permission is needed; returns null whenever we can't tell. Takes the tab URL
// rather than re-querying, so one popup refresh reads the tab exactly once.
async function probeLastRun(base, tabUrl) {
  try {
    if (typeof tabUrl !== 'string' || tabUrl === '') return null;
    const u = new URL(tabUrl);
    if (u.origin !== new URL(base).origin) return null;
    const page = u.pathname.replace(/^\/+/, '');
    if (!page || !/\.html?$/i.test(page)) return null;
    const body = await fetchJson(`${base}/api/status?page=${encodeURIComponent(page)}`);
    return body && body.lastRun ? body.lastRun : null;
  } catch {
    return null;
  }
}

async function probeAll() {
  // Read the tab once, then let both the runner probe and the last-run probe
  // work from it — otherwise the two could disagree about which tab is active.
  const tabUrl = await activeTabUrl();
  const [runner, phoenixUp] = await Promise.all([probeRunner(tabUrl), probePhoenix()]);
  const lastRun = runner ? await probeLastRun(runner.base, tabUrl) : null;
  return { runner, phoenixUp, lastRun };
}

// ---- rendering (browser only) -----------------------------------------------

function setStatusRow(el, on, text, cls) {
  if (!el) return;
  const dot = el.querySelector('.dot');
  const label = el.querySelector('.value');
  if (dot) dot.className = `dot${on ? ' on' : ''}${cls ? ` ${cls}` : ''}`;
  if (label) label.textContent = text;
}

function copyToClipboard(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('clipboard unavailable'));
}

function render(state) {
  const $ = (id) => document.getElementById(id);

  // Runner row. Two different questions, answered in the right order (Blake,
  // 2026-07-29): "is there a runner for the tab I am looking at" comes first,
  // and any OTHER runner that happens to be up is an aside on its own row.
  // Leading with a runner the user did not ask about buried the answer.
  const runnerRow = $('row-runner');
  const alsoRow = $('row-also');
  const scanned = state.connected && state.source === 'scan';

  if (scanned) {
    // A runner exists, but not for this tab. The runner row reports the tab.
    setStatusRow(runnerRow, false, 'No runner for this tab', 'off');
    if (runnerRow) {
      const v = runnerRow.querySelector('.value');
      if (v) v.title = 'Open a page served by a runner, or start one for this directory.';
    }
  } else {
    setStatusRow(runnerRow, state.connected,
      state.connected
        ? [state.rootName,
           state.port != null ? `port ${state.port}` : null,
           state.runnerVersion ? `runner v${state.runnerVersion}` : null]
          .filter(Boolean).join(' · ') || 'Connected'
        : 'Not connected',
      state.connected ? '' : 'off');
    if (runnerRow) {
      const v = runnerRow.querySelector('.value');
      // #119: the full served path is reference, so it lives here rather than
      // in a row of its own that wrapped to three lines.
      if (v) v.title = state.root || '';
    }
  }

  // "Also up" — only when a runner exists that is not this tab's.
  if (alsoRow) {
    alsoRow.hidden = !scanned;
    const v = alsoRow.querySelector('.value');
    if (v && scanned) {
      v.textContent = [state.rootName, state.port != null ? String(state.port) : null]
        .filter(Boolean).join(' · ');
      v.title = state.root || '';
    }
  }

  // Phoenix row.
  setStatusRow($('row-phoenix'), state.phoenix === 'running',
    state.phoenix === 'running' ? 'Running' : 'Not running',
    state.phoenix === 'running' ? '' : 'off');

  // API-key row (#119): shown only when it says something. 'unknown' is the
  // answer whenever /api/info omits the flag, so a permanent "API key:
  // Unknown" row is a line that never varies and never helps.
  const keyRow = $('row-key');
  if (keyRow) keyRow.hidden = state.apiKey === 'unknown';
  if (state.apiKey !== 'unknown') {
    setStatusRow(keyRow, state.apiKey === 'configured',
      state.apiKey === 'configured' ? 'Configured' : 'Missing',
      state.apiKey === 'missing' ? 'warn' : '');
  }

  // Last-run row. It carries a REAL status dot rather than a transparent
  // spacer (Blake, 2026-07-29: the blank looked awkward next to three lit
  // rows). A run has a status, so the dot means the same thing here as
  // everywhere else — green done, red failed, amber running, hollow for a
  // page with no runs yet.
  const runRow = $('row-run');
  if (runRow) {
    runRow.hidden = !state.connected;
    const status = state.lastRun ? state.lastRun.status : null;
    const cls = status === 'ok' ? 'on'
      : (status === 'error' || status === 'failed' || status === 'timeout') ? 'off'
        : status === 'running' ? 'busy'
          : 'idle';
    // setStatusRow already adds 'on' itself, so don't pass it twice.
    setStatusRow(runRow, cls === 'on',
      state.lastRun ? state.lastRun.label : 'No runs yet', cls === 'on' ? '' : cls);
  }

  // Open-directory action.
  const openBtn = $('open-dir');
  if (openBtn) {
    openBtn.hidden = !state.actions.includes('open-directory');
    openBtn.dataset.href = state.base || '';
  }

  // The one start block (#119). Says what it fixes, tells you what to DO with
  // the command -- Blake: "it should be clear in the instructions that I copy
  // this and paste in Terminal" -- and offers exactly one copy.
  const cmds = $('commands');
  if (cmds) {
    cmds.hidden = state.commands.length === 0;
    cmds.replaceChildren();
    for (const c of state.commands) {
      const card = document.createElement('div');
      card.className = 'cmd';

      const label = document.createElement('div');
      label.className = 'cmd-label';
      label.textContent = c.label;

      const how = document.createElement('div');
      how.className = 'cmd-how';
      how.textContent = 'Copy this, then paste it into Terminal in the project folder:';

      const row = document.createElement('div');
      row.className = 'cmd-row';
      const code = document.createElement('code');
      code.textContent = c.command;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        copyToClipboard(c.command).then(() => {
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
        }).catch(() => { btn.textContent = 'Copy failed'; });
      });
      row.appendChild(code);
      row.appendChild(btn);

      const note = document.createElement('div');
      note.className = 'cmd-note';
      // "not already listening" rather than "not already running": dev-up.sh
      // checks the PORT, so it reuses whatever holds 5175 even if that runner
      // serves a different folder. Saying "running" would be a small lie in
      // exactly the multi-worktree case #126 exists for.
      note.textContent = 'Starts whichever is not already listening. Add a folder name to serve that folder instead of the current one.';

      card.appendChild(label);
      card.appendChild(how);
      card.appendChild(row);
      card.appendChild(note);
      cmds.appendChild(card);
    }
  }

}

async function refresh() {
  try {
    render(deriveState(await probeAll()));
  } catch {
    render(deriveState({ runner: null, phoenixUp: false, lastRun: null }));
  }
}

// ---- bootstrap (browser only) -----------------------------------------------

function boot() {
  // Build tag — manifest.json's version_name (or version), so the popup says
  // which unpacked copy is loaded without a trip to chrome://extensions.
  const build = document.getElementById('build-tag');
  if (build) {
    try {
      const m = chrome.runtime.getManifest();
      build.textContent = m.version_name || m.version || '';
    } catch { /* not in an extension context — leave it blank */ }
  }

  // Install links.
  for (const id of ['runner-link', 'runner-repo-link']) {
    const a = document.getElementById(id);
    if (a) a.href = RUNNER_INSTALL_URL;
  }

  // Open served directory in a new tab.
  const openBtn = document.getElementById('open-dir');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      const href = openBtn.dataset.href;
      if (!href) return;
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: href });
      } else {
        window.open(href, '_blank', 'noreferrer');
      }
    });
  }

  refresh();
  let timer = setInterval(refresh, POLL_MS);
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const resume = () => { if (!timer) { refresh(); timer = setInterval(refresh, POLL_MS); } };

  // Don't poll a hidden popup; a Chrome popup usually just closes, but be tidy.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else resume();
  });
  window.addEventListener('pagehide', stop);
  window.addEventListener('beforeunload', stop);
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
