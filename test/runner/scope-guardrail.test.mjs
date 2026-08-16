// test/runner/scope-guardrail.test.mjs — WP7: scope-aware confirmation gate.
//
// The runner computes the ACTUAL reach of an edit set from a dry-run's edit
// records and compares it to the anchored section; the agent's own scope
// report can only add or waive a confirmation, never hide a theme edit or an
// out-of-section reach.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionRange, computeScope, confirmationDecision } from '../../runner/lib/scope.mjs';

const DOC = [
  '<body>',
  '<style data-rev-theme></style>',
  '<section data-rev="r-secA"><h2 data-rev="r-a1">A</h2><p data-rev="r-a2">a body</p></section>',
  '<section data-rev="r-secB"><p data-rev="r-b1">b body</p></section>',
  '</body>',
].join('\n');

// helpers to fake dry-run edit records
const inner = (blockId) => ({ blockId, beforeInner: '', afterInner: '' });
const attr = (blockId) => ({ blockId, op: 'attributes', beforeInner: '', afterInner: '' });
const themeRec = () => ({ blockId: null, op: 'theme', beforeInner: '', afterInner: '' });
const insertAfter = (anchor, blockId = 'r-new1') => ({ blockId, insertedAfter: anchor, afterInner: '' });

// ---- sectionRange ----------------------------------------------------------

test('sectionRange resolves a leaf anchor to its enclosing section', () => {
  const s = sectionRange(DOC, 'r-a2');
  assert.ok(s);
  assert.equal(s.id, 'r-secA');
});

test('sectionRange returns the container itself when the anchor is one', () => {
  const s = sectionRange(DOC, 'r-secA');
  assert.equal(s.id, 'r-secA');
});

test('sectionRange is null when the anchor has no enclosing container', () => {
  const doc = '<body>\n<p data-rev="r-x">loose</p>\n</body>';
  assert.equal(sectionRange(doc, 'r-x'), null);
  assert.equal(sectionRange(DOC, ''), null);
  assert.equal(sectionRange(DOC, 'r-missing'), null);
});

// ---- computeScope ----------------------------------------------------------

test('editing only the anchor block is block-level and in-section', () => {
  const c = computeScope(DOC, { anchorBlockId: 'r-a2', editRecords: [inner('r-a2')] });
  assert.equal(c.level, 'block');
  assert.equal(c.outOfSection, false);
  assert.equal(c.touchedThemeZone, false);
});

test('editing sibling blocks within the section is section-level, in-section', () => {
  const c = computeScope(DOC, { anchorBlockId: 'r-a2', editRecords: [inner('r-a1'), inner('r-a2')] });
  assert.equal(c.level, 'section');
  assert.equal(c.outOfSection, false);
});

test('editing a block in another section is out-of-section', () => {
  const c = computeScope(DOC, { anchorBlockId: 'r-a2', editRecords: [inner('r-a2'), attr('r-b1')] });
  assert.equal(c.outOfSection, true);
  assert.equal(c.level, 'section');
});

test('a theme edit is page-level', () => {
  const c = computeScope(DOC, { anchorBlockId: 'r-a2', editRecords: [inner('r-a2'), themeRec()] });
  assert.equal(c.touchedThemeZone, true);
  assert.equal(c.level, 'page');
});

test('an insert anchored inside the section stays in-section', () => {
  const c = computeScope(DOC, { anchorBlockId: 'r-secA', editRecords: [insertAfter('r-a2')] });
  assert.equal(c.outOfSection, false);
});

test('an insert anchored outside the section is out-of-section', () => {
  const c = computeScope(DOC, { anchorBlockId: 'r-a2', editRecords: [insertAfter('r-b1')] });
  assert.equal(c.outOfSection, true);
});

// ---- confirmationDecision --------------------------------------------------

const narrow = { level: 'block', touchedThemeZone: false, outOfSection: false, touchedBlocks: ['r-a2'] };
const theme = { level: 'page', touchedThemeZone: true, outOfSection: false, touchedBlocks: [] };
const outside = { level: 'section', touchedThemeZone: false, outOfSection: true, touchedBlocks: ['r-b1'] };

test('an in-section change needs no confirmation', () => {
  assert.equal(confirmationDecision({ computed: narrow }).required, false);
});

test('a theme change needs confirmation', () => {
  const d = confirmationDecision({ computed: theme });
  assert.equal(d.required, true);
  assert.match(d.reasons.join(' '), /theme/);
});

test('an out-of-section change needs confirmation', () => {
  assert.equal(confirmationDecision({ computed: outside }).required, true);
});

test('the agent can waive a broad-scope confirmation (user authorized it)', () => {
  assert.equal(confirmationDecision({ computed: outside, agentScope: { requiresConfirmation: false } }).required, false);
  assert.equal(confirmationDecision({ computed: theme, agentScope: { requiresConfirmation: false } }).required, false);
});

test('the agent can request confirmation even for a narrow change', () => {
  assert.equal(confirmationDecision({ computed: narrow, agentScope: { requiresConfirmation: true } }).required, true);
});

test('a waiver cannot hide that the runner still SEES the broad reach', () => {
  const d = confirmationDecision({ computed: outside, agentScope: { requiresConfirmation: false } });
  assert.equal(d.required, false);
  assert.equal(d.broad, true, 'the runner still reports the change is broad');
});
