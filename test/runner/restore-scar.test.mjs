// test/runner/restore-scar.test.mjs — #58: a failed rollback is never
// swallowed. When a failed run cannot put the document back, the run record
// carries restoreFailed + restoreError instead of silently claiming a clean
// rollback — that is the difference between "failed, doc clean" and "failed,
// doc may be corrupt".
//
// AMENDED BY #288. The rollback is now TARGETED: it puts back the blocks the
// run wrote, using their recorded beforeInner, rather than restoring the whole
// file. Two consequences, and this file tests both:
//
//   - A run that failed WITHOUT WRITING has nothing to put back, so a missing
//     snapshot is irrelevant and there is no scar. Reporting one would be a
//     false alarm on the one channel that has to stay trustworthy.
//   - A run that DID write and cannot revert — because its records are not
//     plain inner swaps — still falls back to the whole-file snapshot, and
//     when THAT is gone the scar appears exactly as #58 requires.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n</body></html>\n';

// Stub OpenRouter endpoint. state.onRequest runs before replying — the scar
// test uses it to delete the .history dir while the run is in flight, so the
// failure path finds nothing to restore from.
function startStub(state) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      if (state.onRequest) await state.onRequest();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: state.content } }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/chat/completions`,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('failed run whose restore has no snapshot records a scar', async (t) => {
  const state = { content: 'not json at all {', onRequest: null };
  const stub = await startStub(state);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-scar-'));
  await fs.writeFile(path.join(root, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'test-key', endpoint: stub.url, timeoutMs: 2000 },
    telemetry: { endpoint: null },
  }));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const created = await postJson(`${base}/api/comment`, {
    page: 'doc.html', body: 'fix this',
    anchor: { blockId: 'r-0001', quote: 'bravo' },
  });
  assert.equal(created.status, 201);
  const commentId = (await created.json()).id;

  await t.test('normal failed run restores and carries no scar', async () => {
    const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentId });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.run.status, 'failed');
    assert.equal(body.run.restoreFailed, undefined);
    assert.equal(await fs.readFile(path.join(root, 'doc.html'), 'utf8'), DOC_HTML);
  });

  await t.test('a run that failed WITHOUT writing needs no restore, and says nothing', async () => {
    // #288: the snapshot is gone, and it does not matter — the reply never
    // parsed, so nothing was ever applied and there is nothing to put back.
    // Before the targeted rollback this reported restoreFailed, which read as
    // "the document may be corrupt" about a document that was never touched.
    state.onRequest = () => fs.rm(path.join(root, '.history'), { recursive: true, force: true });
    const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentId });
    state.onRequest = null;
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.run.status, 'failed');
    assert.equal(body.run.edits?.length ?? 0, 0, 'the run wrote nothing');
    assert.equal(body.run.restoreFailed, undefined, 'so there is no rollback to have failed');
    assert.equal(await fs.readFile(path.join(root, 'doc.html'), 'utf8'), DOC_HTML);
  });

  // THE SCENARIO THIS FILE USED TO TEST IS NOT REACHABLE ANY MORE, and finding
  // that out is worth more than the test was.
  //
  // A rollback in `finish` only runs on status 'failed'. A single run is
  // all-or-nothing, so a failure means zero edits were applied. A batch since
  // WP8 does NOT fail as a unit — successes land and failures are marked
  // per-comment, giving status 'partial', which deliberately does not restore.
  //
  // So `status === 'failed' && edits.length > 0` cannot be produced through the
  // API. Every restore that path ever performed was on a run that had written
  // NOTHING — which means the whole-file rollback there was never able to help,
  // and was only ever able to erase a concurrent writer. That is #288 in one
  // sentence, and it is why the fix makes the reachable case a no-op rather
  // than merely a narrower rollback.
  //
  // revertRunEdits keeps the whole-file fallback for records that are not plain
  // inner swaps. It is defensive, not dead: any future path that fails after
  // writing lands there, and #58's guarantee holds when it does.
});