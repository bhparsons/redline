// test/runner/lease-http.test.mjs — #188: holdable block leases over HTTP.
//
// Done when: a session holds blocks across several HTTP calls; an overlapping
// acquire is refused with the right reason; an abandoned lease expires;
// force-release works and is recorded.
//
// The two properties worth stating plainly, because both are load-bearing under
// first-holder-wins (decision 5, the human waits rather than preempting):
//
//   - every held lease expires, so a crashed session cannot lock a paragraph
//     out of its author's own document;
//   - force-release lands in runs[], so a session whose lease was yanked can
//     find out why its next write failed instead of guessing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../../runner/lib/server.mjs';
import { createClient } from '../../runner/lib/api-client.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import {
  createRunRegistry, HOLD_LANE, normalizeLeaseTtl,
  LEASE_DEFAULT_TTL_MS, LEASE_MIN_TTL_MS, LEASE_MAX_TTL_MS,
} from '../../runner/lib/leases.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.REDLINE_OTEL_ENDPOINT;

const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha</p>\n<p data-rev="r-0002">bravo</p>\n'
  + '<p data-rev="r-0003">charlie</p>\n</body></html>\n';

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-leasehttp-'));
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
const del = (url) => fetch(url, { method: 'DELETE' });

test('the ledger holds TTL leases without changing how runs behave', async (t) => {
  await t.test('a run still never expires — only a held lease does', () => {
    let clock = 0;
    const reg = createRunRegistry({ now: () => clock });
    reg.acquire({ runId: 'run-1', page: '/a.html', blocks: ['r-1'], lane: 'standard' });
    clock += 10 * 60 * 1000;
    // A slow model must not cost a run the blocks it is mid-write on.
    assert.equal(reg.blockAvailable('/a.html', 'r-1').ok, false);
    assert.equal(reg.size, 1);
  });

  await t.test('an abandoned lease expires and its blocks come back', () => {
    let clock = 0;
    const reg = createRunRegistry({ now: () => clock });
    reg.acquire({
      runId: 'lease-1', page: '/a.html', blocks: ['r-1'], lane: HOLD_LANE,
      ttlMs: 30_000, holder: 's-abc',
    });
    clock += 29_999;
    assert.equal(reg.blockAvailable('/a.html', 'r-1').ok, false);
    clock += 1;
    assert.equal(reg.blockAvailable('/a.html', 'r-1').ok, true);
    assert.equal(reg.size, 0, 'the sweep removed it, not just hid it');
  });

  await t.test('renew pushes expiry out; extend still widens the block set', () => {
    let clock = 0;
    const reg = createRunRegistry({ now: () => clock });
    reg.acquire({
      runId: 'lease-1', page: '/a.html', blocks: ['r-1'], lane: HOLD_LANE,
      ttlMs: 10_000, holder: 's-abc',
    });
    clock += 9_000;
    assert.equal(reg.renew('lease-1').ok, true);
    clock += 9_000;
    assert.equal(reg.blockAvailable('/a.html', 'r-1').ok, false, 'still held');
    assert.equal(reg.extend('lease-1', ['r-2']).ok, true);
    assert.equal(reg.blockAvailable('/a.html', 'r-2').ok, false, 'widened, not just renewed');
    assert.equal(reg.renew('lease-gone').ok, false);
  });

  await t.test('heldBy finds a session\'s leases and nothing else', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'l-1', page: '/a.html', blocks: ['r-1'], lane: HOLD_LANE, ttlMs: 30_000, holder: 's-1' });
    reg.acquire({ runId: 'l-2', page: '/b.html', blocks: ['r-9'], lane: HOLD_LANE, ttlMs: 30_000, holder: 's-1' });
    reg.acquire({ runId: 'l-3', page: '/a.html', blocks: ['r-2'], lane: HOLD_LANE, ttlMs: 30_000, holder: 's-2' });
    reg.acquire({ runId: 'run-1', page: '/a.html', blocks: ['r-3'], lane: 'standard' });
    assert.deepEqual(reg.heldBy('s-1').map((l) => l.runId), ['l-1', 'l-2']);
    assert.deepEqual(reg.heldBy(null).map((l) => l.runId), [], 'a run has no holder to match');
  });

  await t.test('a requested TTL is clamped, never taken on trust', () => {
    assert.equal(normalizeLeaseTtl(undefined), LEASE_DEFAULT_TTL_MS);
    assert.equal(normalizeLeaseTtl(0), LEASE_MIN_TTL_MS);
    assert.equal(normalizeLeaseTtl(60 * 60 * 1000), LEASE_MAX_TTL_MS);
    assert.equal(normalizeLeaseTtl(5_000), 5_000);
  });
});

