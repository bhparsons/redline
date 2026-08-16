#!/usr/bin/env node
// runner/eval/run.mjs — the eval harness CLI (tiered since WP5).
//
//   node runner/eval/run.mjs [--tier <simple|standard|complex|all>]
//                            [--live] [--only <substring>] [--out <file>]
//
// For every fixture the harness builds a temp page, then drives the REAL run
// flow end to end: startServer → POST /api/comment → POST /api/run → score
// the resulting run record and read its trace bundle for latency/cost
// metrics. Nothing is stubbed inside the runner — only the agent endpoint:
//
//   default   a built-in stub OpenRouter server replies with each fixture's
//             stubResponse. This validates the harness plumbing and the whole
//             route → prompt → agent-parse → apply pipeline, NOT model
//             quality. Env OPENROUTER_* is scrubbed so no real credentials or
//             endpoints can leak into a stub run.
//   --live    the real OpenRouter endpoint, ONLY when OPENROUTER_API_KEY is
//             set AND the flag is passed explicitly. Never the default.
//
// A tier run pins EVERY archetype's model to that tier's model (author-pin
// semantics, so both lanes honor it); --tier all runs each tier in sequence
// and prints the simple-vs-standard quality comparison for the tactical and
// content archetypes (frontload decision 7: simple must reach >=80% of the
// reference tier — reported, never enforced by exit code).
//
// Output: per-tier tables + metrics on stdout, and a JSON report under
// tmp/eval-reports/ (gitignored). Exits 0 whenever the harness itself ran
// cleanly, regardless of scores; exits 1 only on harness failure or misuse.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../lib/server.mjs';
import { CONFIG_FILENAME } from '../lib/config.mjs';
import { ARCHETYPES } from '../lib/classify.mjs';
import { TIERS, DEFAULT_MODEL_TIERS } from '../config/defaults.mjs';
import { traceDir } from '../lib/trace.mjs';
import { FIXTURES, buildDoc, COMMENT_ID_PLACEHOLDER } from './fixtures.mjs';
import { score, estimateCost, COMPONENTS } from './score.mjs';
import { promptText } from '../lib/agent.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REFERENCE_TIER = 'standard';
const SIMPLE_TARGET_RATIO = 0.8; // frontload decision 7
const COMPARED_ARCHETYPES = ['tactical', 'content'];

function parseArgs(argv) {
  const args = { live: false, only: null, out: null, tier: REFERENCE_TIER };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--only') args.only = argv[++i] ?? '';
    else if (a === '--out') args.out = argv[++i] ?? '';
    else if (a === '--tier') args.tier = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.tier !== 'all' && !TIERS.includes(args.tier)) {
    throw new Error(`--tier must be one of ${TIERS.join(', ')}, or all`);
  }
  return args;
}

// Plain-text quote for the comment anchor: the block's text content, capped.
function textQuote(blockHtml) {
  const text = blockHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 60) || 'fixture block';
}

