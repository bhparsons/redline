// test/runner/gutter-fold-stack.test.mjs — #267: comments inside a collapsed
// <details> regroup onto that section's summary row as ONE counted mark,
// instead of leaving the gutter without a trace.
//
// The decisions this pins are Blake's, from the redline on
// design/mock-panel-fold-search-2026-08-13.html (2026-08-13):
//   D1  the mark is a count with the fold's own triangle, dashed and hollow
//   D2  the count respects the lens — the gutter is fed pre-filtered
//   D3  a fold mark NEVER merges with a real dot; it yields and steps below
//   D4  clicking follows the existing dot rule (tray ≤4, row filter past it)
//   D6  the off-screen pills SUM comments, so a fold contributes all members
//   D7  concealment with no <summary> to sit on keeps today's silence
//
// COVERAGE NOTE, deliberately stated: the grouping and the anti-merge rule
// are pure and RUN here. The DOM half (walking to the outermost closed
// <details>, measuring its summary, rendering) is pinned by source assertion
// only, because nothing in the harness drives the gutter's render pass yet —
// boot() builds the column but never places a mark in it. That gap is what
// the UAT cluster (#261-#264) exists to close; until then this file must not
// be read as proof the browser draws it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOverlay } from './_overlay-load.mjs';

const EXT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../extension');
const gutterJs = () => readFileSync(path.join(EXT_DIR, 'overlay-gutter.js'), 'utf8');
const overlayJs = () => readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
const css = () => readFileSync(path.join(EXT_DIR, 'overlay.css'), 'utf8');

const {
  groupFoldRows, foldMarkTop, FOLD_MARK_GAP, FOLD_MARK_SIZE, gutterClusterBox,
} = loadOverlay();

// foldKey is whatever identifies a fold; the DOM half passes the <details>
// element itself, so these stand in for two distinct elements.
const FOLD_A = { id: 'details-a' };
const FOLD_B = { id: 'details-b' };
const row = (id, tier, foldKey, summaryY) => ({
  comment: { id, body: `${id} body` }, tier, foldKey, summaryY,
});

// ---- grouping ---------------------------------------------------------------

test('one mark per fold, carrying every member', () => {
  const folds = groupFoldRows([
    row('c-1', 'rv-gt-open', FOLD_A, 400),
    row('c-2', 'rv-gt-open', FOLD_A, 400),
    row('c-3', 'rv-gt-open', FOLD_A, 400),
  ]);
  assert.equal(folds.length, 1, 'three comments, ONE mark');
  assert.equal(folds[0].count, 3);
  assert.equal(folds[0].y, 400);
  assert.equal(folds[0].members.map((c) => c.id).join(','), 'c-1,c-2,c-3');
});

test('two folds stay two marks, in document order', () => {
  const folds = groupFoldRows([
    row('c-9', 'rv-gt-open', FOLD_B, 900),
    row('c-1', 'rv-gt-open', FOLD_A, 200),
    row('c-2', 'rv-gt-open', FOLD_A, 200),
  ]);
  assert.equal(folds.length, 2);
  assert.equal(folds[0].y, 200, 'sorted by position, not by arrival');
  assert.equal(folds[0].count, 2);
  assert.equal(folds[1].y, 900);
  assert.equal(folds[1].count, 1);
});

test('the mark takes the tier most in need of the author', () => {
  // Same precedence as a cluster chip: failed > actioned > open > resolved.
  const mixed = groupFoldRows([
    row('c-1', 'rv-gt-resolved', FOLD_A, 100),
    row('c-2', 'rv-gt-open', FOLD_A, 100),
    row('c-3', 'rv-gt-failed', FOLD_A, 100),
  ]);
  assert.equal(mixed[0].tier, 'rv-gt-failed', 'a failed comment still shouts through a fold');
  const quiet = groupFoldRows([
    row('c-4', 'rv-gt-resolved', FOLD_A, 100),
    row('c-5', 'rv-gt-open', FOLD_A, 100),
  ]);
  assert.equal(quiet[0].tier, 'rv-gt-open');
});

