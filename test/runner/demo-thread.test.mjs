// test/runner/demo-thread.test.mjs — #279: the demo teaches, or it is just a memo.
//
// `redline demo` used to seed a document and an EMPTY sidecar, so the first
// thing a new user saw was a page and no evidence the tool did anything. The
// seeded thread is the tour: an edit request, a note, a question left open, and
// a decline with its reasoning.
//
// The anchors are the fragile part and the reason this file exists. They quote
// sample-memo.html verbatim, so any edit to the sample silently orphans them and
// the tour starts pointing at the wrong paragraphs — which is exactly the defect
// R-006 was filed about, shipped as a welcome mat.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemo } from '../../runner/lib/open-doc.mjs';
import { startServer } from '../../runner/lib/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function seeded(t) {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rl-demo279-')), 'demo');
  const out = await seedDemo({ repoRoot: REPO, dir });
  t.after(() => fs.rm(path.dirname(dir), { recursive: true, force: true }));
  return { dir, out };
}

test('the demo arrives with a thread, not an empty sidecar', async (t) => {
  const { dir, out } = await seeded(t);
  assert.equal(out.seeded, true);
  assert.equal(out.comments, true, 'the teaching thread was written');

  const thread = JSON.parse(await fs.readFile(`${out.absFile}.review.json`, 'utf8'));
  assert.equal(thread.comments.length, 4);
  assert.equal(thread._comment, undefined, 'the authoring note is stripped on the way out');

  // The four kinds, because the point is that they are DIFFERENT kinds.
  const byId = Object.fromEntries(thread.comments.map((c) => [c.id, c]));
  assert.equal(byId['c-demo-edit'].status, 'open');
  assert.equal(byId['c-demo-edit'].aiEdits, undefined, 'an edit request stores nothing — absent means in the batch');
  assert.equal(byId['c-demo-note'].aiEdits, false, 'a note is stored only as false');
  assert.equal(byId['c-demo-question'].replies.length, 1, 'answered');
  assert.equal(byId['c-demo-question'].status, 'open', 'and still open — the author closes their own question');
  assert.equal(byId['c-demo-declined'].status, 'declined');
  assert.ok(byId['c-demo-declined'].resolution.note, 'a decline carries its reasoning, or it is just a refusal');
});

test('every demo anchor still points at real text — the tour cannot ship orphaned', async (t) => {
  const { out } = await seeded(t);
  const server = await startServer({ root: path.dirname(out.absFile), port: 0 });
  t.after(() => server.close());

  const { comments } = await fetch(
    `http://127.0.0.1:${server.port}/api/comments?page=${encodeURIComponent(path.basename(out.absFile))}`,
  ).then((r) => r.json());

  assert.equal(comments.length, 4);
  for (const c of comments) {
    assert.equal(c.orphaned, undefined,
      `${c.id} quotes text sample-memo.html no longer contains: ${JSON.stringify(c.anchor.quote)}`);
  }
});

test('seeding twice never rewrites a thread someone has worked in', async (t) => {
  const { dir, out } = await seeded(t);
  const sidecar = `${out.absFile}.review.json`;
  const mine = JSON.parse(await fs.readFile(sidecar, 'utf8'));
  mine.comments.push({ id: 'c-mine', body: 'my own', status: 'open', rev: 9, anchor: { quote: 'x' }, replies: [] });
  await fs.writeFile(sidecar, JSON.stringify(mine, null, 2));

  const again = await seedDemo({ repoRoot: REPO, dir });
  assert.equal(again.seeded, false, 'the document is not reseeded');

  const after = JSON.parse(await fs.readFile(sidecar, 'utf8'));
  assert.ok(after.comments.some((c) => c.id === 'c-mine'), 'and the sidecar is left exactly as it was');
});
