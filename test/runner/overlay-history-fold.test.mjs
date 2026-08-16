// test/runner/overlay-history-fold.test.mjs — folding long history entries (#247).
//
// Opening a card must not dump every reply at full length — one verbose agent
// reply pushes everything else off-screen. The RULE (what starts folded) is
// pure and tested directly; the BEHAVIOR (toggle, reset) is tested against the
// booted overlay, driving real clicks, because #196 taught this suite what
// happens when the mechanism is tested and the trigger is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOverlay } from './_overlay-load.mjs';
import { boot } from './_overlay-boot.mjs';

// ---- the pure rule -----------------------------------------------------------

const SHORT = 'Fine as written.';
// 6 lines by any estimate — comfortably past the ~4-line threshold.
const LONG = Array.from({ length: 6 }, (_, i) => `line ${i} of a long reply`).join('\n');
// One unbroken line long enough to WRAP past 4 rendered lines.
const LONG_ONE_LINE = 'x'.repeat(260);

test('an entry past ~4 rendered lines starts folded; a shorter one never does', () => {
  const { foldState } = loadOverlay();
  assert.equal(foldState({ kind: 'reply', body: LONG }, { isNewest: false }), true);
  assert.equal(foldState({ kind: 'reply', body: LONG_ONE_LINE }, { isNewest: false }), true,
    'wrapping counts — length is rendered lines, not newlines');
  assert.equal(foldState({ kind: 'reply', body: SHORT }, { isNewest: false }), false);
  assert.equal(foldState({ kind: 'reply', body: 'one\ntwo\nthree\nfour' }, { isNewest: false }), false,
    'exactly at the threshold renders in full');
});

test('the newest entry is always open, whatever its length', () => {
  const { foldState } = loadOverlay();
  assert.equal(foldState({ kind: 'reply', body: LONG }, { isNewest: true }), false);
  assert.equal(foldState({ kind: 'decision', summary: LONG }, { isNewest: true }), false);
});

test('a long decision summary folds identically to a long reply', () => {
  const { foldState } = loadOverlay();
  assert.equal(foldState({ kind: 'decision', summary: LONG }, { isNewest: false }), true);
  assert.equal(foldState({ kind: 'decision', summary: SHORT }, { isNewest: false }), false);
});

// ---- the booted behavior -----------------------------------------------------

// A comment whose history is: long reply (folds), long decision (folds),
// short reply, then a newest long reply (stays open despite its length).
const COMMENT = {
  id: 'c-1', status: 'open', body: 'the ask',
  anchor: { blockId: 'r-0001', quote: 'block r-0001' },
  creator: 'human',
  replies: [
    { body: LONG, createdAt: '2026-08-10T09:00:00.000Z' },
    { body: SHORT, createdAt: '2026-08-10T09:20:00.000Z' },
    { body: LONG, createdAt: '2026-08-10T09:30:00.000Z' },
  ],
};
const RUNS = [{
  runId: 'run-1', commentId: 'c-1', model: 'sonnet', status: 'ok',
  createdAt: '2026-08-10T09:10:00.000Z',
  decisions: [{ id: 'c-1', decision: 'declined', summary: LONG }],
}];

async function expandCard(app) {
  await app.settle();
  const card = app.host.querySelector('[data-rv-comment]');
  assert.ok(card, 'a card rendered');
  card.fire('click');
  await app.settle();
  return app.host.querySelector('[data-rv-comment]');
}

test('long entries start folded, short and newest render in full', async () => {
  const app = boot({ comments: [COMMENT], runs: RUNS });
  const card = await expandCard(app);
  const entries = card.querySelectorAll('.rv-entry-msg');
  assert.equal(entries.length, 4, 'two replies, one decision, one newest reply');
  assert.deepEqual(entries.map((e) => e.classList.contains('rv-folded')),
    [true, true, false, false],
    'long reply and long decision fold; the short one and the NEWEST long one do not');
  const folded = entries[0];
  // Header + one preview line and nothing else visible: the full body (and
  // any run row) sits inside .rv-entry-full, which the fold class hides.
  assert.ok(folded.querySelector('.rv-fold-preview'), 'the preview line exists');
  assert.ok(folded.querySelector('.rv-entry-full'), 'the full body is one hideable container');
  assert.ok(!folded.querySelector('.rv-fold-preview').textContent.includes('\n'),
    'the preview is one flattened line');
  const decision = entries[1];
  assert.ok(decision.querySelector('.rv-run'), 'the run-id row exists…');
  assert.ok(decision.querySelector('.rv-entry-full').contains(decision.querySelector('.rv-run')),
    '…inside the hidden container, so a folded entry shows no run row');
  // Short entries get no toggle at all.
  assert.equal(entries[2].querySelector('.rv-fold-toggle'), null);
  assert.equal(entries[3].querySelector('.rv-fold-toggle'), null);
});

