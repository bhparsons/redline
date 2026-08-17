// test/runner/watch-mcp.test.mjs — the watcher as four MCP tools (#296-#298).
//
// What these cover is the bookkeeping that used to live in the agent's head, so
// each test is really "the server remembers this, not you":
//
//   - the sessionId never appears in a tool result (it is a capability);
//   - the cursor is per COMMENT, so a clarifying reply on an already-handled
//     comment is new work while our own reply on it is not;
//   - a lease is taken and released inside one call, so the agent can never
//     hold one across a turn or collide with itself;
//   - mode is enforced by the server, not promised by the agent.
//
// The parked-wait tests are the ones with real timing in them: a change landing
// mid-park must return in about the time it took to land, NOT at the timeout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { callTool, closeAll } from '../../runner/lib/mcp-tools.mjs';

const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<section data-rev="r-sec1">\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<p data-rev="r-0002">second paragraph</p>\n'
  + '</section>\n</body></html>\n';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-watch-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ telemetry: { endpoint: null } }, null, 2));
  const server = await startServer({ root: dir, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const file = path.join(dir, 'doc.html');
  const env = { REDLINE_RUNNER_URL: base, REDLINE_AGENT_NAME: 'test-watcher' };
  const post = (route, payload) => fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  return {
    dir, base, file, env, post,
    call: (name, args = {}) => callTool(name, { file, ...args }, { env }),
    // A comment as the AUTHOR writes it: no creator field, so it is an edit
    // request rather than an agent note.
    async comment(body, { quote = 'alpha bravo charlie', aiEdits } = {}) {
      const { body: c } = await post('/api/comment', {
        page: 'doc.html', body, anchor: { quote, blockId: 'r-0001' },
        ...(aiEdits === undefined ? {} : { aiEdits }),
      });
      return c;
    },
    async close() {
      await closeAll();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('watch_start claims the page, reports the baseline, and never leaks the sessionId', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  await f.comment('please tighten this');
  await f.comment('just an observation', { aiEdits: false });

  const started = await f.call('redline_watch_start', { mode: 'reply-and-edit' });
  assert.equal(started.mode, 'reply-and-edit');
  assert.equal(started.resumed, false);
  assert.equal(started.existingCount, 2);
  assert.equal(started.actionableCount, 1, 'the note is not actionable');
  assert.equal(started.noteCount, 1);
  assert.equal(started.hold.on, false);

  // The capability is held by the server. If it ever appears in a result, the
  // skill is back to telling the agent not to print it.
  assert.ok(!JSON.stringify(started).includes('sessionId'), 'sessionId must not appear in a tool result');

  // Presence is real: the runner reports this session as attached. /api/status
  // carries ONE watcher — presence is single-holder by design.
  const status = await fetch(`${f.base}/api/status?page=doc.html`).then((r) => r.json());
  assert.equal(status.session?.agentName, 'test-watcher');
});

test('a page someone else already claimed refuses, names the holder, and does not evict', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  const claimed = await f.post('/api/session/claim', {
    page: 'doc.html', agentName: 'other-agent', pid: 4242, ttlMs: 60_000,
  });
  assert.equal(claimed.status, 200);

  await assert.rejects(
    () => f.call('redline_watch_start', { mode: 'reply-and-edit' }),
    (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /other-agent/);
      assert.match(err.message, /4242/);
      return true;
    },
  );

  // First holder still wins.
  const status = await fetch(`${f.base}/api/status?page=doc.html`).then((r) => r.json());
  assert.equal(status.session?.agentName, 'other-agent');
});

test('wait_for_change returns work that arrived before the call, without parking', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  await f.call('redline_watch_start', { mode: 'reply-and-edit' });
  await f.comment('rewrite the opening');

  const started = Date.now();
  const change = await f.call('redline_wait_for_change', { timeoutMs: 30_000 });
  const elapsed = Date.now() - started;

  assert.equal(change.changed, true);
  assert.equal(change.comments.length, 1);
  assert.equal(change.actionable.length, 1);
  assert.equal(change.comments[0].body, 'rewrite the opening');
  assert.ok(elapsed < 5_000, `returned immediately, took ${elapsed}ms`);
  assert.equal(change.waitedMs, 0);
});

