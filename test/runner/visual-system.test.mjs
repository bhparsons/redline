// test/runner/visual-system.test.mjs — WP11: visual system + extension icon.
//
// Static guardrails: the manifest ships a real icon set (valid PNGs the files
// actually exist), status chips share one base class, and the popup/overlay
// chrome is built on the liquid-glass tokens rather than ad-hoc colors.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
const read = (f) => readFileSync(path.join(EXT, f), 'utf8');
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('manifest declares an icon set whose files exist and are valid PNGs', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.icons, 'top-level icons declared');
  assert.ok(manifest.action.default_icon, 'action.default_icon declared');
  const sizes = ['16', '32', '48', '128'];
  for (const s of sizes) {
    assert.equal(manifest.icons[s], `icons/icon-${s}.png`);
    assert.equal(manifest.action.default_icon[s], `icons/icon-${s}.png`);
    const p = path.join(EXT, 'icons', `icon-${s}.png`);
    assert.ok(existsSync(p), `icon-${s}.png exists`);
    const head = readFileSync(p).subarray(0, 8);
    assert.ok(head.equals(PNG_SIG), `icon-${s}.png is a valid PNG`);
  }
});

test('status chips share one base class', () => {
  const css = read('overlay.css');
  // One base rule …
  assert.match(css, /#rv-root \.rv-chip \{/);
  // … and the variants only set colors on top of it (not their own geometry).
  for (const variant of ['addressed', 'declined', 'deferred', 'resolved', 'agent', 'confirm', 'failed']) {
    assert.match(css, new RegExp(`#rv-root \\.rv-chip-${variant}`), `chip variant ${variant} present`);
  }
});

test('the popup chrome is built on the liquid-glass tokens', () => {
  const css = read('popup.css');
  assert.match(css, /--rv-glass-fill/, 'uses the glass fill token');
  assert.match(css, /prefers-color-scheme: dark/, 'is theme-aware');
});

test('the card reaches the run log via the run-id link, not duplicated in the strip (WP11 / #96)', () => {
  const js = read('overlay.js');
  // #96 demoted the run log to the run id itself in the outcome block: the card
  // opens it via runLogButton(runId, runId) rather than a separate "Run log".
  assert.match(js, /runLogButton\(runId, runId\)/);
  // … and the strip's de-dup note still explains it does not repeat on success.
  assert.match(js, /WP11 de-dup/);
});
