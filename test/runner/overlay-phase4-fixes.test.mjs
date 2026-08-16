// test/runner/overlay-phase4-fixes.test.mjs — the Phase 4 repairs that are
// still live: #105 document-order sorting and #60 hidden-anchor detection.
// Both were extracted as PURE functions precisely so they could be pinned
// here rather than by a screenshot: the sort takes an injected locator, and
// isHidden is a decision about one element.
//
// (#131's pencil-geometry trio lived here too, until #223 retired the corner
// pencil itself — the edit affordance now sits in the gutter rail, and its
// remaining pure surface is pinned by gutter-position.test.mjs.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOverlay } from './_overlay-load.mjs';

// ---- #105: the panel reads top-to-bottom like the document -----------------

// A locator stub: maps comment ids to a top offset, or null for an orphan.
function locatorFor(tops) {
  return (anchor) => {
    const top = tops[anchor && anchor.blockId];
    if (top === undefined) return null;
    return { rect: () => ({ top, left: 0, width: 100, height: 20 }) };
  };
}
const ids = (list) => list.map((c) => c.id);

test('#105 comments sort by vertical position, not creation order', () => {
  const { sortByDocumentOrder } = loadOverlay();
  // Written in the order c1, c2, c3 — but they sit on the page in reverse.
  const comments = [
    { id: 'c1', anchor: { blockId: 'r-bottom' } },
    { id: 'c2', anchor: { blockId: 'r-middle' } },
    { id: 'c3', anchor: { blockId: 'r-top' } },
  ];
  const sorted = sortByDocumentOrder(comments,
    locatorFor({ 'r-top': 10, 'r-middle': 500, 'r-bottom': 900 }));
  assert.deepEqual(ids(sorted), ['c3', 'c2', 'c1']);
});

test('#105 orphans sort last, keeping their own order', () => {
  const { sortByDocumentOrder } = loadOverlay();
  const comments = [
    { id: 'orphanA', anchor: { blockId: 'gone-1' } },
    { id: 'placed', anchor: { blockId: 'r-a' } },
    { id: 'orphanB', anchor: { blockId: 'gone-2' } },
  ];
  const sorted = sortByDocumentOrder(comments, locatorFor({ 'r-a': 300 }));
  assert.deepEqual(ids(sorted), ['placed', 'orphanA', 'orphanB']);
});

test('#105 two comments on the same block keep creation order', () => {
  const { sortByDocumentOrder } = loadOverlay();
  const comments = [
    { id: 'first', anchor: { blockId: 'r-a' } },
    { id: 'second', anchor: { blockId: 'r-a' } },
    { id: 'third', anchor: { blockId: 'r-a' } },
  ];
  const sorted = sortByDocumentOrder(comments, locatorFor({ 'r-a': 42 }));
  assert.deepEqual(ids(sorted), ['first', 'second', 'third']);
});

// A hidden anchor measures 0x0 at the origin. Sorting on that number alone
// would float every hidden comment to the TOP of the panel — the opposite of
// what #60 established about zero-area rects.
test('#105 a zero-area (hidden) anchor sorts as an orphan, not as top-of-page', () => {
  const { sortByDocumentOrder } = loadOverlay();
  const zeroLocator = (anchor) => (anchor.blockId === 'r-hidden'
    ? { rect: () => ({ top: 0, left: 0, width: 0, height: 0 }) }
    : { rect: () => ({ top: 250, left: 0, width: 100, height: 20 }) });
  const comments = [
    { id: 'hidden', anchor: { blockId: 'r-hidden' } },
    { id: 'visible', anchor: { blockId: 'r-shown' } },
  ];
  assert.deepEqual(ids(sortByDocumentOrder(comments, zeroLocator)), ['visible', 'hidden']);
});

test('#105 a throwing locator yields orphans rather than an exception', () => {
  const { sortByDocumentOrder } = loadOverlay();
  const comments = [{ id: 'a', anchor: { blockId: 'x' } }, { id: 'b', anchor: { blockId: 'y' } }];
  const boom = () => { throw new Error('detached node'); };
  assert.deepEqual(ids(sortByDocumentOrder(comments, boom)), ['a', 'b']);
});

test('#105 degenerate inputs are handled without throwing', () => {
  const { sortByDocumentOrder } = loadOverlay();
  // Arrays come back from the vm realm, so their prototype identity differs
  // from this realm's and deepEqual would reject them on that alone (the same
  // caveat popup-status.test.mjs documents). Compare contents, not identity.
  assert.equal(sortByDocumentOrder(null, () => null).length, 0);
  assert.equal(sortByDocumentOrder([], () => null).length, 0);
  assert.equal(sortByDocumentOrder([{ id: 'a', anchor: {} }], undefined).length, 1);
});

// ---- #60: an anchor inside display:none is hidden, not at the origin -------

test('#60 isHidden: offsetParent null means hidden', () => {
  const { isHidden } = loadOverlay();
  const shown = { offsetParent: {}, getBoundingClientRect: () => ({ top: 40 }) };
  const hidden = { offsetParent: null, getBoundingClientRect: () => ({ top: 0 }) };
  assert.equal(isHidden(shown), false);
  assert.equal(isHidden(hidden), true);
});

// position:fixed elements also report offsetParent === null and are very much
// visible — treating them as hidden would fire rv:reveal at a visible block.
test('#60 isHidden: a position:fixed element is NOT hidden', () => {
  const { isHidden } = loadOverlay({
    globals: { getComputedStyle: () => ({ position: 'fixed' }) },
  });
  const fixed = { offsetParent: null, getBoundingClientRect: () => ({ top: 40 }) };
  assert.equal(isHidden(fixed), false);
});

test('#60 isHidden: nothing to measure is not "hidden"', () => {
  const { isHidden } = loadOverlay();
  assert.equal(isHidden(null), false);
  assert.equal(isHidden(undefined), false);
  assert.equal(isHidden({}), false);
});
