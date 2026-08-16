// test/runner/install-mcp.test.mjs — #50: `redline install-mcp`.
//
// The case that carries this file is MERGE-NOT-CLOBBER. These are hand-edited
// files holding other people's MCP servers, and the failure mode is silent:
// a clobbered config looks fine until someone's unrelated server stops
// answering. Everything else here guards a way of failing quietly — writing a
// file nobody reads (copilot has no project scope), overwriting JSON we could
// not parse, or a --dry-run that turns out to write.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installMcp, InstallError, resolveTarget, planInstall, entryFor, CLIENT_NAMES,
} from '../../runner/lib/install-mcp.mjs';

const SERVER = '/opt/redline/runner/mcp-server.mjs';

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rl-mcp-'));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function run(argv, dirs) {
  return installMcp(argv, { cwd: dirs.cwd, home: dirs.home, env: dirs.env ?? {}, serverPath: SERVER });
}

test('installs into each client and records the right agent name', async (t) => {
  for (const client of CLIENT_NAMES) {
    await t.test(client, async () => {
      const dir = await tmp();
      try {
        const dirs = { cwd: dir, home: dir };
        // copilot is per-user only, so it is the one client tested via --global.
        const argv = client === 'copilot'
          ? ['--client', client, '--global']
          : ['--client', client];
        const { code, target } = await run(argv, dirs);
        assert.equal(code, 0);

        const config = await readJson(target);
        assert.equal(config.mcpServers.redline.command, 'node');
        assert.deepEqual(config.mcpServers.redline.args, [SERVER]);
        assert.ok(config.mcpServers.redline.env.REDLINE_AGENT_NAME, 'agent name recorded');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test('merging never clobbers a foreign MCP server', async () => {
  const dir = await tmp();
  try {
    const target = path.join(dir, '.mcp.json');
    const foreign = {
      mcpServers: {
        github: { command: 'gh-mcp', args: ['--stdio'], env: { TOKEN: 'x' } },
        postgres: { command: 'pg-mcp' },
      },
      unrelatedTopLevelKey: { keep: 'me' },
    };
    await fs.writeFile(target, `${JSON.stringify(foreign, null, 2)}\n`);

    await run(['--client', 'claude'], { cwd: dir, home: dir });

    const after = await readJson(target);
    assert.deepEqual(after.mcpServers.github, foreign.mcpServers.github, 'foreign server survives');
    assert.deepEqual(after.mcpServers.postgres, foreign.mcpServers.postgres, 'second foreign server survives');
    assert.deepEqual(after.unrelatedTopLevelKey, foreign.unrelatedTopLevelKey, 'unrelated top-level key survives');
    assert.ok(after.mcpServers.redline, 'and ours is added');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('installing twice is a no-op', async () => {
  const dir = await tmp();
  try {
    const dirs = { cwd: dir, home: dir };
    const { target } = await run(['--client', 'claude'], dirs);
    const first = await fs.readFile(target, 'utf8');

    const second = await run(['--client', 'claude'], dirs);
    assert.equal(second.action, 'unchanged');
    assert.equal(await fs.readFile(target, 'utf8'), first, 'byte-identical');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a differing entry is refused, and --force replaces it', async () => {
  const dir = await tmp();
  try {
    const target = path.join(dir, '.mcp.json');
    await fs.writeFile(target, `${JSON.stringify({
      mcpServers: { redline: { command: 'node', args: ['/somewhere/else/mcp-server.mjs'] } },
    }, null, 2)}\n`);
    const before = await fs.readFile(target, 'utf8');
    const dirs = { cwd: dir, home: dir };

    const refused = await run(['--client', 'claude'], dirs);
    assert.equal(refused.code, 1);
    assert.equal(refused.action, 'conflict');
    assert.match(refused.lines.join('\n'), /--force/);
    assert.equal(await fs.readFile(target, 'utf8'), before, 'refusal wrote nothing');

    const forced = await run(['--client', 'claude', '--force'], dirs);
    assert.equal(forced.code, 0);
    assert.deepEqual((await readJson(target)).mcpServers.redline.args, [SERVER]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--dry-run writes nothing at all', async () => {
  const dir = await tmp();
  try {
    const dirs = { cwd: dir, home: dir };
    const { code, target, lines } = await run(['--client', 'claude', '--dry-run'], dirs);
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /nothing written/);
    assert.equal(await fs.access(target).then(() => true, () => false), false, 'no file created');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--dry-run over an existing file leaves it untouched', async () => {
  const dir = await tmp();
  try {
    const target = path.join(dir, '.mcp.json');
    await fs.writeFile(target, `${JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }, null, 2)}\n`);
    const before = await fs.readFile(target, 'utf8');
    const stat = await fs.stat(target);

    await run(['--client', 'claude', '--dry-run'], { cwd: dir, home: dir });

    assert.equal(await fs.readFile(target, 'utf8'), before);
    assert.equal((await fs.stat(target)).mtimeMs, stat.mtimeMs, 'mtime unchanged');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--uninstall removes only our entry, and round-trips', async () => {
  const dir = await tmp();
  try {
    const target = path.join(dir, '.mcp.json');
    await fs.writeFile(target, `${JSON.stringify({
      mcpServers: { github: { command: 'gh-mcp' } },
    }, null, 2)}\n`);
    const dirs = { cwd: dir, home: dir };

    await run(['--client', 'claude'], dirs);
    const removed = await run(['--client', 'claude', '--uninstall'], dirs);
    assert.equal(removed.action, 'removed');

    const after = await readJson(target);
    assert.equal(after.mcpServers.redline, undefined, 'ours is gone');
    assert.deepEqual(after.mcpServers.github, { command: 'gh-mcp' }, 'theirs is not');

    const again = await run(['--client', 'claude', '--uninstall'], dirs);
    assert.equal(again.action, 'absent');
    assert.equal(again.code, 0, 'removing nothing is not an error');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('copilot has no project scope, so --project errors instead of writing the global file', async () => {
  const dir = await tmp();
  try {
    await assert.rejects(
      () => run(['--client', 'copilot', '--project'], { cwd: dir, home: dir }),
      (err) => err instanceof InstallError && /per-user only/.test(err.message),
    );
    // The point of the error: nothing was written anywhere.
    assert.equal(
      await fs.access(path.join(dir, '.copilot', 'mcp-config.json')).then(() => true, () => false),
      false,
      'global file must not be written as a silent fallback',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('COPILOT_HOME relocates the config', async () => {
  const dir = await tmp();
  try {
    const custom = path.join(dir, 'elsewhere');
    const target = resolveTarget('copilot', {
      scope: 'global', cwd: dir, home: dir, env: { COPILOT_HOME: custom },
    });
    assert.equal(target, path.join(custom, 'mcp-config.json'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unparseable JSON is refused, never overwritten', async () => {
  const dir = await tmp();
  try {
    const target = path.join(dir, '.mcp.json');
    await fs.writeFile(target, '{ this is not json,,, }');
    const before = await fs.readFile(target, 'utf8');

    await assert.rejects(
      () => run(['--client', 'claude'], { cwd: dir, home: dir }),
      (err) => err instanceof InstallError && /not valid JSON/.test(err.message),
    );
    assert.equal(await fs.readFile(target, 'utf8'), before, 'left exactly as found');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a JSON array is refused too', async () => {
  const dir = await tmp();
  try {
    const target = path.join(dir, '.mcp.json');
    await fs.writeFile(target, '[1,2,3]');
    await assert.rejects(
      () => run(['--client', 'claude'], { cwd: dir, home: dir }),
      (err) => err instanceof InstallError && /does not contain a JSON object/.test(err.message),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an unknown or missing --client is a usage error naming the valid ones', async () => {
  const dir = await tmp();
  try {
    const dirs = { cwd: dir, home: dir };
    for (const argv of [['--client', 'emacs'], []]) {
      await assert.rejects(
        () => run(argv, dirs),
        (err) => err instanceof InstallError && /claude, gemini, copilot/.test(err.message),
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('planInstall keeps a non-object mcpServers from destroying the file', () => {
  // Defensive: some other tool could leave junk here. We replace the bad value
  // rather than throwing, but must not lose the rest of the config.
  const plan = planInstall({ mcpServers: 'nonsense', other: 1 }, entryFor('claude', SERVER));
  assert.equal(plan.action, 'added');
  assert.equal(plan.config.other, 1);
  assert.ok(plan.config.mcpServers.redline);
});
