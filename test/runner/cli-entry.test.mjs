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
import { execFile, spawn } from 'node:child_process';
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

// `redline serve` and a busy 5175 (found by testing the rewritten README,
// 2026-08-16). `serve` used to hand runner/index.mjs no port at all, so it
// bound 5175 and died with a raw EADDRINUSE the moment a second project was
// open — while the README tells you to run one runner per repo you review.
// It now picks a free port the way `redline <file>` already did, and still
// respects every explicit pin.
//
// Two things this test learned the hard way. The blocker runs as its own
// process: holding the socket inside the test process crashed node 25 at exit
// once a killed child and a closing server overlapped. And 5175 is often
// ALREADY busy on a developer machine — that satisfies the precondition just
// as well, so the helper treats EADDRINUSE as "someone else is holding it".
function blockPort(port) {
  const child = spawn(process.execPath, ['-e',
    `const s=require('node:net').createServer(()=>{});`
    + `s.on('error',()=>{console.log('taken');});`
    + `s.listen(${port},'127.0.0.1',()=>console.log('mine'));`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve) => {
    child.stdout.once('data', () => resolve({ stop: () => child.kill('SIGKILL') }));
  });
}

// `redline serve` spawns runner/index.mjs, so killing the CLI leaves the
// runner holding the pipe. Start it in its own process group and kill the
// group.
function serveDetached(dir, args = ['serve', dir]) {
  const child = spawn(process.execPath, [BIN, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  const collect = (chunk) => { out += chunk; };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return {
    stop() { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } },
    until(re, ms = 15_000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = setInterval(() => {
          if (re.test(out)) { clearInterval(tick); resolve(out); }
          else if (Date.now() - started > ms) { clearInterval(tick); reject(new Error(`timed out; got: ${out}`)); }
        }, 100);
      });
    },
  };
}

test('serve picks a free port when 5175 is taken', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-serve-walk-'));
  const blocker = await blockPort(5175);
  const server = serveDetached(dir);
  try {
    const out = await server.until(/http:\/\/127\.0\.0\.1:\d+\//);
    const port = Number(out.match(/http:\/\/127\.0\.0\.1:(\d+)\//)[1]);
    assert.notEqual(port, 5175, 'served on the port we deliberately blocked');
    assert.doesNotMatch(out, /EADDRINUSE/);
  } finally {
    server.stop();
    blocker.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('serve still honours an explicit --port, busy or not', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-serve-pin-'));
  const blocker = await blockPort(5175);
  try {
    // A pinned port that is busy is an error, not a silent move: you asked
    // for that port. This one exits on its own, so plain run() is enough.
    const { code, stderr } = await run(['serve', dir, '--port', '5175']);
    assert.notEqual(code, 0);
    assert.match(stderr, /EADDRINUSE/);
  } finally {
    blocker.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('`redline demo <dir>` serves the directory it just seeded', async (t) => {
  // It seeded the file and then printed runner/index.mjs's usage line, because
  // the directory argument was consumed by the seeder AND forwarded to the
  // runner as a second positional. The seed message made that read as success
  // (Blake, 2026-08-17, on a fresh clone following the README).
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rl-demo-')), 'seeded-here');
  const server = serveDetached(dir, ['demo', dir, '--no-open']);
  t.after(() => server.stop());

  const out = await server.until(/http:\/\/127\.0\.0\.1:\d+\//, 20_000);
  assert.match(out, /seeded /);
  assert.doesNotMatch(out, /usage: node runner\/index\.mjs/,
    'the seeded directory must not also be forwarded to the runner');

  // Serving, and serving the right root — not the cwd it was launched from.
  const port = out.match(/127\.0\.0\.1:(\d+)/)[1];
  const info = await fetch(`http://127.0.0.1:${port}/api/info`).then((r) => r.json());
  assert.equal(await fs.realpath(info.root), await fs.realpath(dir));
});

test('a --port value is never mistaken for the demo directory', async (t) => {
  // `redline demo --port 3000 ~/dir` used to seed into a directory called
  // "3000", because the positional scan did not skip the flag's own value.
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rl-demoport-')), 'real-target');
  const server = serveDetached(dir, ['demo', '--port', '5399', dir, '--no-open']);
  t.after(() => server.stop());

  const out = await server.until(/http:\/\/127\.0\.0\.1:5399\//, 20_000);
  assert.match(out, /real-target/, 'seeded into the directory, not into "5399"');

  const info = await fetch('http://127.0.0.1:5399/api/info').then((r) => r.json());
  assert.equal(await fs.realpath(info.root), await fs.realpath(dir));
});
