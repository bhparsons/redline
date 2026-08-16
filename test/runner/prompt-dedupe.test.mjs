// test/runner/prompt-dedupe.test.mjs — #115/#116: don't send the document twice.
//
// A container anchor's section view can already be the whole document, so
// rendering both it and {{DOC}} ships the page twice — measured at 35%
// duplicated content on a live run. Above DOC_ECHO_THRESHOLD coverage exactly
// one copy is sent.
//
// #116 flipped WHICH copy survives. #115 kept the section view and pointed
// {{DOC}} at it; the prompt is now ordered stable-prefix-first so a provider
// cache can match across runs, and the document is the stable copy while the
// section view is per-comment. So the DOCUMENT is always sent in full and the
// SECTION VIEW points up at it. The invariant is unchanged: the page source
// appears exactly once, and a LEAF anchor is unaffected — its section view is
// one block, and dropping the document would blind the agent to the page.

import test from 'node:test';
import assert from 'node:assert/strict';
import { blockSection, sectionCoverage, DOC_ECHO_THRESHOLD } from '../../runner/lib/api.mjs';
import { locateBlock } from '../../runner/lib/surgery.mjs';
import { promptManifest } from '../../runner/lib/context-manifest.mjs';

// 40 paragraphs: the pointer replacing the section outer HTML is a fixed ~300
// chars, so the size assertions below only mean anything against a
// realistically sized page (the live case that motivated this was ~18k chars).
const para = (i) => `<p data-rev="r-${String(i).padStart(4, '0')}">paragraph ${i} carrying enough text to register as duplicated content</p>`;
const BODY = Array.from({ length: 40 }, (_, i) => para(i)).join('\n');
// <main> wraps everything → its outer range covers ~the whole source.
const WHOLE = `<!doctype html>\n<html><body>\n<main data-rev="r-main">\n${BODY}\n</main>\n</body></html>\n`;

test('a container anchor covering the document gets a pointer, not a second copy', () => {
  const out = blockSection(WHOLE, { blockId: 'r-main' });
  assert.match(out, /essentially the WHOLE document/);
  assert.match(out, /Document source/, 'points the agent at the section that does carry it');
  assert.match(out, /data-rev/, 'still tells the agent how blocks are identified');
  assert.ok(!out.includes('paragraph 5'), 'must not repeat the document body');
  assert.ok(out.length < WHOLE.length / 4, `pointer must be far smaller than the source: ${out.length}`);
  assert.ok(out.includes('r-main'), 'still names the anchored section');
});

test('a leaf anchor still gets its own block inner, and never the whole page', () => {
  const out = blockSection(WHOLE, { blockId: 'r-0003' });
  assert.match(out, /blockId: r-0003/);
  assert.ok(out.includes('paragraph 3'), 'the anchored block is shown');
  assert.ok(!out.includes('paragraph 4'), 'a leaf view is one block, not the page');
});

test('the pointer is a constant, not a function of document size', () => {
  const big = WHOLE.replace(BODY, Array.from({ length: 400 }, (_, i) => para(i)).join('\n'));
  const small = blockSection(WHOLE, { blockId: 'r-main' });
  const large = blockSection(big, { blockId: 'r-main' });
  // Bounded, not identical: the text embeds a coverage percentage and the
  // top-level index, so it can differ by a digit — but never by page size.
  assert.ok(Math.abs(small.length - large.length) <= 4, 'pointer must not grow with the page');
  assert.ok(large.length < 900, `pointer stayed small: ${large.length} chars`);
  assert.ok(large.length < big.length / 50, 'savings scale with document size');
});

test('a container covering only part of the page still shows its outer HTML', () => {
  // Two sibling sections: the anchored one is ~half the page, under threshold.
  const half = '<!doctype html>\n<html><body>\n'
    + `<section data-rev="r-a">\n${BODY}\n</section>\n`
    + `<section data-rev="r-b">\n${BODY}\n</section>\n`
    + '</body></html>\n';
  const out = blockSection(half, { blockId: 'r-a' });
  assert.match(out, /Section outer HTML:/, 'a partial section is still shown verbatim');
  assert.ok(out.includes('paragraph 5'));
  assert.ok(DOC_ECHO_THRESHOLD > 0.5, 'threshold must sit above a half-page section');
});

test('sectionCoverage measures the anchored block against the page', () => {
  assert.ok(sectionCoverage(WHOLE, locateBlock(WHOLE, 'r-main')) >= DOC_ECHO_THRESHOLD);
  assert.ok(sectionCoverage(WHOLE, locateBlock(WHOLE, 'r-0003')) < 0.05);
  // Never throws on odd input — prompt assembly must not be able to fail a run.
  assert.equal(sectionCoverage(WHOLE, null), 0);
  assert.equal(sectionCoverage('', null), 0);
});

test('the fix removes the duplication the manifest measured', () => {
  const render = (section) => [
    '## Document source', WHOLE,
    '## Your task', 'do the thing',
    '## Where the reviewer pointed', section,
  ].join('\n');

  const before = promptManifest(render(`Section outer HTML:\n<main data-rev="r-main">\n${BODY}\n</main>`));
  const after = promptManifest(render(blockSection(WHOLE, { blockId: 'r-main' })));

  assert.ok(before.duplicate.share > 0.4, `baseline should be heavily duplicated, got ${before.duplicate.share}`);
  assert.equal(after.duplicate.chars, 0, 'no duplicated lines remain');
  assert.ok(after.chars < before.chars / 1.6, `prompt should roughly halve: ${before.chars} → ${after.chars}`);
});
