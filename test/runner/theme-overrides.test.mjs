// test/runner/theme-overrides.test.mjs — #111: a theme change must not
// silently skip blocks.
//
// The theme zone writes `body { … }`, which reaches other elements only by
// INHERITANCE — and inheritance loses to any element that declares the
// property itself. That is why "make all body text neon purple" recoloured a
// live page except the paragraph the comment was anchored to (it was
// class="meta", and .meta sets its own colour).

import test from 'node:test';
import assert from 'node:assert/strict';
import { themeOverrides, describeThemeOverrides } from '../../runner/lib/theme-overrides.mjs';
import { applyEdits } from '../../runner/lib/apply.mjs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mirrors the real doc: body colour plus class rules that override it.
const DOC = `<!doctype html>
<html><head><style>
  body { color: #1d2230; font-size: 15px; }
  .meta { color: #6b7280; }
  .done { color: #0a7a3d; }
  th { color: #6b7280; }
  a { text-decoration: none; }
</style>
<style data-rev-theme></style></head>
<body>
<p data-rev="r-e6d6" class="meta">session status line</p>
<p data-rev="r-0002">ordinary paragraph</p>
<td data-rev="r-0003" class="done">done</td>
<th data-rev="r-0004">Ticket</th>
</body></html>
`;

test('reports the selectors and blocks that keep their own colour', () => {
  const o = themeOverrides(DOC, 'color: #0033cc');
  assert.deepEqual(o.properties, ['color']);
  const names = o.selectors.map((s) => s.selector).sort();
  assert.deepEqual(names, ['.done', '.meta', 'th']);
  // `a` declares only text-decoration → not an override of colour.
  assert.ok(!names.includes('a'));
  // `body` is what the theme targets, not an override of it.
  assert.ok(!names.includes('body'));
  assert.deepEqual(o.blockIds.sort(), ['r-0003', 'r-0004', 'r-e6d6']);
  // The unstyled paragraph WILL inherit the theme.
  assert.ok(!o.blockIds.includes('r-0002'));
});

test('returns null when nothing overrides the theme', () => {
  assert.equal(themeOverrides(DOC, 'line-height: 1.8'), null, 'no rule declares line-height');
  assert.equal(themeOverrides('<html><body><p data-rev="r-1">x</p></body></html>', 'color: red'), null);
  assert.equal(themeOverrides(DOC, ''), null);
  assert.equal(themeOverrides(null, 'color: red'), null);
});

test('the runner’s own theme zone is never counted as an override', () => {
  const themed = DOC.replace('<style data-rev-theme></style>',
    '<style data-rev-theme>\n  body { color: #0033cc; }\n</style>');
  const o = themeOverrides(themed, 'color: #0033cc');
  assert.deepEqual(o.selectors.map((s) => s.selector).sort(), ['.done', '.meta', 'th']);
});

test('commented-out rules are not reported as overrides', () => {
  const doc = DOC.replace('.done { color: #0a7a3d; }', '/* .done { color: #0a7a3d; } */');
  const o = themeOverrides(doc, 'color: #0033cc');
  assert.ok(!o.selectors.some((s) => s.selector === '.done'));
});

test('selectors too complex to resolve are reported, never silently dropped', () => {
  const doc = DOC.replace('.meta { color: #6b7280; }', 'main > p:first-child { color: #111; }');
  const o = themeOverrides(doc, 'color: #0033cc');
  const complex = o.selectors.find((s) => s.unresolved);
  assert.ok(complex, 'the complex selector must still appear');
  assert.equal(o.unresolvedSelectors, 1);
  assert.deepEqual(complex.blockIds, [], 'unresolved means no block claims, not a guess');
});

test('describeThemeOverrides calls out the anchored block', () => {
  const o = themeOverrides(DOC, 'color: #0033cc');
  const anchored = describeThemeOverrides(o, 'r-e6d6');
  assert.match(anchored, /3 blocks keep their own color/);
  assert.match(anchored, /including the one this comment is anchored to/);
  // A different anchor gets the count without the callout.
  assert.ok(!describeThemeOverrides(o, 'r-0002').includes('anchored to'));
  assert.equal(describeThemeOverrides(null), null);
});

test('applyEdits records the overrides on the theme edit record', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-theme-ovr-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'doc.html'), DOC);

  const r = await applyEdits({ root, page: 'doc.html', theme: 'color: #0033cc' });
  assert.equal(r.ok, true, r.error);
  const themeRecord = r.editRecords.find((e) => e.op === 'theme');
  assert.ok(themeRecord.overrides, 'the run record must carry the override analysis');
  assert.deepEqual(themeRecord.overrides.blockIds.sort(), ['r-0003', 'r-0004', 'r-e6d6']);

  // A theme nothing overrides carries no noise.
  const clean = await applyEdits({ root, page: 'doc.html', theme: 'line-height: 1.9' });
  assert.equal(clean.editRecords.find((e) => e.op === 'theme').overrides, undefined);
});
