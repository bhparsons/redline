// test/runner/status-authority.test.mjs — #250: two comment-lifecycle rules
// move from the overlay into the trust layer.
//
// 1. `resolved` means "a human accepted this". The runner now refuses it from
//    an agent, so a session can no longer accept its own edit and take the
//    comment out of the author's queue unseen.
// 2. A human reply re-opens a settled comment IN THE SAME WRITE. This rule
//    lived in the overlay as reply-then-second-status-call, so only the
//    overlay obeyed it and a failure between the calls left a reply with no
//    re-open. Agent replies never re-open.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { loadOverlay } from './_overlay-load.mjs';

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n</body></html>\n';

const postJson = (url, payload) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

test('status authority (#250)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-authority-'));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, 'doc.html'), DOC_HTML);
  const base = `http://127.0.0.1:${port}`;

  const newComment = async (body) => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html',
      body,
      anchor: { blockId: 'r-0001', quote: 'bravo', prefix: 'alpha ', suffix: ' charlie' },
    });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };
  const statusOf = async (id) => {
    const res = await fetch(`${base}/api/comments?page=doc.html`);
    return (await res.json()).comments.find((c) => c.id === id);
  };

  // ---- hole 1: an agent accepting its own work --------------------------------

  await t.test('an agent-authored resolved is refused, and the comment does not move', async () => {
    const id = await newComment('tighten this sentence');
    const res = await postJson(`${base}/api/comment/${id}/status`, {
      page: 'doc.html', status: 'resolved', creator: 'agent', agentName: 'claude-code',
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /human act/,
      'the refusal names the rule, not just a code');
    assert.equal((await statusOf(id)).status, 'open', 'nothing moved');
  });

  await t.test('a human resolved succeeds, and every other status stays agent-settable', async () => {
    const id = await newComment('second ask');
    const human = await postJson(`${base}/api/comment/${id}/status`, { page: 'doc.html', status: 'resolved' });
    assert.equal(human.status, 200);
    assert.equal((await statusOf(id)).status, 'resolved');

    for (const status of ['open', 'addressed', 'declined', 'deferred']) {
      const res = await postJson(`${base}/api/comment/${id}/status`, {
        page: 'doc.html', status, creator: 'agent', agentName: 'claude-code',
      });
      assert.equal(res.status, 200, `agent may still set ${status}`);
      assert.equal((await statusOf(id)).status, status);
    }
  });

  // ---- hole 2: the reply re-open lives in the runner --------------------------

  await t.test('a human reply re-opens a settled comment in one write', async () => {
    const id = await newComment('third ask');
    await postJson(`${base}/api/comment/${id}/status`, {
      page: 'doc.html', status: 'declined', creator: 'agent', agentName: 'claude-code',
    });
    assert.equal((await statusOf(id)).status, 'declined');

    // No creator — exactly what the overlay (and a bare curl) sends.
    const res = await postJson(`${base}/api/comment/${id}/reply`, {
      page: 'doc.html', body: 'not convinced — try forest green instead',
    });
    assert.equal(res.status, 200);
    const after = await statusOf(id);
    assert.equal(after.status, 'open', 'the reply itself re-opened it');
    assert.equal(after.replies.length, 1, 'and the reply landed in the same write');
  });

  await t.test('an agent reply does NOT re-open — it must not reverse the author', async () => {
    const id = await newComment('fourth ask');
    await postJson(`${base}/api/comment/${id}/status`, { page: 'doc.html', status: 'resolved' });

    const res = await postJson(`${base}/api/comment/${id}/reply`, {
      page: 'doc.html', body: 'noting for the record', creator: 'agent', agentName: 'claude-code',
    });
    assert.equal(res.status, 200);
    const after = await statusOf(id);
    assert.equal(after.status, 'resolved', 'the author\'s acceptance stands');
    assert.equal(after.replies.length, 1, 'the reply still landed');
  });

  await t.test('a human reply to an OPEN comment burns no status write', async () => {
    const id = await newComment('fifth ask');
    const res = await postJson(`${base}/api/comment/${id}/reply`, { page: 'doc.html', body: 'more detail' });
    assert.equal(res.status, 200);
    assert.equal((await statusOf(id)).status, 'open');
  });
});

// ---- the Needs review filter includes failed (#250 AC5) ---------------------

test('the Needs review filter includes failed comments', () => {
  const { FILTERS } = loadOverlay();
  const needs = FILTERS.find(([key]) => key === 'needs')[2];
  for (const status of ['addressed', 'declined', 'deferred', 'failed']) {
    assert.equal(needs({ status }), true, `${status} needs the author's eyes`);
  }
  assert.equal(needs({ status: 'open' }), false);
  assert.equal(needs({ status: 'resolved' }), false);
});
