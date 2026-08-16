// test/runner/ai-edits-batch-filter.test.mjs — #169: the notes flag binds the
// runner, not just the browser.
//
// #165 made agent comments notes by default and showed the flag to a reading
// agent. Nothing enforced it: `aiEdits` was read in exactly one place,
// extension/overlay.js:925, which decides which ids the overlay puts in the
// Send-All request. So an agent calling /api/run with explicit commentIds
// revised text the author had asked to be left alone.
//
// The rule implemented here: a BATCH drops notes, and as of #213 a
// SINGLE-comment run is also refused when the comment is a note. In the
// watcher-first V1, the agent is naming the comment, and the author's
// intention is expressed by the aiEdits flag — the server enforces it.
//
// Stub OpenRouter throughout — no real network.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { promptText } from '../../runner/lib/agent.mjs';
import { callTool, closeAll } from '../../runner/lib/mcp-tools.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<p data-rev="r-0002">delta echo foxtrot</p>\n</body></html>\n';

// Every revise call answers the same way; this file asserts on WHICH comments
// reach the model, not on what comes back.
function startStub() {
  const state = { revised: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const text = promptText(parsed.messages);
      const chat = (content) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      };
      if (text.startsWith('# Redline comment router') || text.startsWith('# Redline tactical edit')) {
        return chat('not json — force the fallback path');
      }
      state.revised.push(text);
      // A run is a 422 unless the reply decides the comment it was sent, so
      // echo back whatever id the prompt carried. No edits — this file is about
      // which comments reach the model, not what comes back.
      const id = text.match(/c-[0-9a-f]{6,}/)?.[0];
      return chat(JSON.stringify({
        decisions: id ? [{ id, decision: 'addressed', summary: 'Did the thing.' }] : [],
        edits: [],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      state,
      url: `http://127.0.0.1:${server.address().port}/chat/completions`,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

const postJson = (url, payload) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

test('#169: batch runs drop notes; single runs do not', async (t) => {
  const stub = await startStub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-batch-filter-'));
  await fs.writeFile(path.join(root, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'cfg-test-key', endpoint: stub.url, timeoutMs: 2000 },
    telemetry: { endpoint: null },
    models: { tactical: 't', redesign: 'r', research: 'rs', accessibility: 'a', content: 'c' },
  }, null, 2));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await closeAll();
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const env = { REDLINE_RUNNER_URL: base, REDLINE_AGENT_NAME: 'test-agent' };

  const addComment = async (body, extra = {}) => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html', body, anchor: { blockId: 'r-0001', quote: 'alpha' }, ...extra,
    });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };

  const wanted = await addComment('Make this shorter.');                 // human → in
  const note = await addComment('Just noting the repetition.', {         // agent → note
    creator: 'agent', agentName: 'claude-code',
  });

  await t.test('a batch skips the note and says which one it dropped', async () => {
    stub.state.revised = [];
    const res = await postJson(`${base}/api/run`, {
      page: 'doc.html', commentIds: [wanted, note],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.skipped, [note], 'the drop is reported, never silent');
    assert.equal(stub.state.revised.length, 1, 'only one comment reached the model');
    assert.match(stub.state.revised[0], /Make this shorter/);
    assert.doesNotMatch(stub.state.revised[0], /noting the repetition/);
  });

  await t.test('a batch of nothing but notes is refused before any spend', async () => {
    stub.state.revised = [];
    const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentIds: [note] });
    assert.equal(res.status, 400);
    assert.deepEqual((await res.json()).skipped, [note]);
    assert.equal(stub.state.revised.length, 0, 'the model was never called');
  });

  await t.test('naming one note explicitly is refused (#213)', async () => {
    // #213: in watcher mode the agent is naming the comment, and the author's
    // intention is the aiEdits flag. The server enforces it.
    stub.state.revised = [];
    const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentId: note });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /do-not-touch/);
    assert.equal(stub.state.revised.length, 0, 'the model was never called');
  });

  await t.test('an agent can promote its own note to an edit request', async () => {
    const out = await callTool('redline_set_ai_edits',
      { file: docPath, commentId: note, aiEdits: true }, { env });
    assert.equal(out.comment.aiEdits, undefined,
      'promoting clears the flag — absence is the storage convention for "in"');

    stub.state.revised = [];
    const res = await postJson(`${base}/api/run`, {
      page: 'doc.html', commentIds: [wanted, note],
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).skipped, undefined);
    assert.equal(stub.state.revised.length, 2, 'both comments now reach the model');
  });

  await t.test('an agent can mark a human comment as handled by hand', async () => {
    await callTool('redline_set_ai_edits',
      { file: docPath, commentId: wanted, aiEdits: false }, { env });
    const listed = await callTool('redline_list_comments', { file: docPath }, { env });
    assert.equal(listed.comments.find((c) => c.id === wanted).aiEdits, false);
    assert.equal(listed.noteCount, 1);

    stub.state.revised = [];
    const res = await postJson(`${base}/api/run`, {
      page: 'doc.html', commentIds: [wanted, note],
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).skipped, [wanted]);
    assert.equal(stub.state.revised.length, 1);
  });

  await t.test('aiEdits must be a boolean, not a string', async () => {
    await assert.rejects(
      () => callTool('redline_set_ai_edits', { file: docPath, commentId: note, aiEdits: 'false' }, { env }),
      /aiEdits must be true or false/,
    );
  });
});
