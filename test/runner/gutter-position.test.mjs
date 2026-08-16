// test/runner/gutter-position.test.mjs — #239: the gutter renders beside the
// content, never under the docked panel.
//
// The defect was a containing-block mistake: .rv-gutter is absolute inside the
// UNPOSITIONED #rv-root, so right:0 measures from the viewport edge and the
// html margin-right reflow (which moves the content) never moves the gutter —
// it sat under the 336px panel. The fix is CSS, so this test reads the sheet:
// cheap, and it fails if someone "simplifies" the offset away.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXT_DIR } from './_overlay-load.mjs';

const css = () => readFileSync(path.join(EXT_DIR, 'overlay.css'), 'utf8');

test('panel open moves the gutter out from under the panel', () => {
  const sheet = css();
  assert.match(sheet, /html\.rv-panel-open #rv-root \.rv-gutter \{ right: 336px; \}/,
    'the gutter offsets by the panel width, landing in the 46px lane the 382px reflow reserves');
});

test('the reflow arithmetic still leaves the gutter its lane', () => {
  const sheet = css();
  // 382 = 336 (panel) + 46 (gutter column). If any of the three numbers moves,
  // this test forces the others to be reconsidered together.
  assert.match(sheet, /html\.rv-panel-open \{ margin-right: 336px; \}/);
  assert.match(sheet, /html\.rv-panel-open\.rv-gutter-open \{ margin-right: 382px; \}/);
  const gutter = sheet.match(/#rv-root \.rv-gutter \{([^}]*)\}/)[1];
  assert.match(gutter, /width: 46px/);
  // Freeze-then-snap (Blake, 2026-08-12): animating `right` on its own clock
  // beside the page's easing read as the dots smearing through the text.
  assert.ok(!/transition: right/.test(gutter),
    'no transition on right — the column freezes during the reflow and snaps at transitionend');
});

// ---- #219: the dot's hit area and tier colors -------------------------------

test('the 8px hit area is a pseudo-element, not a box-shadow', () => {
  const sheet = css();
  const dot = sheet.match(/#rv-root \.rv-gt-dot \{([^}]*)\}/)[1];
  assert.ok(!/box-shadow:[^;]*transparent/.test(dot),
    'a transparent box-shadow paints but never receives pointer events');
  assert.match(sheet, /#rv-root \.rv-gt-dot::after \{[^}]*inset: -8px/,
    'the ::after ring extends the hit area 8px past the dot in every direction');
});

test('tier colors are fixed literals — theme tokens flip over the document', () => {
  // The dots sit over the USER'S DOCUMENT, whose background never follows
  // the overlay theme: --rv-ink-faint goes near-white in dark mode, which
  // made resolved dots invisible over a white page. So no var() in any tier.
  const sheet = css();
  const tiers = [...sheet.matchAll(
    /#rv-root \.rv-gt-(?:chip\.rv-gt-)?(?:open|actioned|resolved|failed)[^{]*\{([^}]*)\}/g)];
  assert.ok(tiers.length >= 8, 'expected dot + chip rules for all four tiers');
  for (const [rule, body] of tiers) {
    assert.ok(!body.includes('var('), `theme token in a tier rule: ${rule}`);
  }
});

// ---- #220: anchor tint on hover ---------------------------------------------

test('the hover tint is pointer-transparent — the dot stays the only click target', () => {
  const sheet = css();
  const tint = sheet.match(/#rv-root \.rv-gt-tint \{([^}]*)\}/)[1];
  assert.match(tint, /pointer-events: none/,
    'a tint that eats clicks would fight text selection under it');
  const label = sheet.match(/#rv-root \.rv-gt-label \{([^}]*)\}/)[1];
  assert.match(label, /pointer-events: none/);
  assert.ok(!/backdrop-filter/.test(label), 'the label is flat fill, not glass');
});

test('the tint is quote-precise with the block as fallback, one set per member', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay-gutter.js'), 'utf8');
  // #257's quoteRects when the quote is findable, rects() otherwise.
  assert.match(js, /quoteRects/, 'the hover tint inherits the layered highlight precision');
  assert.match(js, /exact\.length > 0 \? exact : loc\.rects\(\)/);
  // Every cluster member gets its own box-set (overlaps compound); the
  // panel-open side lights EVERY member's card.
  assert.match(js, /wireHover\(chip, cluster\.map\(\(c\) => c\.comment\)/);
  const overlay = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  assert.match(overlay, /rv-card-lit/, 'panel open, matching cards light');
});

// ---- #221: panel coupling — navigate without resetting ----------------------

test('the card list scroll survives the rebuild; gutter entry goes to the top', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  // render() rebuilds via replaceChildren, which zeroes the scroll box — the
  // position must be captured before and restored after, every render.
  assert.match(js, /const scrolled = cards\.scrollTop;/);
  assert.match(js, /cards\.scrollTop = scrolled;/);
  // #260 superseded #221's visibility gate for gutter clicks: the click
  // filters the panel to the row, the first card scrolls to the TOP, and the
  // emphasis fades slowly enough to scan for.
  assert.match(js, /card\.scrollIntoView\(\{ block: 'start', behavior: scrollBehavior\(\) \}\);/);
  assert.match(js, /rv-card-flash'\), 2500\);/, 'the 2.5s fade — light and fade, time to scan');
  // The DOCUMENT still only scrolls when the anchor is off screen.
  assert.match(js, /const onScreen = r\.bottom > 0 && r\.top < window\.innerHeight;/,
    'document scroll is gated on the anchor being off screen');
});

// ---- #222: the floating stack card and the row filter -----------------------

test('panel closed: ≤4 float, >4 opens the panel filtered to the row', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  // The threshold is the recorded design decision (design/comment-gutter.md).
  assert.match(js, /const STACK_MAX = 4;/);
  assert.match(js, /clickGroup\.length <= STACK_MAX/, 'small clusters float');
  assert.match(js, /rowFilter = \{\s*\n\s*ids: clickGroup\.map\(\(c\) => c\.id\),/,
    'tall clusters set the selection instead');
  // #269: it also records WHAT was clicked, so the chip can name it rather
  // than calling everything a "row".
  assert.match(js, /kind: \(opts && opts\.fold\) \? 'section' : \(clickGroup\.length > 1 \? 'cluster' : 'comment'\),/);
  // The row filter is a third axis in passesFilters. That rule moved into
  // overlay-model.js, where it is RUN rather than source-matched —
  // test/runner/filter-composition.test.mjs owns it now.
  // The visible way out: the header chip clears it.
  // #269: the chip split into two targets — the label widens, the × leaves.
  assert.match(js, /rowChipX\.addEventListener\('click', \(e\) => \{/);
  assert.match(js, /rowFilter = null;\s*\n\s*render\(\);/);
  // Scrolling the document dismisses the stack.
  assert.match(js, /window\.addEventListener\('scroll', stackDismiss, true\);/);
});

test('tray: expand-in-place with slim siblings and the Esc ladder', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  // One state machine renders rest / expanded / replying in place.
  assert.match(js, /function renderStackItems\(\)/);
  assert.match(js, /stackExpanded = comment\.id; \/\/ the expansion MOVES, never stacks/);
  // Esc steps back one layer at a time: reply → card → tray.
  assert.match(js, /if \(stackReplying !== null\) \{ stackReplying = null; renderStackItems\(\); return; \}/);
  assert.match(js, /if \(stackExpanded !== null\) \{ stackExpanded = null; renderStackItems\(\); return; \}/);
  const sheet = css();
  assert.match(sheet, /#rv-root \.rv-stack-slim \{/);
  assert.match(sheet, /#rv-root \.rv-stack-back \{/);
  assert.match(sheet, /#rv-root \.rv-stack-thread \{/);
});

test('the stack card is fully viewport-clamped and 300px wide in both places', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  const sheet = css();
  assert.match(js, /const width = 300; \/\/ matches \.rv-stack in overlay\.css/);
  // Side rule: the tray prefers the empty space right of the mark, and only
  // overlaps the text when the viewport leaves no room there.
  assert.match(js, /const left = spaceRight >= width \+ 20\s*\n\s*\? anchorRight \+ 12/);
  const stack = sheet.match(/#rv-root \.rv-stack \{([^}]*)\}/)[1];
  assert.match(stack, /position: fixed/);
  assert.match(stack, /width: 300px/);
  assert.match(stack, /max-height: 330px/);
});

// ---- #223: the rail — comment + edit in the gutter, corner pencil retired ---

test('the corner pencil is gone, not hidden — the rail owns the pair', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  const util = readFileSync(path.join(EXT_DIR, 'overlay-util.js'), 'utf8');
  // The corner-geometry helper is REMOVED with its placement, not orphaned.
  assert.ok(!/pencilPosition\s*\(/.test(js), 'overlay.js no longer computes a corner position');
  assert.ok(!/function pencilPosition/.test(util), 'the helper left overlay-util.js');
  const sheet = css();
  const pencil = sheet.match(/#rv-root \.rv-edit-pencil \{([^}]*)\}/)[1];
  assert.ok(!/position: absolute/.test(pencil), 'the pencil is a rail child, not a floater');
  assert.match(sheet, /#rv-root \.rv-gt-rail \{[^}]*position: absolute/);
  // Comment opens the composer anchored to the whole block.
  assert.match(js, /openBlockComposer\(pencilBlockId\)/);
  // The whole-block composer carries a quote — the runner refuses anchors
  // without one (Blake hit the bare {blockId} refusal live via hover-M).
  assert.match(js, /showPopover\(\{ blockId, quote: text\.slice\(0, MAX_QUOTE_CHARS\) \},/);
});

test('the teardown bridge widened for the gutter run (#131 as a rule)', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  assert.match(js, /const PENCIL_HIDE_MS = 280;/,
    'the ~280ms bridge covers the dead space between block and gutter');
});

// ---- #224: off-screen counters and the one orphan flag ----------------------

test('counters are viewport-fixed, hidden at zero, and reduced-motion aware', () => {
  const sheet = css();
  const edge = sheet.match(/#rv-root \.rv-gt-edge \{([^}]*)\}/)[1];
  assert.match(edge, /position: fixed/,
    'the column box scrolls away with the document; the counters must not');
  const js = readFileSync(path.join(EXT_DIR, 'overlay-gutter.js'), 'utf8');
  assert.match(js, /classList\.toggle\('rv-hidden', count === 0\)/, 'a count of 0 hides, never shows "0"');
  assert.match(js, /prefers-reduced-motion/, 'the jump honours reduced motion');
});

test('a folded-away anchor renders NO mark — the gutter asks hidden(), not just rect size', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay-gutter.js'), 'utf8');
  // Chrome keeps real geometry on a closed <details>' children
  // (content-visibility), so a 0x0-rect check alone let folded comments
  // render marks at phantom rows.
  assert.match(js, /const concealed = typeof loc\.hidden === 'function' && loc\.hidden\(\);/);
  assert.match(js, /if \(concealed \|\| \(r\.width <= 0 && r\.height <= 0\)\) \{/);
});

test('orphans collapse into ONE counted flag that opens the re-anchor flow', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay-gutter.js'), 'utf8');
  assert.match(js, /const orphans = raw\.filter\(\(r\) => r\.orphan\);/);
  assert.match(js, /el\('div', 'rv-gt-orphan', String\(orphans\.length\)\)/, 'one flag, carrying the count');
  const overlay = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  assert.match(overlay, /startManualReanchor\(comment\.id\); \/\/ sets reanchorId/,
    'the flag click routes to the existing re-anchor flow (#157)');
});

// ---- #225: touch, keyboard, low vision --------------------------------------

test('every mark is a keyboard citizen, and focus tints like hover', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay-gutter.js'), 'utf8');
  // Focusable, announced as buttons, Enter/Space activate.
  assert.match(js, /mark\.tabIndex = 0;/);
  assert.match(js, /mark\.setAttribute\('role', 'button'\);/);
  assert.match(js, /e\.key === 'Enter' \|\| e\.key === ' '/);
  // Focus tints the anchor exactly as hover does — or a keyboard user gets
  // the dot and never the anchor.
  assert.match(js, /mark\.addEventListener\('focus', \(\) => setHover\(members, top, key, true\)\);/);
  assert.match(js, /mark\.addEventListener\('blur', clearHover\);/);
  // The rebuild restores focus, so scrolling doesn't dump the traversal.
  assert.match(js, /child\.focus\(\{ preventScroll: true \}\)/);
  // Focus is visible on every mark kind.
  const sheet = css();
  assert.match(sheet, /#rv-root \.rv-gt-dot:focus-visible,\s*\n#rv-root \.rv-gt-chip:focus-visible,\s*\n#rv-root \.rv-gt-orphan:focus-visible,\s*\n#rv-root \.rv-gt-edge:focus-visible \{/);
});

test('reduced motion covers the gutter transitions and the navigation scrolls', () => {
  const sheet = css();
  assert.match(sheet, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*#rv-root \.rv-gutter \{ transition: none; \}/);
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  assert.match(js, /function scrollBehavior\(\)/);
  // The dot-click document scroll and the card scrolls all route through it;
  // no remaining unconditional smooth scrolls in overlay.js.
  assert.ok(!/behavior: 'smooth'/.test(js),
    'every scroll animation decision goes through scrollBehavior()');
  // Escape reaches the floating stack (now as the tray's step-back ladder).
  assert.match(js, /function stackEscape\(event\) \{\s*\n\s*if \(event\.key !== 'Escape'\) return;/);
});

// ---- #260 amendment: row filter is sidecar-only; click-off clears it --------

test('the row filter narrows the sidecar only, and clicking off clears it', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  assert.match(js, /return everyComment\(\)\.filter\(passesAxisFilters\);/,
    'the gutter keeps every dot while the sidecar narrows — AXIS filters only,'
    + ' never the row filter');
  // Blake, 2026-08-15, live: buffered comments were missing from the gutter
  // and from the filter counts while the header counted them, so the same
  // page reported three different totals. everyComment() is the single join;
  // all three surfaces read it.
  assert.match(js, /const everyComment = \(\) => comments\.concat\(bufferedComments\.map\(asLocalComment\)\);/,
    'one join, not three');
  assert.match(js, /const pool = everyComment\(\);/, 'the filter counts read it too');
  assert.match(js, /function rowFilterBlockIds\(\)/);
  assert.match(js, /if \(block && rowFilterBlockIds\(\)\.has\(block\.getAttribute\('data-rev'\)\)\) return;/,
    'clicks inside the filtered row\'s own blocks keep the filter');
  // A card click re-renders the panel mid-dispatch, detaching the clicked
  // node — closest() then cannot prove it was chrome, and clicking a card
  // INSIDE the filtered list read as clicking off.
  assert.match(js, /if \(!t\.isConnected\) return;/,
    'a detached target is an overlay interaction, never a click-off');
});

// ---- #258 hover scope: c/m/e act on the block under the pointer -------------

test('hover c/m/e mirror the pill, with selection winning over hover', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  // Gated on a hovered block AND the pill being absent — the pill's own
  // c/m/e (selection scope) run earlier in the handler and take precedence.
  assert.match(js, /if \(pencilBlockId !== null && !selPill\) \{/);
  assert.match(js, /openBlockComposer\(pencilBlockId\); return; \}/, 'M = comment on the hovered block');
  assert.match(js, /openInlineEditor\(pencilBlockId\);/, 'E = edit it in place');
  assert.match(js, /function copyHoverBlock\(\)/, 'C = copy its text');
  // The typing guard sits ABOVE the hover keys in the same handler — keys
  // are inert while any input, ours or the host page's, holds focus.
  const handler = js.slice(js.indexOf("closest('input, textarea, select, [contenteditable]')"));
  assert.ok(handler.indexOf('pencilBlockId !== null && !selPill') > 0,
    'hover keys come after the typing-context guard');
});

// ---- #239 follow-up: the column hugs the text edge --------------------------

test('the right offset slides the column to the text, floored by the reflow offsets', async () => {
  const { loadOverlay } = await import('./_overlay-load.mjs');
  const { gutterRightOffset } = loadOverlay();
  // Narrow text on a wide window: the column leaves the viewport edge.
  // 1440 wide, text ends at 900 -> right = 1440-900-10-46 = 484.
  assert.equal(gutterRightOffset(1440, 900, false), 484);
  // Panel open only raises the floor; the text edge still wins when smaller.
  assert.equal(gutterRightOffset(1440, 900, true), 484);
  // Text running under the panel: clamped to the floor, never overlapping.
  assert.equal(gutterRightOffset(1440, 1400, true), 336);
  assert.equal(gutterRightOffset(1440, 1400, false), 0);
  // No measurable text: the CSS defaults stand.
  assert.equal(gutterRightOffset(1440, 0, true), 336);
  assert.equal(gutterRightOffset(1440, NaN, false), 0);
});

// ---- the mark sits on the first LINE of the text, not the block's top edge --
//
// Blake, 2026-08-15, live: "the comment bubbles in the gutter seem to align
// with the very top of the div... I don't know if there's a better way to
// align them with the first line of the text or if our only option is just to
// push them down by a pixel amount."
//
// There is a better way, and it costs nothing: the quoted text's line boxes
// are already computed for the anchor highlight (#257), so the mark centres on
// the real first line. A fixed nudge would have been wrong at any font size
// but one.

test('a mark centres on the block\'s first line, not its top and not its middle', async () => {
  const { loadOverlay } = await import('./_overlay-load.mjs');
  const { anchorMarkY } = loadOverlay();

  // A 13-line paragraph running 100..360, first line 100..120.
  const block = { top: 100, height: 260 };
  // The mark belongs at 110. Not 100 — half a dot centred there hangs above
  // the block entirely, which is what made it look like it pointed at the gap.
  // And emphatically not 230, the middle of the block's height: Blake,
  // 2026-08-15, "for a multi-line block, I want it centered on the first line
  // of the block, not centered on the overall block's height."
  assert.equal(anchorMarkY(block, { top: 100, height: 20 }, 20), 110);
  assert.notEqual(anchorMarkY(block, { top: 100, height: 20 }, 20), block.top + block.height / 2);

  // Block height is irrelevant once a line box is known — a one-line block and
  // a twenty-line block with the same first line get the same mark.
  assert.equal(anchorMarkY({ top: 100, height: 20 }, { top: 100, height: 20 }, 20), 110);
});

test('with no line box it falls back to one line-height, capped by the block', async () => {
  const { loadOverlay } = await import('./_overlay-load.mjs');
  const { anchorMarkY } = loadOverlay();

  // The block's line boxes could not be measured. One line-height down is
  // still far better than the top edge.
  assert.equal(anchorMarkY({ top: 100, height: 260 }, null, 20), 110);
  // A zero-height line box is not a line box.
  assert.equal(anchorMarkY({ top: 100, height: 260 }, { top: 100, height: 0 }, 20), 110);

  // A block SHORTER than its line-height cannot push the mark past its own
  // bottom edge — an <img> or a one-line cell with tight leading.
  assert.equal(anchorMarkY({ top: 100, height: 8 }, null, 40), 104);

  // line-height: normal parses to NaN, and a computed style can be missing
  // entirely. Neither may move the mark to a wrong place — the top edge is a
  // worse answer, never an incorrect one.
  assert.equal(anchorMarkY({ top: 100, height: 260 }, null, NaN), 100);
  assert.equal(anchorMarkY({ top: 100, height: 260 }, null, 0), 100);
});
