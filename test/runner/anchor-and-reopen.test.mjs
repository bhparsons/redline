// test/runner/anchor-and-reopen.test.mjs — R-006 and R-007 from the testing
// session's log, both about a review record that says something untrue.
//
// R-006: a comment quoting text an edit rewrote points at nothing, and nothing
//        said so — the highlight lands in the wrong place and status changes
//        are accepted without complaint.
// R-007: a reopened comment kept the resolution that had closed it, so the
//        record read "open" and "resolved by run X" at the same time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">the numbers now clear every bar we set in January</p>\n'
  + '<p data-rev="r-0002">the remainder stays in the budget as contingency</p>\n'
  + '</body></html>\n';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-anchor-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ telemetry: { endpoint: null } }));
  const server = await startServer({ root: dir, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => { await server.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return {
    base,
    post: (route, payload) => fetch(base + route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }).then((r) => r.json()),
    list: () => fetch(`${base}/api/comments?page=doc.html`).then((r) => r.json()),
  };
}

test('an anchor whose quote an edit rewrote is flagged orphaned', async (t) => {
  const f = await fixture(t);
  const c = await f.post('/api/comment', {
    page: 'doc.html',
    body: 'is "now" doing any work here?',
    anchor: { quote: 'the numbers now clear every bar', blockId: 'r-0001' },
  });

  const before = await f.list();
  assert.equal(before.comments.find((x) => x.id === c.id).orphaned, undefined, 'intact anchors carry no flag');

  // Exactly the live example from the log: run-841b95a34a02 removed "now".
  await f.post('/api/edit', {
    page: 'doc.html', blockId: 'r-0001',
    newInner: 'the numbers clear every bar we set in January', creator: 'human',
  });

  const after = await f.list();
  assert.equal(after.comments.find((x) => x.id === c.id).orphaned, true,
    'the quote no longer exists in the block it names');
});

test('an untouched comment on an edited page is not swept up with it', async (t) => {
  const f = await fixture(t);
  const stale = await f.post('/api/comment', {
    page: 'doc.html', body: 'rewrite this', anchor: { quote: 'the remainder stays', blockId: 'r-0002' },
  });
  const fine = await f.post('/api/comment', {
    page: 'doc.html', body: 'this one is fine', anchor: { quote: 'clear every bar', blockId: 'r-0001' },
  });

  await f.post('/api/edit', {
    page: 'doc.html', blockId: 'r-0002', newInner: 'whatever is left is contingency', creator: 'human',
  });

  const { comments } = await f.list();
  assert.equal(comments.find((x) => x.id === stale.id).orphaned, true);
  assert.equal(comments.find((x) => x.id === fine.id).orphaned, undefined,
    'a comment on a different block is untouched');
});

test('markup and entities do not read as an orphan', async (t) => {
  const f = await fixture(t);
  const c = await f.post('/api/comment', {
    page: 'doc.html', body: 'fine', anchor: { quote: 'clear every bar we set', blockId: 'r-0001' },
  });
  // Same words, now with inline markup and an encoded entity around them.
  await f.post('/api/edit', {
    page: 'doc.html', blockId: 'r-0001',
    newInner: 'the numbers now <em>clear every bar</em> we set in January &amp; February',
    creator: 'human',
  });
  const { comments } = await f.list();
  assert.equal(comments.find((x) => x.id === c.id).orphaned, undefined,
    'stripping tags and collapsing whitespace must not invent an orphan');
});

test('reopening a comment drops the resolution that closed it (R-007)', async (t) => {
  const f = await fixture(t);
  const c = await f.post('/api/comment', {
    page: 'doc.html', body: 'tighten this', anchor: { quote: 'clear every bar', blockId: 'r-0001' },
  });

  const run = await f.post('/api/propose-edits', {
    page: 'doc.html',
    commentId: c.id,
    edits: [{ blockId: 'r-0001', newInner: 'the numbers clear every bar' }],
    decisions: [{ id: c.id, decision: 'addressed', summary: 'tightened' }],
    dryRun: false,
    creator: 'agent', agentName: 'test-agent',
  });
  assert.ok(run.runId);

  const closed = (await f.list()).comments.find((x) => x.id === c.id);
  assert.equal(closed.status, 'addressed');
  assert.ok(closed.resolution, 'it was resolved by a run');

  await f.post(`/api/comment/${encodeURIComponent(c.id)}/status`, { page: 'doc.html', status: 'open' });

  const reopened = (await f.list()).comments.find((x) => x.id === c.id);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.resolution, undefined,
    'an open comment must not also claim to be resolved');

  // The history is not lost — the run still names what it decided.
  const { runs } = await f.list();
  const record = runs.find((r) => r.runId === run.runId);
  assert.ok(record.decisions.some((d) => d.id === c.id), 'the run log still says what was tried');
});
