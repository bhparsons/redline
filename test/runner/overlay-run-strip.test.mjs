// test/runner/overlay-run-strip.test.mjs — #227: the outcome strip links to
// the card it decided.
//
// A finished run strip named a decision — "Addressed", a summary — with no way
// back to the comment card it was about. This file boots the overlay and
// drives a real single-comment run from "adopted as running" to settled
// (POLL_MS = 1000ms), so the View card control's WIRING is proven, not just
// its shape. What the click defers to requestAnimationFrame (scrollIntoView,
// the flash) is source-matched instead — the DOM stub's rAF is a no-op sink,
// the same limitation gutter-position.test.mjs works around the same way.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { boot } from './_overlay-boot.mjs';
import { EXT_DIR } from './_overlay-load.mjs';

const js = () => readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');

const COMMENT = {
  id: 'c-1', status: 'open', body: 'Tighten this intro.',
  anchor: { blockId: 'r-0001', quote: 'block r-0001 body text' },
  creator: 'human', createdAt: '2026-08-15T10:00:00.000Z', replies: [],
};

function bootRunning(extraStatus) {
  return boot({
    comments: [COMMENT],
    status: {
      running: true,
      runs: [{ runId: 'run-1', state: 'running', lane: 'standard', commentId: 'c-1' }],
      ...extraStatus,
    },
  });
}

// Answer the next status poll as "finished", the way a real runner does, and
// fire the 1 s tick that reads it — this is the trigger settleRun hangs off.
async function settle(app, lastRun) {
  app.state.status = { running: false, lastRun };
  const fired = await app.fireTimeouts((t) => t.ms === 1000);
  assert.ok(fired > 0, 'the 1 s status poll must be scheduled');
}

test('a settled single-comment run gets a View card control naming the comment', async () => {
  const app = bootRunning();
  await app.settle();
  await settle(app, {
    runId: 'run-1', status: 'ok', commentId: 'c-1',
    decisions: [{ id: 'c-1', decision: 'addressed', summary: 'Tightened the intro per your note.' }],
    edits: [{ blockId: 'r-0001' }],
  });

  const strip = app.host.querySelector('.rv-run-strip');
  assert.ok(!strip.classList.contains('rv-hidden'), 'the strip is showing the outcome');
  const view = strip.querySelector('.rv-strip-viewcard');
  assert.ok(view, 'the strip carries a View card control');
  assert.equal(view.textContent, 'View card');
});

test('clicking View card expands the card the run decided', async () => {
  const app = bootRunning();
  await app.settle();
  await settle(app, {
    runId: 'run-1', status: 'ok', commentId: 'c-1',
    decisions: [{ id: 'c-1', decision: 'declined', summary: "The ask reaches past this page's scope." }],
    edits: [{ blockId: 'r-0001' }],
  });

  const before = app.cardsEl().querySelector('[data-rv-comment="c-1"]');
  assert.ok(before.classList.contains('rv-collapsed'), 'not expanded yet — nothing has clicked it');

  app.host.querySelector('.rv-strip-viewcard').fire('click');
  await app.settle();

  const after = app.cardsEl().querySelector('[data-rv-comment="c-1"]');
  assert.ok(after.classList.contains('rv-expanded'), 'View card landed on it, expanded');
});

test('a batch (Send All) outcome names no single card, so the strip offers no dead link', async () => {
  const app = boot({
    comments: [COMMENT],
    status: {
      running: true,
      runs: [{ runId: 'run-2', state: 'running', lane: 'standard', commentIds: ['c-1'] }],
    },
  });
  await app.settle();
  await settle(app, {
    runId: 'run-2', status: 'ok', commentIds: ['c-1'],
    decisions: [{ id: 'c-1', decision: 'addressed', summary: 'ok' }],
    edits: [{ blockId: 'r-0001' }],
  });

  const strip = app.host.querySelector('.rv-run-strip');
  assert.ok(!strip.classList.contains('rv-hidden'));
  assert.equal(strip.querySelectorAll('.rv-strip-viewcard').length, 0,
    'several comments were touched — none of them is "the" one');
});

test('an undo strip names no comment — the branch that renders it has no View card code at all', () => {
  const src = js();
  // 'undone' is its own phase, handled in a separate branch from 'done' (the
  // one View card is wired into) — assert the two never merge rather than
  // trying to drive a real reload through the DOM stub's no-op
  // window.location.reload().
  const undone = src.match(/\} else if \(runUi\.phase === 'undone'\) \{[\s\S]*?\n {6}\}/)[0];
  assert.ok(!/rv-strip-viewcard/.test(undone), 'the undone branch builds no View card');
});

test('the wiring behind the click matches source review', () => {
  const src = js();
  // The button appears only when the run named one comment.
  assert.match(src, /if \(o\.commentId\) \{/);
  assert.match(src, /el\('button', 'rv-strip-viewcard', 'View card'\)/);
  // goToCard reuses the same expand + reveal steps as the gutter dot click
  // (onDotClick) rather than growing a second path to the same place.
  assert.match(src, /function goToCard\(commentId\)/);
  assert.match(src, /expandedId = commentId;/);
  assert.match(src, /uncollapseSectionOf\(card\);/);
  assert.match(src, /card\.scrollIntoView\(\{ block: 'center', behavior: scrollBehavior\(\) \}\);/);
  // A batch run's outcome carries no commentId — computed once in settleRun,
  // so every strip that reads the outcome inherits the same rule.
  assert.match(src, /commentId: batchIds \? null : \(run\.commentId \?\? null\)/);
});

// ---- the link rides the top line, not a row of its own ----------------------
//
// Blake, 2026-08-15, after seeing both at real panel width: "show the view card
// button in the same line as the addressed or declined, just on the right-hand
// side of that top line."
//
// The reasoning that makes it the better layout, and the reason this is pinned
// rather than left to drift: the head row carries only FIXED-WIDTH things — the
// decision chip, the author chip, the provenance — so the link lands in the
// same place on every strip. The summary sentence is the one part whose length
// varies, and it already has its own row beneath, where wrapping costs nothing.

test('View card sits on the head row, hard right', async () => {
  const app = bootRunning();
  await app.settle();
  await settle(app, {
    runId: 'run-1', status: 'ok', commentId: 'c-1',
    decisions: [{ id: 'c-1', decision: 'addressed', summary: 'Tightened the intro per your note.' }],
    edits: [{ blockId: 'r-0001' }],
  });

  const view = app.host.querySelector('.rv-strip-viewcard');
  assert.ok(view, 'the link is rendered');
  assert.ok(view.parentElement.className.includes('rv-strip-head'),
    'it belongs to the head row, beside the outcome chip');
  assert.ok(!view.parentElement.className.includes('rv-strip-text'),
    'not a sibling of the summary, which is what gave it its own row');

  const sheet = readFileSync(path.join(EXT_DIR, 'overlay.css'), 'utf8');
  const rule = /#rv-root \.rv-strip-viewcard \{([^}]*)\}/.exec(sheet)[1];
  assert.match(rule, /margin-left: auto/,
    'margin-left:auto is what pins it right — without it the layout is just "after the chips"');
  assert.match(rule, /flex: none/,
    'and flex:none keeps it whole when the head row wraps at 312px');
  assert.ok(!/display: inline-block/.test(rule),
    'the own-row version is gone, not merely overridden');
});
