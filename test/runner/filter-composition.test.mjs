// test/runner/filter-composition.test.mjs — the rule that decides which
// comments a surface shows, moved out of overlay.js's init() closure into
// overlay-model.js (DECISION 19, Blake's redline 2026-08-13).
//
// It used to be unreachable: the only way the suite could check it was by
// matching overlay.js as TEXT (gutter-position.test.mjs did exactly that for
// the row-filter line). Source matching proves a line was typed, not that it
// behaves — so #267, #268 and #269 all wanted real tests here first.
//
// The two halves are deliberately different, and the difference is the #260
// amendment: the GUTTER consumes passesAxisFilters (status × audience only,
// so entering a row never erases the page's map), while the SIDECAR consumes
// passesFilters (which adds the row).

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOverlay } from './_overlay-load.mjs';

const {
  FILTERS, AUD_FILTERS, inAiBatch, passesAxisFilters, passesFilters, rowChipLabel,
} = loadOverlay();

// A comment carries only what the rule reads.
const c = (id, status, extra = {}) => ({ id, status, ...extra });

const OPEN = c('c-1', 'open');
const ADDRESSED = c('c-2', 'addressed');
const RESOLVED = c('c-3', 'resolved');
const FAILED = c('c-4', 'failed');
const NOTE = c('c-5', 'open', { aiEdits: false });

const ALL = { filter: 'all', audienceFilter: 'all', rowFilter: null };

test('the two axis tables cover the vocabulary the panel offers', () => {
  // Joined rather than deep-equalled: the model loads in a stubbed window, so
  // its arrays carry that realm's prototype and deepStrictEqual rejects them.
  // "All" leads both dropdowns now (Blake, 2026-08-13) — display order only;
  // every lookup is by key and 'active' is still the default.
  assert.equal(FILTERS.map(([k]) => k).join(','), 'all,active,needs,resolved');
  assert.equal(FILTERS[0][1], 'All statuses', 'the widest option names its own axis');
  assert.equal(AUD_FILTERS[0][1], 'All comments');
  assert.ok(!AUD_FILTERS.some(([, label]) => label === 'Everyone'),
    '"Everyone" read as people, under a sentence about people');
  assert.equal(AUD_FILTERS.map(([k]) => k).join(','), 'all,ai,note');
});

test('audience: only an explicit false opts a comment out of the AI batch', () => {
  assert.equal(inAiBatch({ id: 'x' }), true, 'absent aiEdits stays in the batch');
  assert.equal(inAiBatch({ id: 'x', aiEdits: true }), true);
  assert.equal(inAiBatch({ id: 'x', aiEdits: false }), false);
  // Never throws on a missing comment — the panel merges buffered entries in.
  assert.equal(inAiBatch(null), false);
  assert.equal(inAiBatch(undefined), false);
});

test('status axis: Active hides only what is resolved', () => {
  const st = { ...ALL, filter: 'active' };
  assert.equal(passesAxisFilters(OPEN, st), true);
  assert.equal(passesAxisFilters(ADDRESSED, st), true);
  assert.equal(passesAxisFilters(FAILED, st), true);
  assert.equal(passesAxisFilters(RESOLVED, st), false);
});

test('status axis: Needs review is the four decided states, failed included (#250)', () => {
  const st = { ...ALL, filter: 'needs' };
  assert.equal(passesAxisFilters(ADDRESSED, st), true);
  assert.equal(passesAxisFilters(FAILED, st), true, 'a failed run needs the author too');
  assert.equal(passesAxisFilters(c('c-6', 'declined'), st), true);
  assert.equal(passesAxisFilters(c('c-7', 'deferred'), st), true);
  assert.equal(passesAxisFilters(OPEN, st), false);
  assert.equal(passesAxisFilters(RESOLVED, st), false);
});

test('the two axes compose by intersection, not replacement', () => {
  // An open note under "Active × For the AI" fails on audience alone.
  assert.equal(passesAxisFilters(NOTE, { ...ALL, filter: 'active', audienceFilter: 'ai' }), false);
  assert.equal(passesAxisFilters(NOTE, { ...ALL, filter: 'active', audienceFilter: 'note' }), true);
  // A resolved note under "Notes only" still fails on status.
  const resolvedNote = c('c-8', 'resolved', { aiEdits: false });
  assert.equal(passesAxisFilters(resolvedNote, { ...ALL, filter: 'active', audienceFilter: 'note' }), false);
  assert.equal(passesAxisFilters(resolvedNote, { ...ALL, filter: 'resolved', audienceFilter: 'note' }), true);
});

test('a stale or unknown axis key falls back to All rather than blanking the panel', () => {
  // The status filter is restored from sessionStorage across a run reload; a
  // value written by an older build must not throw or hide everything.
  assert.equal(passesAxisFilters(OPEN, { ...ALL, filter: 'no-such-filter' }), true);
  assert.equal(passesAxisFilters(NOTE, { ...ALL, audienceFilter: 'no-such-audience' }), true);
  // No state at all is All × All.
  assert.equal(passesAxisFilters(RESOLVED, undefined), true);
});

