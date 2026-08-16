// test/runner/overlay-reference.test.mjs — WP2: reference presentation.
//
// The persistent-highlight and clamp behavior lives in the Chrome-only init()
// closure, but its two decisions are pulled out as pure module-level helpers
// exposed on window.__rvTest: shouldClampQuote() (does a reference get the
// Show more toggle?) and anchorBoxRect() (document-space geometry for each
// highlight tile). Node exercises both against a stub DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOverlay } from './_overlay-load.mjs';


test('shouldClampQuote clamps only references past the threshold', () => {
  const { shouldClampQuote, QUOTE_CLAMP_CHARS } = loadOverlay();
  assert.equal(shouldClampQuote('short quote'), false);
  assert.equal(shouldClampQuote('x'.repeat(QUOTE_CLAMP_CHARS)), false, 'exactly at threshold is not clamped');
  assert.equal(shouldClampQuote('x'.repeat(QUOTE_CLAMP_CHARS + 1)), true);
  assert.equal(shouldClampQuote(''), false);
  assert.equal(shouldClampQuote(null), false);
  assert.equal(shouldClampQuote(undefined), false);
});

test('anchorBoxRect pads a client rect and offsets by scroll', () => {
  const { anchorBoxRect } = loadOverlay();
  const box = anchorBoxRect({ top: 100, left: 50, width: 200, height: 18 }, { x: 0, y: 300 });
  // Spread into this realm: the vm-created object carries the vm's
  // Object.prototype, which deepStrictEqual would otherwise reject.
  assert.deepEqual({ ...box }, { top: 399, left: 48, width: 204, height: 20 });
});

test('anchorBoxRect clamps a negative left to 0', () => {
  const { anchorBoxRect } = loadOverlay();
  const box = anchorBoxRect({ top: 0, left: 1, width: 10, height: 10 }, { x: 0, y: 0 });
  assert.equal(box.left, 0, 'left never goes negative');
});
