// runner/lib/cli.mjs — the terminal-agent surface.
//
//   redline list <page>
//   redline source <page> [--blocks]
//   redline comment <page> --quote "…" --body "…" [--block-id r-0001] [--ai-edits|--note]
//   redline edit <page> --block-id r-0001 --inner "<em>new</em> text"
//   redline run <page> --comment-id c-… | --comment-ids c-…,c-…
//   redline propose <page> [--comment-id c-…] --edits-file edits.json [--apply]
//   redline set-status <page> --comment-id c-… --status open
//   redline status <page>
//
// Same runner endpoints and the same client the MCP server uses
// (lib/api-client.mjs), so the two agent surfaces can't drift. <page> is a path
// to the .html document, or a page id relative to --dir. The runner is
// discovered from that directory (or auto-started, unless --no-auto-start);
// a runner this command started is stopped before it returns.
//
// Output is plain text by default and raw JSON under --json — the machine-
// readable form for a scripted agent. Exit codes are the contract for anything
// wrapping this in a shell:
//
//   0  success (a dry-run proposal that is VALID also exits 0)
//   1  usage error — unknown command, missing or malformed flags
//   2  could not reach or start a runner
//   3  the runner refused the request (any 4xx/5xx)
//   4  a dry-run proposal came back INVALID (the document would not accept it)

import { promises as fs } from 'node:fs';
import { connectToPage, ApiError } from './api-client.mjs';
import { loadSecret, mintToken, ROLES } from './identity.mjs';

export const EXIT = { ok: 0, usage: 1, runner: 2, api: 3, invalid: 4 };

class UsageError extends Error {}

const COMMANDS = new Set(['list', 'source', 'comment', 'edit', 'run', 'propose', 'set-status', 'status', 'token']);

export const USAGE = [
  'Agent commands (all take <page>: a .html path, or a page id with --dir):',
  '  list <page>                      list the comments on a document',
  '  source <page> [--blocks]         print the document source (or just its block index)',
  '  comment <page> --quote Q --body B   add a comment (--block-id, --prefix, --suffix,',
  '                                   --ai-edits | --note to set the flag at creation)',
  '  edit <page> --block-id ID --inner HTML   replace one block, no model call, no cost',
  '  run <page> --comment-id ID       COSTS MONEY — a paid model run, not how a session works',
  '                                   (--comment-ids a,b for a batch)',
  '  propose <page> --edits-file F    validate agent edits (--apply to write, --comment-id to resolve)',
  '  set-status <page> --comment-id ID --status S   open|addressed|declined|deferred',
  '                                   (resolved is the author accepting the work — a human act)',
  '  status <page>                    is a run active, and what was the last one',
  '  token <page> --name <n> [--role commenter]   mint a signed identity token (#41)',
  '',
  'Shared flags: --json, --dir <dir>, --runner <url>, --no-auto-start, --agent-name <name>',
].join('\n');

// Flags that take a value; everything else is a boolean switch.
const VALUE_FLAGS = new Set([
  'dir', 'runner', 'quote', 'body', 'block-id', 'block', 'inner', 'prefix', 'suffix',
  'comment-id', 'comment-ids', 'edits-file', 'agent-name', 'status',
  'name', 'role', // token minting (#41)
]);

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq));
    if (VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
      continue;
    }
    if (eq !== -1) throw new UsageError(`--${name} does not take a value`);
    flags[name] = true;
  }
  return { positional, flags };
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}

function actorFrom(flags, env) {
  const name = typeof flags['agent-name'] === 'string' && flags['agent-name'].trim().length > 0
    ? flags['agent-name'].trim()
    : (typeof env.REDLINE_AGENT_NAME === 'string' && env.REDLINE_AGENT_NAME.trim().length > 0
      ? env.REDLINE_AGENT_NAME.trim()
      : 'cli-agent');
  return { creator: 'agent', agentName: name };
}