test('the who·when row is the toggle: accessible, clickable, round-trips', async () => {
  const app = boot({ comments: [COMMENT], runs: RUNS });
  const card = await expandCard(app);
  const folded = card.querySelector('.rv-entry-fold');
  const head = folded.querySelector('.rv-fold-toggle');
  assert.equal(head.getAttribute('role'), 'button');
  assert.equal(head.getAttribute('tabindex'), '0');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.ok(head.querySelector('.rv-fold-chevron'), 'a chevron indicates state');

  head.fire('click');
  assert.equal(folded.classList.contains('rv-folded'), false, 'click opens');
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  head.fire('click');
  assert.equal(folded.classList.contains('rv-folded'), true, 'click again re-folds');
  assert.equal(head.getAttribute('aria-expanded'), 'false');

  head.fire('keydown', { key: 'Enter' });
  assert.equal(folded.classList.contains('rv-folded'), false, 'Enter toggles');
  head.fire('keydown', { key: ' ' });
  assert.equal(folded.classList.contains('rv-folded'), true, 'Space toggles back');
  head.fire('keydown', { key: 'a' });
  assert.equal(folded.classList.contains('rv-folded'), true, 'other keys do nothing');
});

test('fold state survives an in-place reopen; the next rebuild resets it', async () => {
  // Amended for #265: close/reopen used to rebuild the card (and so reset
  // every entry). It is now a class flip on the EXISTING node — that is what
  // lets the expand transition run — so what you unfolded stays unfolded
  // across a toggle. The #247 default still returns on any real rebuild
  // (poll change, filter change, run reload).
  const app = boot({ comments: [COMMENT], runs: RUNS });
  let card = await expandCard(app);
  const head = card.querySelector('.rv-fold-toggle');
  head.fire('click');
  assert.equal(card.querySelector('.rv-entry-fold').classList.contains('rv-folded'), false);

  // Close and reopen: the same node, so the unfolded entry is still open.
  card.fire('click');
  await app.settle();
  card.fire('click');
  await app.settle();
  assert.equal(card.classList.contains('rv-expanded'), true, 'the card reopened in place');
  assert.equal(card.querySelector('.rv-entry-fold').classList.contains('rv-folded'), false,
    'an in-place reopen is not a rebuild — what you unfolded stays unfolded');

  // Any render() rebuild returns the defaults. A filter-select change is the
  // cheapest one a test can fire (the stub select tracks no value, so set a
  // real filter key first — 'all' keeps the open comment visible).
  const sel = app.host.querySelectorAll('select')[0];
  sel.value = 'all';
  sel.fire('change');
  await app.settle();
  card = app.host.querySelector('[data-rv-comment]');
  assert.equal(card.classList.contains('rv-expanded'), true, 'still the expanded card after the rebuild');
  const entries = card.querySelectorAll('.rv-entry-fold');
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.classList.contains('rv-folded')),
    'fold state lives in the render, not anywhere persistent');
});

test('a folded entry unfolds from anywhere on the box; the chevron follows the name', async () => {
  // Blake, acceptance 2026-08-12: the whole folded box is the target, and the
  // chevron sits AFTER the author name, not before it.
  const app = boot({ comments: [COMMENT], runs: RUNS });
  const card = await expandCard(app);
  const folded = card.querySelector('.rv-entry-fold');
  const head = folded.querySelector('.rv-fold-toggle');
  assert.notEqual(head.children[0].className, 'rv-fold-chevron', 'the name leads the row');
  assert.equal(head.children[1].className, 'rv-fold-chevron', 'the chevron follows it');

  folded.fire('click', { target: folded });
  assert.equal(folded.classList.contains('rv-folded'), false, 'a box click unfolds');
  // Open, a body click must NOT re-fold — only the head does.
  folded.fire('click', { target: folded });
  assert.equal(folded.classList.contains('rv-folded'), false, 'body clicks never collapse an open entry');
  head.fire('click');
  assert.equal(folded.classList.contains('rv-folded'), true, 'the head still folds it back');
});
