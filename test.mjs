#!/usr/bin/env node
// test.mjs — thin launcher for the node:test suite (F4, issue #37).
//
//   node test.mjs [--fast]
//
// The suite lives in test/*.test.mjs — one node:test file per section group,
// each with its own git sandbox and a review-server on an ephemeral port
// (REVIEW_PORT=0), so files run in PARALLEL. test/claude/*.test.mjs spawn real
// headless `claude` runs and are skipped by --fast (they need the CLI + a
// subscription; CI runs --fast only).
//
// Browser-side behavior (highlights, popover, normalizer fixtures) can't run
// headless here — see "Browser checks" in README.md. The exceptions are the
// overlay's anchor-resolution order and shortcut/grouping logic, covered via
// minimal DOM stubs in test/overlay-*.test.mjs.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const FAST = process.argv.includes('--fast');

const listTests = (dir) => readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => path.join(dir, f))
  .sort();

const files = listTests(path.join(SELF_DIR, 'test', 'runner'));

// Fast files are cheap (stub agents) — full parallelism. The claude files each
// spawn several real headless runs, so cap concurrency to keep the box sane.
const concurrency = FAST ? os.availableParallelism() : Math.min(4, os.availableParallelism());

const child = spawn(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...files], {
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
