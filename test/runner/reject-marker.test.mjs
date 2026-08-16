// test/runner/reject-marker.test.mjs — #194: Reject backs an edit out.
//
// The reply carries a FIXED machine-readable token, [[redline:reject]], never
// free-text parsing. Two tiers behind it: a clean run reverts mechanically via
// the targeted undo (#232); a conflicted one leaves the marker for the watcher
// to re-derive the block from the comments that still stand. The overlay half
// is booted; the runner half walks the exact recipe the watch skill documents,
// with the test standing in as the watcher.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { boot } from './_overlay-boot.mjs';

const MARKER = '[[redline:reject]]';

// ---- the overlay: the Reject affordance and what it posts -------------------

const ADDRESSED = {
  id: 'c-1', status: 'addressed', body: 'tighten this',
  anchor: { blockId: 'r-0001', quote: 'block r-0001' },
  creator: 'human', createdAt: '2026-08-11T10:00:00.000Z', replies: [],
  resolution: { runId: 'run-a', decision: 'addressed', summary: 'Tightened.' },
};
const RUNS = [{
  runId: 'run-a', commentId: 'c-1', model: 'sonnet', status: 'ok',
  createdAt: '2026-08-11T10:05:00.000Z',
  decisions: [{ id: 'c-1', decision: 'addressed', summary: 'Tightened.' }],
}];

async function expandCard(app) {
  await app.settle();
  const card = app.host.querySelector('[data-rv-comment]');
  card.fire('click');
  await app.settle();
  return app.host.querySelector('[data-rv-comment]');
}

test('Reject posts the fixed marker plus the author\'s words, then tries the clean back-out', async () => {
  const app = boot({ comments: [ADDRESSED], runs: RUNS });
  const card = await expandCard(app);
  const rejectBtn = card.querySelectorAll('button').find((b) => b.textContent === 'Reject…');
  assert.ok(rejectBtn, 'an addressed comment with a run offers Reject');

  rejectBtn.fire('click');
  const ta = card.querySelector('.rv-followup-input');
  ta.value = 'the new wording lost the caveat';
  card.querySelectorAll('button').find((b) => b.textContent === 'Reject & back out').fire('click');
  await app.settle();

  const writes = app.state.posted;
  const reply = writes.find((p) => p.url.includes('/comment/c-1/reply'));
  assert.ok(reply, 'the rejection is a reply on the thread');
  assert.equal(reply.body.body, `${MARKER} the new wording lost the caveat`,
    'the marker is the fixed token, leading, with the author\'s text after it');
  const undo = writes.find((p) => p.url.includes('/api/undo'));
  assert.ok(undo, 'and the clean back-out is attempted');
  assert.equal(undo.body.runId, 'run-a', 'naming the run that actioned the comment');
});

test('an open comment gets no Reject — there is no edit to back out', async () => {
  const app = boot({ comments: [{ ...ADDRESSED, status: 'open', resolution: undefined }], runs: [] });
  const card = await expandCard(app);
  assert.equal(card.querySelectorAll('button').find((b) => b.textContent === 'Reject…'), undefined);
});

// ---- the runner: both tiers, the test standing in as the watcher ------------

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha</p>\n<p data-rev="r-0002">bravo</p>\n</body></html>\n';

const postJson = (url, payload) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

test('the two tiers against a live runner (#194)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-reject-'));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, 'doc.html'), DOC_HTML);
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');

  const newComment = async (blockId, body) => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html', body, anchor: { blockId, quote: body.slice(0, 10) },
    });
    return (await res.json()).id;
  };
  // An agent actioning a comment: edits + the decision in one proposal.
  const action = async (commentId, blockId, newInner) => {
    const res = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html', dryRun: false, commentId,
      edits: [{ blockId, newInner }],
      decisions: [{ id: commentId, decision: 'addressed', summary: 'done' }],
      creator: 'agent', agentName: 'watcher',
    });
    assert.equal(res.status, 200);
    return (await res.json()).runId;
  };
  const commentById = async (id) => {
    const res = await fetch(`${base}/api/comments?page=doc.html`);
    return (await res.json()).comments.find((c) => c.id === id);
  };

  await t.test('tier 1: clean run — marker reply reopens, targeted revert lands', async () => {
    const c1 = await newComment('r-0001', 'say alpha better');
    const runA = await action(c1, 'r-0001', 'ALPHA');

    // The author rejects: marker + reason, as the overlay posts it.
    await postJson(`${base}/api/comment/${c1}/reply`, {
      page: 'doc.html', body: `${MARKER} lost the original tone`,
    });
    // The watcher's first move (or the overlay's own follow-up): named undo.
    const undo = await postJson(`${base}/api/undo`, { page: 'doc.html', runId: runA });
    assert.equal(undo.status, 200);

    const doc = await fs.readFile(docPath, 'utf8');
    assert.ok(doc.includes('<p data-rev="r-0001">alpha</p>'), 'the edit is backed out');
    const c = await commentById(c1);
    assert.equal(c.status, 'open', 'the comment reopened');
    assert.ok(c.replies.at(-1).body.startsWith(MARKER), 'with the rejection in-thread');
  });

  await t.test('tier 2: conflicted run — the marker routes to re-derivation', async () => {
    const c2 = await newComment('r-0002', 'sharpen bravo');
    const runB = await action(c2, 'r-0002', 'bravo, sharpened');
    const c3 = await newComment('r-0002', 'and mention charlie');
    await action(c3, 'r-0002', 'bravo, sharpened, with charlie');

    await postJson(`${base}/api/comment/${c2}/reply`, {
      page: 'doc.html', body: `${MARKER} sharpening changed the meaning`,
    });
    const undo = await postJson(`${base}/api/undo`, { page: 'doc.html', runId: runB });
    assert.equal(undo.status, 409, 'the mechanical revert refuses');
    const body = await undo.json();
    assert.equal(body.reason, 'conflicted', 'with the machine-readable re-derive trigger');
    assert.deepEqual(body.blocks, ['r-0002']);

    // The watcher re-derives: the block rebuilt from the STANDING comments
    // (c3's ask) minus the rejected one (c2's sharpening).
    const rederive = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html', dryRun: false, commentId: c2,
      edits: [{ blockId: 'r-0002', newInner: 'bravo, with charlie' }],
      creator: 'agent', agentName: 'watcher',
    });
    assert.equal(rederive.status, 200);
    const doc = await fs.readFile(docPath, 'utf8');
    assert.ok(doc.includes('<p data-rev="r-0002">bravo, with charlie</p>'),
      'the block reflects the standing comments minus the rejected ask');
  });
});

test('Reject with an EMPTY reason still rejects — the marker alone is the act', async () => {
  // Blake hit this live (2026-08-12): he had already said why in an earlier
  // reply, left the box empty, clicked Reject & back out — and nothing
  // happened, silently. The empty-text guard belongs to plain replies only.
  const app = boot({ comments: [ADDRESSED], runs: RUNS });
  const card = await expandCard(app);
  card.querySelectorAll('button').find((b) => b.textContent === 'Reject…').fire('click');
  card.querySelectorAll('button').find((b) => b.textContent === 'Reject & back out').fire('click');
  await app.settle();

  const reply = app.state.posted.find((p) => p.url.includes('/comment/c-1/reply'));
  assert.ok(reply, 'the rejection posted');
  assert.equal(reply.body.body, MARKER, 'the bare marker, nothing appended');
  assert.ok(app.state.posted.find((p) => p.url.includes('/api/undo')), 'and the back-out was attempted');
});