test('holding blocks over HTTP: acquire, refuse, renew, release, expire, force', async (t) => {
  const root = await makeRoot();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const sidecar = async () => JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
  const lease = (payload) => post(`${base}/api/lease`, { page: 'doc.html', ...payload });
  const status = async () => (await fetch(`${base}/api/status?page=doc.html`)).json();
  const edit = (payload) => post(`${base}/api/edit`, { page: 'doc.html', ...payload });

  await t.test('a session holds a block across several calls', async () => {
    const res = await lease({ blocks: ['r-0001'], sessionId: 's-one' });
    assert.equal(res.status, 200);
    const held = await res.json();
    assert.match(held.leaseId, /^lease-/);
    assert.deepEqual(held.blocks, ['r-0001']);
    assert.equal(held.sessionId, 's-one');
    assert.equal(held.ttlMs, 30_000);

    // The whole point: it is still held on the NEXT request, not released in a
    // finally the way a run's lease is.
    const s = await status();
    assert.equal(s.leases['r-0001'], held.leaseId);
    const mine = s.runs.find((r) => r.runId === held.leaseId);
    assert.equal(mine.lane, 'session-hold');
    assert.equal(mine.holder, 's-one');
    assert.ok(mine.expiresAt > Date.now());

    const renewed = await post(`${base}/api/lease/renew`, { leaseId: held.leaseId });
    assert.equal(renewed.status, 200);
    assert.ok((await renewed.json()).expiresAt >= held.expiresAt);
  });

  await t.test('an overlapping acquire is refused in the EXISTING vocabulary', async () => {
    const res = await lease({ blocks: ['r-0001', 'r-0002'], sessionId: 's-two' });
    assert.equal(res.status, 409);
    const body = await res.json();
    // #38's vocabulary, not a second one invented for leases.
    assert.equal(body.reason, 'blocks-leased');
    assert.deepEqual(body.blocks, ['r-0001'], 'names WHICH block is contended');
    assert.ok(body.runId, 'and who holds it');
  });

  await t.test('a disjoint block is free — that is the whole disjointness rule', async () => {
    const res = await lease({ blocks: ['r-0003'], sessionId: 's-two' });
    assert.equal(res.status, 200);
    const other = await res.json();
    await del(`${base}/api/lease/${other.leaseId}?sessionId=s-two`);
  });

  await t.test('a held block gates writes; an unheld one still goes through', async () => {
    const blocked = await edit({ blockId: 'r-0001', newInner: 'from someone else' });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).reason, 'blocks-leased');
    const free = await edit({ blockId: 'r-0002', newInner: 'BRAVO' });
    assert.equal(free.status, 200);
  });

  await t.test('the holder gives it back; a stranger is told to use force', async () => {
    const held = await (await lease({ blocks: ['r-0003'], sessionId: 's-one' })).json();
    const stranger = await del(`${base}/api/lease/${held.leaseId}?sessionId=s-nope`);
    assert.equal(stranger.status, 403);
    assert.equal((await stranger.json()).reason, 'not-your-lease');
    const mine = await del(`${base}/api/lease/${held.leaseId}?sessionId=s-one`);
    assert.equal(mine.status, 200);
    assert.equal((await mine.json()).forced, false);
    assert.equal((await status()).leases['r-0003'], undefined);
  });

  await t.test('force-release yanks a lease AND lands in the run log', async () => {
    const held = await (await lease({ blocks: ['r-0003'], sessionId: 's-two' })).json();
    const res = await del(`${base}/api/lease/${held.leaseId}?force=1&creator=human`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.forced, true);
    assert.equal((await status()).leases['r-0003'], undefined);

    const record = (await sidecar()).runs.find((r) => r.runId === body.runId);
    assert.equal(record.status, 'force-released');
    assert.equal(record.lane, 'lease-force-release');
    assert.equal(record.releasedLeases[0].leaseId, held.leaseId);
    assert.equal(record.releasedLeases[0].sessionId, 's-two');
    assert.deepEqual(record.releasedLeases[0].blocks, ['r-0003']);
    assert.deepEqual(record.actor, { creator: 'human' });
  });

  await t.test('undo waits on ANY held lease, because it restores the whole page', async () => {
    // s-one still holds r-0001 from the first case. Undo cannot be scoped to
    // blocks the way an edit can — it writes the document back wholesale — so
    // one held paragraph is enough to make it wait.
    const res = await post(`${base}/api/undo`, { page: 'doc.html' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, 'run-active');
  });

  await t.test('a force-release record is undo-inert — undo reaches past it', async () => {
    await del(`${base}/api/lease?page=doc.html&force=1`);
    // r-0002 was edited above and that run is undoable. The force-release
    // record sits on top of it and must be walked past, not tripped over.
    const res = await post(`${base}/api/undo`, { page: 'doc.html' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).lane, 'direct-edit');
    assert.match(await fs.readFile(docPath, 'utf8'), /<p data-rev="r-0002">bravo<\/p>/);
  });

  await t.test('a lease that stops renewing expires and the block comes back', async () => {
    const dying = await (await lease({ blocks: ['r-0003'], sessionId: 's-crashed', ttlMs: 1_000 })).json();
    assert.equal(dying.ttlMs, 1_000);
    assert.equal((await status()).leases['r-0003'], dying.leaseId);
    await sleep(1_100);
    assert.equal((await status()).leases['r-0003'], undefined);
    // And it cannot be renewed back to life: those blocks may be someone else's
    // by now, and re-admitting without re-checking is how two writers meet.
    const renewed = await post(`${base}/api/lease/renew`, { leaseId: dying.leaseId });
    assert.equal(renewed.status, 404);
    assert.equal((await renewed.json()).reason, 'unknown-lease');
    assert.equal((await lease({ blocks: ['r-0003'], sessionId: 's-next' })).status, 200);
  });

  await t.test('the page-level break-all clears every hold and records once', async () => {
    await lease({ blocks: ['r-0001'], sessionId: 's-a' });
    await lease({ blocks: ['r-0002'], sessionId: 's-b' });
    const res = await del(`${base}/api/lease?page=doc.html&force=1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.released.length, 3, 'every hold on the page, across sessions');
    assert.deepEqual((await status()).leases, {});
    const record = (await sidecar()).runs.find((r) => r.runId === body.runId);
    assert.equal(record.releasedLeases.length, body.released.length);
  });

  await t.test('a run\'s lease is NOT force-releasable — only held leases are', async () => {
    // Force-release exists so a human can take back a paragraph an agent is
    // sitting on. Yanking a RUN's lease would leave it writing outside its
    // lease, which is the one thing the ledger exists to prevent.
    const res = await del(`${base}/api/lease/run-does-not-exist?force=1`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).reason, 'unknown-lease');
  });

  await t.test('releasing a session drops the leases it held', async () => {
    const claim = await (await post(`${base}/api/session/claim`, {
      page: 'doc.html', agentName: 'claude-code',
    })).json();
    const held = await (await lease({ blocks: ['r-0001'], sessionId: claim.sessionId })).json();
    assert.equal((await status()).leases['r-0001'], held.leaseId);
    const released = await (await post(`${base}/api/session/release`, {
      sessionId: claim.sessionId,
    })).json();
    assert.deepEqual(released.leasesReleased, [held.leaseId]);
    assert.deepEqual((await status()).leases, {});
  });

  await t.test('validation: unknown page, empty blocks, bad ids, missing sessionId', async () => {
    assert.equal((await post(`${base}/api/lease`, { page: 'nope.html', blocks: ['r-0001'], sessionId: 's' })).status, 404);
    assert.equal((await lease({ blocks: [], sessionId: 's' })).status, 400);
    // An empty block set must NOT read as "the whole page" the way a run's
    // unknown reach does — that would take the document out of its author's
    // hands on a typo.
    assert.equal((await lease({ sessionId: 's' })).status, 400);
    assert.equal((await lease({ blocks: ['bad id!'], sessionId: 's' })).status, 400);
    assert.equal((await lease({ blocks: ['r-0001'] })).status, 400);
    assert.equal((await lease({ blocks: ['r-0001'], sessionId: 's', ttlMs: 'soon' })).status, 400);
    assert.equal((await post(`${base}/api/lease/renew`, {})).status, 400);
    assert.equal((await del(`${base}/api/lease`)).status, 400);
    assert.equal((await fetch(`${base}/api/lease`)).status, 405);
  });

  // ---- #231: a write NAMES the lease it holds ------------------------------

  await t.test('lease -> write-with-leaseId -> release: the happy path has no gap', async () => {
    const held = await (await lease({ blocks: ['r-0003'], sessionId: 's-writer' })).json();
    // The write carries the held leaseId and goes through WHILE the hold lives.
    const res = await edit({ blockId: 'r-0003', newInner: 'CHARLIE, held', leaseId: held.leaseId });
    assert.equal(res.status, 200);
    // The hold is still ours after the write — release is the caller's last move.
    const released = await del(`${base}/api/lease/${held.leaseId}?sessionId=s-writer`);
    assert.equal(released.status, 200);
  });

  await t.test("a stranger's lease still refuses, leaseId or not", async () => {
    const held = await (await lease({ blocks: ['r-0003'], sessionId: 's-holder' })).json();
    // No leaseId: refused as ever.
    const bare = await edit({ blockId: 'r-0003', newInner: 'x' });
    assert.equal(bare.status, 409);
    assert.equal((await bare.json()).reason, 'blocks-leased');
    // A DIFFERENT (valid but non-covering) leaseId exempts nothing.
    const mine = await (await lease({ blocks: ['r-0002'], sessionId: 's-me' })).json();
    const wrong = await edit({ blockId: 'r-0003', newInner: 'x', leaseId: mine.leaseId });
    assert.equal(wrong.status, 409, 'a lease that does not cover the block is as good as none');
    assert.equal((await wrong.json()).reason, 'blocks-leased');
    await del(`${base}/api/lease/${held.leaseId}?sessionId=s-holder`);
    await del(`${base}/api/lease/${mine.leaseId}?sessionId=s-me`);
  });

  await t.test('a stale or garbage leaseId is ignored, never an escalation', async () => {
    const held = await (await lease({ blocks: ['r-0003'], sessionId: 's-brief', ttlMs: 1000 })).json();
    await del(`${base}/api/lease/${held.leaseId}?sessionId=s-brief`);
    // The lease is gone; naming it neither helps nor hurts — the block is
    // free, so the write proceeds on its own merits.
    const stale = await edit({ blockId: 'r-0003', newInner: 'CHARLIE, stale id', leaseId: held.leaseId });
    assert.equal(stale.status, 200);
    const garbage = await edit({ blockId: 'r-0003', newInner: 'CHARLIE, garbage id', leaseId: 'lease-nope' });
    assert.equal(garbage.status, 200);
  });

  await t.test('propose-edits takes the same exemption', async () => {
    const held = await (await lease({ blocks: ['r-0003'], sessionId: 's-prop' })).json();
    const refused = await post(`${base}/api/propose-edits`, {
      page: 'doc.html', dryRun: false,
      edits: [{ blockId: 'r-0003', newInner: 'via proposal, no lease named' }],
    });
    assert.equal(refused.status, 409, 'unnamed, the hold refuses even its holder');
    const named = await post(`${base}/api/propose-edits`, {
      page: 'doc.html', dryRun: false, leaseId: held.leaseId,
      edits: [{ blockId: 'r-0003', newInner: 'via proposal, under the lease' }],
    });
    assert.equal(named.status, 200);
    await del(`${base}/api/lease/${held.leaseId}?sessionId=s-prop`);
  });

  await t.test('the shared client speaks all three verbs', async () => {
    const client = createClient(base);
    const held = await client.acquireLease({ page: 'doc.html', blocks: ['r-0002'], sessionId: 's-client' });
    assert.deepEqual(held.blocks, ['r-0002']);
    assert.ok((await client.renewLease({ leaseId: held.leaseId })).expiresAt >= held.expiresAt);
    assert.equal((await client.releaseLease(held.leaseId, { sessionId: 's-client' })).ok, true);
    await assert.rejects(
      () => client.renewLease({ leaseId: held.leaseId }),
      (err) => err.status === 404,
    );
  });
});