test('a nested fold contributes to the OUTER mark, because that is the key it arrives with', () => {
  // The DOM half resolves every concealed comment to its outermost closed
  // ancestor — the only one whose summary is still on screen — so a comment
  // two folds deep arrives here keyed to the outer one. The transitive count
  // is a consequence of that, not a rule here.
  const folds = groupFoldRows([
    row('c-outer', 'rv-gt-open', FOLD_A, 300),
    row('c-inner', 'rv-gt-open', FOLD_A, 300),
  ]);
  assert.equal(folds.length, 1);
  assert.equal(folds[0].count, 2, 'the inner fold is inside the outer count');
});

test('rows with no fold are ignored, and the input is not mutated', () => {
  const rows = [
    row('c-1', 'rv-gt-open', FOLD_A, 100),
    row('c-2', 'rv-gt-open', null, 100),
    row('c-3', 'rv-gt-open', undefined, 100),
    null,
  ];
  const before = rows.length;
  const folds = groupFoldRows(rows);
  assert.equal(folds.length, 1);
  assert.equal(folds[0].count, 1);
  assert.equal(rows.length, before);
  // DECISION 7: concealment with nothing to sit on stays out of the gutter.
  assert.equal(groupFoldRows([row('c-x', 'rv-gt-open', null, 50)]).length, 0);
});

test('no concealed comments means no marks at all', () => {
  assert.equal(groupFoldRows([]).length, 0);
  assert.equal(groupFoldRows(undefined).length, 0);
  assert.equal(groupFoldRows(null).length, 0);
});

// ---- the anti-merge rule (DECISION 3) --------------------------------------

const DOT = (center) => ({ center, half: 4.5 });        // a lone 9px dot
const CHIP = (center) => ({ center, half: 9.5 });       // a 19px cluster chip
const MARK_HALF = 9.5;                                  // the fold mark itself

test('a clear summary row keeps the mark exactly on it', () => {
  assert.equal(foldMarkTop(500, []), 500);
  assert.equal(foldMarkTop(500, [DOT(200), DOT(900)]), 500, 'distant marks are not in the way');
  assert.equal(foldMarkTop(500, undefined), 500);
});

test('a comment on the heading yields the row, and the mark clears the DRAWN box', () => {
  // The heading's own mark is readable; the fold mark is not. Fusing them
  // would lie about what you can reach, so the fold yields — by exactly
  // enough that the two boxes do not touch, and no more.
  //
  // Against a 9px dot: 4.5 + 9.5 + 2 = 16.
  assert.equal(foldMarkTop(500, [DOT(500)]), 516);
  // Against a 19px cluster chip: 9.5 + 9.5 + 2 = 21. This is the case Blake
  // caught overlapping — a fixed 19px step cleared the dot but not the chip,
  // leaving 5px of the two pills on top of each other.
  assert.equal(foldMarkTop(500, [CHIP(500)]), 521);
});

test('the clearance is measured from the box, so a taller chip pushes further', () => {
  // A cluster spanning several rows is drawn as tall as its span.
  const tall = { center: 500, half: 30 };
  assert.equal(foldMarkTop(500, [tall]), 500 + 30 + MARK_HALF + 2);
});

test('clearing one mark never re-collides with another', () => {
  // Dodging the dot at 500 lands on 516 — inside the chip at 520. The settle
  // loop has to notice and move again rather than stopping at the first fit.
  const top = foldMarkTop(500, [DOT(500), CHIP(520)]);
  assert.ok(Math.abs(top - 500) >= 16 && Math.abs(top - 520) >= 21,
    `clears both, got ${top}`);
  assert.equal(top, 541);
});

test('two folds whose summaries nearly touch get separate rows', () => {
  // The caller feeds each placed mark back in, so consecutive folds stack.
  const occupied = [];
  const first = foldMarkTop(300, occupied);
  occupied.push({ center: first, half: MARK_HALF });
  const second = foldMarkTop(305, occupied);
  assert.equal(first, 300);
  assert.equal(second, 321, 'two 19px marks need 19 apart, plus the 2px gap');
  assert.ok(Math.abs(second - first) >= 2 * MARK_HALF, 'they do not overlap');
});

test('the settle is bounded — a pathological pile-up cannot spin', () => {
  const wall = [];
  for (let y = 500; y <= 900; y += 4) wall.push(DOT(y));
  const top = foldMarkTop(500, wall);
  assert.ok(Number.isFinite(top), 'terminates');
  assert.ok(top >= 500, 'only ever moves down');
});

