// test/runner/agent-api.test.mjs — M2 WP2: the agent-facing API surface.
//
// Self-contained like the other runner tests: fixture dir in a tmpdir, the
// runner on an OS-assigned port, no network. Covers GET /api/info, GET
// /api/source, the creator/agentName provenance fields on comment/reply/
// status, the widened status vocabulary, POST /api/propose-edits in both
// dry-run and apply modes, and that a rejected proposal never touches disk.
//
// /api/run is exercised against a real (stub) model endpoint in run.test.mjs
// and send-all.test.mjs — this file only asserts the batch contract it
// already had is reachable and unchanged for agents.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<section data-rev="r-0002">\n  <p data-rev="r-0003">inside the section</p>\n</section>\n'
  + '<p>plain paragraph</p>\n</body></html>\n';

const UNSTAMPED_HTML = '<!doctype html>\n<html><body>\n<p>nothing stamped here</p>\n</body></html>\n';

async function makeFixtureDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-agent-api-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, 'bare.html'), UNSTAMPED_HTML);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    telemetry: { endpoint: null }, // never export from tests
  }, null, 2));
  return dir;
}

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

const getJson = async (url) => {
  const res = await fetch(url);
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('agent-facing API', async (t) => {
  const root = await makeFixtureDir();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');

  await t.test('GET /api/info reports this runner\'s identity', async () => {
    const { status, body } = await getJson(`${base}/api/info`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.root, root);
    assert.equal(body.port, port);
    assert.equal(body.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(body.startedAt)), 'startedAt is a timestamp');
    assert.equal(typeof body.version, 'string');
    // Presence-only key signal for the popup (WP14) — a boolean, never the key.
    assert.equal(typeof body.hasApiKey, 'boolean');
  });

  await t.test('GET /health is unchanged (the extension asserts it exactly)', async () => {
    const { status, body } = await getJson(`${base}/health`);
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
  });

  await t.test('GET /api/source returns the raw source and the block index', async () => {
    const { status, body } = await getJson(`${base}/api/source?page=doc.html`);
    assert.equal(status, 200);
    assert.equal(body.page, 'doc.html');
    assert.equal(body.source, DOC_HTML, 'byte-identical to disk');
    assert.equal(body.bytes, Buffer.byteLength(DOC_HTML, 'utf8'));
    assert.deepEqual(body.blocks.map((b) => b.id), ['r-0001', 'r-0002', 'r-0003'], 'document order');
    assert.deepEqual(body.blocks[0], { id: 'r-0001', tag: 'p', text: 'alpha bravo charlie' });
    assert.equal(body.blocks[1].tag, 'section');
    assert.equal(body.blocks[1].text, 'inside the section', 'container text is tag-stripped');
  });

  await t.test('GET /api/source on an unstamped page returns no blocks', async () => {
    const { status, body } = await getJson(`${base}/api/source?page=bare.html`);
    assert.equal(status, 200);
    assert.deepEqual(body.blocks, []);
    assert.equal(body.source, UNSTAMPED_HTML);
  });

  await t.test('GET /api/source guards: missing page → 400, unknown/traversal → 404', async () => {
    assert.equal((await fetch(`${base}/api/source`)).status, 400);
    assert.equal((await fetch(`${base}/api/source?page=nope.html`)).status, 404);
    assert.equal((await fetch(`${base}/api/source?page=${encodeURIComponent('../../etc/passwd.html')}`)).status, 404);
    assert.equal((await fetch(`${base}/api/source?page=${encodeURIComponent(CONFIG_FILENAME)}`)).status, 404);
    assert.equal((await postJson(`${base}/api/source`, {})).status, 405);
  });

  // ---- provenance -----------------------------------------------------------

  let agentCommentId;
  let humanCommentId;

  await t.test('POST /api/comment records creator + agentName', async () => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html',
      body: 'The ask is buried.',
      anchor: { blockId: 'r-0001', quote: 'bravo' },
      creator: 'agent',
      agentName: 'claude-code',
      aiEdits: true,
    });
    assert.equal(res.status, 201);
    const comment = await res.json();
    assert.equal(comment.creator, 'agent');
    assert.equal(comment.agentName, 'claude-code');
    agentCommentId = comment.id;
  });

  await t.test('a comment with no actor fields stays legacy-shaped', async () => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html', body: 'Human comment.', anchor: { blockId: 'r-0003', quote: 'inside' },
    });
    assert.equal(res.status, 201);
    const comment = await res.json();
    assert.ok(!('creator' in comment), 'absent means human — never stamped');
    assert.ok(!('agentName' in comment));
    humanCommentId = comment.id;
  });

  await t.test('invalid creator/agentName → 400', async () => {
    for (const actor of [
      { creator: 'robot' }, { creator: 42 }, { creator: 'agent', agentName: 'bad name!' },
      { creator: 'agent', agentName: 'x'.repeat(65) }, { creator: 'agent', agentName: 7 },
    ]) {
      const res = await postJson(`${base}/api/comment`, {
        page: 'doc.html', body: 'x', anchor: { quote: 'bravo' }, ...actor,
      });
      assert.equal(res.status, 400, JSON.stringify(actor));
    }
  });

  await t.test('agentName without creator:"agent" is dropped, not recorded', async () => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html', body: 'x', anchor: { quote: 'bravo' }, creator: 'human', agentName: 'sneaky',
    });
    assert.equal(res.status, 201);
    const comment = await res.json();
    assert.equal(comment.creator, 'human');
    assert.ok(!('agentName' in comment));
  });

  await t.test('replies carry provenance too', async () => {
    const res = await postJson(`${base}/api/comment/${humanCommentId}/reply`, {
      page: 'doc.html', body: 'Following up.', creator: 'agent', agentName: 'codex',
    });
    assert.equal(res.status, 200);
    const reply = (await res.json()).replies.at(-1);
    assert.equal(reply.creator, 'agent');
    assert.equal(reply.agentName, 'codex');
  });

  await t.test('status accepts the decision vocabulary and records who set it', async () => {
    // `resolved` left this list in #250: it is the author accepting the work,
    // and the runner refuses it from an agent (status-authority.test.mjs).
    for (const status of ['addressed', 'declined', 'deferred', 'open']) {
      const res = await postJson(`${base}/api/comment/${humanCommentId}/status`, {
        page: 'doc.html', status, creator: 'agent', agentName: 'claude-code',
      });
      assert.equal(res.status, 200, status);
      const comment = await res.json();
      assert.equal(comment.status, status);
      assert.equal(comment.statusUpdatedBy.creator, 'agent');
      assert.equal(comment.statusUpdatedBy.agentName, 'claude-code');
      assert.ok(!Number.isNaN(Date.parse(comment.statusUpdatedBy.at)));
    }
  });

  await t.test('a status change with no actor clears the attribution', async () => {
    const res = await postJson(`${base}/api/comment/${humanCommentId}/status`, {
      page: 'doc.html', status: 'open',
    });
    assert.equal(res.status, 200);
    assert.ok(!('statusUpdatedBy' in await res.json()));
  });

  await t.test('unknown status still → 400', async () => {
    const res = await postJson(`${base}/api/comment/${humanCommentId}/status`, {
      page: 'doc.html', status: 'closed',
    });
    assert.equal(res.status, 400);
  });

  // ---- propose-edits: dry run ----------------------------------------------

  await t.test('dry run defaults to true and never writes', async () => {
    const before = await fs.readFile(docPath, 'utf8');
    const res = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html',
      edits: [{ blockId: 'r-0001', newInner: 'alpha <strong>bravo</strong> charlie' }],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.dryRun, true);
    assert.equal(body.valid, true);
    assert.equal(body.changed, true);
    assert.equal(body.editRecords.length, 1);
    assert.equal(body.editRecords[0].beforeInner, 'alpha bravo charlie');
    assert.equal(body.editRecords[0].afterInner, 'alpha <strong>bravo</strong> charlie');
    assert.equal(await fs.readFile(docPath, 'utf8'), before, 'document untouched');
  });

  await t.test('an invalid dry run is a 200 verdict, not an error', async () => {
    const res = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html', dryRun: true,
      edits: [{ blockId: 'r-9999', newInner: 'nope' }],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.valid, false);
    assert.equal(body.code, 'unknown-block');
    assert.equal(body.blockId, 'r-9999');
    assert.equal(typeof body.error, 'string');
  });

  await t.test('dry run rejects unbalanced markup with the reason', async () => {
    const res = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html', edits: [{ blockId: 'r-0001', newInner: 'alpha <strong>bravo' }],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.valid, false);
    assert.equal(body.code, 'unbalanced');
  });

  await t.test('malformed proposals → 400', async () => {
    for (const payload of [
      { edits: 'nope' },
      { edits: [{ blockId: 'r-0001' }] },
      { edits: [{ blockId: '../x', newInner: 'x' }] },
      { inserts: [{ afterBlockId: 'r-0001', beforeBlockId: 'r-0003', html: '<p>x</p>' }] },
      { inserts: [{ afterBlockId: 'r-0001' }] },
      { decisions: [{ id: 'c-1', decision: 'nope', summary: '' }] },
      { dryRun: 'yes' },
    ]) {
      const res = await postJson(`${base}/api/propose-edits`, { page: 'doc.html', ...payload });
      assert.equal(res.status, 400, JSON.stringify(payload));
    }
  });

  await t.test('decisions need a commentId, and must name it', async () => {
    let res = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html',
      decisions: [{ id: agentCommentId, decision: 'addressed', summary: 'ok' }],
    });
    assert.equal(res.status, 400);

    res = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html', commentId: agentCommentId,
      decisions: [{ id: 'c-someone-else', decision: 'addressed', summary: 'ok' }],
    });
    assert.equal(res.status, 400);

    res = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html', commentId: 'c-doesnotexist',
      decisions: [{ id: 'c-doesnotexist', decision: 'addressed', summary: 'ok' }],
    });
    assert.equal(res.status, 404);
  });

  await t.test('unknown page → 404, wrong method → 405', async () => {
    assert.equal((await postJson(`${base}/api/propose-edits`, { page: 'nope.html' })).status, 404);
    assert.equal((await fetch(`${base}/api/propose-edits`)).status, 405);
  });

  // ---- propose-edits: apply -------------------------------------------------

  await t.test('a rejected apply is a 422 and writes nothing', async () => {
    const before = await fs.readFile(docPath, 'utf8');
    const res = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html', dryRun: false,
      edits: [{ blockId: 'r-0001', newInner: 'alpha <em>bravo' }],
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.valid, false);
    assert.equal(body.code, 'unbalanced');
    assert.equal(await fs.readFile(docPath, 'utf8'), before, 'document untouched');
    const { body: status } = await getJson(`${base}/api/status?page=doc.html`);
    assert.ok(status.lastRun === undefined, 'no run record for a rejected proposal');
  });

  let appliedRunId;

  await t.test('an applied proposal writes the doc and records a run with provenance', async () => {
    const res = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html', dryRun: false, commentId: agentCommentId,
      decisions: [{ id: agentCommentId, decision: 'addressed', summary: 'Lifted the ask.', note: 'Bolded it.' }],
      edits: [{ blockId: 'r-0001', newInner: 'alpha <strong>bravo</strong> charlie' }],
      inserts: [{ afterBlockId: 'r-0001', html: '<p>Added by the agent.</p>' }],
      creator: 'agent', agentName: 'claude-code',
    });
    assert.equal(res.status, 200);
    const run = await res.json();
    appliedRunId = run.runId;
    assert.match(run.runId, /^run-[0-9a-f]{12}$/);
    assert.equal(run.status, 'ok');
    assert.equal(run.lane, 'proposed');
    assert.equal(run.commentId, agentCommentId);
    assert.deepEqual(run.actor, { creator: 'agent', agentName: 'claude-code' });
    assert.equal(run.edits.length, 2, 'one edit record + one insert record');
    assert.equal(run.edits[1].insertedAfter, 'r-0001');
    assert.match(run.edits[1].blockId, /^r-[0-9a-f]{4}$/, 'the runner minted the new id');

    const source = await fs.readFile(docPath, 'utf8');
    assert.ok(source.includes('alpha <strong>bravo</strong> charlie'));
    assert.ok(source.includes('Added by the agent.'));
  });

  await t.test('the proposal resolved its comment', async () => {
    const { body } = await getJson(`${base}/api/comments?page=doc.html`);
    const comment = body.comments.find((c) => c.id === agentCommentId);
    assert.equal(comment.status, 'addressed');
    assert.equal(comment.resolution.runId, appliedRunId);
    assert.equal(comment.resolution.summary, 'Lifted the ask.');
    assert.equal(comment.resolution.note, 'Bolded it.');
  });

  await t.test('/api/status reports the proposal as the last run', async () => {
    const { body } = await getJson(`${base}/api/status?page=doc.html`);
    assert.equal(body.running, false);
    assert.equal(body.lastRun.runId, appliedRunId);
    assert.equal(body.lastRun.lane, 'proposed');
  });

  await t.test('POST /api/undo reverts an applied proposal', async () => {
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).runId, appliedRunId);
    const source = await fs.readFile(docPath, 'utf8');
    assert.ok(!source.includes('<strong>bravo</strong>'), 'edit reverted');
    assert.ok(!source.includes('Added by the agent.'), 'insert reverted');
    const { body } = await getJson(`${base}/api/comments?page=doc.html`);
    const comment = body.comments.find((c) => c.id === agentCommentId);
    assert.equal(comment.status, 'open', 'comment restored to its pre-run state');
    assert.ok(!('resolution' in comment));
  });

  await t.test('an empty proposal is legal: it records the decision only', async () => {
    const res = await postJson(`${base}/api/propose-edits`, {
      page: 'doc.html', dryRun: false, commentId: agentCommentId,
      decisions: [{ id: agentCommentId, decision: 'declined', summary: 'Out of scope.' }],
      creator: 'agent', agentName: 'claude-code',
    });
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.deepEqual(run.edits, []);
    const { body } = await getJson(`${base}/api/comments?page=doc.html`);
    assert.equal(body.comments.find((c) => c.id === agentCommentId).status, 'declined');
  });

  await t.test('atomic writes leave no .tmp files behind', async () => {
    const entries = await fs.readdir(root);
    assert.ok(!entries.some((n) => n.includes('.tmp')), `leftovers: ${entries}`);
  });
});
