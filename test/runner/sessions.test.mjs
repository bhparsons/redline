// test/runner/sessions.test.mjs — #187: session presence.
//
// Done when: two sessions cannot claim the same page; the loser learns who
// holds it; a killed session's claim expires and the page becomes claimable
// again.
//
// Expiry is the half that matters and the half that is easy to fake, so it is
// tested twice: once against the registry with an injected clock (exact, and
// covers the sweep), and once over HTTP with a real one-second TTL (proves the
// endpoints actually reach the sweep rather than reporting a stale map).

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSessionRegistry, normalizeTtl, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS } from '../../runner/lib/sessions.mjs';
import { startServer } from '../../runner/lib/server.mjs';
import { createClient } from '../../runner/lib/api-client.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.REDLINE_OTEL_ENDPOINT;

const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha</p>\n</body></html>\n';

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-presence-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, 'other.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'k', endpoint: 'http://127.0.0.1:1/chat', timeoutMs: 500 },
    telemetry: { endpoint: null },
  }, null, 2));
  return dir;
}

const post = (url, payload) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

test('the presence registry: one claim per page, and every claim expires', async (t) => {
  await t.test('a second claim on a held page is refused, naming the holder', () => {
    const reg = createSessionRegistry();
    const first = reg.claim({ page: '/docs/a.html', agentName: 'claude-code', pid: 4242 });
    assert.equal(first.ok, true);
    const second = reg.claim({ page: '/docs/a.html', agentName: 'other-cli' });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'page-claimed');
    assert.equal(second.holder.agentName, 'claude-code');
    assert.equal(second.holder.pid, 4242);
    // The loser learns WHO, never the capability to evict them.
    assert.equal('sessionId' in second.holder, false);
  });

  await t.test('claims are per page, so one session can watch several documents', () => {
    const reg = createSessionRegistry();
    assert.equal(reg.claim({ page: '/docs/a.html', agentName: 'claude-code' }).ok, true);
    assert.equal(reg.claim({ page: '/docs/b.html', agentName: 'claude-code' }).ok, true);
    assert.equal(reg.size, 2);
  });

  await t.test('a page whose claim ran out is claimable again', () => {
    let clock = 1_000;
    const reg = createSessionRegistry({ now: () => clock, ttlMs: 10_000 });
    reg.claim({ page: '/docs/a.html', agentName: 'dead-session' });
    clock += 9_999;
    assert.equal(reg.claim({ page: '/docs/a.html', agentName: 'live' }).ok, false);
    clock += 1; // exactly at the TTL
    const retry = reg.claim({ page: '/docs/a.html', agentName: 'live' });
    assert.equal(retry.ok, true);
    assert.equal(reg.holderFor('/docs/a.html').agentName, 'live');
  });

  await t.test('a heartbeat pushes expiry out; without one the claim dies', () => {
    let clock = 0;
    const reg = createSessionRegistry({ now: () => clock, ttlMs: 10_000 });
    const { session } = reg.claim({ page: '/docs/a.html', agentName: 'w' });
    clock += 9_000;
    assert.equal(reg.heartbeat(session.sessionId).ok, true);
    clock += 9_000; // 18s in, but only 9s since the beat
    assert.equal(reg.holderFor('/docs/a.html')?.agentName, 'w');
    clock += 2_000;
    assert.equal(reg.holderFor('/docs/a.html'), null);
  });

  await t.test('a heartbeat after expiry says "expired", an invented id says "unknown"', () => {
    let clock = 0;
    const reg = createSessionRegistry({ now: () => clock, ttlMs: 1_000 });
    const { session } = reg.claim({ page: '/docs/a.html', agentName: 'w' });
    clock += 5_000;
    // The distinction survives an intervening sweep — a watcher must be told to
    // re-claim rather than that it is talking to the wrong runner.
    assert.equal(reg.holderFor('/docs/a.html'), null);
    assert.deepEqual(reg.heartbeat(session.sessionId), { ok: false, reason: 'expired' });
    assert.deepEqual(reg.heartbeat('s-nope'), { ok: false, reason: 'unknown-session' });
  });

  await t.test('release frees the page at once, and is refused twice over', () => {
    const reg = createSessionRegistry();
    const { session } = reg.claim({ page: '/docs/a.html', agentName: 'w' });
    assert.equal(reg.release(session.sessionId).ok, true);
    assert.equal(reg.holderFor('/docs/a.html'), null);
    assert.equal(reg.release(session.sessionId).ok, false);
    assert.equal(reg.claim({ page: '/docs/a.html', agentName: 'next' }).ok, true);
  });

  await t.test('markSeen stamps only the session that presents its own id (#235)', () => {
    const reg = createSessionRegistry();
    const { session } = reg.claim({ page: '/docs/a.html', agentName: 'watcher' });
    // The default is "no receipt": nothing has been seen yet.
    assert.equal(reg.describe(session).seenRev, null);
    // A caller with no capability (the author's poll passes none) never gets
    // this far — but even a WRONG id or a mismatched page is a no-op.
    assert.equal(reg.markSeen('s-nope', '/docs/a.html', 3), false);
    assert.equal(reg.markSeen(session.sessionId, '/docs/other.html', 3), false);
    assert.equal(reg.markSeen(session.sessionId, '/docs/a.html', 'x'), false);
    assert.equal(reg.describe(session).seenRev, null);
    // The holder presenting its own id on its own page advances the receipt.
    assert.equal(reg.markSeen(session.sessionId, '/docs/a.html', 7), true);
    assert.equal(reg.describe(session).seenRev, 7);
    // An expired session cannot be stamped — the receipt dies with the claim.
    reg.release(session.sessionId);
    assert.equal(reg.markSeen(session.sessionId, '/docs/a.html', 9), false);
  });

  await t.test('the runner never honours an unbounded or absurd TTL', () => {
    assert.equal(normalizeTtl(undefined), DEFAULT_TTL_MS);
    assert.equal(normalizeTtl(Number.POSITIVE_INFINITY), DEFAULT_TTL_MS);
    assert.equal(normalizeTtl(0), MIN_TTL_MS);
    assert.equal(normalizeTtl(-1), MIN_TTL_MS);
    assert.equal(normalizeTtl(9_999_999), MAX_TTL_MS);
    assert.equal(normalizeTtl(30_000), 30_000);
  });
});

