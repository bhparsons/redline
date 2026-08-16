// test/runner/gutter-model.test.mjs — #219: the gutter's pure half, moved
// into overlay-model.js so node can pin it down: the status → tier mapping,
// the cluster pass, and the dot-row geometry (#218's residue).
//
// The DOM half (overlay-gutter.js) only measures anchors and renders what
// these functions decide — so what passes here is what the browser draws.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOverlay } from './_overlay-load.mjs';

const {
  gutterTier, dominantTier, clusterGutterRows, gutterDotTop, gutterClusterBox,
  GUTTER_CLUSTER_PX, GUTTER_DOT_SIZE, gutterEdgeCounts,
} = loadOverlay();

test('status → tier: four marks cover the whole status vocabulary', () => {
  assert.equal(gutterTier('open'), 'rv-gt-open');
  assert.equal(gutterTier('addressed'), 'rv-gt-actioned');
  // The three human decisions that end a thread all read as spent.
  assert.equal(gutterTier('resolved'), 'rv-gt-resolved');
  assert.equal(gutterTier('declined'), 'rv-gt-resolved');
  assert.equal(gutterTier('deferred'), 'rv-gt-resolved');
  assert.equal(gutterTier('failed'), 'rv-gt-failed');
  // Anything unknown (or missing) is still asking for something.
  assert.equal(gutterTier(undefined), 'rv-gt-open');
  assert.equal(gutterTier('someday-status'), 'rv-gt-open');
});

test('a cluster of {3 resolved, 1 open} takes the open tier', () => {
  assert.equal(
    dominantTier(['rv-gt-resolved', 'rv-gt-resolved', 'rv-gt-open', 'rv-gt-resolved']),
    'rv-gt-open');
  // Failed outranks everything — it is the loudest thing in the gutter.
  assert.equal(dominantTier(['rv-gt-open', 'rv-gt-failed']), 'rv-gt-failed');
  assert.equal(dominantTier(['rv-gt-resolved', 'rv-gt-actioned']), 'rv-gt-actioned');
  // Acceptance decision (Blake, 2026-08-12): actioned outranks open — an
  // open comment needs no revisit until something acts on it, an actioned
  // one is waiting on the author's review.
  assert.equal(dominantTier(['rv-gt-open', 'rv-gt-actioned']), 'rv-gt-actioned');
});

test('24 comments over 14 blocks collapse to 13 marks; counts sum to 24', () => {
  // 14 block rows, 40px apart — except the last two, 12px apart, which the
  // 18px threshold merges. Blocks 0-9 carry 2 comments each (same y), blocks
  // 10-13 one each: 24 comments in all.
  const rows = [];
  const blockY = (i) => (i < 13 ? i * 40 : 12 * 40 + 12);
  for (let b = 0; b < 14; b += 1) {
    const copies = b < 10 ? 2 : 1;
    for (let c = 0; c < copies; c += 1) {
      rows.push({ y: blockY(b), orphan: false, tier: 'rv-gt-open', id: `${b}:${c}` });
    }
  }
  assert.equal(rows.length, 24);
  const clusters = clusterGutterRows(rows);
  // 10 two-comment blocks + 2 singles + the merged last pair = 13 marks.
  assert.equal(clusters.length, 13);
  assert.equal(clusters.reduce((n, c) => n + c.length, 0), 24, 'no comment lost');
});

test('the 18px threshold: chained neighbours merge, a 19px gap splits', () => {
  const at = (...ys) => ys.map((y) => ({ y, orphan: false }));
  assert.equal(clusterGutterRows(at(100, 118)).length, 1, '18px apart merges');
  assert.equal(clusterGutterRows(at(100, 119)).length, 2, '19px apart splits');
  // Chaining: each member within 18px of the PREVIOUS one, even though the
  // ends are 36px apart.
  assert.equal(clusterGutterRows(at(100, 118, 136)).length, 1);
  assert.equal(GUTTER_CLUSTER_PX, 18);
});

test('orphans sort first and never merge — each is its own flag', () => {
  const rows = [
    { y: 500, orphan: false },
    { y: -1, orphan: true },
    { y: -1, orphan: true },
    { y: 505, orphan: false },
  ];
  const clusters = clusterGutterRows(rows);
  assert.equal(clusters.length, 3);
  assert.ok(clusters[0][0].orphan && clusters[1][0].orphan, 'orphans pinned to the top');
  assert.equal(clusters[2].length, 2, 'the two placed rows still cluster');
  // Pure: the caller's array is left as it was handed over.
  assert.equal(rows[0].y, 500);
  assert.equal(rows[1].orphan, true);
});

test('off-screen counters (#224): above/below counts at any scroll position', () => {
  const ys = [100, 500, 900, 1300, 1700];
  // Viewport 800px tall, sitting at 450: 100 is above; 1300 and 1700 below.
  let c = gutterEdgeCounts(ys, 450, 800);
  assert.equal(c.above, 1);
  assert.equal(c.below, 2);
  // At the top nothing is above; 900, 1300, 1700 start past the fold.
  c = gutterEdgeCounts(ys, 0, 800);
  assert.equal(c.above, 0);
  assert.equal(c.below, 3);
  // Scrolled past everything: all five above, none below.
  c = gutterEdgeCounts(ys, 2000, 800);
  assert.equal(c.above, 5);
  assert.equal(c.below, 0);
  // A row exactly at the top edge is on screen, not above it.
  assert.equal(gutterEdgeCounts([300], 300, 800).above, 0);
});

test('dot-row geometry (#218 residue): dots center on y, chips span the cluster', () => {
  assert.equal(GUTTER_DOT_SIZE, 9);
  assert.equal(gutterDotTop(100), 95.5, 'a 9px dot centers on its anchor line');
  // Field-by-field: the box is built inside the loader's vm context, whose
  // Object.prototype deepEqual would reject despite identical contents.
  const span = gutterClusterBox([100, 130]);
  assert.equal(span.top, 95.5);
  assert.equal(span.height, 39, 'chip spans first-to-last plus the dot size');
  // Coincident members used to floor at one dot (9px) and hang from `top`,
  // while `.rv-gt-chip { min-height: 19px }` stretched the DRAWN chip
  // downward — so the chip sat 5px below the dots either side of it, and
  // anything reasoning about where it ended was told 9 when 19 were painted.
  // #267's fold mark was the thing that asked, and overlapped it (Blake, live
  // pass 2026-08-13). The box is now the height CSS renders, centred on its
  // row like every dot.
  const flat = gutterClusterBox([100, 100]);
  assert.equal(flat.height, 19, 'the height the sheet actually draws');
  assert.equal(flat.top, 90.5);
  assert.equal(flat.top + flat.height / 2, 100, 'centred on its row');
});
