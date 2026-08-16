// test/runner/discovery.test.mjs — M2 WP5: finding or starting a runner.
//
// Covers the three checks discovery makes before believing a .redline.lock
// (live pid, healthy port, matching root), the page-id mapping, and the
// auto-start lifecycle: attach to a pre-existing runner and leave it alone,
// spawn one when there is none, refuse when auto-start is off, and never
// orphan a child.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, LOCK_FILENAME } from '../../runner/lib/server.mjs';
import {
  discoverRunner, findLocks, pageForFile, pidAlive, probe,
} from '../../runner/lib/discovery.mjs';
import { ensureRunner, startRunner } from '../../runner/lib/auto-runner.mjs';

const DOC_HTML = '<!doctype html>\n<html><body>\n<p data-rev="r-0001">hello</p>\n</body></html>\n';
const DEAD_PID = 999_999; // above every platform pid ceiling we run on

async function makeFixtureDir(tag) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `redline-discovery-${tag}-`));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'page.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, 'redline.config.json'),
    JSON.stringify({ telemetry: { endpoint: null } }, null, 2));
  return dir;
}

test('runner discovery', async (t) => {
  const root = await makeFixtureDir('served');
  const stranger = await makeFixtureDir('stranger');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stranger, { recursive: true, force: true });
  });

  await t.test('no runner → null', async () => {
    assert.equal(await discoverRunner(root), null);
  });

  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); });

  await t.test('finds the runner from the served root', async () => {
    const found = await discoverRunner(root);
    assert.ok(found, 'discovered');
    assert.equal(found.port, port);
    assert.equal(found.base, `http://127.0.0.1:${port}`);
    assert.equal(found.root, path.resolve(root));
    assert.equal(found.lockPath, path.join(root, LOCK_FILENAME));
  });

  await t.test('finds it from a subdirectory by walking up', async () => {
    const found = await discoverRunner(path.join(root, 'sub'));
    assert.ok(found);
    assert.equal(found.port, port);
  });

  await t.test('the lock records the bound port', async () => {
    const lock = JSON.parse(await fs.readFile(path.join(root, LOCK_FILENAME), 'utf8'));
    assert.equal(lock.port, port);
    assert.equal(lock.pid, process.pid);
    assert.ok(pidAlive(lock.pid));
    assert.ok(!Number.isNaN(Date.parse(lock.startedAt)));
  });

  await t.test('a dead pid in the lock is ignored', async () => {
    const lockPath = path.join(stranger, LOCK_FILENAME);
    await fs.writeFile(lockPath, JSON.stringify({ pid: DEAD_PID, port, startedAt: new Date().toISOString() }));
    assert.equal(await discoverRunner(stranger), null, 'stale lock never resolves');
    await fs.rm(lockPath, { force: true });
  });

  await t.test('a live port serving a DIFFERENT root is ignored', async () => {
    // The lock is real and its port answers — but that runner serves `root`,
    // not this directory, so believing it would send every page param to the
    // wrong tree.
    const lockPath = path.join(stranger, LOCK_FILENAME);
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
    assert.equal(await discoverRunner(stranger), null);
    await fs.rm(lockPath, { force: true });
  });

  await t.test('a corrupt lock is treated as absent', async () => {
    const lockPath = path.join(stranger, LOCK_FILENAME);
    await fs.writeFile(lockPath, 'not json at all');
    assert.deepEqual(await findLocks(stranger), [], 'unparseable → skipped');
    assert.equal(await discoverRunner(stranger), null);
    await fs.rm(lockPath, { force: true });
  });

  await t.test('probe rejects a port nothing is listening on', async () => {
    assert.equal(await probe(1, { timeoutMs: 500 }), null);
  });

  await t.test('pageForFile maps files to root-relative page ids', async () => {
    assert.equal(await pageForFile(root, path.join(root, 'doc.html')), 'doc.html');
    assert.equal(await pageForFile(root, path.join(root, 'sub', 'page.html')), 'sub/page.html');
    assert.equal(await pageForFile(root, path.join(stranger, 'doc.html')), null, 'outside the root');
    assert.equal(await pageForFile(root, root), null, 'the root itself is not a page');
  });

  await t.test('ensureRunner attaches to the live runner and never stops it', async () => {
    const conn = await ensureRunner({ dir: path.join(root, 'sub') });
    assert.equal(conn.spawned, false);
    assert.equal(conn.port, port);
    await conn.stop(); // must be a no-op for a runner we did not start
    assert.equal((await fetch(`${conn.base}/health`)).status, 200, 'still serving');
  });
});

test('auto-start', async (t) => {
  const root = await makeFixtureDir('autostart');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  await t.test('starts a runner when none is serving the directory', async () => {
    const conn = await ensureRunner({ dir: root });
    assert.equal(conn.spawned, true);
    assert.ok(conn.port > 0);
    assert.equal(conn.root, path.resolve(root));

    const health = await fetch(`${conn.base}/health`);
    assert.equal(health.status, 200);
    const info = await (await fetch(`${conn.base}/api/info`)).json();
    assert.equal(info.port, conn.port);

    // A second call now discovers the child instead of starting another.
    const again = await ensureRunner({ dir: root });
    assert.equal(again.spawned, false);
    assert.equal(again.port, conn.port);

    await conn.stop();
    await assert.rejects(
      fetch(`${conn.base}/health`, { signal: AbortSignal.timeout(1000) }),
      'the auto-started runner is gone',
    );
    assert.equal(await discoverRunner(root), null, 'and its lock was released');
  });

  await t.test('auto-start disabled → an error naming the manual command', async () => {
    await assert.rejects(
      ensureRunner({ dir: root, autoStart: false }),
      (err) => /auto-start is disabled/.test(err.message) && /node runner\/index\.mjs/.test(err.message),
    );
  });

  await t.test('REDLINE_NO_AUTO_START in the env disables it too', async () => {
    await assert.rejects(
      ensureRunner({ dir: root, env: { ...process.env, REDLINE_NO_AUTO_START: '1' } }),
      /auto-start is disabled/,
    );
    // ...and an explicit falsy value does not.
    const conn = await ensureRunner({ dir: root, env: { ...process.env, REDLINE_NO_AUTO_START: '0' } });
    assert.equal(conn.spawned, true);
    await conn.stop();
  });

  await t.test('startRunner reports a runner that cannot start', async () => {
    await assert.rejects(
      startRunner(path.join(root, 'does-not-exist')),
      /exited|did not come up/,
    );
  });
});
