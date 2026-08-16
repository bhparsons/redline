// runner/lib/install-mcp.mjs — `redline install-mcp` (#50).
//
// Writes an `mcpServers.redline` entry into whichever config file a given
// agent CLI reads, so a session can drive Redline over MCP without anyone
// hand-editing JSON. docs/AGENT-USAGE.md §1 documented that edit by hand, for
// one of three clients; this automates it for all three.
//
// MCP REGISTRATION IS GENERIC. Any MCP client can already talk to
// runner/mcp-server.mjs — these presets are convenience, not capability, and
// the docs say so rather than implying a supported-clients list we then owe
// maintenance on.
//
// THE RULES THIS FILE EXISTS TO KEEP:
//
//   - MERGE, NEVER CLOBBER. These are hand-edited files holding other people's
//     servers. We read, touch exactly one key, and write back. A user's other
//     MCP servers must survive byte-identical.
//   - REFUSE RATHER THAN GUESS. An existing `redline` entry that differs is a
//     conflict, not an invitation: we print the difference and stop unless
//     --force. Unparseable JSON is never overwritten.
//   - AN ABSOLUTE PATH TO THE SERVER. Resolved from this checkout, never `.` —
//     the client launches it from a working directory we do not control, and a
//     relative path is the most common way this silently fails.
//   - SAY WHAT WOULD HAPPEN. --dry-run prints the exact target and the exact
//     JSON and touches nothing.
//
// COPILOT HAS NO PROJECT SCOPE. Its config is per-user only (relocatable with
// COPILOT_HOME). `--project --client copilot` therefore ERRORS instead of
// quietly writing the global file — writing a file the user did not ask for is
// the same class of failure as writing one nobody reads.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SERVER_KEY = 'redline';

/** Where each client keeps its MCP registry, and what to call the agent in
 *  provenance. Paths verified against vendor docs 2026-07-29 — re-check them
 *  when this breaks, because these CLIs move and a wrong path fails SILENTLY:
 *  we would write a well-formed file that nothing ever reads. */
export const CLIENTS = {
  claude: {
    label: 'Claude Code',
    agentName: 'claude-code',
    project: () => path.join('.', '.mcp.json'),
    global: (home) => path.join(home, '.claude.json'),
  },
  gemini: {
    label: 'Gemini CLI',
    agentName: 'gemini-cli',
    project: () => path.join('.', '.gemini', 'settings.json'),
    global: (home) => path.join(home, '.gemini', 'settings.json'),
  },
  copilot: {
    label: 'Copilot CLI',
    agentName: 'copilot-cli',
    // Per-user only. `project` is deliberately absent, and resolveTarget turns
    // that absence into a clear error rather than a silent fallback.
    project: null,
    global: (home, env) => path.join(
      env.COPILOT_HOME && env.COPILOT_HOME.trim() ? env.COPILOT_HOME.trim() : path.join(home, '.copilot'),
      'mcp-config.json',
    ),
  },
};

export const CLIENT_NAMES = Object.keys(CLIENTS);

export class InstallError extends Error {}

/** The entry we install. `command`/`args` mirror the shape every one of the
 *  three clients reads, which is why one helper serves all of them.
 *
 *  `node` rather than process.execPath: pinning the absolute path of whichever
 *  node ran the installer would break the registration on the next version
 *  bump, and it is the shape docs/AGENT-USAGE.md has always documented. The
 *  SERVER path is absolute, because that one the client cannot resolve. */
export function entryFor(client, serverPath) {
  return {
    command: 'node',
    args: [serverPath],
    env: { REDLINE_AGENT_NAME: CLIENTS[client].agentName },
  };
}

export function resolveTarget(client, { scope, cwd, home, env = process.env }) {
  const spec = CLIENTS[client];
  if (!spec) {
    throw new InstallError(`unknown client ${JSON.stringify(client)} — expected one of: ${CLIENT_NAMES.join(', ')}`);
  }
  if (scope === 'project') {
    if (!spec.project) {
      throw new InstallError(
        `${spec.label} has no project-scoped MCP config — its registry is per-user only. `
        + 'Re-run without --project (or set COPILOT_HOME to point at a different config directory).',
      );
    }
    return path.resolve(cwd, spec.project());
  }
  return path.resolve(spec.global(home, env));
}

/** Read a config file we are about to merge into. A missing file is an empty
 *  object; an unparseable one is an error, because the alternative is
 *  destroying JSON somebody hand-wrote. */
export async function readConfig(target) {
  let raw;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { existed: false, config: {} };
    throw new InstallError(`cannot read ${target}: ${err.message}`);
  }
  if (raw.trim() === '') return { existed: true, config: {} };
  try {
    const config = JSON.parse(raw);
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new InstallError(`${target} does not contain a JSON object — refusing to overwrite it`);
    }
    return { existed: true, config };
  } catch (err) {
    if (err instanceof InstallError) throw err;
    throw new InstallError(
      `${target} is not valid JSON (${err.message}) — refusing to overwrite it. Fix or move the file and re-run.`,
    );
  }
}

