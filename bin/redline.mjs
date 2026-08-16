#!/usr/bin/env node
// bin/redline.mjs — single entry point for npx / global install.
//
//   npx github:bhparsons/redline serve docs/
//   redline instrument path/to/doc.html
//   redline list docs/plan.html
//
// Two kinds of command:
//
//   - the document commands (serve, instrument) exec the target script in a
//     child so those scripts keep their own argv contracts and exit codes;
//     Ctrl-C reaches the child through the shared foreground process group.
//     `serve` is the rebuilt runner (runner/index.mjs) — the canonical server;
//     the legacy review-server.mjs is still runnable by hand but is no longer
//     reachable through this CLI;
//   - the agent commands (list, source, comment, run, propose, set-status,
//     status — M2 WP4) run in-process through runner/lib/cli.mjs, which finds
//     or starts a runner and speaks the same API the MCP server does.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli, isAgentCommand, USAGE as AGENT_USAGE, EXIT } from '../runner/lib/cli.mjs';
import { installMcp, InstallError, USAGE as INSTALL_USAGE } from '../runner/lib/install-mcp.mjs';
import {
  looksLikeDoc, seedDemo, planOpen, pageUrl, openInBrowser, choosePort,
} from '../runner/lib/open-doc.mjs';
import { discoverRunner } from '../runner/lib/discovery.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Serve a document's directory and open the page (#46).
 *
 * A runner already covering the directory is reused and the command returns
 * immediately — it did not start that runner, so it has no business owning its
 * lifetime. Otherwise it starts one in the FOREGROUND and stays attached: a
 * runner that dies when the CLI exits is not what "open this document" means.
 *
 * The browser waits for the runner to actually answer. Opening the URL before
 * the server binds is a blank tab the user has to reload, and reload is exactly
 * the action the offline path warns against.
 */
async function openDocument(docPath, { noOpen = false, extraArgs = [] } = {}) {
  const plan = await planOpen(docPath);
  if (plan.error) {
    console.error(`redline: ${plan.error}`);
    return EXIT.usage;
  }

  if (!plan.serve) {
    const url = pageUrl(plan.base, plan.page);
    console.log(`reusing the runner on ${plan.base} (serving ${plan.root})`);
    console.log(`  ${url}`);
    if (!noOpen) openInBrowser(url);
    return EXIT.ok;
  }

  // Pick a port, preferring the window the extension's fallback scan knows.
  // runner/index.mjs does not walk, so without this the command dies with a raw
  // EADDRINUSE whenever anything already holds 5175 — the normal state on a
  // machine that has run redline once today. A full window is NOT fatal: the
  // extension uses the origin that served the page, so any port serves
  // documents fine, and only the popup and file:// pages lose auto-discovery.
  const portArgs = [];
  if (!extraArgs.includes('--port')) {
    const { port, scannable, note } = await choosePort();
    if (!scannable) console.warn(`redline: ${note}`);
    portArgs.push('--port', String(port));
  }

  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'runner', 'index.mjs'), plan.root, ...portArgs, ...extraArgs],
    { stdio: 'inherit' },
  );
  let exited = false;
  child.on('exit', (code, signal) => { exited = true; process.exit(signal ? 1 : (code ?? 1)); });

  // Poll discovery rather than the port: the runner writes its lock once it is
  // bound, and discovery is the same three checks every other surface uses, so
  // "we can see it" here means the same thing it means everywhere else.
  const deadline = Date.now() + 20_000;
  while (!exited && Date.now() < deadline) {
    const found = await discoverRunner(plan.root).catch(() => null);
    if (found) {
      const url = pageUrl(found.base, plan.page);
      console.log(`  ${url}`);
      if (!noOpen) openInBrowser(url);
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise(() => {}); // stay attached; the child's exit handler ends us
  return EXIT.ok;
}

// Every `script` here MUST resolve to a real file under ROOT — the archive
// extraction (2026-07-28) deleted the root instrument.mjs and distill.mjs and
// left this table pointing at both, so `redline instrument` and `redline
// distill` died with a raw module-loader stack trace (#158). `distill` is gone
// rather than repaired: the distill loop is one of the features the rebuild
// deliberately did not carry (docs/PLAN-CONSOLIDATION-2026-07-28.md §2), and
// advertising a command for a dropped feature is worse than not having it.
// test/runner/cli-entry.test.mjs asserts each path exists, so this fails in CI
// rather than in someone's terminal.
const COMMANDS = {
  serve: { script: 'runner/index.mjs', usage: 'serve [dir] [--port N]  start the runner on <dir> (default: .)' },
  instrument: { script: 'runner/instrument.mjs', usage: 'instrument <files..>   stamp data-rev block ids (idempotent; --check to audit)' },
};

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  const lines = [
    'redline — Google-Docs-style review layer for static HTML documents',
    '',
    'Usage: redline <command> [args]',
    '       redline <file.html>    serve its directory and open it in the browser',
    '',
    ...Object.values(COMMANDS).map((c) => '  ' + c.usage),
    '  demo [dir]             seed a sample document (default: ./redline-demo) and open it',
    '  ' + INSTALL_USAGE,
    '  help                   show this message',
    '',
    'Add --no-open to print the URL without launching a browser.',
    '',
    AGENT_USAGE,
    '',
    'After `serve`, open',
    '  http://127.0.0.1:5175/<page>.html',
    'with the Redline extension loaded.',
    'Agent surfaces: docs/AGENT-CONTRACT.md and docs/AGENT-USAGE.md',
    'Docs: https://github.com/bhparsons/redline#readme',
  ];
  console.log(lines.join('\n'));
  process.exit(cmd ? 0 : 1);
}

