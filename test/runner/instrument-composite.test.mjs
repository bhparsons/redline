// test/runner/instrument-composite.test.mjs — #69 Gap 1: composite divs.
//
// A <div> carrying its own visible text AND a block child matched neither
// stamping rule: not a STAMP_TAG, and isLeafTextDiv() rejects it the moment it
// contains a <p>. Its text therefore belonged to no stamped element and could
// not be anchored — the card-deck case from FIELD-NOTES.
//
// The rescue is a second pass over divs, asking whether any of their text sits
// outside every stamped descendant. These tests pin the rule from both sides:
// composite divs ARE stamped, pure wrappers are NOT, and running twice changes
// nothing. The tag-rule coverage lives in instrument.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { instrumentSource } from '../../runner/lib/instrument.mjs';
import { checkBalanced, isAsciiOnly } from '../../runner/lib/surgery.mjs';

// data-rev id of the nth stamped element in document order, or null.
const idsInOrder = (src) => [...src.matchAll(/data-rev="([^"]+)"/g)].map((m) => m[1]);
// The whole open tag that carries `id`, e.g. '<div data-rev="r-1" class="card">'.
// The id is inserted immediately after the tag name, so any other attribute
// sits AFTER it — read to the closing '>', not just up to the id.
const tagCarrying = (src, id) => {
  const at = src.indexOf(`data-rev="${id}"`);
  const open = src.lastIndexOf('<', at);
  return src.slice(open, src.indexOf('>', at) + 1);
};

test('a card div with a bare title above a <p> is stamped', () => {
  const src = '<body><div class="card">Site cards<p>Body text.</p></div></body>';
  const { source: out, added } = instrumentSource(src);

  // Both the div and its <p> — the container and the leaf are independently
  // anchorable, which is the whole point of multi-level stamping.
  assert.equal(added, 2);
  const ids = idsInOrder(out);
  assert.equal(ids.length, 2);
  assert.match(tagCarrying(out, ids[0]), /^<div/);
  assert.match(tagCarrying(out, ids[1]), /^<p/);
  assert.notEqual(ids[0], ids[1], 'nested ids never collide');
});

test('a pure wrapper div — all text inside stamped children — stays unstamped', () => {
  const src = '<body><div class="wrap"><p>One.</p><p>Two.</p></div></body>';
  const { source: out, added } = instrumentSource(src);

  assert.equal(added, 2, 'the two paragraphs, and nothing else');
  for (const id of idsInOrder(out)) {
    assert.match(tagCarrying(out, id), /^<p/, 'only paragraphs carry ids');
  }
});

test('whitespace between children is not text worth stamping for', () => {
  const src = [
    '<body>',
    '  <div class="wrap">',
    '    <p>One.</p>',
    '    <p>Two.</p>',
    '  </div>',
    '</body>',
  ].join('\n');
  const { source: out, added } = instrumentSource(src);
  assert.equal(added, 2);
  for (const id of idsInOrder(out)) assert.match(tagCarrying(out, id), /^<p/);
});

test('text after a block child counts too, not just before it', () => {
  const src = '<body><div class="card"><p>Body.</p>A trailing caption.</div></body>';
  const { source: out, added } = instrumentSource(src);
  assert.equal(added, 2);
  assert.match(tagCarrying(out, idsInOrder(out)[0]), /^<div/);
});

test('inline markup around the orphan text does not hide it', () => {
  const src = '<body><div class="card"><strong>Title</strong><p>Body.</p></div></body>';
  const { added } = instrumentSource(src);
  assert.equal(added, 2, 'the div (via its <strong> text) and the <p>');
});

test('a deck of cards: every card gets an id, the deck itself does not', () => {
  const src = [
    '<body><div class="deck">',
    '<div class="card">Alpha<p>First.</p></div>',
    '<div class="card">Beta<p>Second.</p></div>',
    '</div></body>',
  ].join('\n');
  const { source: out, added } = instrumentSource(src);

  // Two cards + two paragraphs. The deck's own content is entirely covered by
  // the cards, so it has no orphan text of its own.
  assert.equal(added, 4);
  const carriers = idsInOrder(out).map((id) => tagCarrying(out, id));
  assert.equal(carriers.filter((c) => c.includes('class="card"')).length, 2);
  assert.equal(carriers.filter((c) => c.includes('class="deck"')).length, 0);
});

test('stamping is idempotent — a second pass is a byte-for-byte no-op', () => {
  const src = '<body><div class="card">Site cards<p>Body text.</p></div></body>';
  const once = instrumentSource(src).source;
  const twice = instrumentSource(once);
  assert.equal(twice.added, 0);
  assert.equal(twice.source, once);
});

test('an existing id on the child still covers the parent on a re-run', () => {
  // The child was stamped by an older build; the parent has no orphan text of
  // its own. A composite pass that ignored existing ids would stamp the
  // wrapper here and break idempotency across versions.
  const src = '<body><div class="wrap"><p data-rev="r-aaaa">One.</p></div></body>';
  const { source: out, added } = instrumentSource(src);
  assert.equal(added, 0, 'nothing new to stamp');
  // (The source still changes: a document with no theme zone gains one. That
  // is ensureThemeZone, not stamping.)
  assert.ok(out.includes('data-rev="r-aaaa"'));
  assert.equal(idsInOrder(out).length, 1);
});

test('an existing id on the parent is never altered or duplicated', () => {
  const src = '<body><div data-rev="r-bbbb" class="card">Title<p>Body.</p></div></body>';
  const { source: out, added } = instrumentSource(src);
  assert.equal(added, 1, 'only the <p>');
  assert.ok(out.includes('data-rev="r-bbbb"'), 'the existing id survives verbatim');
  assert.equal(idsInOrder(out).filter((id) => id === 'r-bbbb').length, 1);
});

test('composite divs inside a stamped container are still found', () => {
  const src = '<body><section><div class="card">Title<p>Body.</p></div></section></body>';
  const { source: out, added } = instrumentSource(src);
  assert.equal(added, 3, 'section + card div + p');
  const carriers = idsInOrder(out).map((id) => tagCarrying(out, id));
  assert.match(carriers[0], /^<section/);
  assert.match(carriers[1], /^<div/);
  assert.match(carriers[2], /^<p/);
});

test('text in comments and <script> is not orphan text', () => {
  const src = [
    '<body><div class="wrap">',
    '<!-- a note to nobody -->',
    '<script>var x = "hello";</script>',
    '<p>One.</p>',
    '</div></body>',
  ].join('\n');
  const { added } = instrumentSource(src);
  assert.equal(added, 1, 'the <p> only — a comment is not anchorable content');
});

test('the invariants hold across a composite stamp', () => {
  const src = [
    '<html><body>',
    '<div class="card">Caf&eacute; notes<p>Body &amp; more.</p></div>',
    '</body></html>',
  ].join('\n');
  const { source: out } = instrumentSource(src);
  assert.ok(checkBalanced(out).ok, 'tag balance survives');
  assert.equal(isAsciiOnly(src), true);
  assert.equal(isAsciiOnly(out), true, 'the ASCII invariant survives');
  // Entities are never decoded — the whole reason writes are string surgery.
  assert.ok(out.includes('Caf&eacute;') && out.includes('&amp;'));
});