test('presence over HTTP: claim, 409, heartbeat, release, and real expiry', async (t) => {
  const root = await makeRoot();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const claim = (payload) => post(`${base}/api/session/claim`, payload);
  const status = async (page = 'doc.html') => (await fetch(`${base}/api/status?page=${page}`)).json();
  const info = async () => (await fetch(`${base}/api/info`)).json();

  let sessionId = null;

  await t.test('no session is the default, and /api/status says so without complaint', async () => {
    assert.equal((await status()).session, null);
    assert.deepEqual((await info()).sessions, []);
  });

  await t.test('a claim returns a sessionId and its expiry', async () => {
    const res = await claim({ page: 'doc.html', agentName: 'claude-code', pid: process.pid });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.sessionId, /^s-[0-9a-f]{16}$/);
    assert.equal(body.page, 'doc.html'); // root-relative, not the absolute key
    assert.equal(body.agentName, 'claude-code');
    assert.equal(body.pid, process.pid);
    assert.equal(body.ttlMs, 60_000);
    assert.ok(body.expiresAt > Date.now());
    sessionId = body.sessionId;
  });

  await t.test('a second session is refused 409 and told who has it', async () => {
    const res = await claim({ page: 'doc.html', agentName: 'other-cli' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.reason, 'page-claimed');
    assert.equal(body.holder.agentName, 'claude-code');
    assert.match(body.error, /claude-code is already watching/);
    assert.equal('sessionId' in body.holder, false);
  });

  await t.test('a different page under the same runner is still free', async () => {
    const res = await claim({ page: 'other.html', agentName: 'other-cli' });
    assert.equal(res.status, 200);
    const other = await res.json();
    assert.equal(other.page, 'other.html');
    await post(`${base}/api/session/release`, { sessionId: other.sessionId });
  });

  await t.test('/api/status and /api/info report the watcher, sessionId withheld', async () => {
    const s = await status();
    assert.equal(s.session.agentName, 'claude-code');
    assert.equal('sessionId' in s.session, false);
    const pages = (await info()).sessions.map((x) => x.page);
    assert.deepEqual(pages, ['doc.html']);
  });

  await t.test('a heartbeat extends the claim', async () => {
    const before = (await status()).session.expiresAt;
    await sleep(15);
    const res = await post(`${base}/api/session/heartbeat`, { sessionId });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).expiresAt > before);
  });

  await t.test('a heartbeat for an unknown session is a 404, not a conflict', async () => {
    const res = await post(`${base}/api/session/heartbeat`, { sessionId: 's-deadbeefdeadbeef' });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).reason, 'unknown-session');
  });

  await t.test('release frees the page for the next session', async () => {
    const res = await post(`${base}/api/session/release`, { sessionId });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).released, true);
    assert.equal((await status()).session, null);
    const next = await claim({ page: 'doc.html', agentName: 'other-cli' });
    assert.equal(next.status, 200);
    await post(`${base}/api/session/release`, { sessionId: (await next.json()).sessionId });
  });

  await t.test('a claim that stops beating expires and the page is claimable again', async () => {
    const dead = await (await claim({ page: 'doc.html', agentName: 'crashed', ttlMs: 1_000 })).json();
    assert.equal(dead.ttlMs, 1_000);
    assert.equal((await status()).session.agentName, 'crashed');
    await sleep(1_100); // no heartbeat: the session is gone, not slow
    assert.equal((await status()).session, null);
    const res = await claim({ page: 'doc.html', agentName: 'claude-code' });
    assert.equal(res.status, 200);
    // And the dead session's own heartbeat now tells it to re-claim.
    const beat = await post(`${base}/api/session/heartbeat`, { sessionId: dead.sessionId });
    assert.equal(beat.status, 404);
    assert.equal((await beat.json()).reason, 'expired');
    await post(`${base}/api/session/release`, { sessionId: (await res.json()).sessionId });
  });

  await t.test('validation: unknown page, bad agentName, bad pid, missing sessionId', async () => {
    assert.equal((await claim({ page: 'nope.html', agentName: 'a' })).status, 404);
    assert.equal((await claim({ page: 'doc.html', agentName: 'has spaces' })).status, 400);
    assert.equal((await claim({ page: 'doc.html' })).status, 400);
    assert.equal((await claim({ page: 'doc.html', agentName: 'a', pid: 'x' })).status, 400);
    assert.equal((await claim({ page: 'doc.html', agentName: 'a', ttlMs: 'soon' })).status, 400);
    assert.equal((await post(`${base}/api/session/release`, {})).status, 400);
  });

  await t.test('GET on a session endpoint is 405', async () => {
    assert.equal((await fetch(`${base}/api/session/claim`)).status, 405);
  });

  await t.test('the read receipt tracks the WATCHER, never the author (#235)', async () => {
    const watcher = await (await claim({ page: 'doc.html', agentName: 'watcher' })).json();
    const rev = (await status()).rev;
    assert.equal((await status()).session.seenRev, null); // nothing seen yet

    // The author's overlay poll carries no sessionId. It must NOT mark the
    // watcher caught up — that false positive was the whole defect.
    await fetch(`${base}/api/comments?page=doc.html`);
    assert.equal((await status()).session.seenRev, null);

    // The watcher's poll presents its capability and advances the receipt to
    // the current rev, which /api/status then reports for the author to see.
    await fetch(`${base}/api/comments?page=doc.html&sessionId=${watcher.sessionId}`);
    assert.equal((await status()).session.seenRev, rev);

    // A stranger's id (not the holder of this page) is a no-op too.
    await fetch(`${base}/api/comments?page=doc.html&sessionId=s-deadbeefdeadbeef`);
    assert.equal((await status()).session.seenRev, rev);

    await post(`${base}/api/session/release`, { sessionId: watcher.sessionId });
  });

  await t.test('the shared client speaks all three verbs (MCP and CLI cannot drift)', async () => {
    const client = createClient(base);
    const claimed = await client.claimSession({ page: 'doc.html', agentName: 'via-client' });
    assert.equal(claimed.agentName, 'via-client');
    assert.ok((await client.heartbeatSession(claimed.sessionId)).expiresAt >= claimed.expiresAt);
    assert.equal((await client.releaseSession(claimed.sessionId)).released, true);
    await assert.rejects(() => client.heartbeatSession(claimed.sessionId), (err) => err.status === 404);
  });
});
