// test/runner/hold-mode.test.mjs — #190: hold mode, the runner half.
//
// A watcher that acts within seconds is wrong when you are reading a section
// and want to leave four comments that belong together: actioned one at a time,
// the agent makes four disconnected edits and may undo its own earlier
// reasoning. Hold lets you think, then hand the set over.
//
// The two rules that shape everything here:
//
//   - hold gates INTAKE only (decision 15). Anything released before it went on
//     is already in the agent's hands, and there is no stop-what-you-are-doing
//     control. So the count means "held back since hold went on", never "not
//     yet done".
//   - the runner EXPOSES hold and does not enforce it. A human pressing Send
//     All means it; hold is a signal to the watcher, and the watcher is what
//     stops.
//
// The overlay control is extension-owned and is not tested here.

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
  + '<p data-rev="r-0001">alpha</p>\n<p data-rev="r-0002">bravo</p>\n</body></html>\n';

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-hold-'));
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

test('hold queues new comments, survives a reload, and hands the batch over', async (t) => {
  const root = await makeRoot();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const sidecar = async () => JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
  const hold = (on, extra = {}) => post(`${base}/api/hold`, { page: 'doc.html', hold: on, ...extra });
  const status = async () => (await (await fetch(`${base}/api/status?page=doc.html`)).json());
  const comment = (body, extra = {}) => post(`${base}/api/comment`, {
    page: 'doc.html', body, anchor: { quote: 'alpha', blockId: 'r-0001' }, ...extra,
  });

  let before = null;

  await t.test('off is the default, and says so without anything stored', async () => {
    const s = await status();
    assert.deepEqual(s.hold, {
      on: false, since: null, heldCount: 0, heldCommentIds: [], lastRelease: null,
    });
  });

  await t.test('a comment made BEFORE hold is not held back', async () => {
    before = await (await comment('this one is already in flight')).json();
    const res = await hold(true, { creator: 'human' });
    assert.equal(res.status, 200);
    const view = await res.json();
    assert.equal(view.on, true);
    assert.ok(view.since);
    // Decision 15: hold gates intake. The earlier comment is the agent's
    // already, and calling it "held" would promise a brake hold does not have.
    assert.equal(view.heldCount, 0);
    assert.deepEqual(view.heldCommentIds, []);
  });

  await t.test('comments made after it pile up as a counted batch', async () => {
    const a = await (await comment('first of a set')).json();
    const b = await (await comment('second of a set')).json();
    const view = (await status()).hold;
    assert.equal(view.heldCount, 2);
    assert.deepEqual(view.heldCommentIds, [a.id, b.id]);
  });

  await t.test('a NOTE is not counted — it was never going to be actioned', async () => {
    await comment('just an observation', { aiEdits: false });
    assert.equal((await status()).hold.heldCount, 2, 'still the two edit requests');
  });

  await t.test('turning hold on again does not reset the count', async () => {
    const view = await (await hold(true)).json();
    assert.equal(view.heldCount, 2, '`since` did not move');
  });

  await t.test('it lives in the sidecar, so it survives a reload', async () => {
    const data = await sidecar();
    assert.equal(data.hold.on, true);
    assert.equal(typeof data.hold.since, 'string');
    assert.deepEqual(data.hold.by.creator, 'human');
  });

  await t.test('setting it bumps rev, so watchers learn from the existing stream', async () => {
    const revBefore = (await sidecar()).rev;
    await hold(false);
    const revAfter = (await sidecar()).rev;
    assert.ok(revAfter > revBefore, 'a rev bump is what every client already listens for');
  });

  await t.test('release names the whole set, in the sidecar, not just to the caller', async () => {
    // A watcher that learns of the release from a rev bump — rather than from
    // the response to its own call — still has to find out WHICH comments were
    // handed over. State, not a delta.
    const view = (await status()).hold;
    assert.equal(view.on, false);
    assert.equal(view.since, null);
    assert.equal(view.heldCount, 0);
    assert.equal(view.lastRelease.commentIds.length, 2);
    assert.ok(view.lastRelease.at);
    assert.ok(view.lastRelease.heldSince);
  });

  await t.test('releasing when nothing is held is harmless', async () => {
    const view = await (await hold(false)).json();
    assert.equal(view.on, false);
    assert.equal(view.heldCount, 0);
  });

  await t.test('the runner exposes hold and does not enforce it', async () => {
    // The rule lives in the watcher, on purpose: the human pressing Send All
    // means it, and a rule in two places is a rule that drifts. A run started
    // while hold is on is refused for reasons of its own (no API key here), not
    // by hold.
    await hold(true);
    const res = await post(`${base}/api/run`, { page: 'doc.html', commentId: before.id });
    assert.notEqual(res.status, 409, 'hold is not a lock');
    const body = await res.json();
    assert.equal(body.error === 'the page is busy', false);
    await hold(false);
  });

  await t.test('validation: unknown page, missing flag, wrong method', async () => {
    assert.equal((await post(`${base}/api/hold`, { page: 'nope.html', hold: true })).status, 404);
    assert.equal((await post(`${base}/api/hold`, { page: 'doc.html' })).status, 400);
    assert.equal((await post(`${base}/api/hold`, { page: 'doc.html', hold: 'yes' })).status, 400);
    assert.equal((await fetch(`${base}/api/hold`)).status, 405);
  });
});
