// test/runner/ai-edits-agent-surface.test.mjs — #165 P0s: the notes flag on the
// agent surface.
//
// Two failures this pins, both of which only appear once an agent is in the loop:
//
//   1. An agent leaves a question on a block. It lands unflagged, the Send-All
//      default is opt-out, so the human's next Send-All pays OpenRouter to
//      revise the document on the strength of the agent's own aside.
//   2. The human marks a comment as a note. `redline_list_comments` returns it
//      identically to every other comment, so the agent edits the block anyway.
//
// The default is enforced in the RUNNER (api.mjs createComment), not in
// mcp-tools, so the CLI, MCP and any direct HTTP agent behave the same.
// Storage convention is store.mjs's: only `false` is written, absent means in
// the batch — which is why the MCP layer normalizes to an explicit boolean.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { callTool, closeAll } from '../../runner/lib/mcp-tools.mjs';

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<p data-rev="r-0002">delta echo foxtrot</p>\n</body></html>\n';

const ANCHOR = { blockId: 'r-0001', quote: 'alpha' };

async function makeFixtureDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-ai-edits-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    telemetry: { endpoint: null },
  }, null, 2));
  return dir;
}

const postJson = (url, payload) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

// The overlay's batch rule, copied verbatim from extension/overlay.js:922-925 so
// this file fails if the runner and the browser ever disagree about the default.
const inAiBatch = (c) => c.aiEdits !== false;
const sendAllBatch = (comments) => comments.filter((c) => c.status === 'open' && inAiBatch(c));

test('#165 P0: the notes flag on the agent surface', async (t) => {
  const root = await makeFixtureDir();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await closeAll();
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const env = { REDLINE_RUNNER_URL: base, REDLINE_AGENT_NAME: 'test-agent' };
  const docPath = path.join(root, 'doc.html');
  const listComments = () => fetch(`${base}/api/comments?page=doc.html`).then((r) => r.json());

  await t.test('an agent-authored comment defaults to a note', async () => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html',
      body: 'Noting that this paragraph repeats the heading.',
      anchor: ANCHOR,
      creator: 'agent',
      agentName: 'claude-code',
    });
    assert.equal(res.status, 201);
    const comment = await res.json();
    assert.equal(comment.aiEdits, false, 'agent comment is created as a note');
    assert.equal(comment.creator, 'agent');
  });

  await t.test('a human-authored comment keeps the opt-out default', async () => {
    // Two ways a human reaches this endpoint: saying so, and saying nothing.
    // Absence is what every M1 sidecar carries, so both must behave alike.
    for (const extra of [{}, { creator: 'human' }]) {
      const res = await postJson(`${base}/api/comment`, {
        page: 'doc.html',
        body: 'Make this sentence shorter.',
        anchor: ANCHOR,
        ...extra,
      });
      assert.equal(res.status, 201);
      const comment = await res.json();
      assert.equal(comment.aiEdits, undefined,
        'no flag is written for a human — absence means in the batch');
      assert.equal(inAiBatch(comment), true);
    }
  });

  await t.test('Send-All skips the agent\'s comment and keeps the human\'s', async () => {
    const { comments } = await listComments();
    const batch = sendAllBatch(comments);
    assert.equal(comments.length, 3, 'one agent comment, two human');
    assert.equal(batch.length, 2, 'only the human comments are billable');
    assert.ok(batch.every((c) => c.creator !== 'agent'));
  });

  await t.test('a human can still flag the agent\'s comment in', async () => {
    const { comments } = await listComments();
    const agentComment = comments.find((c) => c.creator === 'agent');
    const res = await postJson(`${base}/api/comment/${agentComment.id}/ai-edits`, {
      page: 'doc.html',
      value: true,
    });
    assert.equal(res.status, 200);
    const after = await listComments();
    assert.equal(sendAllBatch(after.comments).length, 3, 'now all three are in the batch');
  });

  await t.test('redline_list_comments states the flag explicitly on every comment', async () => {
    // The sidecar records aiEdits only when false. An agent reading raw JSON
    // cannot tell a default from a missing field, so the tool normalizes.
    await postJson(`${base}/api/comment`, {
      page: 'doc.html',
      body: 'Second agent note.',
      anchor: { blockId: 'r-0002', quote: 'delta' },
      creator: 'agent',
      agentName: 'claude-code',
    });

    const out = await callTool('redline_list_comments', { file: docPath }, { env });
    assert.equal(out.count, 4);
    assert.ok(out.comments.every((c) => typeof c.aiEdits === 'boolean'),
      'every comment carries an explicit boolean, never an absent key');
    assert.equal(out.noteCount, 1, 'one comment is still a note');

    const notes = out.comments.filter((c) => !c.aiEdits);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].body, 'Second agent note.');
  });

  await t.test('normalization does not rewrite the sidecar', async () => {
    // The tool is a projection. If it wrote its normalized shape back, every
    // human comment would gain an explicit aiEdits:true and the storage
    // convention would be lost.
    const { comments } = await listComments();
    const human = comments.find((c) => c.body === 'Make this sentence shorter.');
    assert.equal(human.aiEdits, undefined, 'still absent on disk');
  });
});