// The built-in stub OpenRouter server. It finds the comment id inside the
// rendered prompt (revise AND tactical prompts inline the comment JSON) and
// answers with that fixture's stubResponse, placeholder substituted. Router
// calls carry no comment JSON in that shape and fall through to the empty
// reply — an invalid route, so the runner takes its keyword fallback.
function startStubAgent(byCommentId) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let content;
      try {
        const prompt = promptText(JSON.parse(body).messages);
        const id = /"id": "(c-[0-9a-f]{12})"/.exec(prompt)?.[1];
        const fixture = id === undefined ? undefined : byCommentId.get(id);
        if (fixture === undefined) throw new Error('unknown comment id in prompt');
        content = JSON.stringify(fixture.stubResponse)
          .split(COMMENT_ID_PLACEHOLDER).join(id);
      } catch {
        content = JSON.stringify({ decisions: [], edits: [] });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/chat/completions`,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const usd = (v) => `$${v.toFixed(4)}`;
const ms = (v) => `${Math.round(v)}ms`;

function printTable(tier, model, results) {
  const SHORT = { archetype: 'arc', blockId: 'blk', decision: 'dec', editSimilarity: 'sim', appliedCleanly: 'app' };
  const flags = (b) => COMPONENTS.map((c) => {
    const v = b[c];
    return `${SHORT[c]}${v === 1 ? '+' : v === 0 ? '-' : '~'}`;
  }).join(' ');
  const nameWidth = Math.max(...results.map((r) => r.name.length), 7);

  console.log(`\n=== tier: ${tier} (${model}) ===`);
  for (const archetype of ARCHETYPES) {
    const rows = results.filter((r) => r.archetype === archetype);
    if (rows.length === 0) continue;
    const avg = rows.reduce((s, r) => s + r.score, 0) / rows.length;
    console.log(`${archetype}  (${pct(avg)})`);
    for (const r of rows) {
      const note = r.notes.length > 0 ? `  ${r.notes[0]}` : '';
      console.log(`  ${r.name.padEnd(nameWidth)}  ${pct(r.score).padStart(6)}  `
        + `${ms(r.latencyMs).padStart(7)}  ${usd(r.estCostUsd).padStart(8)}  ${flags(r.breakdown)}${note}`);
    }
  }
  const overall = results.reduce((s, r) => s + r.score, 0) / results.length;
  const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / results.length;
  const totalCost = results.reduce((s, r) => s + r.estCostUsd, 0);
  console.log(`tier ${tier}: ${pct(overall)} over ${results.length} fixture(s), `
    + `avg latency ${ms(avgLatency)}, est. total cost ${usd(totalCost)}`);
  return overall;
}

// Per-archetype rollup {quality, avgLatencyMs, avgCostUsd} for one tier run.
function perArchetypeStats(results) {
  const out = {};
  for (const archetype of ARCHETYPES) {
    const rows = results.filter((r) => r.archetype === archetype);
    if (rows.length === 0) continue;
    out[archetype] = {
      quality: Math.round((rows.reduce((s, r) => s + r.score, 0) / rows.length) * 1000) / 1000,
      avgLatencyMs: Math.round(rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length),
      avgCostUsd: Math.round((rows.reduce((s, r) => s + r.estCostUsd, 0) / rows.length) * 1e6) / 1e6,
    };
  }
  return out;
}

// Latency/cost for one run from its trace bundle: the canonical exchange's
// request/response sizes (and real token usage when the envelope carried
// it). Router/tactical-attempt overhead is not costed — the canonical files
// are the run's decisive exchange; bundle files are the ground truth.
async function runMetrics(runId, model) {
  let promptChars = 0;
  let responseChars = 0;
  let usage = null;
  try {
    promptChars = (await fs.readFile(path.join(traceDir(runId), 'prompt.md'), 'utf8')).length;
    const response = JSON.parse(await fs.readFile(path.join(traceDir(runId), 'agent-response.json'), 'utf8'));
    responseChars = typeof response.content === 'string' ? response.content.length : 0;
    const rawUsage = response.envelope?.usage;
    if (rawUsage && typeof rawUsage === 'object') {
      usage = {
        inputTokens: rawUsage.prompt_tokens,
        outputTokens: rawUsage.completion_tokens,
      };
      // The charged cost, when the provider returned one — it already
      // accounts for cache reads/writes that the price table cannot (#118).
      if (Number.isFinite(rawUsage.cost)) usage.costUsd = rawUsage.cost;
    }
  } catch { /* failed pre-bundle — estimate from nothing */ }
  return { estCostUsd: estimateCost({ model, usage, promptChars, responseChars }) };
}

// Run every fixture against ONE tier: fresh root, every archetype's model
// pinned to the tier model, its own trace-bundle dir.
async function runTier({ tier, fixtures, live, stubAgent, byCommentId }) {
  const tierModel = DEFAULT_MODEL_TIERS[tier];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `redline-eval-${tier}-`));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), `redline-eval-trace-${tier}-`));
  const prevTraceDir = process.env.REDLINE_TRACE_DIR;
  process.env.REDLINE_TRACE_DIR = bundleDir;

  const agentConfig = live
    ? { timeoutMs: 120_000 } // endpoint + key resolve from env/defaults
    : { endpoint: stubAgent.url, apiKey: 'eval-stub-key', timeoutMs: 10_000 };
  await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
    agent: agentConfig,
    // Pin every archetype to the tier's model — author-pin semantics, so the
    // standard AND tactical lanes both honor it.
    models: Object.fromEntries(ARCHETYPES.map((a) => [a, tierModel])),
    // Stub runs measure plumbing, not models — keep them out of Phoenix.
    // Live runs keep the default so eval traces are explorable there.
    ...(live ? {} : { telemetry: { endpoint: null } }),
  }, null, 2));

  const pages = new Map();
  for (const [i, fixture] of fixtures.entries()) {
    const page = `fixture-${String(i).padStart(2, '0')}.html`;
    pages.set(fixture.name, page);
    await fs.writeFile(path.join(root, page), buildDoc(fixture.blockHtml));
  }

  const { port, close } = await startServer({ root, port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const post = async (url, payload) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  };

  const results = [];
  try {
    for (const fixture of fixtures) {
      const page = pages.get(fixture.name);
      const created = await post(`${base}/api/comment`, {
        page,
        body: fixture.body,
        anchor: { blockId: fixture.expectedBlockId, quote: textQuote(fixture.blockHtml) },
      });
      if (created.status !== 201) throw new Error(`comment creation failed for ${fixture.name}: HTTP ${created.status}`);
      const commentId = created.body.id;
      byCommentId.set(commentId, fixture);

      const t0 = Date.now();
      const ran = await post(`${base}/api/run`, { page, commentId });
      const latencyMs = Date.now() - t0;
      // 200 → the run record; 4xx/5xx → {error, errorType, run}. Score the
      // run record either way — a failed run is a scoreable (bad) outcome.
      const run = ran.status === 200 ? ran.body : (ran.body?.run ?? {});
      const scored = score(fixture, run);
      const metrics = typeof run.runId === 'string'
        ? await runMetrics(run.runId, run.model ?? tierModel)
        : { estCostUsd: 0 };
      results.push({
        name: fixture.name,
        archetype: fixture.expectedArchetype,
        actualArchetype: run.archetype ?? null,
        model: run.model ?? tierModel,
        lane: run.lane ?? null,
        httpStatus: ran.status,
        runStatus: run.status ?? null,
        score: scored.score,
        breakdown: scored.breakdown,
        notes: scored.notes,
        latencyMs,
        estCostUsd: metrics.estCostUsd,
      });
    }
  } finally {
    await close();
    if (prevTraceDir === undefined) delete process.env.REDLINE_TRACE_DIR;
    else process.env.REDLINE_TRACE_DIR = prevTraceDir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(bundleDir, { recursive: true, force: true });
  }

  const overall = printTable(tier, tierModel, results);
  return {
    model: tierModel,
    overall: Math.round(overall * 1000) / 1000,
    perArchetype: perArchetypeStats(results),
    fixtures: results,
  };
}

// The simple-vs-reference quality comparison (frontload decision 7).
function compareTiers(tiers) {
  const simple = tiers.simple;
  const reference = tiers[REFERENCE_TIER];
  if (!simple || !reference) return null;
  const comparison = {};
  for (const archetype of COMPARED_ARCHETYPES) {
    const s = simple.perArchetype[archetype]?.quality;
    const r = reference.perArchetype[archetype]?.quality;
    if (s === undefined || r === undefined) continue;
    const ratio = r === 0 ? 1 : Math.round((s / r) * 1000) / 1000;
    comparison[archetype] = { simple: s, reference: r, ratio, pass: ratio >= SIMPLE_TARGET_RATIO };
  }
  return comparison;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node runner/eval/run.mjs [--tier <simple|standard|complex|all>] [--live] [--only <substring>] [--out <file>]');
    return 0;
  }

  const fixtures = args.only === null
    ? [...FIXTURES]
    : FIXTURES.filter((f) => f.name.includes(args.only) || f.expectedArchetype === args.only);
  if (fixtures.length === 0) {
    console.error(`no fixtures match --only "${args.only}"`);
    return 1;
  }

  // Live mode is double-gated: the explicit flag AND a key. Anything else is
  // stub mode, with the OpenRouter env scrubbed so the stub run can never
  // touch the real endpoint or carry a real key.
  const live = args.live === true;
  if (live && !process.env.OPENROUTER_API_KEY) {
    console.error('--live requires OPENROUTER_API_KEY to be set');
    return 1;
  }
  if (!live) {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_ENDPOINT;
  }

  const byCommentId = new Map();
  const stubAgent = live ? null : await startStubAgent(byCommentId);
  const tierList = args.tier === 'all' ? [...TIERS] : [args.tier];

  console.log(`redline eval: ${fixtures.length} fixture(s), mode=${live ? 'LIVE (real OpenRouter)' : 'stub'}, `
    + `tier(s): ${tierList.join(', ')}`);

  const tiers = {};
  try {
    for (const tier of tierList) {
      tiers[tier] = await runTier({ tier, fixtures, live, stubAgent, byCommentId });
    }
  } finally {
    if (stubAgent) await stubAgent.close();
  }

  const comparison = compareTiers(tiers);
  if (comparison !== null) {
    console.log(`\nsimple vs ${REFERENCE_TIER} (target: simple >= ${pct(SIMPLE_TARGET_RATIO)} of reference quality):`);
    for (const [archetype, c] of Object.entries(comparison)) {
      console.log(`  ${archetype.padEnd(9)} simple ${pct(c.simple)} / reference ${pct(c.reference)} `
        + `= ${pct(c.ratio)}  ${c.pass ? 'PASS' : 'BELOW TARGET'}`);
    }
  }

  const outPath = args.out !== null
    ? path.resolve(args.out)
    : path.join(REPO_ROOT, 'tmp', 'eval-reports',
      `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({
    mode: live ? 'live' : 'stub',
    createdAt: new Date().toISOString(),
    tiers,
    ...(comparison !== null ? { comparison } : {}),
  }, null, 2) + '\n');
  console.log(`report written to ${outPath}`);

  return 0; // clean harness run — scores never set the exit code
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`eval harness failed: ${err?.message ?? err}`);
    process.exit(1);
  },
);
