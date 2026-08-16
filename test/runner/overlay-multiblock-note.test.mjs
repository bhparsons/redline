// test/runner/overlay-multiblock-note.test.mjs — #226: the pill is honest
// about where a multi-paragraph selection anchors.
//
// Decision (Blake, 2026-08-11): multi-block edit REACH already works — the
// agent receives the whole selection as the quote and may edit any implicated
// block. What lied was the UI: the comment anchors (and tints) only the first
// block, with nothing saying so. The pill now carries a one-line note for
// cross-block selections; single-block selections are unchanged. The
// full-quote-reaches-the-agent half is pinned in context.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_overlay-boot.mjs';

test('a selection spanning two stamped blocks gets the anchor note', () => {
  const app = boot({ comments: [] });
  const pill = app.raiseSelPill('r-0001', {
    endBlockId: 'r-0002',
    text: 'block r-0001 body text block r-0002 body text',
  });
  const note = pill.querySelector('.rv-selpill-note');
  assert.ok(note, 'the note is on the pill');
  assert.match(note.textContent, /first paragraph/i, 'it names where the comment anchors');
  assert.match(note.textContent, /whole selection/i, 'and says the agent still gets everything');
  assert.ok(pill.querySelectorAll('.rv-selpill-btn').length > 0, 'the buttons are still there');
});

test('a single-block selection shows no note', () => {
  const app = boot({ comments: [] });
  const pill = app.raiseSelPill('r-0001');
  assert.equal(pill.querySelector('.rv-selpill-note'), null);
});

test('a triple-click that merely ENDS at the next block is not "multi-block"', () => {
  // The classic #150 case: endContainer is offset 0 of the NEXT element, but
  // the selected text is wholly inside the first block.
  const app = boot({ comments: [] });
  const pill = app.raiseSelPill('r-0001', { endBlockId: 'r-0002', text: 'block r-0001' });
  assert.equal(pill.querySelector('.rv-selpill-note'), null,
    'content containment absolves it, as it does for the Edit button');
});

test('a triple-click with a trailing newline is still one block (#226 follow-up)', () => {
  // toString() of a triple-click carries a trailing newline, which a raw
  // includes() against textContent missed — the note fired on one paragraph.
  const app = boot({ comments: [] });
  const pill = app.raiseSelPill('r-0001', { endBlockId: 'r-0002', text: 'block r-0001 body text\n' });
  assert.equal(pill.querySelector('.rv-selpill-note'), null,
    'whitespace-normalized containment absolves it');
});
