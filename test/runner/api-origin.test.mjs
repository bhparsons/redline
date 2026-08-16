// test/runner/api-origin.test.mjs — #33: Origin/Host/content-type gate on /api/*.
//
// The runner binds loopback, but that alone does not stop cross-site
// no-preflight POSTs or DNS-rebinding requests. Every /api request must carry
// a loopback Host; a present Origin must be loopback or a chrome-extension;
// POSTs must declare application/json. Unit tests hit requestGateError
// directly; the e2e tests drive a real server over HTTP.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestGateError } from '../../runner/lib/api.mjs';
import { startServer } from '../../runner/lib/server.mjs';

// null = omit that header entirely (undefined would fall back to the default).
const req = ({ method = 'POST', host = '127.0.0.1:5175', origin, contentType = 'application/json' } = {}) => ({
  method,
  headers: {
    ...(host === null ? {} : { host }),
    ...(origin === undefined ? {} : { origin }),
    ...(contentType === null || contentType === undefined ? {} : { 'content-type': contentType }),
  },
});

test('requestGateError allows loopback hosts, no-Origin clients, and extension origins', () => {
  assert.equal(requestGateError(req()), null);
  assert.equal(requestGateError(req({ host: 'localhost:5175' })), null);
  assert.equal(requestGateError(req({ host: '127.0.0.1' })), null);
  assert.equal(requestGateError(req({ origin: 'http://127.0.0.1:5175' })), null);
  assert.equal(requestGateError(req({ origin: 'http://localhost:9999' })), null);
  assert.equal(requestGateError(req({ origin: 'chrome-extension://abcdefghijklmnop' })), null);
  assert.equal(requestGateError(req({ method: 'GET', contentType: null })), null);
});

test('requestGateError rejects non-loopback Hosts (DNS rebinding)', () => {
  for (const host of ['evil.example:5175', 'evil.example', '127.0.0.1.evil.example', '', null]) {
    const verdict = requestGateError(req({ host }));
    assert.equal(verdict?.status, 403, `host ${host} must be rejected`);
  }
});

test('requestGateError rejects cross-site and null Origins', () => {
  for (const origin of ['http://evil.example', 'https://evil.example:5175', 'null', 'file://', 'garbage']) {
    const verdict = requestGateError(req({ origin }));
    assert.equal(verdict?.status, 403, `origin ${origin} must be rejected`);
  }
});

test('requestGateError rejects POSTs without application/json', () => {
  for (const contentType of [null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const verdict = requestGateError(req({ contentType }));
    assert.equal(verdict?.status, 415, `content-type ${contentType} must be rejected`);
  }
  // Parameters after the type are fine.
  assert.equal(requestGateError(req({ contentType: 'application/json; charset=utf-8' })), null);
  // GETs carry no body — no content-type requirement.
  assert.equal(requestGateError(req({ method: 'GET', contentType: 'text/plain' })), null);
});

test('gate e2e: hostile requests are refused, legitimate ones pass', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-origin-'));
  await fs.writeFile(path.join(root, 'doc.html'), '<body>\n<p data-rev="r-0001">x</p>\n</body>\n');
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const payload = JSON.stringify({ page: 'doc.html', body: 'hi', anchor: { blockId: 'r-0001', quote: 'x' } });

  await t.test('cross-site Origin POST → 403, nothing written', async () => {
    const res = await fetch(`${base}/api/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: payload,
    });
    assert.equal(res.status, 403);
    await assert.rejects(fs.stat(path.join(root, 'doc.html.review.json')));
  });

  await t.test('no-preflight content-type POST → 415', async () => {
    const res = await fetch(`${base}/api/comment`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: payload,
    });
    assert.equal(res.status, 415);
  });

  await t.test('rebound Host → 403 even on GET', async () => {
    // fetch/undici refuses to override Host, so speak raw HTTP for this one.
    const status = await new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/comments?page=doc.html',
        headers: { host: 'evil.example' },
      }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(status, 403);
  });

  await t.test('legitimate extension-style POST → 201', async () => {
    const res = await fetch(`${base}/api/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnop' },
      body: payload,
    });
    assert.equal(res.status, 201);
  });

  await t.test('legitimate no-Origin CLI-style POST → 201', async () => {
    const res = await fetch(`${base}/api/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(res.status, 201);
  });
});
