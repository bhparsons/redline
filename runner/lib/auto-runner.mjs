// runner/lib/auto-runner.mjs — attach to a runner, or start one.
//
// ensureRunner({dir}) is what the MCP server and the CLI call before their
// first API request:
//
//   - a live runner serving `dir` (or an ancestor) → attach to it, spawned:false
//   - none, auto-start allowed → spawn `node runner/index.mjs <dir> --port 0
//     --no-onboarding` on an OS-assigned port and wait for it to report the
//     port, spawned:true
//   - none, auto-start disabled → an error naming the command to run by hand
//
// The caller ALWAYS calls stop() when its session ends. stop() is a no-op for
// a runner it attached to: a pre-existing runner (the author's browser session)
// is never shut down by an agent. Auto-started children are also killed from a
// process-exit hook, so an agent that dies mid-session leaves nothing behind.
//
// Auto-start is disabled with {autoStart:false} or REDLINE_NO_AUTO_START=1.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverRunner } from './discovery.mjs';

const RUNNER_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');

export const START_TIMEOUT_MS = 20_000;

// Every child we spawned, so a dying process never orphans a runner.
const children = new Set();
process.on('exit', () => {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
});

function autoStartAllowed(autoStart, env) {
  if (autoStart === false) return false;
  const flag = env.REDLINE_NO_AUTO_START;
  return !(typeof flag === 'string' && flag.length > 0 && flag !== '0' && flag !== 'false');
}

/**
 * Spawn a runner for `dir` on an ephemeral port and resolve once it reports
 * the bound port: {base, port, pid, stop()}. Rejects with the child's stderr
 * when it exits before coming up.
 */
export function startRunner(dir, { port = 0, timeoutMs = START_TIMEOUT_MS, env = process.env } = {}) {
  const child = spawn(process.execPath, [RUNNER_ENTRY, dir, '--port', String(port), '--no-onboarding'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  children.add(child);

  const stop = () => new Promise((resolve) => {
    children.delete(child);
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    // The runner's SIGTERM hook releases its lock and exits; if it somehow
    // doesn't, don't hang the agent session on it.
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 2000).unref?.();
  });

  return new Promise((resolve, reject) => {
    let out = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    const onData = (chunk) => {
      out += String(chunk);
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        finish(resolve, {
          base: `http://127.0.0.1:${m[1]}`, port: Number(m[1]), pid: child.pid, stop,
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      children.delete(child);
      finish(reject, new Error(`could not start the runner: ${err.message}`));
    });
    child.on('exit', (code) => {
      children.delete(child);
      finish(reject, new Error(
        `the runner exited (code ${code}) before it was listening: ${out.trim() || 'no output'}`));
    });
    const deadline = setTimeout(() => {
      stop();
      finish(reject, new Error(`the runner did not come up within ${timeoutMs} ms`));
    }, timeoutMs);
  });
}

/**
 * Attach to the runner serving `dir`, or start one.
 * Returns {base, port, root, spawned, stop()}.
 */
export async function ensureRunner({ dir, autoStart = true, env = process.env, timeoutMs } = {}) {
  const target = path.resolve(dir);
  const found = await discoverRunner(target);
  if (found !== null) {
    return { base: found.base, port: found.port, root: found.root, spawned: false, stop: async () => {} };
  }
  if (!autoStartAllowed(autoStart, env)) {
    throw new Error(
      `no runner is serving ${target} and auto-start is disabled — run: node runner/index.mjs ${target}`);
  }
  try {
    const started = await startRunner(target, { timeoutMs, env });
    return { base: started.base, port: started.port, root: target, spawned: true, stop: started.stop };
  } catch (err) {
    // Lost a start race (another agent's runner took the lock between our
    // discovery pass and our spawn) — look once more before giving up.
    const raced = await discoverRunner(target);
    if (raced !== null) {
      return { base: raced.base, port: raced.port, root: raced.root, spawned: false, stop: async () => {} };
    }
    throw err;
  }
}