// Read {decisions?, edits?, inserts?} from a file, or from stdin for "-".
async function readEditsFile(pathArg) {
  let raw;
  try {
    raw = pathArg === '-'
      ? await new Response(process.stdin).text()
      : await fs.readFile(pathArg, 'utf8');
  } catch (err) {
    throw new UsageError(`could not read --edits-file ${pathArg}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`--edits-file ${pathArg} is not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError('--edits-file must contain a JSON object: {decisions?, edits?, inserts?}');
  }
  return parsed;
}

const short = (text, n = 60) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

// ---- commands ---------------------------------------------------------------
//
// Each returns {code, json, lines}: `json` is what --json prints, `lines` the
// human form. Neither shape is derived from the other, on purpose — the plain
// output is a summary, the JSON is the runner's answer verbatim.

const handlers = {
  async list({ client, page }) {
    const { comments } = await client.comments(page);
    const lines = comments.length === 0
      ? [`no comments on ${page}`]
      : comments.map((c) => {
        const who = c.creator === 'agent' ? `agent:${c.agentName ?? '?'}` : 'human';
        const block = c.anchor?.blockId ?? '-';
        const replies = (c.replies?.length ?? 0) > 0 ? ` (+${c.replies.length})` : '';
        return `${c.id}  ${c.status.padEnd(9)} ${who.padEnd(20)} ${block.padEnd(8)} ${short(c.body)}${replies}`;
      });
    return { code: EXIT.ok, json: { page, comments }, lines };
  },

  async source({ client, page, flags }) {
    const body = await client.source(page);
    if (flags.blocks) {
      return {
        code: EXIT.ok,
        json: { page, bytes: body.bytes, blocks: body.blocks },
        lines: body.blocks.length === 0
          ? [`${page} has no data-rev blocks — instrument it first`]
          : body.blocks.map((b) => `${b.id}  <${b.tag}>  ${short(b.text, 70)}`),
      };
    }
    // The document itself, unwrapped: `redline source page.html > copy.html`.
    return { code: EXIT.ok, json: body, lines: [body.source], raw: true };
  },

  async comment({ client, page, flags, env }) {
    const anchor = { quote: requireFlag(flags, 'quote') };
    if (flags['block-id']) anchor.blockId = flags['block-id'];
    if (flags.prefix) anchor.prefix = flags.prefix;
    if (flags.suffix) anchor.suffix = flags.suffix;
    // #185: --ai-edits / --note set the flag AT CREATION, so the comment is
    // never briefly readable as the other kind. Neither flag leaves the
    // runner's per-creator default in charge (an agent's comment is a note).
    if (flags['ai-edits'] === true && flags.note === true) {
      throw new UsageError('--ai-edits and --note are opposites; pass at most one');
    }
    const aiEdits = flags['ai-edits'] === true ? true : (flags.note === true ? false : undefined);
    const created = await client.addComment({
      page, body: requireFlag(flags, 'body'), anchor,
      ...(aiEdits === undefined ? {} : { aiEdits }),
      ...actorFrom(flags, env),
    });
    return { code: EXIT.ok, json: created, lines: [`${created.id}  ${created.status}  ${short(created.body)}`] };
  },

  // Replace one block's inner HTML — no model call, no cost (#186). The
  // one-block case had to go through `propose --edits-file`, which means
  // writing a JSON file to change a sentence.
  //
  // Build --inner from the FULL document (`redline source <page>`), never from
  // the block index `redline source --blocks` prints: that text is truncated
  // plain text, so an --inner built from it silently strips inline markup and
  // cuts long blocks short.
  async edit({ client, page, flags, env }) {
    const blockId = flags['block-id'] ?? flags.block;
    if (typeof blockId !== 'string' || blockId.trim().length === 0) {
      throw new UsageError('--block-id is required');
    }
    if (typeof flags.inner !== 'string') {
      throw new UsageError('--inner is required (use --inner "" to empty a block)');
    }
    const run = await client.edit({
      page, blockId, newInner: flags.inner, ...actorFrom(flags, env),
    });
    // A wide edit can PAUSE on the scope gate (#195) instead of applying. It
    // cannot today — one block is always inside its own section — but say so
    // rather than printing a run line for a run that did not happen.
    if (run.pendingConfirmation === true) {
      return {
        code: EXIT.ok,
        json: run,
        lines: [`${run.runId}  pending-confirmation  ${short(run.scope?.summary ?? 'awaiting the author')}`],
      };
    }
    return {
      code: EXIT.ok,
      json: run,
      lines: [`${run.runId}  ${run.status}  lane=${run.lane}  ${blockId}`],
    };
  },

  async run({ client, page, flags }) {
    const single = flags['comment-id'];
    const many = flags['comment-ids'];
    if ((single === undefined) === (many === undefined)) {
      throw new UsageError('provide exactly one of --comment-id or --comment-ids');
    }
    const payload = single !== undefined
      ? { page, commentId: single }
      : { page, commentIds: String(many).split(',').map((s) => s.trim()).filter(Boolean) };
    const run = await client.run(payload);
    const lines = [`${run.runId}  ${run.status}  lane=${run.lane ?? '-'}  edits=${run.edits?.length ?? 0}`];
    for (const d of run.decisions ?? []) lines.push(`  ${d.id}  ${d.decision}  ${short(d.summary)}`);
    return { code: EXIT.ok, json: run, lines };
  },

  async propose({ client, page, flags, env }) {
    const proposal = await readEditsFile(requireFlag(flags, 'edits-file'));
    const apply = flags.apply === true;
    const result = await client.proposeEdits({
      page,
      ...(flags['comment-id'] ? { commentId: flags['comment-id'] } : {}),
      // ALL SIX, not three (#303). This forwarded decisions, edits and inserts
      // and silently dropped theme, attributeEdits and scope — then returned
      // status "ok" with edits: [], so the caller believed a proposal had
      // applied when nothing had been written. A silent no-op that reports
      // success is worse than an error, and it also made the page-level scope
      // gate unreachable from this surface: a theme edit is the main way to
      // trip it, and a theme edit could not be expressed.
      ...(proposal.decisions ? { decisions: proposal.decisions } : {}),
      ...(proposal.edits ? { edits: proposal.edits } : {}),
      ...(proposal.inserts ? { inserts: proposal.inserts } : {}),
      ...(proposal.attributeEdits ? { attributeEdits: proposal.attributeEdits } : {}),
      ...(proposal.theme !== undefined ? { theme: proposal.theme } : {}),
      ...(proposal.scope !== undefined ? { scope: proposal.scope } : {}),
      dryRun: !apply,
      ...actorFrom(flags, env),
    });
    if (!apply) {
      const lines = result.valid
        ? [`valid: ${result.editRecords.length} edit(s) would apply${result.changed ? '' : ' (no change)'}`]
        : [`INVALID [${result.code}]${result.blockId ? ` on ${result.blockId}` : ''}: ${result.error}`];
      return { code: result.valid ? EXIT.ok : EXIT.invalid, json: result, lines };
    }
    // THE GATE IS A REAL OUTCOME, not a malformed apply (#303). A proposal that
    // reaches past its section or changes the page theme comes back as
    // {pendingConfirmation, runId, scope} with NO `edits` — and this read
    // result.edits.length unconditionally, so the CLI crashed with "Cannot read
    // properties of undefined" on a perfectly correct response.
    //
    // It went unnoticed because the two bugs hid each other: the CLI also
    // dropped `theme` on the way out, and a theme change is the main way to
    // trip the gate, so the payload that would have exposed this never arrived.
    // Fixing the drop is what surfaced the crash.
    if (result.pendingConfirmation) {
      const reasons = result.scope?.reasons?.join('; ') || 'reaches beyond the anchored section';
      return {
        code: EXIT.ok,
        json: result,
        lines: [
          `${result.runId}  PAUSED  the scope gate stopped this write — nothing was applied`,
          `  ${result.scope?.level ?? 'section'}-level: ${reasons}`,
          `  answer it: redline confirm ${result.runId} --allow | --decline, or from the overlay`,
        ],
      };
    }
    return {
      code: EXIT.ok,
      json: result,
      lines: [`${result.runId}  applied  edits=${(result.edits ?? []).length}`],
    };
  },

  async 'set-status'({ client, page, flags, env }) {
    const comment = await client.setStatus(requireFlag(flags, 'comment-id'), {
      page, status: requireFlag(flags, 'status'), ...actorFrom(flags, env),
    });
    return { code: EXIT.ok, json: comment, lines: [`${comment.id}  ${comment.status}`] };
  },

  // #41: mint a signed link token for the served root. Minting is a LOCAL
  // act — it reads the root's secret file, which never travels over HTTP —
  // so the runner is consulted only to learn which root serves this page.
  async token({ client, flags }) {
    const name = requireFlag(flags, 'name');
    const role = typeof flags.role === 'string' ? flags.role : 'commenter';
    if (!ROLES.has(role)) {
      throw new UsageError(`--role must be one of: ${[...ROLES].join(', ')}`);
    }
    const info = await client.info();
    const secret = await loadSecret(info.root);
    let token;
    try {
      token = mintToken({ name, role }, secret);
    } catch (err) {
      throw new UsageError(err.message);
    }
    return {
      code: EXIT.ok,
      json: { token, name, role },
      lines: [token, `identity: ${name} (${role}) — pass as {"token": "…"} on comment/reply/status writes`],
    };
  },

  async status({ client, page }) {
    const body = await client.status(page);
    const lines = [`running: ${body.running}${body.runId ? ` (${body.runId})` : ''}`];
    if (body.lastRun) {
      lines.push(`last run: ${body.lastRun.runId}  ${body.lastRun.status}`
        + `  lane=${body.lastRun.lane ?? '-'}  edits=${body.lastRun.edits?.length ?? 0}`);
    } else {
      lines.push('last run: none');
    }
    return { code: EXIT.ok, json: body, lines };
  },
};

export function isAgentCommand(name) {
  return COMMANDS.has(name);
}

/**
 * Run one agent command. Returns the process exit code; all output goes
 * through `out`/`err` (injectable so tests can capture it).
 */
export async function runCli(argv, {
  env = process.env,
  out = console.log,
  err = console.error,
  outRaw = (text) => process.stdout.write(text),
} = {}) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    err(`redline: unknown command ${JSON.stringify(command)}\n${USAGE}`);
    return EXIT.usage;
  }

  let parsed;
  try {
    parsed = parseArgs(rest);
  } catch (e) {
    err(`redline ${command}: ${e.message}`);
    return EXIT.usage;
  }
  const { positional, flags } = parsed;
  if (positional.length !== 1) {
    err(`redline ${command}: exactly one <page> argument is required\n${USAGE}`);
    return EXIT.usage;
  }

  let connection = null;
  try {
    connection = await connectToPage(positional[0], {
      dir: flags.dir,
      base: typeof flags.runner === 'string' ? flags.runner : (env.REDLINE_RUNNER_URL || null),
      autoStart: flags['no-auto-start'] !== true,
      env,
    });
  } catch (e) {
    // Nothing was contacted, or the target isn't served by the runner we found.
    err(`redline ${command}: ${e.message}`);
    return EXIT.runner;
  }

  try {
    const result = await handlers[command]({
      client: connection.client, page: connection.page, flags, env,
    });
    if (flags.json) out(JSON.stringify(result.json, null, 2));
    // `redline source page.html > copy.html` must reproduce the file byte for
    // byte — no added trailing newline.
    else if (result.raw) outRaw(result.lines.join(''));
    else out(result.lines.join('\n'));
    return result.code;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`redline ${command}: ${e.message}`);
      return EXIT.usage;
    }
    if (e instanceof ApiError) {
      if (flags.json) out(JSON.stringify(e.body ?? { error: e.message }, null, 2));
      else err(`redline ${command}: ${e.body?.error ?? e.message} (HTTP ${e.status})`);
      return EXIT.api;
    }
    err(`redline ${command}: ${e.message}`);
    return EXIT.runner;
  } finally {
    await connection.stop().catch(() => {});
  }
}
