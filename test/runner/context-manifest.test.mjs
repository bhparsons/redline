// test/runner/context-manifest.test.mjs — #94: per-run context manifest.
//
// Token totals say a run was expensive; the manifest says WHICH layer paid.
// It must be exact about composition, honest about redundancy, and incapable
// of throwing — a diagnostic that can fail a run is worse than no diagnostic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promptManifest, usageManifest, manifestAttributes } from '../../runner/lib/context-manifest.mjs';

const PROMPT = [
  'preamble line',
  '',
  '## Reviewer comment',
  'the ask',
  '',
  '## Document source',
  'a'.repeat(200),
  '',
  '## Your task',
  'do the thing',
].join('\n');

test('promptManifest splits a prompt into sections, largest first', () => {
  const m = promptManifest(PROMPT);
  assert.equal(m.chars, PROMPT.length);
  assert.equal(m.largest, 'Document source');
  assert.deepEqual(m.sections.map((s) => s.name),
    ['Document source', 'Reviewer comment', 'Your task', '(preamble)']);
  // Strictly descending by size — that ordering is the point of the view.
  const sizes = m.sections.map((s) => s.chars);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
  // Sections tile the whole prompt exactly — no bytes lost or double-counted.
  assert.equal(m.sections.reduce((n, s) => n + s.chars, 0), PROMPT.length);
  for (const s of m.sections) assert.ok(s.share >= 0 && s.share <= 1, `share ${s.share}`);
});

test('promptManifest reports duplicated content', () => {
  const line = 'This exact sentence is long enough to count as real duplicated content.';
  const dup = ['## A', line, '## B', line].join('\n');
  const m = promptManifest(dup);
  assert.equal(m.duplicate.lines, 1);          // one copy beyond the first
  assert.equal(m.duplicate.chars, line.length);
  assert.ok(m.duplicate.share > 0.4, `share was ${m.duplicate.share}`);

  // Short repeated lines (markup scraps, indentation) are not "duplication".
  const noise = ['## A', '</p>', '## B', '</p>'].join('\n');
  assert.equal(promptManifest(noise).duplicate.chars, 0);
});

test('promptManifest handles headingless, empty, and non-string input', () => {
  const flat = promptManifest('just text, no headings');
  assert.equal(flat.sections.length, 1);
  assert.equal(flat.sections[0].name, '(preamble)');
  assert.equal(flat.largest, '(preamble)');

  for (const bad of ['', null, undefined, 42, {}]) {
    const m = promptManifest(bad);
    assert.equal(m.chars, 0);
    assert.deepEqual(m.sections, []);
    assert.equal(m.largest, null);
    assert.equal(m.duplicate.chars, 0);
  }
});

test('usageManifest reports sent-vs-billed, including the cached share', () => {
  const m = usageManifest({
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 250, cache_write_tokens: 10 },
  }, 4000);
  assert.equal(m.promptTokens, 1000);
  assert.equal(m.completionTokens, 50);
  assert.equal(m.cachedTokens, 250);
  assert.equal(m.cacheWriteTokens, 10);
  assert.equal(m.cachedShare, 0.25);
  assert.equal(m.charsPerToken, 4);
});

test('usageManifest omits what the provider did not report', () => {
  assert.equal(usageManifest(null), null);
  assert.equal(usageManifest({}), null);
  assert.equal(usageManifest('nope'), null);
  const partial = usageManifest({ prompt_tokens: 10 });
  assert.deepEqual(partial, { promptTokens: 10 });   // no cache fields invented
  // No divide-by-zero when a provider reports zero tokens.
  assert.equal(usageManifest({ prompt_tokens: 0 }, 100).charsPerToken, undefined);
});

test('manifestAttributes flattens to span-safe scalars only', () => {
  const attrs = manifestAttributes(promptManifest(PROMPT));
  for (const [key, value] of Object.entries(attrs)) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof value),
      `${key} must be a scalar for the OTEL encoder, got ${typeof value}`);
  }
  assert.equal(attrs['redline.context.chars'], PROMPT.length);
  assert.equal(attrs['redline.context.largest_section'], 'Document source');
  assert.match(attrs['redline.context.sections'], /Document source=\d+/);
  assert.deepEqual(manifestAttributes(null), {});
});

test('the real regression: a container-anchored prompt shows the document twice', () => {
  // Shape of the live run-578527eb6102 prompt: the anchored SECTION view and
  // the full DOCUMENT source both carry the same block text.
  const doc = Array.from({ length: 8 },
    (_, i) => `<p data-rev="r-000${i}">paragraph ${i} with enough text to count as duplicated</p>`).join('\n');
  const m = promptManifest([
    '## Where the reviewer pointed', doc,
    '## Document source', doc,
  ].join('\n'));
  assert.ok(m.duplicate.share > 0.45,
    `expected ~half the prompt to read as duplicate, got ${m.duplicate.share}`);
  assert.equal(m.duplicate.lines, 8);
});