test('a malformed occupied entry is ignored, never a throw', () => {
  assert.equal(foldMarkTop(500, [null, {}, { half: 9.5 }]), 500);
});

test('the mark is chip-sized, and the gap is deliberate breathing room', () => {
  assert.equal(FOLD_MARK_SIZE, 19, 'same height as a cluster chip');
  assert.equal(FOLD_MARK_GAP, 2, 'adjacent rows, not separated ones');
});

test('a same-row cluster chip is CENTRED on its row, like every dot', () => {
  // The bug underneath the overlap: the chip floored at one dot (9px) and
  // hung from `top`, while min-height: 19px in the sheet stretched the drawn
  // chip downward — so it sat 5px low, and anything asking where it ended
  // was told 9px when 19 were painted.
  const flat = gutterClusterBox([100, 100]);
  assert.equal(flat.height, 19, 'the height CSS actually renders');
  assert.equal(flat.top, 90.5);
  assert.equal(flat.top + flat.height / 2, 100, 'centred on the row');
  // A cluster with real span is unchanged — same top it always had.
  const span = gutterClusterBox([100, 130]);
  assert.equal(span.top, 95.5);
  assert.equal(span.height, 39);
});

// ---- the DOM half, pinned by source (see the coverage note above) -----------

test('the concealment branch routes folds to a mark instead of dropping them', () => {
  const js = gutterJs();
  // The branch that used to be an unconditional `continue`.
  assert.match(js, /const fold = foldAncestorOf\(loc, scroll\);/);
  assert.match(js, /if \(fold !== null\) \{/);
  assert.match(js, /foldKey: fold\.el,/);
  // DECISION 7: no fold, no mark — the old behaviour survives underneath.
  assert.match(js, /if \(fold !== null\) \{[\s\S]{0,400}?continue;\s*\}\s*\n\s*\/\/ HIDDEN is not ORPHANED|continue;/);
});

test('the walk takes the OUTERMOST closed details, which is the visible one', () => {
  const js = gutterJs();
  assert.match(js, /for \(let n = node; n; n = n\.parentElement\) \{\s*\n\s*if \(n\.tagName === 'DETAILS' && !n\.open\) outermost = n;/,
    'keeps the last match walking up = the outermost');
  assert.match(js, /querySelector\(':scope > summary'\)/, 'the summary is the row it sits on');
});

test('fold marks are placed after the dots, and feed their own rows back in', () => {
  const js = gutterJs();
  assert.match(js, /const folds = groupFoldRows\(foldRaw\);/);
  assert.match(js, /occupied\.push\(\{ center: cluster\[0\]\.y, half: GUTTER_DOT_SIZE \/ 2 \}\);/,
    'a lone dot occupies its own 9px');
  assert.match(js, /occupied\.push\(\{ center: box\.top \+ box\.height \/ 2, half: box\.height \/ 2 \}\);/,
    'a chip occupies its DRAWN height, which is what overlapped');
  assert.match(js, /occupied\.push\(\{ center: fold\.top, half: FOLD_MARK_SIZE \/ 2 \}\);/,
    'and so is each mark already placed');
  // The fold rows never enter the cluster pass — that is what stops a merge.
  assert.match(js, /const clusters = clusterGutterRows\(placed\);/);
  assert.doesNotMatch(js, /clusterGutterRows\(placed\.concat\(foldRaw\)/);
});

test('DECISION 6: the off-screen pills count members, not marks', () => {
  const js = gutterJs();
  assert.match(js, /for \(let i = 0; i < fold\.count; i \+= 1\) edgeYs\.push\(fold\.top\);/);
  assert.match(js, /gutterEdgeCounts\(edgeYs, scroll\.y, viewportH\)/);
});

test('DECISION 4: a fold mark opens the tray, and unfolding is a second click', () => {
  const gj = gutterJs();
  const oj = overlayJs();
  // The mark hands the fold through; it does NOT open the details itself.
  assert.match(gj, /fold: fold\.foldKey,/);
  assert.doesNotMatch(gj, /\.open = true/, 'the gutter never unfolds anything');
  // overlay.js routes it into the existing ≤ STACK_MAX tray rule.
  assert.match(oj, /openStack\(clickGroup, opts && opts\.rect \? opts\.rect : null,\s*\n\s*opts && opts\.fold \? \{ el: opts\.fold, name: opts\.foldName \|\| '' \} : null\);/);
  // The unfold rides each CARD, not a row at the bottom of the tray (Blake,
  // live pass 2026-08-13: at the bottom it was buried under the cards you
  // were scanning), and it jumps to that card's own comment.
  assert.match(oj, /function stackUnfoldButton\(comment\)/);
  assert.match(oj, /row\.appendChild\(stackUnfoldButton\(comment\)\);/);
  assert.match(oj, /revealAnchor\(loc, comment\.anchor, comment\.id\);/);
  assert.doesNotMatch(oj, /stackEl\.appendChild\(stackUnfold\(\)\)/,
    'the buried bottom row is gone');
});

test('hovering a fold mark tints NOTHING — the text is not on screen', () => {
  // Chrome keeps real geometry on a closed <details>'s children, so the
  // zero-area filter waves them through and the tint lands over blank page
  // where the text would be (Blake, live pass 2026-08-13). Same trap #237
  // fixed for the persistent highlight.
  const js = gutterJs();
  assert.match(js, /function tintRectsFor\(comment\) \{[\s\S]{0,700}?if \(typeof loc\.hidden === 'function' && loc\.hidden\(\)\) return \[\];/);
  // And it guards BEFORE the rect filter, which is the thing that let them by.
  const body = js.slice(js.indexOf('function tintRectsFor'));
  const guardAt = body.indexOf('loc.hidden()');
  const filterAt = body.indexOf('r.width > 0');
  assert.ok(guardAt !== -1 && guardAt < filterAt, 'the concealment guard comes first');
});

test('the mark sits on the summary rect TOP, like every other row', () => {
  // Centring on the summary put the mark half a heading-height below the
  // rule that places the dots, which read as a gap (Blake, live pass).
  const js = gutterJs();
  assert.match(js, /return \{ el: outermost, y: rect\.top \+ scroll\.y \};/);
  assert.doesNotMatch(js, /rect\.top \+ scroll\.y \+ rect\.height \/ 2/);
});

test('#269 core: entering a row from the gutter keeps the lens', () => {
  const oj = overlayJs();
  assert.match(oj, /rowFilter = \{\s*\n\s*ids: clickGroup\.map\(\(c\) => c\.id\),/,
    'the selection is still a fixed id set');
  assert.doesNotMatch(oj, /ids: clickGroup[\s\S]{0,300}?filter = 'all';/,
    'no axis reset between setting the selection and expanding the card');
  assert.doesNotMatch(oj, /rowFilter = \{ ids: clickGroup[\s\S]{0,120}?filter = 'all';/,
    'the status axis is never clobbered on entry');
});

test('every gutter mark shares one centre axis', () => {
  const sheet = css();
  for (const cls of ['rv-gt-chip', 'rv-gt-fold', 'rv-gt-orphan']) {
    assert.match(sheet, new RegExp(`#rv-root \\.${cls} \\{[\\s\\S]*?right: 37\\.5px; transform: translateX\\(50%\\);`),
      `${cls} is centred on the axis`);
  }
  // The dot is 9px at right:33 — 33 + 4.5 = 37.5, the axis the rest match.
  assert.match(sheet, /#rv-root \.rv-gt-dot \{[\s\S]*?right: 33px; width: 9px;/);
  assert.doesNotMatch(sheet, /#rv-root \.rv-gt-chip \{[\s\S]*?right: 28px/,
    'the old fixed right edge drifted off the line at two digits');
});

test('the chip is back, on the title line, with two targets', () => {
  const sheet = css();
  // It was hidden for squeezing the filter row; it now shares the title line,
  // which costs the header no height (Blake, DECISION A / 2026-08-13).
  assert.doesNotMatch(sheet, /#rv-root \.rv-rowchip \{ display: none !important; \}/,
    'no longer hidden');
  assert.match(sheet, /#rv-root \.rv-rowchip-label:not\(:disabled\) \{[^}]*cursor: pointer/,
    'the label is a control only when it can widen');
  const oj = overlayJs();
  assert.match(oj, /headerTop\.appendChild\(rowChip\);/, 'on the title line');
  assert.match(oj, /headerTitle\.classList\.toggle\('rv-hidden', Boolean\(chip\)\);/,
    'the title yields its slot while the chip is up');
  // Widen clears the axes hiding members; the x leaves the selection.
  assert.match(oj, /rowChipLbl\.addEventListener\('click'[\s\S]{0,400}?filter = 'all';[\s\S]{0,80}?audienceFilter = 'all';/);
  // The exits that do NOT depend on it still exist.
  assert.match(oj, /if \(rowFilter !== null\) \{ rowFilter = null; render\(\); return; \}/, 'Escape');
  assert.match(oj, /function rowFilterBlockIds\(\)/, 'click-off');
});
test('DECISION 5: the folded tag rides every concealed card, on one line', () => {
  const oj = overlayJs();
  assert.match(oj, /if \(loc && \(comment\.id === hiddenAnchorId \|\| anchorConcealed\(loc\)\)\) \{/,
    'no longer waits for a failed reveal');
  assert.match(oj, /'Content in folded section'/);
  assert.match(oj, /el\('button', 'rv-btn', 'Unfold'\)/);
  // The LABEL shortened; the ACTION did not.
  assert.match(oj, /for \(const det of folded\.closed\) det\.open = true;\s*\n\s*revealAnchor\(loc, comment\.anchor, comment\.id\);/);
  const sheet = css();
  assert.match(sheet, /#rv-root \.rv-hidden-tag \{[\s\S]*?display: flex;/, 'one row');
  assert.match(sheet, /\.rv-hidden-tag-text \{[\s\S]*?text-overflow: ellipsis;/,
    'the note truncates rather than wrapping the button off the line');
});

test('DECISION 1 + 3: hollow and dashed, on the shared 37.5px centre axis', () => {
  const sheet = css();
  assert.match(sheet, /#rv-root \.rv-gt-fold \{[\s\S]*?border: 1\.5px dashed currentColor;/,
    'a hidden stack must not read like a visible cluster');
  assert.match(sheet, /#rv-root \.rv-gt-fold \{[\s\S]*?right: 37\.5px; transform: translateX\(50%\);/);
  // Blake's amendment: EVERY mark shares one centre — the orphan flag was 4px off.
  assert.match(sheet, /#rv-root \.rv-gt-orphan \{[\s\S]*?right: 37\.5px; transform: translateX\(50%\);/);
  assert.doesNotMatch(sheet, /#rv-root \.rv-gt-orphan \{[\s\S]*?right: 24px/);
  // All four tiers dress the mark.
  for (const tier of ['open', 'actioned', 'resolved', 'failed']) {
    assert.match(sheet, new RegExp(`#rv-root \\.rv-gt-fold\\.rv-gt-${tier} \\{`), `${tier} tier`);
  }
});

test('#269: a run no longer drops the audience and selection axes', () => {
  // Blake's case (2026-08-13): the watcher runs while the panel is set to what
  // needs his eye, and revisions should LAND in that view rather than resetting
  // it. Status already survived; audience and the gutter selection did not.
  const oj = overlayJs();
  const blob = oj.slice(oj.indexOf('function reloadPreserving'));
  const payload = blob.slice(0, 1600);
  for (const field of ['filter,', 'audienceFilter,', 'rowFilter,', 'search: searchQuery,']) {
    assert.ok(payload.includes(field), `the reload blob carries ${field}`);
  }
  // Collapsed sections and document folds are deliberately NOT in the blob —
  // they already ride their own sessionStorage keys, and a second copy would
  // be a second source of truth for the same state.
  assert.ok(!payload.includes('sections: ['), 'no duplicate copy of the section folds');
  assert.match(oj, /const SECTIONS_KEY_PREFIX = 'rv-sections:'/);
  assert.match(oj, /const FOLD_KEY_PREFIX = 'rv-folds:'/);
  // Restored, and shape-checked because the blob is user-writable storage.
  assert.match(oj, /AUD_FILTERS\.some\(\(\[key\]\) => key === saved\.audienceFilter\)/);
  assert.match(oj, /saved\.rowFilter && Array\.isArray\(saved\.rowFilter\.ids\)/);
});
