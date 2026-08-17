// test/runner/markdown-render-in.test.mjs — #52, Markdown render-in.
//
// The feature is one-way by decision: the converted HTML is promoted to the
// reviewed document and the .md retires from the review flow. So the two things
// that can go wrong are (a) writing the source, which is the thing we promised
// not to do, and (b) unstable ids, which silently orphan every comment on a
// paragraph nobody touched — the failure that makes re-conversion useless and
// which the old review-copy script warned about in its own banner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convert, blocks, stamp, inline, sourceOf } from '../../runner/lib/markdown.mjs';
import { convertMarkdown, isMarkdown, looksLikeDoc } from '../../runner/lib/open-doc.mjs';
import { revIds } from '../../runner/lib/surgery.mjs';

const MD = `# A plan

First paragraph, unchanged.

Second paragraph.

- one
- two

| a | b |
|---|---|
| 1 | 2 |

> a quote

\`\`\`
code stays literal <not markup>
\`\`\`
`;

const idsOf = (html) => revIds(html);

test('the same Markdown always converts to the same ids', () => {
  const a = convert(MD, { sourceName: 'plan.md' });
  const b = convert(MD, { sourceName: 'plan.md' });
  assert.equal(a, b, 'conversion is deterministic, byte for byte');
  const ids = idsOf(a);
  assert.ok(ids.length >= 7, `expected a block per element, got ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('editing one paragraph moves one id and leaves the rest alone', () => {
  // This is the whole point. Random ids would move all of them.
  const before = idsOf(convert(MD, { sourceName: 'plan.md' }));
  const after = idsOf(convert(MD.replace('Second paragraph.', 'Second paragraph, rewritten.'), { sourceName: 'plan.md' }));

  assert.equal(before.length, after.length);
  const moved = before.filter((id, i) => after[i] !== id);
  assert.equal(moved.length, 1, `exactly one id should move, ${moved.length} did`);
});

test('moving a paragraph carries its id with it — position is not hashed', () => {
  const reordered = MD.replace(
    'First paragraph, unchanged.\n\nSecond paragraph.',
    'Second paragraph.\n\nFirst paragraph, unchanged.',
  );
  const before = new Set(idsOf(convert(MD, { sourceName: 'plan.md' })));
  const after = new Set(idsOf(convert(reordered, { sourceName: 'plan.md' })));
  assert.deepEqual([...after].sort(), [...before].sort(),
    'the same blocks in a different order are the same blocks');
});

test('a table is one block, not three — you comment on a table', () => {
  const list = blocks('| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.equal(list.length, 1);
  assert.match(list[0], /^<table>/);
  assert.match(list[0], /<\/table>$/);
});

test('every block carries exactly one id, including void elements', () => {
  const stamped = stamp(blocks('# h\n\npara\n\n---\n\n- a\n'));
  for (const b of stamped) {
    assert.equal(revIds(b).length, 1, `one id per block: ${b}`);
    assert.match(b, /^<[a-z][a-z0-9]* data-rev="r-[0-9a-f]{4}"/, `id on the opening tag: ${b}`);
  }
});

test('code spans survive prose that looks like a placeholder', () => {
  // The obvious placeholder — a bare index between spaces — ate ordinary prose:
  // "section 3 of the plan" matched the put-it-back pass and became whatever
  // code span happened to be third.
  assert.equal(inline('plan 0 is the one with `code` in it'),
    'plan 0 is the one with <code>code</code> in it');
  assert.equal(inline('see 1 and 0 with `a` and `b`'),
    'see 1 and 0 with <code>a</code> and <code>b</code>');
});

test('markup inside a fenced block is escaped, not rendered', () => {
  const html = convert(MD, { sourceName: 'plan.md' });
  assert.match(html, /code stays literal &lt;not markup&gt;/);
  assert.doesNotMatch(html, /<not markup>/);
});

test('converting never writes the source, and re-converting is safe', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-md-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'plan.md');
  await fs.writeFile(src, MD);
  const original = await fs.readFile(src, 'utf8');

  const first = await convertMarkdown(src);
  assert.equal(first.reconverted, false);
  assert.equal(path.basename(first.out), 'plan.html');
  assert.equal(sourceOf(await fs.readFile(first.out, 'utf8')), 'plan.md');

  const second = await convertMarkdown(src);
  assert.equal(second.reconverted, true);
  assert.equal(second.changed, false, 'an unchanged source produces an unchanged document');

  assert.equal(await fs.readFile(src, 'utf8'), original, 'the .md is never written');
});

test('conversion refuses to overwrite an HTML file it did not generate', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-md-guard-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'notes.md'), '# notes\n');
  await fs.writeFile(path.join(dir, 'notes.html'), '<p>hand written, do not touch</p>');

  const res = await convertMarkdown(path.join(dir, 'notes.md'));
  assert.match(res.error, /was not generated from/);
  assert.equal(await fs.readFile(path.join(dir, 'notes.html'), 'utf8'), '<p>hand written, do not touch</p>');
});

test('the CLI recognises a Markdown file as a document', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-md-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const md = path.join(dir, 'x.md');
  await fs.writeFile(md, '# x\n');

  assert.equal(isMarkdown(md), true);
  assert.equal(isMarkdown(path.join(dir, 'x.html')), false);
  assert.equal(await looksLikeDoc(md), true);
  assert.equal(await looksLikeDoc(path.join(dir, 'nope.md')), false, 'a path that is not a file is not a document');
  assert.equal(await looksLikeDoc('serve'), false, 'a subcommand is still a subcommand');
});
