// test/runner/overlay-lifecycle.test.mjs — WP9: comment lifecycle sections.
//
// A comment belongs to exactly ONE section, chosen by its status: Open,
// Recently actioned (subdivided addressed/declined/deferred/failed), or
// Resolved. groupComments() is the pure assignment the render uses; testing
// it guarantees the section placement and the absence of duplicate cards
// without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOverlay } from './_overlay-load.mjs';


const c = (id, status) => ({ id, status });

test('sectionKey maps every status to one section', () => {
  const { sectionKey } = loadOverlay();
  assert.equal(sectionKey('open'), 'open');
  assert.equal(sectionKey('reopened'), 'open');
  assert.equal(sectionKey('sent'), 'open');
  assert.equal(sectionKey('addressed'), 'actioned');
  assert.equal(sectionKey('declined'), 'actioned');
  assert.equal(sectionKey('deferred'), 'actioned');
  assert.equal(sectionKey('failed'), 'actioned');
  assert.equal(sectionKey('resolved'), 'resolved');
});

test('groupComments places each comment in its section and sub-section', () => {
  const { groupComments } = loadOverlay();
  const g = groupComments([
    c('a', 'open'), c('b', 'addressed'), c('c', 'declined'),
    c('d', 'deferred'), c('e', 'failed'), c('f', 'resolved'), c('g', 'reopened'),
  ]);
  // ids(): re-materialize in this realm (vm arrays trip deepStrictEqual on prototype).
  const ids = (arr) => Array.from(arr, (x) => x.id);
  assert.deepEqual(ids(g.open), ['a', 'g']);
  assert.deepEqual(ids(g.actioned.addressed), ['b']);
  assert.deepEqual(ids(g.actioned.declined), ['c']);
  assert.deepEqual(ids(g.actioned.deferred), ['d']);
  assert.deepEqual(ids(g.actioned.failed), ['e']);
  assert.deepEqual(ids(g.resolved), ['f']);
});

test('no comment appears in more than one section (no duplicate cards)', () => {
  const { groupComments } = loadOverlay();
  const list = ['open', 'addressed', 'declined', 'deferred', 'failed', 'resolved']
    .map((s, i) => c(`id-${i}`, s));
  const g = groupComments(list);
  const seen = [];
  const collect = (arr) => arr.forEach((x) => seen.push(x.id));
  collect(g.open);
  for (const k of ['addressed', 'declined', 'deferred', 'failed']) collect(g.actioned[k]);
  collect(g.resolved);
  assert.equal(seen.length, list.length, 'every comment placed exactly once');
  assert.equal(new Set(seen).size, seen.length, 'no comment placed twice');
});

test('the actioned sub-section order is stable', () => {
  const { ACTIONED_ORDER } = loadOverlay();
  assert.deepEqual(Array.from(ACTIONED_ORDER), ['addressed', 'declined', 'deferred', 'failed']);
});
