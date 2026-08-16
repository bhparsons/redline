// test/runner/_overlay-load.mjs — shared loader for the overlay file SET.
//
// The overlay is several plain content scripts that cooperate through the
// window.__rv namespace (see extension/overlay-util.js for why it is a
// namespace and not ES imports). A test that evaluated overlay.js alone would
// now throw on the first helper it reaches, so the loader evaluates the whole
// set in one context.
//
// The order comes from manifest.json rather than a list here — the manifest is
// what Chrome actually obeys, so a load-order mistake fails these tests too
// instead of only showing up in the browser.

import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

// The overlay-* files plus overlay.js, in manifest order. refraction.js
// (mounts SVG filters) and content.js (runner detection, fetches) are skipped:
// a node stub has nothing for them to do.
export function overlayFiles() {
  const manifest = JSON.parse(readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  return manifest.content_scripts[0].js.filter((f) => /^overlay[-.]/.test(f));
}

// Evaluate the set against a minimal DOM stub and return window.__rvTest —
// the pure helpers the overlay exposes for exactly this purpose. readyState
// 'loading' keeps init() from running.
// `globals` adds or overrides context globals — needed when a helper consults
// something outside the DOM stub (isHidden asks getComputedStyle whether an
// offsetParent-less element is position:fixed, #60).
export function loadOverlay({ createElement = () => ({}), globals = {} } = {}) {
  const win = { __REVIEW__: {}, addEventListener() {} };
  const ctx = vm.createContext({
    window: win,
    document: { readyState: 'loading', addEventListener() {}, createElement, body: {} },
    navigator: { platform: 'MacIntel' },
    localStorage: { getItem: () => null, setItem() {} },
    ...globals,
  });
  for (const file of overlayFiles()) {
    vm.runInContext(readFileSync(path.join(EXT_DIR, file), 'utf8'), ctx, { filename: file });
  }
  return win.__rvTest;
}
