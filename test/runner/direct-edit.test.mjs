// test/runner/direct-edit.test.mjs — WP10: direct author edit (/api/edit).
//
// A quick manual fix goes through the SAME surgery/apply pipeline as an agent
// edit — the browser never writes the file. The runner entity-encodes,
// validates, records a run with lane 'direct-edit' (+ optional attribution),
// and the edit is undoable like any other run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.REDLINE_OTEL_ENDPOINT;

const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n<p data-rev="r-0002">delta</p>\n</body></html>\n';

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-directedit-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'k', endpoint: 'http://127.0.0.1:1/chat', timeoutMs: 500 },
    telemetry: { endpoint: null },
  }, null, 2));
  return dir;
}

const post = (url, payload) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

test('direct edit: apply, entity-encode, record, attribute, undo, and validation', async (t) => {
  const root = await makeRoot();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const readDoc = () => fs.readFile(docPath, 'utf8');
  const sidecar = async () => JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
  const edit = (payload) => post(`${base}/api/edit`, { page: 'doc.html', ...payload });

  await t.test('applies one block inner through surgery and records a direct-edit run', async () => {
    const res = await edit({ blockId: 'r-0001', newInner: 'alpha — “bravo” charlie' });
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.lane, 'direct-edit');
    assert.equal(run.status, 'ok');
    assert.deepEqual(run.edits, [{
      blockId: 'r-0001',
      beforeInner: 'alpha bravo charlie',
      afterInner: 'alpha &mdash; &ldquo;bravo&rdquo; charlie',
    }]);
    assert.match(await readDoc(), /<p data-rev="r-0001">alpha &mdash; &ldquo;bravo&rdquo; charlie<\/p>/);
    const data = await sidecar();
    assert.equal(data.runs.at(-1).lane, 'direct-edit');
  });

  await t.test('carries creator/agentName attribution when given', async () => {
    const run = await (await edit({ blockId: 'r-0002', newInner: 'DELTA', creator: 'agent', agentName: 'claude-code' })).json();
    assert.deepEqual(run.actor, { creator: 'agent', agentName: 'claude-code' });
  });

  await t.test('a direct edit is undoable like any run', async () => {
    const before = await readDoc();
    await edit({ blockId: 'r-0002', newInner: 'delta again' });
    assert.match(await readDoc(), /delta again/);
    const undo = await (await post(`${base}/api/undo`, { page: 'doc.html' })).json();
    assert.equal(undo.status, 'undone');
    assert.equal(await readDoc(), before, 'the direct edit is reverted');
  });

  await t.test('validation: unknown block 422, bad payloads 400, unknown page 404', async () => {
    assert.equal((await edit({ blockId: 'r-9999', newInner: 'x' })).status, 422);
    assert.equal((await edit({ blockId: '', newInner: 'x' })).status, 400);
    assert.equal((await edit({ blockId: 'r-0001', newInner: 5 })).status, 400);
    assert.equal((await post(`${base}/api/edit`, { page: 'nope.html', blockId: 'r-0001', newInner: 'x' })).status, 404);
  });
});

test('#213 direct edit: a watcher may not edit a block marked do-not-touch', async (t) => {
  const root = await makeRoot();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const edit = (payload) => post(`${base}/api/edit`, { page: 'doc.html', ...payload });

  // The author marks r-0001 as a note (aiEdits:false) — discussion only,
  // do not act on it.
  const noteRes = await post(`${base}/api/comment`, {
    page: 'doc.html',
    body: 'Leave this line exactly as it is.',
    anchor: { blockId: 'r-0001', quote: 'alpha bravo charlie' },
    aiEdits: false,
  });
  assert.equal(noteRes.status, 201);
  const noteId = (await noteRes.json()).id;

  await t.test('an AGENT edit of the noted block is refused with 403 and names the note', async () => {
    const res = await edit({ blockId: 'r-0001', newInner: 'rewritten', creator: 'agent', agentName: 'claude-code' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /do-not-touch/);
    assert.equal(body.blockId, 'r-0001');
    assert.deepEqual(body.notes, [noteId]);
    // The document is untouched.
    assert.match(await fs.readFile(path.join(root, 'doc.html'), 'utf8'), /alpha bravo charlie/);
  });

  await t.test("the author's own Edit-text on the noted block is NOT gated", async () => {
    const res = await edit({ blockId: 'r-0001', newInner: 'author fixed it' });
    assert.equal(res.status, 200, 'a human edit declares no creator:agent and passes');
    assert.match(await fs.readFile(path.join(root, 'doc.html'), 'utf8'), /author fixed it/);
  });

  await t.test('an agent edit of a block with no note goes through', async () => {
    const res = await edit({ blockId: 'r-0002', newInner: 'DELTA', creator: 'agent', agentName: 'claude-code' });
    assert.equal(res.status, 200);
  });
});

test('overlay wires the card controls (static, #96 redesign)', () => {
  const overlayJs = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension', 'overlay.js'), 'utf8');
  // #96 action model: one Reply, an AI-edits batch toggle, and Send now / Retry
  // (reopen-then-run on a decided/failed comment).
  assert.match(overlayJs, /'Reply'/);
  assert.match(overlayJs, /'Send now'/);
  assert.match(overlayJs, /'Retry'/);
  assert.match(overlayJs, /\/ai-edits/, 'AI-edits toggle POSTs the batch endpoint');
  // Direct edit engine survives (rewired onto the document by #112); the inline
  // editor still POSTs /api/edit and the runner remains the only writer.
  assert.match(overlayJs, /function openInlineEditor\(/);
  assert.match(overlayJs, /apiRaw\('\/api\/edit'/);
});
