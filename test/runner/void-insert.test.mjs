// test/runner/void-insert.test.mjs — WP5: void/structural inserts.
//
// insertSiblingBlock() accepts a single void element (<hr>, <img>, <br>) as a
// valid insert root: the minted data-rev lands on the void tag itself, its
// afterInner is '', and tag balance still passes (void tags need no close).
// Non-void inserts keep the strict single-root rule; a stray-content void, a
// srcless <img>, and a data-rev in the fragment are all rejected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { insertSiblingBlock, checkBalanced } from '../../runner/lib/surgery.mjs';

const DOC = '<p data-rev="r-0001">alpha</p>\n<p data-rev="r-0002">beta</p>\n';
const NEW = 'r-newid';

const ins = (html, position = 'after', anchorBlockId = 'r-0001') =>
  insertSiblingBlock(DOC, { anchorBlockId, position, html, newBlockId: NEW });

test('<hr> inserts after the anchor, stamped and with empty inner', () => {
  const r = ins('<hr>');
  assert.equal(r.ok, true);
  assert.equal(r.blockId, NEW);
  assert.equal(r.afterInner, '');
  assert.match(r.source, /<p data-rev="r-0001">alpha<\/p>\n<hr data-rev="r-newid">/);
  assert.equal(checkBalanced(r.source).ok, true);
});

test('<hr> inserts before the anchor', () => {
  const r = ins('<hr>', 'before');
  assert.equal(r.ok, true);
  assert.match(r.source, /<hr data-rev="r-newid">\n<p data-rev="r-0001">alpha<\/p>/);
});

test('<img> with src is stamped and preserved', () => {
  const r = ins('<img src="figure.png" alt="a chart">');
  assert.equal(r.ok, true);
  assert.match(r.source, /<img data-rev="r-newid" src="figure.png" alt="a chart">/);
  assert.equal(checkBalanced(r.source).ok, true);
});

test('<br> is a valid void insert', () => {
  const r = ins('<br>');
  assert.equal(r.ok, true);
  assert.match(r.source, /<br data-rev="r-newid">/);
});

test('a self-closing void tag (<hr/>) is accepted', () => {
  const r = ins('<hr/>');
  assert.equal(r.ok, true);
  assert.match(r.source, /<hr data-rev="r-newid"\/>/);
});

test('<img> without src is rejected', () => {
  const r = ins('<img alt="no source">');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid-insert');
});

test('a void tag with trailing content is rejected', () => {
  const r = ins('<hr>extra');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid-insert');
});

test('a non-void multi-element fragment still requires a single root', () => {
  const r = ins('<p>a</p><p>b</p>');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid-insert');
});

test('a non-void single element still inserts (regression)', () => {
  const r = ins('<p>fresh</p>');
  assert.equal(r.ok, true);
  assert.equal(r.afterInner, 'fresh');
  assert.match(r.source, /<p data-rev="r-newid">fresh<\/p>/);
});

test('a data-rev in the inserted markup is rejected', () => {
  const r = ins('<hr data-rev="r-x">');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'data-rev-tampered');
});