test('the row filter is a fixed id set that composes with the other axes (#222)', () => {
  const rowFilter = { ids: ['c-1', 'c-3'] };
  assert.equal(passesFilters(OPEN, { ...ALL, rowFilter }), true);
  assert.equal(passesFilters(RESOLVED, { ...ALL, rowFilter }), true);
  assert.equal(passesFilters(ADDRESSED, { ...ALL, rowFilter }), false, 'outside the row');
  // Intersection: inside the row but hidden by status.
  assert.equal(passesFilters(RESOLVED, { ...ALL, filter: 'active', rowFilter }), false);
  assert.equal(passesFilters(OPEN, { ...ALL, filter: 'active', rowFilter }), true);
});

test('a member whose status changes stays in the row — the set is ids, not a predicate', () => {
  const rowFilter = { ids: ['c-1'] };
  const nowResolved = c('c-1', 'resolved');
  assert.equal(passesFilters(nowResolved, { ...ALL, rowFilter }), true,
    'still a row member after the status moved');
  // It is the status axis, not row membership, that can then hide it.
  assert.equal(passesFilters(nowResolved, { ...ALL, filter: 'active', rowFilter }), false);
});

test('the row filter is sidecar-only: the gutter rule ignores it (#260)', () => {
  const rowFilter = { ids: ['c-1'] };
  // ADDRESSED is outside the row. The sidecar hides it; the gutter keeps it,
  // so entering a row never erases the page's map of everything else.
  assert.equal(passesFilters(ADDRESSED, { ...ALL, rowFilter }), false);
  assert.equal(passesAxisFilters(ADDRESSED, { ...ALL, rowFilter }), true);
});

test('an empty row set hides everything; a null row filter hides nothing', () => {
  assert.equal(passesFilters(OPEN, { ...ALL, rowFilter: { ids: [] } }), false);
  assert.equal(passesFilters(OPEN, { ...ALL, rowFilter: null }), true);
});

test('both halves are pure — the same call twice gives the same answer', () => {
  const st = { ...ALL, filter: 'active', rowFilter: { ids: ['c-1'] } };
  const before = JSON.stringify(st);
  assert.equal(passesFilters(OPEN, st), passesFilters(OPEN, st));
  assert.equal(JSON.stringify(st), before, 'state is not mutated');
});

// ---- #269: what the gutter-entry chip says ---------------------------------
//
// "This row · N" named the MECHANISM — marks within 18px of each other,
// chained — and Blake was right that it named nothing in the document
// (2026-08-13). It is a fact about where things land on screen: two comments
// on different short paragraphs group, two on different lines of one long
// paragraph do not, and a fold mark's group is a whole section. The chip now
// names what was clicked instead of pretending those are one thing.

const sel = (n, kind, name) => ({ ids: Array.from({ length: n }, (_, i) => `c-${i}`), kind, name });

test('the chip names what you clicked, not the clustering that produced it', () => {
  assert.equal(rowChipLabel(sel(1, 'comment'), 1).text, 'This comment');
  assert.equal(rowChipLabel(sel(7, 'cluster'), 7).text, 'These comments · 7');
  assert.equal(rowChipLabel(sel(7, 'section'), 7).text, 'This section · 7');
  assert.ok(!/row/i.test(rowChipLabel(sel(7, 'cluster'), 7).text), 'the word is gone');
});

test('a lone comment carries no arithmetic — 1 of 1 is noise on a glanceable chip', () => {
  const one = rowChipLabel(sel(1, 'comment'), 1);
  assert.equal(one.text, 'This comment');
  assert.equal(one.canWiden, false);
});

test('when the lens hides members the count becomes a composition', () => {
  // The gap between the two numbers IS the explanation for why the list is
  // shorter than the mark implied.
  const partial = rowChipLabel(sel(7, 'cluster'), 3);
  assert.equal(partial.text, 'These comments · 3 of 7');
  assert.equal(partial.canWiden, true, 'there is something to widen to');
  assert.match(partial.title, /3 shown under your filters/);
  // Even a single comment says so when its own lens is hiding it.
  assert.equal(rowChipLabel(sel(1, 'comment'), 0).text, 'This comment · 0 of 1');
  assert.equal(rowChipLabel(sel(1, 'comment'), 0).canWiden, true);
});

test('widening is offered only when it would do something', () => {
  assert.equal(rowChipLabel(sel(7, 'cluster'), 7).canWiden, false);
  assert.equal(rowChipLabel(sel(7, 'cluster'), 6).canWiden, true);
  // A section's own heading is too long for a 336px header, so it rides the
  // tooltip rather than the face.
  const named = rowChipLabel(sel(4, 'section', 'Prior art'), 4);
  assert.ok(!named.text.includes('Prior art'), 'not on the face');
  assert.match(named.title, /Prior art/, 'but reachable');
});

test('the chip survives nonsense rather than throwing at the top of the header', () => {
  assert.equal(rowChipLabel(null, 0), null);
  assert.equal(rowChipLabel({}, 0).text, 'These comments');
  assert.equal(rowChipLabel(sel(3, 'no-such-kind'), 3).text, 'These comments · 3');
  // A shown count larger than the set (a stale render) clamps rather than
  // printing "5 of 3".
  assert.equal(rowChipLabel(sel(3, 'cluster'), 99).text, 'These comments · 3');
  assert.equal(rowChipLabel(sel(3, 'cluster'), -5).text, 'These comments · 0 of 3');
});
