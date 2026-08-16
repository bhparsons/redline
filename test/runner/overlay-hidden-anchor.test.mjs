// test/runner/overlay-hidden-anchor.test.mjs — #237: an anchor inside hidden
// content draws NO highlight instead of tinting the wrong line.
//
// A block inside a display:none ancestor is found by querySelector but
// measures 0x0 at the origin, so the persistent highlight (WP2) landed as a
// tint on whatever happened to be at the top of the document. Booted tests,
// not source reads: the trigger is "expand a card whose anchor is hidden",
// and the assertion is what #rv-root actually contains.

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_overlay-boot.mjs';

const COMMENT = {
  id: 'c-1', status: 'open', body: 'the ask',
  anchor: { blockId: 'r-0001', quote: 'block r-0001' },
  creator: 'human', createdAt: '2026-08-11T10:00:00.000Z', replies: [],
};

async function expandCard(app) {
  await app.settle();
  const card = app.host.querySelector('[data-rv-comment]');
  assert.ok(card, 'a card rendered');
  card.fire('click');
  await app.settle();
  return app.host.querySelector('[data-rv-comment]');
}

// The stub's blocks are visible by default (offsetParent → parentElement).
// Hiding one the way display:none does: offsetParent goes null, and the boot
// context's getComputedStyle reports position:static — exactly the #60
// signature isHidden() keys on.
function hideBlock(app) {
  const block = app.document.querySelector('[data-rev="r-0001"]');
  Object.defineProperty(block, 'offsetParent', { get: () => null, configurable: true });
  return block;
}
function revealBlock(block) {
  Object.defineProperty(block, 'offsetParent', { get() { return this.parentElement; }, configurable: true });
}

test('a visible anchor still gets its persistent tint (baseline)', async () => {
  const app = boot({ comments: [COMMENT] });
  const card = await expandCard(app);
  assert.ok(app.host.querySelectorAll('.rv-anchor-hl').length > 0, 'the tint is drawn');
  assert.equal(card.querySelector('.rv-hidden-tag'), null, 'and no hidden note shows');
});

test('a hidden anchor draws no highlight and the card says so', async () => {
  const app = boot({ comments: [COMMENT] });
  await app.settle();
  hideBlock(app);
  const card = await expandCard(app);
  assert.equal(app.host.querySelectorAll('.rv-anchor-hl').length, 0,
    'no highlight boxes anywhere in #rv-root — nothing to tint wrongly');
  assert.ok(card.querySelector('.rv-hidden-tag'),
    'the expanded card carries the anchored-to-hidden-text note');
});

test('the highlight returns once the content is revealed', async () => {
  const app = boot({ comments: [COMMENT] });
  await app.settle();
  const block = hideBlock(app);
  let card = await expandCard(app);
  assert.equal(app.host.querySelectorAll('.rv-anchor-hl').length, 0);

  revealBlock(block);
  // Collapse and re-expand — any render() reconciles, this is just the
  // cheapest way to cause one from user space.
  card.fire('click');
  await app.settle();
  card = await expandCard(app);
  assert.ok(app.host.querySelectorAll('.rv-anchor-hl').length > 0, 'the tint is back');
  assert.equal(card.querySelector('.rv-hidden-tag'), null, 'and the stale note is gone');
});

// ---- #237 follow-up: content-visibility hiding (closed <details>) -----------

test('checkVisibility() overrules the offsetParent heuristic when available', async () => {
  // Chrome hides closed-<details> content with content-visibility, which
  // keeps offsetParent non-null AND real geometry — the acceptance pass
  // caught the highlight landing "where the text would be". isHidden must
  // believe checkVisibility over its own heuristic.
  const { loadOverlay } = await import('./_overlay-load.mjs');
  const { isHidden } = loadOverlay();
  const node = {
    getBoundingClientRect: () => ({ top: 100, left: 0, width: 400, height: 20 }),
    offsetParent: {}, // the heuristic alone would call this visible
    checkVisibility: () => false,
  };
  assert.equal(isHidden(node), true, 'hidden by content-visibility, geometry or not');
  node.checkVisibility = () => true;
  assert.equal(isHidden(node), false);
});

// ---- #257: the layered highlight --------------------------------------------

test('the exact quote layers a deeper tint over the ambient block tint', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { EXT_DIR } = await import('./_overlay-load.mjs');
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  const anchor = readFileSync(path.join(EXT_DIR, 'overlay-anchor.js'), 'utf8');
  const css = readFileSync(path.join(EXT_DIR, 'overlay.css'), 'utf8');
  // The anchor exposes the exact quoted text's line boxes, scoped to the block.
  assert.match(anchor, /quoteRects: \(\) => \{/);
  assert.match(anchor, /findQuoteRange\(quote, block\)/, 'the search is scoped WITHIN the block');
  // The painter draws both layers; [] from quoteRects degrades to block-only.
  assert.match(js, /exact\.map\(\(r\) => \(\{ r, cls: 'rv-anchor-hl rv-anchor-exact' \}\)\)/);
  // And the deeper layer is a tint, not an underline.
  assert.match(css, /#rv-root \.rv-anchor-exact \{[^}]*color-mix[^}]*42%/);
});

test('a missing or stale quote degrades to the block-only tint (fallback intact)', async () => {
  // In the stub, createTreeWalker yields nothing, so quoteRects is always []
  // — which makes the baseline test above double as the fallback proof: the
  // ambient boxes still render (see 'a visible anchor still gets its
  // persistent tint'). Here: quoteRects tolerates an anchor with no quote.
  const app = boot({ comments: [{ ...COMMENT, anchor: { blockId: 'r-0001' } }] });
  const card = await expandCard(app);
  assert.ok(app.host.querySelectorAll('.rv-anchor-hl').length > 0, 'ambient tint still drawn');
  assert.equal(app.host.querySelectorAll('.rv-anchor-exact').length, 0, 'no phantom exact layer');
});
