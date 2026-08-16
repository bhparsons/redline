// test/runner/restore-scar.test.mjs — #58: a failed snapshot restore is never
// swallowed. When a failed run cannot roll the doc back (here: the pre-run
// snapshot vanished mid-run), the run record carries restoreFailed +
// restoreError instead of silently claiming a clean rollback — that is the
// difference between "failed, doc clean" and "failed, doc may be corrupt".

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

  await t.test('vanished snapshot → restoreFailed scar on the run record', async () => {
    state.onRequest = () => fs.rm(path.join(root, '.history'), { recursive: true, force: true });
    const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentId });
    state.onRequest = null;
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.run.status, 'failed');
    assert.equal(body.run.restoreFailed, true);
    assert.match(body.run.restoreError, /snapshot/);

    // The scar is persisted on the sidecar's run record too.
    const sidecar = JSON.parse(await fs.readFile(path.join(root, 'doc.html.review.json'), 'utf8'));
    const last = sidecar.runs.at(-1);
    assert.equal(last.runId, body.run.runId);
    assert.equal(last.restoreFailed, true);
    assert.match(last.restoreError, /snapshot/);
  });
});