// install-mcp is a third kind of command: in-process like the agent ones, but
// it needs no runner at all — it only writes a client's config file.
if (cmd === 'install-mcp') {
  try {
    const { code, lines } = await installMcp(rest, {
      serverPath: path.join(ROOT, 'runner', 'mcp-server.mjs'),
    });
    console.log(`redline install-mcp\n${lines.join('\n')}`);
    process.exit(code);
  } catch (err) {
    console.error(`redline install-mcp: ${err.message}`);
    process.exit(err instanceof InstallError ? EXIT.usage : EXIT.runner);
  }
}

if (isAgentCommand(cmd)) {
  let code = EXIT.usage;
  try {
    code = await runCli([cmd, ...rest]);
  } catch (err) {
    console.error(`redline ${cmd}: ${err.message}`);
    code = EXIT.runner;
  }
  // Exiting outright would truncate a large `source` dump into a pipe, and
  // waiting for the loop to drain would sit on fetch's keep-alive sockets —
  // so: flush, then exit.
  if (!process.stdout.write('')) await new Promise((resolve) => process.stdout.once('drain', resolve));
  process.exit(code);
}

// `redline demo` and `redline <file.html>` (#46). Both end in the same place —
// a runner serving a directory and a browser pointed at one page in it — so
// they share openDocument() below. Ordered before the unknown-command error so
// a document path is a command, but AFTER the command table so a file that
// happens to be called `serve` cannot shadow one.
if (cmd === 'demo' || await looksLikeDoc(cmd)) {
  const noOpen = rest.includes('--no-open');
  const passThrough = rest.filter((a) => a !== '--no-open');
  let docPath = cmd;
  if (cmd === 'demo') {
    const dirArg = passThrough.find((a) => !a.startsWith('--'));
    const seeded = await seedDemo({ repoRoot: ROOT, ...(dirArg ? { dir: dirArg } : {}) });
    console.log(seeded.seeded
      ? `seeded ${path.relative(process.cwd(), seeded.absFile) || seeded.name}`
      : `reusing the demo already at ${path.relative(process.cwd(), seeded.absFile) || seeded.name}`);
    docPath = seeded.absFile;
  }
  process.exit(await openDocument(docPath, {
    noOpen,
    extraArgs: passThrough.filter((a) => a.startsWith('--') || a !== docPath),
  }));
}

const target = COMMANDS[cmd];
if (!target) {
  console.error(`redline: unknown command ${JSON.stringify(cmd)} — try: ${Object.keys(COMMANDS).join(', ')}, demo, help`);
  process.exit(1);
}

// runner/index.mjs requires an explicit directory; `redline serve` keeps the
// old default of the current directory. `--port` takes a value, so skip it
// when looking for a positional argument.
function hasPositional(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') { i++; continue; }
    if (!argv[i].startsWith('--')) return true;
  }
  return false;
}
const args = (cmd === 'serve' && !hasPositional(rest)) ? ['.', ...rest] : rest;

const child = spawn(process.execPath, [path.join(ROOT, target.script), ...args], { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
