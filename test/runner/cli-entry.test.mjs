// test/runner/cli-entry.test.mjs — #158: the document-command dispatch table.
//
// bin/redline.mjs execs document commands by PATH STRING, so a file move
// breaks them silently at the source level and loudly at the user's terminal.
// That is exactly what happened: the 2026-07-28 archive extraction deleted the
// root instrument.mjs and distill.mjs and left both entries in COMMANDS, so
// `redline instrument` — a command CLAUDE.md documents as canonical — died with
// a raw module-loader stack trace.
//
// The first test is the guard: every script path in the table must resolve.
// It reads the source rather than importing it, because importing
// bin/redline.mjs RUNS it. The rest exercise the two commands end to end as
// real subprocesses, since the exit code is half the contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO, 'bin', 'redline.mjs');

function run(args, cwd = REPO) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('every COMMANDS script path resolves to a real file', async () => {
  const src = await fs.readFile(BIN, 'utf8');
  const table = src.slice(src.indexOf('const COMMANDS = {'), src.indexOf('const [cmd,'));
  const paths = [...table.matchAll(/script:\s*'([^']+)'/g)].map((m) => m[1]);

  assert.ok(paths.length >= 2, `expected to parse the dispatch table, got ${paths.length} entries`);

  for (const rel of paths) {
    const abs = path.join(REPO, rel);
    assert.ok(
      await fs.access(abs).then(() => true, () => false),
      `bin/redline.mjs dispatches to ${rel}, which does not exist (#158)`,
    );
  }
});

test('`redline instrument` stamps a file instead of crashing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-entry-'));
  try {
    const doc = path.join(dir, 'doc.html');
    await fs.writeFile(doc, '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n<p>alpha</p>\n</body></html>\n');

    const first = await run(['instrument', doc]);
    assert.equal(first.code, 0, `instrument failed: ${first.stderr}`);
    assert.match(await fs.readFile(doc, 'utf8'), /data-rev="/);

    // The command advertises itself as idempotent; a second pass must not
    // re-stamp or fail.
    const second = await run(['instrument', doc]);
    assert.equal(second.code, 0, `second instrument failed: ${second.stderr}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a missing module never surfaces as a raw stack trace', async () => {
  const { stderr } = await run(['instrument', '--check', path.join(REPO, 'design', 'mock-phase6-install.html')]);
  assert.doesNotMatch(stderr, /Cannot find module/, 'dispatch table points at a deleted file (#158)');
});

test('`distill` is gone, not broken — it is a feature the rebuild did not carry', async () => {
  const { code, stderr } = await run(['distill']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown command/);
  assert.doesNotMatch(stderr, /Cannot find module/);
});

test('help advertises only commands that exist', async () => {
  const { stdout } = await run(['help']);
  assert.match(stdout, /serve \[dir\]/);
  assert.match(stdout, /instrument <files\.\.>/);
  assert.doesNotMatch(stdout, /distill/);
});
