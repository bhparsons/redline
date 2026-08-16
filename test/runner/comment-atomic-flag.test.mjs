// test/runner/comment-atomic-flag.test.mjs — #185: the actionable/note flag at
// comment creation.
//
// The overlay used to POST /api/comment and then POST /ai-edits. Two writes,
// two revs, two SSE frames — and between them a note read exactly like an edit
// request, so a watcher could action text the author had marked do-not-touch.
// The fix is that a comment is BORN with its audience: one write, one rev, no
// intermediate state to observe.
//
// The defaults are load-bearing and must not move: absent flag means "in the
// batch" for a human and "note" for an agent (#165).

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
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n</body></html>\n';

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-atomicflag-'));
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

test('POST /api/comment carries the actionable/note flag at creation', async (t) => {
  const root = await makeRoot();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const sidecar = async () => JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
  const comment = (extra) => post(`${base}/api/comment`, {
    page: 'doc.html', body: 'tighten this', anchor: { quote: 'alpha', blockId: 'r-0001' }, ...extra,
  });

  await t.test('a human comment with no flag stays in the batch (absent = in)', async () => {
    const res = await comment({});
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal('aiEdits' in created, false);
  });

  await t.test('aiEdits:false is born a note — one write, no window where it is not', async () => {
    const before = (await sidecar()).rev;
    const created = await (await comment({ aiEdits: false })).json();
    assert.equal(created.aiEdits, false);
    const data = await sidecar();
    // ONE rev bump for the whole creation. Under the old two-call sequence this
    // was two, and the comment was actionable in between.
    assert.equal(data.rev, before + 1);
    assert.equal(data.comments.at(-1).aiEdits, false);
  });

  await t.test('aiEdits:true overrides the agent default, and records nothing', async () => {
    const created = await (await comment({
      aiEdits: true, creator: 'agent', agentName: 'claude-code',
    })).json();
    // Storage convention (store.mjs): only `false` is persisted, absent = in.
    assert.equal('aiEdits' in created, false);
    assert.equal(created.creator, 'agent');
  });

  await t.test('an agent comment with no flag is still a note (#165 default holds)', async () => {
    const created = await (await comment({ creator: 'agent', agentName: 'claude-code' })).json();
    assert.equal(created.aiEdits, false);
  });

  await t.test('a non-boolean flag is refused, and nothing is written', async () => {
    const before = (await sidecar()).rev;
    const res = await comment({ aiEdits: 'yes' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /aiEdits must be a boolean/);
    assert.equal((await sidecar()).rev, before);
  });

  await t.test('the flag survives a round trip through GET /api/comments', async () => {
    const { comments } = await (await fetch(`${base}/api/comments?page=doc.html`)).json();
    const notes = comments.filter((c) => c.aiEdits === false);
    assert.equal(notes.length, 2); // the explicit note + the agent default
  });
});
