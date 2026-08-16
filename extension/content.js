// content.js — runner detection. Runs on localhost/127.0.0.1 and file:// pages.
//
// Detection order:
//   1. Page served from a local http origin → ping that origin's /health.
//      A page served BY the runner also carries the injection placeholder
//      comment (stamped at serve time), which marks it as a reviewable doc.
//   2. file:// page → scan the default port range for a running runner.
//
// On success, hands off to the overlay (overlay.js, loaded first). On
// failure, shows a subtle "runner not connected" hint instead.

(() => {
  'use strict';

  // One shared list, published by ports.js (loaded first in manifest.json) —
  // this used to be a second copy that drifted from the popup's (#126).
  const DEFAULT_PORTS = window.__rvPorts || [];
  const MARKER = 'redline:overlay-injection-point';

  async function healthOk(origin) {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return false;
      const body = await res.json();
      return body && body.ok === true;
    } catch {
      return false;
    }
  }

  // Probe every port in `ports` CONCURRENTLY. The old loop awaited one port at
  // a time — ten ports at 1.5s each meant up to 15s of waiting before "no
  // runner is running" (#285). The list is still ORDERED and that order is
  // meaningful: with several runners live, the EARLIEST port wins, never
  // whichever happened to answer first — a race would make the popup/overlay
  // pick a different runner on every open. allSettled (not all) so one
  // rejected or timed-out probe can't sink the whole batch; healthOk already
  // swallows its own errors, this is belt-and-suspenders for anything that
  // slips past it.
  async function scanPorts(ports) {
    const results = await Promise.allSettled(ports.map((port) => healthOk(`http://127.0.0.1:${port}`)));
    for (let i = 0; i < ports.length; i++) {
      if (results[i].status === 'fulfilled' && results[i].value === true) return ports[i];
    }
    return null;
  }

  // The serve-time placeholder is an HTML comment just before </body>.
  function hasInjectionMarker() {
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_COMMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue.includes(MARKER)) return true;
    }
    return false;
  }

  async function detectRunner() {
    const { protocol, hostname, origin } = window.location;
    if (protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost')) {
      if (await healthOk(origin)) {
        return { origin, servedByRunner: hasInjectionMarker() };
      }
      return null;
    }
    if (protocol === 'file:') {
      const port = await scanPorts(DEFAULT_PORTS);
      return port === null ? null : { origin: `http://127.0.0.1:${port}`, servedByRunner: false };
    }
    return null;
  }

  // Test-only hooks (node DOM-stub tests) — mirrors overlay.js's window.__rvTest
  // and popup.js's window.__popupTest. No effect on the real content script:
  // main() below only runs detectRunner() when window.__redline is set, which
  // never happens under a bare vm stub.
  window.__rvContentTest = { detectRunner, healthOk, scanPorts };

  async function main() {
    if (!window.__redline || document.getElementById('rv-root')) return;
    const runner = await detectRunner();
    if (runner) {
      window.__redline.init(runner);
    } else {
      window.__redline.hint();
    }
  }

  main();
})();