/** Decide what installing would do, without doing it. Split out so --dry-run
 *  and the real thing cannot disagree about the outcome. */
export function planInstall(config, entry, { force = false, remove = false } = {}) {
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers))
    ? config.mcpServers
    : {};
  const current = servers[SERVER_KEY];
  const others = Object.keys(servers).filter((k) => k !== SERVER_KEY);

  if (remove) {
    if (current === undefined) return { action: 'absent', others };
    const next = { ...config, mcpServers: { ...servers } };
    delete next.mcpServers[SERVER_KEY];
    return { action: 'removed', config: next, others };
  }

  if (current !== undefined) {
    if (JSON.stringify(current) === JSON.stringify(entry)) return { action: 'unchanged', others };
    if (!force) return { action: 'conflict', current, others };
  }

  return {
    action: current === undefined ? 'added' : 'replaced',
    config: { ...config, mcpServers: { ...servers, [SERVER_KEY]: entry } },
    others,
  };
}

/** Two-space indent and a trailing newline: these files are read and edited by
 *  hand, and matching the house style of onboarding.mjs's config writer keeps
 *  diffs small. */
export function serialize(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function writeConfig(target, config) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, serialize(config), 'utf8');
}

/**
 * Run the command. Returns {code, lines} rather than printing, so tests can
 * assert on the outcome and the caller owns stdout.
 */
export async function installMcp(argv, {
  cwd = process.cwd(),
  home = os.homedir(),
  env = process.env,
  serverPath,
} = {}) {
  const lines = [];
  let client = null;
  let scope = 'project';
  let dryRun = false;
  let force = false;
  let remove = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--client') { client = argv[++i] ?? null; continue; }
    if (arg.startsWith('--client=')) { client = arg.slice(9); continue; }
    if (arg === '--global') { scope = 'global'; continue; }
    if (arg === '--project') { scope = 'project'; continue; }
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--force') { force = true; continue; }
    if (arg === '--uninstall') { remove = true; continue; }
    throw new InstallError(`unexpected argument ${JSON.stringify(arg)}`);
  }

  if (!client) {
    throw new InstallError(`--client is required — one of: ${CLIENT_NAMES.join(', ')}`);
  }
  if (!CLIENTS[client]) {
    throw new InstallError(`unknown client ${JSON.stringify(client)} — expected one of: ${CLIENT_NAMES.join(', ')}`);
  }

  const target = resolveTarget(client, { scope, cwd, home, env });
  const entry = entryFor(client, serverPath);
  const { config } = await readConfig(target);
  const plan = planInstall(config, entry, { force, remove });

  const preserved = plan.others.length > 0
    ? `  preserved ${plan.others.length} other MCP server${plan.others.length === 1 ? '' : 's'}: ${plan.others.join(', ')}`
    : null;

  lines.push(`  client   ${CLIENTS[client].label}`);
  lines.push(`  scope    ${scope}`);
  lines.push(`  target   ${target}`);

  if (plan.action === 'conflict') {
    lines.push('');
    lines.push('  a different "redline" entry is already registered:');
    lines.push(...serialize(plan.current).trimEnd().split('\n').map((l) => `    ${l}`));
    lines.push('  would replace it with:');
    lines.push(...serialize(entry).trimEnd().split('\n').map((l) => `    ${l}`));
    lines.push('  refusing — re-run with --force to replace it.');
    return { code: 1, lines, action: plan.action, target };
  }

  if (plan.action === 'unchanged') {
    lines.push('  already installed, unchanged.');
    if (preserved) lines.push(preserved);
    return { code: 0, lines, action: plan.action, target };
  }

  if (plan.action === 'absent') {
    lines.push('  nothing to remove.');
    return { code: 0, lines, action: plan.action, target };
  }

  if (dryRun) {
    const verb = { added: 'add', replaced: 'replace', removed: 'remove' }[plan.action] ?? plan.action;
    lines.push(`  would ${verb} the "redline" entry, writing:`);
    lines.push(...serialize(plan.config).trimEnd().split('\n').map((l) => `    ${l}`));
    if (preserved) lines.push(preserved);
    lines.push('  --dry-run: nothing written.');
    return { code: 0, lines, action: plan.action, target, dryRun: true };
  }

  await writeConfig(target, plan.config);

  if (plan.action === 'removed') {
    lines.push('  uninstalled.');
    if (preserved) lines.push(preserved);
    return { code: 0, lines, action: plan.action, target };
  }

  lines.push(`  ${plan.action === 'replaced' ? 'replaced' : 'installed'}.`);
  if (preserved) lines.push(preserved);
  lines.push(`  restart ${CLIENTS[client].label} to pick it up.`);
  return { code: 0, lines, action: plan.action, target };
}

export const USAGE = 'install-mcp --client <claude|gemini|copilot> [--global] [--dry-run] [--force] [--uninstall]';
