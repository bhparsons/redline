// test/runner/store-ops.test.mjs — #88: per-annotation ops + sync cursor.
//
// applyOps() is the one mutation vocabulary (a hosted store can implement it
// row-based); every touched record is stamped with the rev the enclosing save
// lands at, and changesSince(page, cursor) filters on those stamps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyOps, changesSince, load, update, save, REV_CONFLICT,
} from '../../runner/lib/store.mjs';

const comment = (id, extra = {}) => ({
  id, body: 'b', anchor: { blockId: 'r-0001', quote: 'q' }, status: 'open', replies: [], ...extra,
});

// ---- applyOps (pure) --------------------------------------------------------

test('applyOps applies each op kind and stamps touched records with rev+1', () => {
  const data = { comments: [comment('c-1'), comment('c-2')], rev: 4 };
  const { applied, missing } = applyOps(data, [
    { op: 'addComment', comment: comment('c-3') },
    { op: 'reply', commentId: 'c-1', entry: { id: 'rp-1', body: 'hi' } },
    { op: 'setStatus', commentId: 'c-2', status: 'resolved', by: { creator: 'agent', agentName: 'x', at: 't' } },
    { op: 'setAnchorBlock', commentId: 'c-1', blockId: 'r-0009' },
    { op: 'addRun', run: { runId: 'run-1', status: 'ok' } },
    { op: 'resolve', commentId: 'c-3', status: 'addressed', resolution: { runId: 'run-1', decision: 'addressed', summary: 's' } },
    { op: 'setRunStatus', runId: 'run-1', status: 'undone' },
  ]);
  assert.equal(applied.length, 7);
  assert.equal(missing.length, 0);

  assert.equal(data.comments.length, 3);
  assert.deepEqual(data.comments[0].replies, [{ id: 'rp-1', body: 'hi' }]);
  assert.equal(data.comments[0].anchor.blockId, 'r-0009');
  assert.equal(data.comments[1].status, 'resolved');
  assert.deepEqual(data.comments[1].statusUpdatedBy, { creator: 'agent', agentName: 'x', at: 't' });
  assert.equal(data.comments[2].status, 'addressed');
  assert.equal(data.comments[2].resolution.decision, 'addressed');
  assert.equal(data.runs[0].status, 'undone');
  // Every touched record carries the landing rev (4 + 1).
  for (const record of [...data.comments, data.runs[0]]) {
    assert.equal(record.rev, 5, `record ${record.id ?? record.runId}`);
  }
});

test('applyOps: setAiEdits persists only the OFF state, deleting the field for default (#96)', () => {
  const data = { comments: [comment('c-1')], rev: 2 };
  applyOps(data, [{ op: 'setAiEdits', commentId: 'c-1', value: false }]);
  assert.equal(data.comments[0].aiEdits, false, 'off is stored');
  assert.equal(data.comments[0].rev, 3, 'touched record stamped');

  applyOps(data, [{ op: 'setAiEdits', commentId: 'c-1', value: true }]);
  assert.equal('aiEdits' in data.comments[0], false, 'on deletes the field (absent === in batch)');

  const { missing } = applyOps(data, [{ op: 'setAiEdits', commentId: 'c-gone', value: false }]);
  assert.equal(missing.length, 1, 'unknown comment is reported, not thrown');
});

test('applyOps reports missing targets without throwing; unknown op throws', () => {
  const data = { comments: [comment('c-1')], rev: 0 };
  const { applied, missing } = applyOps(data, [
    { op: 'reply', commentId: 'c-gone', entry: { id: 'rp-1', body: 'x' } },
    { op: 'setStatus', commentId: 'c-gone', status: 'resolved' },
    { op: 'resolve', commentId: 'c-gone', status: 'addressed' },
    { op: 'setRunStatus', runId: 'run-gone', status: 'undone' },
    { op: 'setStatus', commentId: 'c-1', status: 'resolved' },
  ]);
  assert.equal(applied.length, 1);
  assert.equal(missing.length, 4);
  assert.equal(data.comments[0].status, 'resolved');
  assert.throws(() => applyOps(data, [{ op: 'nope' }]), /unknown op/);
});