test('wait_for_change parks, then returns when the change lands — not at the timeout', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  await f.call('redline_watch_start', { mode: 'reply-and-edit' });

  const parked = f.call('redline_wait_for_change', { timeoutMs: 20_000 });
  // Long enough that the park is genuinely established first.
  await new Promise((r) => setTimeout(r, 400));
  await f.comment('landed while parked');

  const change = await parked;
  assert.equal(change.changed, true);
  assert.equal(change.comments[0].body, 'landed while parked');
  assert.ok(change.waitedMs < 10_000,
    `woke on the change (${change.waitedMs}ms), not at the 20s timeout`);
});

test('an empty park returns changed:false and says to call again', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  await f.call('redline_watch_start', { mode: 'reply-and-edit' });
  const change = await f.call('redline_wait_for_change', { timeoutMs: 1_200 });

  assert.equal(change.changed, false);
  assert.match(change.note, /call redline_wait_for_change again/);
});

test('resolve_comment applies, replies, sets the status, and does not wake itself', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  await f.call('redline_watch_start', { mode: 'reply-and-edit' });
  const c = await f.comment('make the opening plainer');
  await f.call('redline_wait_for_change', { timeoutMs: 20_000 });

  const done = await f.call('redline_resolve_comment', {
    commentId: c.id,
    edits: [{ blockId: 'r-0001', newInner: 'alpha bravo, plainly' }],
    reply: 'Reworded the opening.',
    status: 'addressed',
  });
  assert.equal(done.applied, true);
  assert.equal(done.replied, true);
  assert.ok(done.runId, 'the write is a recorded run');
  assert.ok(!JSON.stringify(done).includes('leaseId'), 'the agent never sees a lease id');

  // The runner is the writer, and the document really changed.
  const source = await fetch(`${f.base}/api/source?page=doc.html`).then((r) => r.json());
  assert.match(source.source, /alpha bravo, plainly/);

  const after = await fetch(`${f.base}/api/comments?page=doc.html`).then((r) => r.json());
  const updated = after.comments.find((x) => x.id === c.id);
  assert.equal(updated.status, 'addressed');
  assert.ok(updated.replies.some((r) => r.body === 'Reworded the opening.'));

  // The echo filter: our own reply and status bumped the rev, and we must not
  // be woken for work we just did.
  const quiet = await f.call('redline_wait_for_change', { timeoutMs: 1_200 });
  assert.equal(quiet.changed, false, 'our own write must not wake us');
});

test('a clarifying reply on a handled comment IS new work — the cursor is per comment', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  await f.call('redline_watch_start', { mode: 'reply-and-edit' });
  const c = await f.comment('make the opening plainer');
  await f.call('redline_wait_for_change', { timeoutMs: 20_000 });
  await f.call('redline_resolve_comment', {
    commentId: c.id,
    edits: [{ blockId: 'r-0001', newInner: 'alpha bravo, plainly' }],
    reply: 'Reworded the opening.',
    status: 'addressed',
  });

  // The author comes back on the SAME comment. A seen-set keyed by id would
  // drop this silently; the per-comment rev cursor catches it.
  await f.post(`/api/comment/${encodeURIComponent(c.id)}/reply`, {
    page: 'doc.html', body: 'still too long',
  });

  const change = await f.call('redline_wait_for_change', { timeoutMs: 20_000 });
  assert.equal(change.changed, true);
  assert.equal(change.comments.length, 1);
  assert.equal(change.comments[0].id, c.id);
});

test('reply-only refuses edits, and replies without touching the document', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  await f.call('redline_watch_start', { mode: 'reply-only' });
  const c = await f.comment('make the opening plainer');

  await assert.rejects(
    () => f.call('redline_resolve_comment', {
      commentId: c.id,
      edits: [{ blockId: 'r-0001', newInner: 'rewritten' }],
      reply: 'done',
    }),
    /reply-only/,
  );

  const before = await fetch(`${f.base}/api/source?page=doc.html`).then((r) => r.json());
  const answered = await f.call('redline_resolve_comment', {
    commentId: c.id, reply: 'I would shorten it to one clause — say the word and I will.',
  });
  assert.equal(answered.applied, false);
  assert.equal(answered.replied, true);

  const after = await fetch(`${f.base}/api/source?page=doc.html`).then((r) => r.json());
  assert.equal(after.source, before.source, 'reply-only never writes the document');
});

