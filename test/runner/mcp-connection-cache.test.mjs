// test/runner/mcp-connection-cache.test.mjs — the MCP server's per-directory
// connection cache must not outlive the runner it points at.
//
// Found live (Blake, 2026-08-17): redline_instrument auto-started a runner on an
// ephemeral port, that runner was replaced by one on a scannable port, and every
// later tool call kept dialling the dead one. The cache was only evicted when
// ensureRunner itself rejected — never when a runner died AFTER being cached.
// The only recovery was restarting the MCP server, which is not something a user
// should have to know.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { connectToPage, closeSessions } from '../../runner/lib/api-client.mjs';

const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n</body></html>\n';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-cache-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ telemetry: { endpoint: null } }));
  return { dir, file: path.join(dir, 'doc.html') };
}

test('a cached connection whose runner died is replaced, not reused', async (t) => {
  const { dir, file } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const first = await startServer({ root: dir, port: 0 });
  const sessions = new Map();
  t.after(() => closeSessions(sessions));

  const a = await connectToPage(file, { sessions, autoStart: false });
  assert.equal(a.base, `http://127.0.0.1:${first.port}`);
  assert.equal(sessions.size, 1, 'the connection is cached');

  // The runner goes away and a different one takes over the directory — exactly
  // the shape that broke: replaced on purpose, not crashed.
  await first.close();
  const second = await startServer({ root: dir, port: 0 });
  t.after(() => second.close());
  assert.notEqual(second.port, first.port);

  const b = await connectToPage(file, { sessions, autoStart: false });
  assert.equal(b.base, `http://127.0.0.1:${second.port}`,
    'the second call must reach the live runner, not the cached dead one');

  // And it still works — the point is a usable client, not just a fresh URL.
  const source = await b.client.source(b.page);
  assert.match(source.source, /alpha bravo charlie/);
});

test('a live cached connection is reused, not rediscovered every call', async (t) => {
  const { dir, file } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const server = await startServer({ root: dir, port: 0 });
  t.after(() => server.close());
  const sessions = new Map();
  t.after(() => closeSessions(sessions));

  const a = await connectToPage(file, { sessions, autoStart: false });
  const cached = sessions.get(path.dirname(file));
  const b = await connectToPage(file, { sessions, autoStart: false });

  assert.equal(a.base, b.base);
  assert.equal(sessions.get(path.dirname(file)), cached,
    'a healthy runner keeps the same cache entry — the check must not churn it');
});
