// test/runner/direct-edit-surfaces.test.mjs — #186: direct edit on the MCP and
// CLI surfaces.
//
// POST /api/edit has replaced one block's inner through the full
// surgery/validation/snapshot pipeline since WP10, with no model call. It was
// reachable over HTTP only, so this phase's headline case — a local session
// edits your document for free — required an agent to hand-roll HTTP around
// api-client.mjs, the module that exists to keep the MCP and CLI surfaces from
// drifting.
//
// Done when (from the ticket): an MCP-speaking agent with no OpenRouter key can
// revise a block end to end, the run shows lane 'direct-edit' with its
// agentName, and POST /api/undo reverts it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { TOOLS, callTool, closeAll } from '../../runner/lib/mcp-tools.mjs';
import { runCli, EXIT } from '../../runner/lib/cli.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.REDLINE_OTEL_ENDPOINT;

const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n<p data-rev="r-0002">delta</p>\n</body></html>\n';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-directverb-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  // No apiKey at all: the whole point is that this path spends nothing.
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ telemetry: { endpoint: null } }, null, 2));
  const server = await startServer({ root: dir, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    dir,
    base,
    docPath: path.join(dir, 'doc.html'),
    env: { REDLINE_RUNNER_URL: base, REDLINE_AGENT_NAME: 'test-agent' },
    readDoc: () => fs.readFile(path.join(dir, 'doc.html'), 'utf8'),
    async close() {
      await closeAll();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('redline_direct_edit revises a block end to end with no API key', async () => {
  const f = await fixture();
  try {
    const info = await (await fetch(`${f.base}/api/info`)).json();
    assert.equal(info.hasApiKey, false, 'no key configured — nothing here may need one');

    const run = await callTool('redline_direct_edit', {
      file: 'doc.html', blockId: 'r-0001', newInner: 'alpha — “bravo” charlie',
    }, { env: f.env });

    assert.equal(run.lane, 'direct-edit');
    assert.equal(run.status, 'ok');
    // Attributable without the caller remembering to say so.
    assert.deepEqual(run.actor, { creator: 'agent', agentName: 'test-agent' });
    // Same surgery pipeline as any other write: entity-encoded, never
    // DOM-reserialized.
    assert.match(await f.readDoc(), /<p data-rev="r-0001">alpha &mdash; &ldquo;bravo&rdquo; charlie<\/p>/);

    const undone = await callTool('redline_undo', {
      file: 'doc.html', expectRunId: run.runId,
    }, { env: f.env });
    assert.ok(undone);
    assert.match(await f.readDoc(), /<p data-rev="r-0001">alpha bravo charlie<\/p>/);
  } finally {
    await f.close();
  }
});

test('redline_direct_edit validates its arguments before reaching the runner', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => callTool('redline_direct_edit', { file: 'doc.html', newInner: 'x' }, { env: f.env }),
      /blockId is required/,
    );
    await assert.rejects(
      () => callTool('redline_direct_edit', { file: 'doc.html', blockId: 'r-0001' }, { env: f.env }),
      /newInner must be a string/,
    );
    // An empty string is a legitimate edit (empty the block), not a missing one.
    const run = await callTool('redline_direct_edit', {
      file: 'doc.html', blockId: 'r-0002', newInner: '',
    }, { env: f.env });
    assert.equal(run.status, 'ok');
    assert.match(await f.readDoc(), /<p data-rev="r-0002"><\/p>/);
  } finally {
    await f.close();
  }
});

test('the tool description carries the truncated-index gotcha', () => {
  // The failure it prevents is SILENT: an agent that builds newInner from
  // blocks[].text strips inline markup and cuts long blocks short, and the edit
  // applies cleanly. The warning is the only thing standing in front of it.
  const tool = TOOLS.find((t) => t.name === 'redline_direct_edit');
  assert.ok(tool, 'redline_direct_edit is registered');
  assert.match(tool.description, /TRUNCATED PLAIN\s*TEXT/);
  assert.match(tool.description, /full source/i);
  assert.match(tool.description, /redline_propose_edits/, 'points at the multi-block verb');
});

test('redline edit <page> --block-id --inner writes and reports the run', async () => {
  const f = await fixture();
  const lines = [];
  const errors = [];
  try {
    const code = await runCli(
      ['edit', 'doc.html', '--block-id', 'r-0001', '--inner', 'ALPHA'],
      { env: f.env, out: (t) => lines.push(t), err: (t) => errors.push(t) },
    );
    assert.equal(code, EXIT.ok, errors.join('\n'));
    assert.match(lines.join('\n'), /ok\s+lane=direct-edit\s+r-0001/);
    assert.match(await f.readDoc(), /<p data-rev="r-0001">ALPHA<\/p>/);
  } finally {
    await f.close();
  }
});

test('redline edit: --json is the runner\'s answer, --block is an accepted alias', async () => {
  const f = await fixture();
  const lines = [];
  try {
    const code = await runCli(
      ['edit', 'doc.html', '--block', 'r-0002', '--inner', 'DELTA', '--json'],
      { env: f.env, out: (t) => lines.push(t), err: () => {} },
    );
    assert.equal(code, EXIT.ok);
    const run = JSON.parse(lines.join('\n'));
    assert.equal(run.lane, 'direct-edit');
    assert.deepEqual(run.actor, { creator: 'agent', agentName: 'test-agent' });
  } finally {
    await f.close();
  }
});

test('redline edit: missing flags are usage errors, not runner calls', async () => {
  const f = await fixture();
  const errors = [];
  try {
    const opts = { env: f.env, out: () => {}, err: (t) => errors.push(t) };
    assert.equal(await runCli(['edit', 'doc.html', '--inner', 'x'], opts), EXIT.usage);
    assert.equal(await runCli(['edit', 'doc.html', '--block-id', 'r-0001'], opts), EXIT.usage);
    assert.match(errors.join('\n'), /--block-id is required/);
    assert.match(errors.join('\n'), /--inner is required/);
    // An unknown block is the RUNNER's refusal, and exits differently.
    assert.equal(
      await runCli(['edit', 'doc.html', '--block-id', 'r-nope', '--inner', 'x'], opts),
      EXIT.api,
    );
  } finally {
    await f.close();
  }
});
