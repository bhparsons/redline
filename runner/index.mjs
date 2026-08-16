#!/usr/bin/env node
// runner/index.mjs — redline runner entry point.
//
//   node runner/index.mjs <dir> [--port N] [--no-onboarding]
//
// Serves static files from <dir> with the overlay injection placeholder and a
// /health endpoint. Port precedence: --port flag → REDLINE_PORT env →
// redline.config.json runnerPort → 5175. Port 0 asks the OS for an ephemeral
// port (tests use this). An invalid redline.config.json is a startup error.
//
// First start against a directory with no redline.config.json (and stdin a
// TTY) runs the interactive onboarding (lib/onboarding.mjs) before the config
// loads; --no-onboarding skips it.

import path from 'node:path';
import process from 'node:process';
import { startServer } from './lib/server.mjs';
import { loadConfig } from './lib/config.mjs';
import { maybeRunOnboarding } from './lib/onboarding.mjs';

const args = process.argv.slice(2);
let dir = null;
let portArg = null;
let noOnboarding = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') { portArg = args[++i]; continue; }
  if (args[i] === '--no-onboarding') { noOnboarding = true; continue; }
  if (args[i].startsWith('--')) {
    console.error(`unknown flag: ${args[i]}`);
    process.exit(1);
  }
  if (dir !== null) {
    console.error('usage: node runner/index.mjs <dir> [--port N] [--no-onboarding]');
    process.exit(1);
  }
  dir = args[i];
}
if (dir === null) {
  console.error('usage: node runner/index.mjs <dir> [--port N] [--no-onboarding]');
  process.exit(1);
}

const root = path.resolve(dir);
let config;
try {
  await maybeRunOnboarding({ root, skip: noOnboarding });
  config = await loadConfig(root);
} catch (err) {
  console.error(`failed to start: ${err.message}`);
  process.exit(1);
}

const rawPort = portArg ?? process.env.REDLINE_PORT ?? String(config.runnerPort);
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid port: ${rawPort}`);
  process.exit(1);
}

try {
  const { port: boundPort } = await startServer({ root, port, config });
  console.log(`redline runner serving ${root}`);
  console.log(`  http://127.0.0.1:${boundPort}/`);
} catch (err) {
  console.error(`failed to start: ${err.message}`);
  process.exit(1);
}
