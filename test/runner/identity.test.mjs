// test/runner/identity.test.mjs — #41: signed link tokens.
//
// A token is a capability mapping to {name, role}, HMAC-signed with a
// per-root secret. Write endpoints stamp identity from a VERIFIED token
// instead of trusting the payload's self-declared creator/agentName; an
// invalid token is a 400 (a failed credential never degrades to the honor
// system); an absent token keeps today's behavior exactly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSecret, mintToken, verifyToken, ROLES, SECRET_FILENAME,
} from '../../runner/lib/identity.mjs';
import { startServer } from '../../runner/lib/server.mjs';

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo</p>\n</body></html>\n';

const postJson = (url, payload) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

// ---- the pure half ----------------------------------------------------------

test('mint/verify round-trips; tampered, truncated, and foreign tokens all fail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-id-'));
  const secret = await loadSecret(root);
  assert.equal(await loadSecret(root), secret, 'the secret persists — minted once');

  const token = mintToken({ name: 'Dana Reviewer', role: 'commenter' }, secret);
  assert.deepEqual(verifyToken(token, secret), { name: 'Dana Reviewer', role: 'commenter' });

  // Tampered payload, tampered mac, truncation, garbage, foreign secret.
  const [payload, mac] = token.split('.');
  const other = Buffer.from(JSON.stringify({ name: 'Mallory', role: 'commenter' })).toString('base64url');
  assert.equal(verifyToken(`${other}.${mac}`, secret), null, 'payload swap fails');
  assert.equal(verifyToken(`${payload}.${mac.slice(0, -4)}zzzz`, secret), null, 'mac tamper fails');
  assert.equal(verifyToken(token.slice(0, -10), secret), null, 'truncation fails');
  assert.equal(verifyToken('not-a-token', secret), null);
  assert.equal(verifyToken('', secret), null);
  assert.equal(verifyToken(token, 'a-different-secret-entirely-32ch'), null, 'foreign secret fails');

  assert.throws(() => mintToken({ name: 'x', role: 'admin' }, secret), /role/,
    'roles are a fixed set');
  assert.ok(ROLES.has('commenter'));
  await fs.rm(root, { recursive: true, force: true });
});

// ---- the wire half ----------------------------------------------------------

test('token-stamped writes (#41)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-id-http-'));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, 'doc.html'), DOC_HTML);
  const base = `http://127.0.0.1:${port}`;
  const secret = await loadSecret(root);
  const token = mintToken({ name: 'Dana', role: 'commenter' }, secret);

  let commentId = null;

  await t.test('a valid token stamps identity and ignores payload creator/agentName', async () => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html', body: 'too wordy',
      anchor: { blockId: 'r-0001', quote: 'alpha' },
      token,
      // The self-declared fields lie; the token wins.
      creator: 'agent', agentName: 'impostor',
    });
    assert.equal(res.status, 201);
    const c = await res.json();
    commentId = c.id;
    assert.equal(c.creator, 'human');
    assert.equal(c.author, 'Dana');
    assert.equal(c.role, 'commenter');
    assert.equal(c.agentName, undefined, 'the payload agentName never landed');
  });

  await t.test('reply and set-status stamp from the token too', async () => {
    const rep = await postJson(`${base}/api/comment/${commentId}/reply`, {
      page: 'doc.html', body: 'seconding this', token,
    });
    assert.equal(rep.status, 200);
    const reply = (await rep.json()).replies.at(-1);
    assert.equal(reply.author, 'Dana');
    assert.equal(reply.creator, 'human');

    const st = await postJson(`${base}/api/comment/${commentId}/status`, {
      page: 'doc.html', status: 'resolved', token,
    });
    assert.equal(st.status, 200, 'a token identity is human — resolved is allowed (#250)');
    assert.equal((await st.json()).statusUpdatedBy.author, 'Dana');
  });

  await t.test('an invalid token is a 400, never a silent downgrade', async () => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html', body: 'x', anchor: { blockId: 'r-0001', quote: 'alpha' },
      token: `${token}tampered`,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid token');
  });

  await t.test('no token keeps the honor system exactly as before', async () => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html', body: 'agent note', anchor: { blockId: 'r-0001', quote: 'alpha' },
      creator: 'agent', agentName: 'claude-code',
    });
    assert.equal(res.status, 201);
    const c = await res.json();
    assert.equal(c.creator, 'agent');
    assert.equal(c.agentName, 'claude-code');
    assert.equal(c.author, undefined);
  });

  await t.test('the secret is unreachable through the file server and the index', async () => {
    assert.equal((await fetch(`${base}/${SECRET_FILENAME}`)).status, 404,
      'dotfiles are refused by resolvePath');
    const dir = await (await fetch(`${base}/api/dir?path=.`)).json().catch(() => null);
    if (dir && Array.isArray(dir.entries)) {
      assert.ok(!dir.entries.some((e) => (e.name || '').includes('redline-secret')),
        'and the directory listing never names it');
    }
  });
});
