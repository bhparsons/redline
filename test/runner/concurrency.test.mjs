// test/runner/concurrency.test.mjs — two runners, one truth.
//
// Field bug: TWO runner instances served overlapping directories at once.
// Each process's withLock is in-memory only, so their sidecar read-modify-
// write cycles interleaved and the late writer clobbered the early one's run
// records (the doc edits survived — they live in the .html, not the sidecar).
//
// Two layers of defense, both covered here:
//   1. <root>/.redline.lock — same-root double-starts refuse at startup.
//   2. sidecar rev guard (store.mjs save/update) — overlapping-root writers
//      that the lock can't see conflict on rev and retry instead of clobber.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, LOCK_FILENAME } from '../../runner/lib/server.mjs';
import { load, save, update, sidecarPath, REV_CONFLICT } from '../../runner/lib/store.mjs';

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-conc-'));
  await fs.writeFile(path.join(dir, 'doc.html'),
    '<body><p data-rev="r-0001">alpha</p></body>\n');
  return dir;
}

// A pid that is guaranteed dead: spawn a no-op node child and wait it out.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve) => child.on('exit', resolve));
  return pid;
}

test('single-instance lock', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, LOCK_FILENAME);
  const readLock = async () => JSON.parse(await fs.readFile(lockPath, 'utf8'));

  const first = await startServer({ root, port: 0 });

  await t.test('created at startup with pid, bound port, startedAt', async () => {
    const lock = await readLock();
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.port, first.port);
    assert.ok(!Number.isNaN(Date.parse(lock.startedAt)), 'startedAt is a timestamp');
  });

  await t.test('lock file is never servable (dotfile guard)', async () => {
    const res = await fetch(`http://127.0.0.1:${first.port}/${LOCK_FILENAME}`);
    assert.equal(res.status, 404);
  });

  await t.test('second startServer on the same root refuses, naming pid and port', async () => {
    await assert.rejects(
      startServer({ root, port: 0 }),
      new RegExp(`another runner is already serving this directory \\(pid ${process.pid}, port ${first.port}\\)`),
    );
    // The refused start must not have damaged the live instance's lock.
    assert.equal((await readLock()).pid, process.pid);
  });

  await t.test('removed on close(); a fresh start then succeeds', async () => {
    await first.close();
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
    const second = await startServer({ root, port: 0 });
    assert.equal((await readLock()).port, second.port);
    await second.close();
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  });

  await t.test('stale lock (dead pid) is replaced, not fatal', async () => {
    const pid = await deadPid();
    await fs.writeFile(lockPath, JSON.stringify({ pid, port: 4444, startedAt: 'then' }));
    const server = await startServer({ root, port: 0 });
    const lock = await readLock();
    assert.equal(lock.pid, process.pid, 'stale lock taken over');
    assert.equal(lock.port, server.port);
    await server.close();
  });

  await t.test('corrupt lock is treated as stale', async () => {
    await fs.writeFile(lockPath, '{nope');
    const server = await startServer({ root, port: 0 });
    assert.equal((await readLock()).pid, process.pid);
    await server.close();
  });
});

test('sidecar rev guard', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const htmlPath = path.join(root, 'doc.html');
  const resetSidecar = () => fs.rm(sidecarPath(htmlPath), { force: true });

  await t.test('rev increments across saves', async () => {
    const data = await load(htmlPath);
    assert.equal(data.rev, 0, 'no sidecar yet → rev 0');
    await save(htmlPath, data);
    assert.equal(data.rev, 1, 'save stamps the new rev onto the caller\'s copy');
    await save(htmlPath, data);
    assert.equal((await load(htmlPath)).rev, 2);
  });

  await t.test('legacy sidecar without rev loads as rev 0, gains rev on first save', async () => {
    const legacy = { comments: [{ id: 'c-legacy', body: 'old', status: 'open' }], runs: [] };
    await fs.writeFile(sidecarPath(htmlPath), JSON.stringify(legacy, null, 2) + '\n');
    const data = await load(htmlPath);
    assert.equal(data.rev, 0, 'legacy tolerated forever');
    assert.equal(data.comments[0].id, 'c-legacy');
    // load alone never migrates the file on disk:
    assert.equal(JSON.parse(await fs.readFile(sidecarPath(htmlPath), 'utf8')).rev, undefined);
    await save(htmlPath, data, data.rev);
    const onDisk = JSON.parse(await fs.readFile(sidecarPath(htmlPath), 'utf8'));
    assert.equal(onDisk.rev, 1, 'first save migrates');
    assert.equal(onDisk.comments[0].id, 'c-legacy', 'content preserved');
  });

  await t.test('save with a stale expected rev throws REV_CONFLICT', async () => {
    await resetSidecar();
    const a = await load(htmlPath);
    const b = await load(htmlPath); // the "other process" read the same state
    a.comments.push({ id: 'c-a' });
    await save(htmlPath, a, a.rev);
    b.comments.push({ id: 'c-b' });
    await assert.rejects(save(htmlPath, b, b.rev), (err) => err.code === REV_CONFLICT);
    // Nothing was clobbered by the refused write:
    const final = await load(htmlPath);
    assert.deepEqual(final.comments.map((c) => c.id), ['c-a']);
  });

  await t.test('the field bug: interleaved blind saves clobber a run record', async () => {
    // This is exactly what two runners did in the field — reproduce it with
    // the unguarded save (no expected rev) to pin the failure mode down.
    await resetSidecar();
    const a = await load(htmlPath);
    const b = await load(htmlPath);
    a.runs = [{ runId: 'run-aaaa', status: 'ok' }];
    await save(htmlPath, a); // runner A records its successful run
    b.runs = [{ runId: 'run-bbbb', status: 'ok' }];
    await save(htmlPath, b); // runner B, unaware, writes its own view
    const clobbered = await load(htmlPath);
    assert.deepEqual(clobbered.runs.map((r) => r.runId), ['run-bbbb'],
      'run-aaaa is GONE — the data loss this change exists to stop');
  });

  await t.test('fixed: update() retries the late writer — both run records land', async () => {
    await resetSidecar();
    let attempts = 0;
    await update(htmlPath, async (data) => {
      attempts++;
      if (attempts === 1) {
        // Simulate the other PROCESS landing its run between our read and
        // our write (in-process interleaving is already serialized by
        // withLock; this is the cross-process window).
        const other = await load(htmlPath);
        other.runs = [...(other.runs ?? []), { runId: 'run-aaaa', status: 'ok' }];
        await save(htmlPath, other, other.rev);
      }
      data.runs = [...(data.runs ?? []), { runId: 'run-bbbb', status: 'ok' }];
    });
    assert.equal(attempts, 2, 'first save hit the rev conflict and re-ran the mutator');
    const final = await load(htmlPath);
    assert.deepEqual(final.runs.map((r) => r.runId).sort(), ['run-aaaa', 'run-bbbb'],
      'no record lost: the late writer re-read and re-applied on top');
    assert.equal(final.rev, 2, 'one bump per landed write');
  });

  await t.test('update() skip() finishes without saving or bumping rev', async () => {
    const before = (await load(htmlPath)).rev;
    const result = await update(htmlPath, (data, { skip }) => {
      skip();
      return 'nothing to do';
    });
    assert.equal(result, 'nothing to do');
    assert.equal((await load(htmlPath)).rev, before);
  });
});