test('applyOps: setStatus without by deletes statusUpdatedBy; resolve without resolution deletes it', () => {
  const data = {
    comments: [comment('c-1', {
      statusUpdatedBy: { creator: 'agent', at: 't' },
      resolution: { runId: 'run-0', decision: 'addressed', summary: 's' },
    })],
    rev: 0,
  };
  applyOps(data, [
    { op: 'setStatus', commentId: 'c-1', status: 'open' },
    { op: 'resolve', commentId: 'c-1', status: 'open' },
  ]);
  assert.equal(data.comments[0].statusUpdatedBy, undefined);
  assert.equal(data.comments[0].resolution, undefined);
});

test('applyOps: setAnchorBlock on an anchor-less comment is missing, not a crash', () => {
  const data = { comments: [{ id: 'c-1', body: 'b', anchor: null, status: 'open' }], rev: 0 };
  const { missing } = applyOps(data, [{ op: 'setAnchorBlock', commentId: 'c-1', blockId: 'r-1' }]);
  assert.equal(missing.length, 1);
});

// ---- changesSince (against the real store) ---------------------------------

test('changesSince returns only records stamped after the cursor', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-store-ops-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const htmlPath = path.join(dir, 'doc.html');
  await fs.writeFile(htmlPath, '<body><p data-rev="r-0001">x</p></body>');

  // Save 1: two comments land at rev 1.
  await update(htmlPath, (data) => {
    applyOps(data, [
      { op: 'addComment', comment: comment('c-1') },
      { op: 'addComment', comment: comment('c-2') },
    ]);
  });
  const first = await changesSince(htmlPath, 0);
  assert.equal(first.full, true);
  assert.equal(first.rev, 1);
  assert.equal(first.comments.length, 2);

  // Save 2: touch only c-2 and add a run → rev 2.
  await update(htmlPath, (data) => {
    applyOps(data, [
      { op: 'setStatus', commentId: 'c-2', status: 'resolved' },
      { op: 'addRun', run: { runId: 'run-1', status: 'ok' } },
    ]);
  });

  const delta = await changesSince(htmlPath, first.rev);
  assert.equal(delta.full, false);
  assert.equal(delta.rev, 2);
  assert.deepEqual(delta.comments.map((c) => c.id), ['c-2']);
  assert.deepEqual(delta.runs.map((r) => r.runId), ['run-1']);

  // Cursor at head → empty delta.
  const empty = await changesSince(htmlPath, delta.rev);
  assert.equal(empty.comments.length + empty.runs.length, 0);
  assert.equal(empty.rev, 2);
});

test('changesSince: legacy unstamped records appear only in a full fetch', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-store-legacy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const htmlPath = path.join(dir, 'doc.html');
  await fs.writeFile(htmlPath, '<body><p data-rev="r-0001">x</p></body>');
  // A legacy sidecar: records with no rev stamps, no top-level rev.
  await fs.writeFile(`${htmlPath}.review.json`, JSON.stringify({
    comments: [comment('c-legacy')],
    runs: [{ runId: 'run-legacy', status: 'ok' }],
  }));

  const full = await changesSince(htmlPath, 0);
  assert.equal(full.full, true);
  assert.equal(full.comments.length, 1);
  assert.equal(full.runs.length, 1);

  const delta = await changesSince(htmlPath, 1);
  assert.equal(delta.comments.length + delta.runs.length, 0);
});

test('save still 409s on a moved rev (the ifRev contract applyOps rides on)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-store-rev-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const htmlPath = path.join(dir, 'doc.html');
  await fs.writeFile(htmlPath, '<body><p>x</p></body>');

  const a = await load(htmlPath);
  const b = await load(htmlPath);
  applyOps(a, [{ op: 'addComment', comment: comment('c-a') }]);
  await save(htmlPath, a, a.rev === undefined ? 0 : 0);
  applyOps(b, [{ op: 'addComment', comment: comment('c-b') }]);
  await assert.rejects(() => save(htmlPath, b, 0), (err) => err.code === REV_CONFLICT);
});