test('hold suppresses actionable work but still reports the comments', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  await f.call('redline_watch_start', { mode: 'reply-and-edit' });
  await f.post('/api/hold', { page: 'doc.html', hold: true });
  await f.comment('one of several related asks');

  const change = await f.call('redline_wait_for_change', { timeoutMs: 20_000 });
  assert.equal(change.changed, true);
  assert.equal(change.hold.on, true);
  assert.equal(change.comments.length, 1, 'the comment is still reported');
  assert.deepEqual(change.actionable, [], 'but nothing is actionable until hold clears');
});

test('watch_stop releases the claim, and the page stops showing a watcher', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  await f.call('redline_watch_start', { mode: 'reply-and-edit' });
  const before = await fetch(`${f.base}/api/status?page=doc.html`).then((r) => r.json());
  assert.equal(before.session?.agentName, 'test-watcher');

  const stopped = await f.call('redline_watch_stop');
  assert.equal(stopped.stopped, 1);

  const after = await fetch(`${f.base}/api/status?page=doc.html`).then((r) => r.json());
  assert.equal(after.session, null, 'the page stops showing a watcher');

  // And the loop verbs say so plainly rather than failing obscurely.
  await assert.rejects(() => f.call('redline_wait_for_change'), /not watching/);
});

test('an orchestrator that acknowledges with a plain reply can still park', async (t) => {
  // The failure this exists for (live session, 2026-08-17): the cursor only
  // advanced inside redline_resolve_comment, but the orchestrator pattern
  // ACKNOWLEDGES first with redline_reply and delegates the work. A reply bumps
  // the comment's rev like any other write, so the orchestrator replayed its own
  // acknowledgement as a delta forever — wait_for_change returned in 0 ms every
  // time and it could never park.
  const f = await fixture();
  t.after(() => f.close());

  await f.call('redline_watch_start', { mode: 'reply-and-edit' });
  const c = await f.comment('tighten the opening');
  const change = await f.call('redline_wait_for_change', { timeoutMs: 20_000 });
  assert.equal(change.actionable.length, 1);

  // Acknowledge and hand off. No edit, no status — exactly what an orchestrator
  // does before a worker picks the comment up.
  await f.call('redline_reply', { commentId: c.id, body: 'Got it — tightening the opening.' });

  const quiet = await f.call('redline_wait_for_change', { timeoutMs: 1_500 });
  assert.equal(quiet.changed, false, 'the acknowledgement must not read back as new work');
  assert.ok(quiet.waitedMs > 1_000, `it actually parked (waited ${quiet.waitedMs}ms), rather than returning at once`);
});

test('every comment-mutating tool advances the cursor, not just resolve_comment', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  await f.call('redline_watch_start', { mode: 'reply-and-edit' });
  const c = await f.comment('a thing to handle');
  await f.call('redline_wait_for_change', { timeoutMs: 20_000 });

  // Each of these bumps the comment's rev; none of them is resolve_comment.
  await f.call('redline_reply', { commentId: c.id, body: 'looking at it' });
  await f.call('redline_update_status', { commentId: c.id, status: 'deferred' });
  await f.call('redline_set_ai_edits', { commentId: c.id, aiEdits: false });

  const quiet = await f.call('redline_wait_for_change', { timeoutMs: 1_500 });
  assert.equal(quiet.changed, false, 'three of our own writes, zero deltas');

  // And a real change from someone else still gets through — the filter must
  // not have become "ignore this comment".
  await f.post(`/api/comment/${encodeURIComponent(c.id)}/reply`, { page: 'doc.html', body: 'actually, no' });
  const woke = await f.call('redline_wait_for_change', { timeoutMs: 20_000 });
  assert.equal(woke.changed, true);
  assert.equal(woke.comments[0].id, c.id);
});
