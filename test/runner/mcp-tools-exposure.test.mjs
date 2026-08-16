// test/runner/mcp-tools-exposure.test.mjs — #50: the three tools MCP was missing.
//
// These are EXPOSURE, not new capability — the endpoints and their api-client
// wrappers already existed. So the first test here is the one that would have
// caught the omission in the first place: every mutating api-client method an
// agent could need must have a tool, or the gap is silent again.
//
// The behavioural cases cover what an agent actually hits:
//   - instrument, because a page the agent just wrote has no blocks and cannot
//     be commented on until it does (this is what broke "create a document");
//   - reply, because flipping a status tells the human nothing;
//   - undo, including the hazard that it is LAST-RUN-WINS.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { TOOLS, callTool, closeAll } from '../../runner/lib/mcp-tools.mjs';

const STAMPED = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<p data-rev="r-0002">second paragraph</p>\n'
  + '</body></html>\n';

const UNSTAMPED = '<!doctype html>\n<html><head><title>fresh</title></head>\n<body>\n'
  + '<h1>A plan the agent just wrote</h1>\n<p>Step one.</p>\n<p>Step two.</p>\n'
  + '</body></html>\n';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-expose-'));
  await fs.writeFile(path.join(dir, 'doc.html'), STAMPED);
  await fs.writeFile(path.join(dir, 'fresh.html'), UNSTAMPED);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ telemetry: { endpoint: null } }, null, 2));
  const server = await startServer({ root: dir, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    dir,
    base,
    env: { REDLINE_RUNNER_URL: base, REDLINE_AGENT_NAME: 'test-agent' },
    async close() {
      await closeAll();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('every mutating api-client method an agent needs has a tool', async () => {
  // The guard against this class of omission recurring. `trace` is knowingly
  // excluded (observability, not part of the review loop); everything else on
  // the client is something an agent can legitimately want.
  const src = await fs.readFile(new URL('../../runner/lib/api-client.mjs', import.meta.url), 'utf8');
  const methods = [...src.matchAll(/^\s{4}([a-zA-Z]+): \(/gm)].map((m) => m[1]);
  assert.ok(methods.length >= 10, `expected to parse api-client methods, got ${methods.length}`);

  // `trace` and `info` are knowingly excluded (observability and discovery, not
  // part of the review loop). The three session verbs (#187) are excluded for a
  // stronger reason: the heartbeat is owned by the detached WATCHER
  // subprocess, not by an agent turn — a conversational session does not act on
  // a timer, so beating from a tool call would go silent while the session was
  // alive. Claim and release belong to the same watcher lifecycle, so exposing
  // either alone would hand an agent a claim that dies at its TTL. The watcher
  // protocol is #192's, and these are its verbs.
//
  // The three lease verbs (#188) are excluded for now and it IS a gap, not a
  // principle: decision 9 has the agent lease immediately before writing and
  // release immediately after, which is an agent-turn action and belongs on the
  // tool surface. What is missing is the protocol around it — a tool that takes
  // a lease and no tool that reliably gives it back leaves blocks held for
  // their full TTL every time an agent stops mid-turn. That pairing is #192's.
  const EXPECTED_UNEXPOSED = new Set([
    'trace', 'info', 'claimSession', 'heartbeatSession', 'releaseSession',
    'acquireLease', 'renewLease', 'releaseLease',
  ]);
  const toolNames = TOOLS.map((t) => t.name).join(' ');
  const ALIASES = {
    source: 'read_source', comments: 'list_comments', addComment: 'add_comment',
    setStatus: 'update_status', run: 'run_revision', proposeEdits: 'propose_edits',
    status: 'run_status', instrument: 'instrument', reply: 'reply', undo: 'undo',
    setAiEdits: 'set_ai_edits', confirmRun: 'confirm_scope', edit: 'direct_edit',
  };

  for (const method of methods) {
    if (EXPECTED_UNEXPOSED.has(method)) continue;
    const alias = ALIASES[method];
    assert.ok(alias, `api-client gained "${method}" with no decision about exposing it — add it to ALIASES or EXPECTED_UNEXPOSED`);
    assert.ok(toolNames.includes(`redline_${alias}`), `api-client.${method} has no MCP tool`);
  }
});

test('redline_instrument takes a fresh document from uncommentable to commentable', async () => {
  const f = await fixture();
  try {
    const before = await callTool('redline_read_source', { file: 'fresh.html', blocksOnly: true }, { env: f.env });
    assert.equal(before.blocks.length, 0, 'a page the agent just wrote has no blocks');

    const stamped = await callTool('redline_instrument', { file: 'fresh.html' }, { env: f.env });
    assert.ok(stamped.added > 0, 'blocks were stamped');
    assert.equal(stamped.total, stamped.added);

    const after = await callTool('redline_read_source', { file: 'fresh.html', blocksOnly: true }, { env: f.env });
    assert.ok(after.blocks.length > 0, 'now it has blocks');

    // The point of the whole exercise: a comment can now anchor.
    const added = await callTool('redline_add_comment', {
      file: 'fresh.html', body: 'tighten this', quote: 'Step one.', blockId: after.blocks[0].id,
    }, { env: f.env });
    assert.ok(added.comment.id);
  } finally {
    await f.close();
  }
});

test('redline_instrument is idempotent', async () => {
  const f = await fixture();
  try {
    await callTool('redline_instrument', { file: 'fresh.html' }, { env: f.env });
    const again = await callTool('redline_instrument', { file: 'fresh.html' }, { env: f.env });
    assert.equal(again.added, 0, 'second call adds nothing');
  } finally {
    await f.close();
  }
});

test('redline_reply posts onto the thread with agent provenance', async () => {
  const f = await fixture();
  try {
    const { comment } = await callTool('redline_add_comment', {
      file: 'doc.html', body: 'please rewrite', quote: 'alpha bravo charlie', blockId: 'r-0001',
    }, { env: f.env });

    const replied = await callTool('redline_reply', {
      file: 'doc.html', commentId: comment.id, body: 'done - shortened the sentence',
    }, { env: f.env });

    const replies = replied.comment.replies ?? [];
    assert.equal(replies.length, 1);
    assert.match(replies[0].body, /shortened/);
    assert.equal(replies[0].creator, 'agent');
    assert.equal(replies[0].agentName, 'test-agent');

    const listed = await callTool('redline_list_comments', { file: 'doc.html' }, { env: f.env });
    assert.equal(listed.comments[0].replies.length, 1, 'and the human can read it back');
  } finally {
    await f.close();
  }
});

test('redline_undo reverts the agent\'s own applied edits', async () => {
  const f = await fixture();
  try {
    const original = await fs.readFile(path.join(f.dir, 'doc.html'), 'utf8');
    const { comment } = await callTool('redline_add_comment', {
      file: 'doc.html', body: 'shorten', quote: 'alpha bravo charlie', blockId: 'r-0001', aiEdits: true,
    }, { env: f.env });

    await callTool('redline_propose_edits', {
      file: 'doc.html',
      commentId: comment.id,
      edits: [{ blockId: 'r-0001', newInner: 'alpha' }],
      dryRun: false,
    }, { env: f.env });
    assert.notEqual(await fs.readFile(path.join(f.dir, 'doc.html'), 'utf8'), original, 'the edit applied');

    const undone = await callTool('redline_undo', { file: 'doc.html' }, { env: f.env });
    assert.ok(undone.run ?? undone.undone ?? undone, 'a run record came back');
    assert.equal(await fs.readFile(path.join(f.dir, 'doc.html'), 'utf8'), original, 'document restored');
  } finally {
    await f.close();
  }
});

test('redline_confirm_scope lets an agent resolve a gate it tripped', async () => {
  // Before #195 there was no tool for POST /api/run/confirm, so an agent could
  // PAUSE its own write and then had no way to answer — the write sat waiting
  // on a human who might not be looking at the document.
  const f = await fixture();
  try {
    const { comment } = await callTool('redline_add_comment', {
      file: 'doc.html', body: 'shorten', quote: 'alpha bravo charlie', blockId: 'r-0001', aiEdits: true,
    }, { env: f.env });

    const paused = await callTool('redline_propose_edits', {
      file: 'doc.html',
      commentId: comment.id,
      edits: [{ blockId: 'r-0001', newInner: 'alpha' }],
      // The agent asking for a confirmation it would not otherwise get — the
      // cheapest way to reach the gate without a two-section fixture.
      scope: { requiresConfirmation: true, summary: 'Wider than you may want.' },
      dryRun: false,
    }, { env: f.env });
    assert.equal(paused.pendingConfirmation, true, 'the write paused');

    const original = await fs.readFile(path.join(f.dir, 'doc.html'), 'utf8');
    const declined = await callTool('redline_confirm_scope', {
      file: 'doc.html', runId: paused.runId, allow: false,
    }, { env: f.env });
    assert.equal(declined.declined, true);
    assert.equal(await fs.readFile(path.join(f.dir, 'doc.html'), 'utf8'), original,
      'declining writes nothing');

    // And allow applies it, so the tool is not a one-way withdraw.
    const again = await callTool('redline_propose_edits', {
      file: 'doc.html',
      commentId: comment.id,
      edits: [{ blockId: 'r-0001', newInner: 'alpha' }],
      scope: { requiresConfirmation: true },
      dryRun: false,
    }, { env: f.env });
    const allowed = await callTool('redline_confirm_scope', {
      file: 'doc.html', runId: again.runId, allow: true,
    }, { env: f.env });
    assert.equal(allowed.status, 'ok');
    assert.match(await fs.readFile(path.join(f.dir, 'doc.html'), 'utf8'),
      /<p data-rev="r-0001">alpha<\/p>/);
  } finally {
    await f.close();
  }
});

test('redline_undo is LAST-RUN-WINS, and the tool description says so', async () => {
  // Not a bug being pinned as correct — a known hazard being pinned as KNOWN.
  // The run-id guard was deferred (Blake, 2026-07-29), so the only mitigation
  // shipped is that the agent is warned. If undo ever becomes run-targeted,
  // this test should fail and be rewritten.
  const tool = TOOLS.find((t) => t.name === 'redline_undo');
  assert.ok(tool, 'redline_undo is registered');
  assert.match(tool.description, /LAST-RUN-WINS/);
  assert.match(tool.description, /human/i, 'warns that it can revert a human\'s run');
  assert.equal(tool.inputSchema.properties.runId, undefined, 'no run targeting yet - keep the warning');
});

test('results carry a url the agent can hand to a human', async () => {
  const f = await fixture();
  try {
    for (const [name, args] of [
      ['redline_read_source', { file: 'doc.html', blocksOnly: true }],
      ['redline_list_comments', { file: 'doc.html' }],
      ['redline_instrument', { file: 'fresh.html' }],
    ]) {
      const result = await callTool(name, args, { env: f.env });
      assert.ok(result.url, `${name} returns a url`);
      assert.equal(result.url, `${f.base}/${result.page}`);
      assert.doesNotMatch(result.url, /\/\/[^/]*\/\//, 'no doubled slashes');
    }
  } finally {
    await f.close();
  }
});
