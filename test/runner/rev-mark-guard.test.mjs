// test/runner/rev-mark-guard.test.mjs — #99: the data-rev tamper guard counts
// marks in TAGS, not in text.
//
// A data-rev mark can only be an attribute, and an attribute only lives between
// a tag's angle brackets. Counting every literal "data-rev" substring anywhere
// in a fragment rejected legitimate content — prose about this very system, an
// ASCII diagram labelling "data-rev anchored blocks" — which is what failed the
// real diagram-insert run (run-fe76fb504fb1, comment c-97aab8e35a70). Every
// smuggling route must still fail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { insertSiblingBlock, replaceBlockInner, sameRevMarks } from '../../runner/lib/surgery.mjs';

const DOC = '<!doctype html>\n<html><body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<p data-rev="r-3765">tail block</p>\n</body></html>\n';

const insert = (html) => insertSiblingBlock(DOC, {
  anchorBlockId: 'r-3765', position: 'before', html, newBlockId: 'r-9999',
});

// ---- the regression: prose that mentions data-rev ---------------------------

test('insert: the exact <pre> diagram that failed run-fe76fb504fb1 is accepted', () => {
  // Verbatim shape from tmp/review-runs/run-fe76fb504fb1/agent-response-3.json:
  // the diagram's TEXT describes the reviewed doc as "(data-rev anchored blocks)".
  const diagram = '<pre style="background: #eef0f3; padding: 14px;">'
    + '  +-----------------------------+\n'
    + '  |   Reviewed HTML document     |\n'
    + '  |   (data-rev anchored blocks) |\n'
    + '  +-----------------------------+</pre>';
  const r = insert(diagram);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.source.includes('<pre data-rev="r-9999"'), 'minted id lands on the root tag');
  assert.ok(r.source.includes('(data-rev anchored blocks)'), 'diagram text survives verbatim');
});

test('insert: prose mentioning data-rev in text content is accepted', () => {
  for (const html of [
    '<p>Blocks are located by their data-rev id.</p>',
    '<p>The runner never alters <code>data-rev</code> attributes.</p>',
    '<li>data-rev="r-0001" is written by the instrumenter, not the agent.</li>',
  ]) {
    assert.equal(insert(html).ok, true, `should accept: ${html}`);
  }
});

// ---- every smuggling route still fails --------------------------------------

test('insert: a real data-rev attribute is still refused, however it is written', () => {
  const smuggles = [
    '<p data-rev="r-1234">double quoted</p>',
    "<p data-rev='r-1234'>single quoted</p>",
    '<p data-rev=r-1234>unquoted</p>',
    '<p data-rev>valueless</p>',
    '<p DATA-REV="r-1234">upper case</p>',
    '<p><span data-rev="r-1234">nested child</span></p>',
    // The quote-aware case: a '>' inside an attribute VALUE must not end the
    // tag span and push the following data-rev outside the scan.
    '<p title="a>b" data-rev="r-1234">quote-hidden angle bracket</p>',
  ];
  for (const html of smuggles) {
    const r = insert(html);
    assert.equal(r.ok, false, `should refuse: ${html}`);
    assert.equal(r.code, 'data-rev-tampered', `wrong code for: ${html}`);
  }
});

test('insert: an unparseable "<" falls back to the strict whole-string count', () => {
  // '<' that opens no tag span → the scan is untrusted → pre-#99 behavior.
  const r = insert('<p>3 < 4 and data-rev="r-1234" hides here</p>');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'data-rev-tampered');
});

// ---- the replace path gets the same fix -------------------------------------

test('replaceBlockInner: prose may newly mention data-rev', () => {
  const r = replaceBlockInner(DOC, 'r-0001', 'Blocks carry a data-rev id minted server-side.');
  assert.equal(r.ok, true, r.error);
  assert.ok(r.source.includes('<p data-rev="r-0001">Blocks carry a data-rev id minted server-side.</p>'));
});

test('replaceBlockInner: altering the marks inside a block is still refused', () => {
  const withChild = '<!doctype html>\n<html><body>\n'
    + '<div data-rev="r-0001">head <span data-rev="r-0002">child</span></div>\n</body></html>\n';
  for (const [inner, why] of [
    ['head <span data-rev="r-0003">child</span>', 'renamed child id'],
    ['head child', 'dropped the child mark'],
    ['head <span data-rev="r-0002">a</span><span data-rev="r-0004">b</span>', 'invented a mark'],
  ]) {
    const r = replaceBlockInner(withChild, 'r-0001', inner);
    assert.equal(r.ok, false, `should refuse: ${why}`);
    assert.equal(r.code, 'data-rev-tampered');
  }
});

// ---- sameRevMarks units -----------------------------------------------------

test('sameRevMarks ignores text mentions and compares tag marks', () => {
  assert.equal(sameRevMarks('plain', 'now mentions data-rev in prose'), true);
  assert.equal(sameRevMarks('<p data-rev="a">x</p>', '<p data-rev="a">talks about data-rev</p>'), true);
  assert.equal(sameRevMarks('<p data-rev="a">x</p>', '<p data-rev="b">x</p>'), false);
  assert.equal(sameRevMarks('x', "<i data-rev='a'>x</i>"), false);
  assert.equal(sameRevMarks('<p data-rev="a">x</p>', '<p>x</p>'), false);
});
