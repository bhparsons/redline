// test/runner/comments-runs-projection.test.mjs — #199: GET /api/comments
// carries the page's runs[].
//
// commentThread() has interleaved the ask, the replies and every decision by
// timestamp for the AGENT prompt since #108. The overlay computes the same
// history for the human, and had nothing to compute it from: /api/comments
// returned comments alone, and /api/status carries live LEASE records plus a
// single lastRun — not the sidecar's runs[]. So a card that was declined,
// argued with and then addressed showed only the addressing.
//
// The second thing this projection has to carry is ATTRIBUTION. A watching
// agent reading only run outcomes invents a second writer; the tell is in the
// record (lane + actor) and it has to survive the projection, or the reader is
// no better off than it was reading /api/status.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.REDLINE_OTEL_ENDPOINT;

const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n<p data-rev="r-0002">delta</p>\n</body></html>\n';

const post = (url, payload) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

test('GET /api/comments projects the page runs[] alongside the comments', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-runsproj-'));
  // No apiKey: every writer below is free, so nothing here needs one.
  await fs.writeFile(path.join(root, 'doc.html'), DOC);
  await fs.writeFile(path.join(root, CONFIG_FILENAME),
    JSON.stringify({ telemetry: { endpoint: null } }, null, 2));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const list = async () => (await fetch(`${base}/api/comments?page=doc.html`)).json();

  await t.test('a page with no runs answers with an empty array, never a missing key', async () => {
    const body = await list();
    assert.deepEqual(body.comments, []);
    // ?? [] matters: a sidecar written before runs[] existed has no such key,
    // and a client that has to distinguish undefined from [] will get it wrong.
    assert.deepEqual(body.runs, []);
  });

  const comment = await (await post(`${base}/api/comment`, {
    page: 'doc.html', body: 'tighten this', anchor: { quote: 'alpha', blockId: 'r-0001' },
  })).json();

  await t.test('a session-authored run appears, with the lane and actor that name its writer', async () => {
    const run = await (await post(`${base}/api/propose-edits`, {
      page: 'doc.html', dryRun: false, commentId: comment.id,
      creator: 'agent', agentName: 'watcher',
      edits: [{ blockId: 'r-0001', newInner: 'ALPHA bravo charlie' }],
    })).json();
    assert.equal(run.status, 'ok');

    const { runs } = await list();
    assert.equal(runs.length, 1);
    const projected = runs[0];
    assert.equal(projected.runId, run.runId);
    // The two fields that let a reader tell a session apart from the browser.
    assert.equal(projected.lane, 'proposed');
    assert.deepEqual(projected.actor, { creator: 'agent', agentName: 'watcher' });
    assert.equal(projected.model, null, 'a session-authored run spends nothing');
    // And the link back to the card that asked for it. NOTE the asymmetry a
    // client has to handle: a proposal answers one comment and records
    // `commentId`; a batch /api/run records `commentIds`. Both shapes are in
    // the same array.
    assert.equal(projected.commentId, comment.id);
  });

  await t.test('a browser direct edit lands in the same array under its own lane', async () => {
    await post(`${base}/api/edit`, {
      page: 'doc.html', blockId: 'r-0002', newInner: 'DELTA',
    });
    const { runs } = await list();
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((r) => r.lane), ['proposed', 'direct-edit']);
    // Oldest first, so a client can interleave by timestamp without re-sorting.
    assert.ok(runs[0].createdAt <= runs[1].createdAt);
  });

  await t.test('the projection tracks the sidecar — an undone run is still in the history', async () => {
    const before = (await list()).runs;
    const undo = await post(`${base}/api/undo`, { page: 'doc.html' });
    assert.equal(undo.status, 200);
    const after = (await list()).runs;
    // Undo does not delete the record; a card whose edit was reverted should
    // still show that the edit happened.
    assert.equal(after.length, before.length);
    assert.equal(after.at(-1).runId, before.at(-1).runId);
  });
});
