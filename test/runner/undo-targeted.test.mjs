// test/runner/undo-targeted.test.mjs — #232: undo any clean run by name, not
// just the top of the stack.
//
// Tier 1 of the two-tier undo: POST /api/undo {page, runId} reverts THAT
// run's blocks via their recorded beforeInner through the normal edit
// pipeline — provided every touched block is clean (current inner equals the
// run's afterInner). A conflicted block refuses with reason 'conflicted'
// (#194's re-derive trigger); theme/attribute/insert runs refuse with
// 'unsupported-ops'; the LIFO snapshot undo (no runId) stays the blunt
// escape hatch and is pinned by undo tests that predate this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha</p>\n<p data-rev="r-0002">bravo</p>\n<p data-rev="r-0003">charlie</p>\n'
  + '</body></html>\n';

const postJson = (url, payload) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

test('targeted undo (#232)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-undo-t-'));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, 'doc.html'), DOC_HTML);
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');

  // A run per write: the direct-edit lane records {blockId, beforeInner,
  // afterInner} and snapshots exactly like an agent run.
  const edit = async (blockId, newInner) => {
    const res = await postJson(`${base}/api/edit`, { page: 'doc.html', blockId, newInner });
    assert.equal(res.status, 200, `direct edit of ${blockId}`);
    return (await res.json()).runId;
  };
  const runsById = async () => {
    const runs = JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8')).runs;
    return Object.fromEntries(runs.map((r) => [r.runId, r]));
  };

  const run1 = await edit('r-0001', 'ALPHA');
  const run2 = await edit('r-0002', 'BRAVO');

  await t.test('a clean mid-stack run reverts by name, leaving later runs alone', async () => {
    // run1 is NOT on top — run2 is — and nothing touched r-0001 since run1.
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html', runId: run1 });
    assert.equal(res.status, 200);
    const doc = await fs.readFile(docPath, 'utf8');
    assert.ok(doc.includes('<p data-rev="r-0001">alpha</p>'), 'run1 reverted');
    assert.ok(doc.includes('<p data-rev="r-0002">BRAVO</p>'), 'run2 untouched');
    assert.equal((await runsById())[run1].status, 'undone');
    assert.equal((await runsById())[run2].status, 'ok');
  });

  await t.test('an already-undone run refuses as not-revertible', async () => {
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html', runId: run1 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, 'not-revertible');
  });

  await t.test('an unknown runId is its own refusal, distinct from "no run to undo"', async () => {
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html', runId: 'run-nope' });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).reason, 'no-such-run');
  });

  await t.test('a conflicted block refuses with the #194 trigger, and writes nothing', async () => {
    const run3 = await edit('r-0003', 'CHARLIE');
    await edit('r-0003', 'CHARLIE-AGAIN'); // compounding edit on the same block
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html', runId: run3 });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.reason, 'conflicted');
    assert.deepEqual(body.blocks, ['r-0003'], 'the conflicted blocks are named');
    const doc = await fs.readFile(docPath, 'utf8');
    assert.ok(doc.includes('CHARLIE-AGAIN'), 'the document did not move');
    assert.equal((await runsById())[run3].status, 'ok', 'and the run is not marked undone');
  });

  await t.test('a run carrying an insert refuses targeted revert (unsupported-ops)', async () => {
    const res = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html',
      dryRun: false,
      edits: [],
      inserts: [{ afterBlockId: 'r-0002', html: '<p>a new paragraph</p>' }],
    });
    assert.equal(res.status, 200, 'the insert applied');
    const insertRun = (await res.json()).runId;
    const undo = await postJson(`${base}/api/undo`, { page: 'doc.html', runId: insertRun });
    assert.equal(undo.status, 409);
    assert.equal((await undo.json()).reason, 'unsupported-ops');
  });

  await t.test('the nameless form still walks the stack LIFO, untouched by all this', async () => {
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html' });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).runId, 'the top ok run reverted via its snapshot');
  });
});
