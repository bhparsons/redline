// test/runner/agent-integration.test.mjs — M2 WP6: the agent access layer end
// to end, through both surfaces, against one runner.
//
// Two questions this file exists to answer:
//
//   1. Can an agent actually do the loop? Add a comment, trigger a revision,
//      read the outcome — once over MCP, once over the CLI, both as real
//      subprocesses against the same document.
//   2. Is the runner still the only writer? Nothing an agent can reach writes
//      the document except through validated, snapshotted, recorded applies —
//      and every byte that changed is attributable to one of them.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO, 'bin', 'redline.mjs');
const MCP_ENTRY = path.join(REPO, 'runner', 'mcp-server.mjs');

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<p data-rev="r-0002">second paragraph</p>\n'
  + '<p data-rev="r-0003">third paragraph</p>\n'
  + '</body></html>\n';

// --- fixtures ----------------------------------------------------------------

function startStub() {
  const state = { result: { decisions: [], edits: [] } };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(state.result) } }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      state,
      url: `http://127.0.0.1:${server.address().port}/chat/completions`,
      close: () => new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
    }));
  });
}

async function makeFixtureDir(stubUrl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-agent-e2e-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    telemetry: { endpoint: null },
    agent: { apiKey: 'stub-key', endpoint: stubUrl, timeoutMs: 5000 },
  }, null, 2));
  return dir;
}

function cli(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], {
      cwd: REPO, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    child.stdin.end();
  });
}

function startMcp(env = {}) {
  const child = spawn(process.execPath, [MCP_ENTRY], {
    cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  const pending = new Map();
  const stderr = [];
  child.stderr.on('data', (c) => stderr.push(String(c)));
  readline.createInterface({ input: child.stdout, terminal: false }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const resolve = pending.get(String(msg.id));
    if (resolve) {
      pending.delete(String(msg.id));
      resolve(msg);
    }
  });
  let nextId = 1;
  const call = (name, args) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(String(id), (msg) => {
      if (msg.error) return reject(new Error(msg.error.message));
      const text = msg.result.content[0].text;
      resolve(msg.result.isError ? { isError: true, text } : JSON.parse(text));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    setTimeout(() => reject(new Error(`no reply to ${name} (stderr: ${stderr.join('')})`)), 30_000).unref();
  });
  const close = () => new Promise((resolve) => {
    child.on('exit', resolve);
    child.stdin.end();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10_000).unref();
  });
  return { call, close };
}

/** Every pre-run snapshot directory recorded for a page, by run id. */
async function snapshotRunIds(root, page) {
  const dir = path.join(root, '.history', encodeURIComponent(page));
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => /__pre-run__([\w-]+)$/.exec(n))
    .filter(Boolean)
    .map((m) => m[1]);
}

// --- the loop, through both surfaces -----------------------------------------

test('an agent runs the whole loop through MCP and the CLI', async (t) => {
  const stub = await startStub();
  const root = await makeFixtureDir(stub.url);
  const { port, close } = await startServer({ root, port: 0 });
  const mcp = startMcp({ REDLINE_AGENT_NAME: 'mcp-agent' });
  t.after(async () => {
    await mcp.close();
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const docFile = path.join(root, 'doc.html');
  const sidecarPath = `${docFile}.review.json`;
  const readDoc = () => fs.readFile(docFile, 'utf8');
  const readSidecar = async () => JSON.parse(await fs.readFile(sidecarPath, 'utf8'));

  let mcpCommentId;
  let cliCommentId;

  await t.test('MCP: read the document, comment on it, revise it', async () => {
    const source = await mcp.call('redline_read_source', { file: docFile });
    const target = source.blocks.find((b) => b.text.startsWith('alpha'));
    assert.equal(target.id, 'r-0001');

    const added = await mcp.call('redline_add_comment', {
      file: docFile, body: 'Put the ask first.', quote: 'alpha bravo charlie', blockId: target.id, aiEdits: true,
    });
    mcpCommentId = added.comment.id;
    assert.equal(added.comment.creator, 'agent');
    assert.equal(added.comment.agentName, 'mcp-agent');

    stub.state.result = {
      decisions: [{ id: mcpCommentId, decision: 'addressed', summary: 'Opened with the ask.' }],
      edits: [{ blockId: 'r-0001', newInner: 'The ask, first.' }],
    };
    const out = await mcp.call('redline_run_revision', { file: docFile, commentId: mcpCommentId });
    assert.equal(out.run.status, 'ok');

    assert.match(await readDoc(), /The ask, first\./);
    const sidecar = await readSidecar();
    const comment = sidecar.comments.find((c) => c.id === mcpCommentId);
    assert.equal(comment.status, 'addressed');
    assert.equal(comment.resolution.summary, 'Opened with the ask.');
  });

  await t.test('CLI: the same loop, same runner, from the shell', async () => {
    const added = await cli([
      'comment', docFile, '--quote', 'second paragraph', '--block-id', 'r-0002',
      '--body', 'Tighten this.', '--agent-name', 'cli-agent', '--ai-edits', '--json',
    ]);
    assert.equal(added.code, 0);
    cliCommentId = JSON.parse(added.stdout).id;

    stub.state.result = {
      decisions: [{ id: cliCommentId, decision: 'addressed', summary: 'Tightened.' }],
      edits: [{ blockId: 'r-0002', newInner: 'Second, tighter.' }],
    };
    const ran = await cli(['run', docFile, '--comment-id', cliCommentId, '--json']);
    assert.equal(ran.code, 0);
    assert.equal(JSON.parse(ran.stdout).status, 'ok');
    assert.match(await readDoc(), /Second, tighter\./);
  });

  await t.test('both surfaces see one shared review state', async () => {
    const fromCli = JSON.parse((await cli(['list', docFile, '--json'])).stdout);
    const fromMcp = await mcp.call('redline_list_comments', { file: docFile });
    assert.deepEqual(
      fromCli.comments.map((c) => c.id).sort(),
      fromMcp.comments.map((c) => c.id).sort(),
    );
    const byAgent = Object.fromEntries(fromMcp.comments.map((c) => [c.agentName, c.id]));
    assert.equal(byAgent['mcp-agent'], mcpCommentId);
    assert.equal(byAgent['cli-agent'], cliCommentId);
  });

  await t.test('an agent proposal round-trips: invalid, fixed, applied', async () => {
    const bad = await mcp.call('redline_propose_edits', {
      file: docFile, edits: [{ blockId: 'r-0404', newInner: 'x' }],
    });
    assert.equal(bad.valid, false);
    assert.equal(bad.code, 'unknown-block');

    const good = await mcp.call('redline_propose_edits', {
      file: docFile, edits: [{ blockId: 'r-0003', newInner: 'Third, revised.' }],
    });
    assert.equal(good.valid, true);

    const applied = await mcp.call('redline_propose_edits', {
      file: docFile, dryRun: false, edits: [{ blockId: 'r-0003', newInner: 'Third, revised.' }],
    });
    assert.equal(applied.status, 'ok');
    assert.match(await readDoc(), /Third, revised\./);
  });

  // ---- the runner is the only writer ---------------------------------------

  await t.test('no HTTP method serves a way to write a file', async () => {
    const base = `http://127.0.0.1:${port}`;
    const before = await readDoc();
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
      const res = await fetch(`${base}/doc.html`, {
        method, body: method === 'DELETE' ? undefined : '<html>overwritten</html>',
      });
      assert.equal(res.status, 405, method);
    }
    assert.equal(await readDoc(), before, 'document byte-identical');
  });

  await t.test('the config file (which can hold the API key) is never served', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/${CONFIG_FILENAME}`);
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.ok(!text.includes('stub-key'));
  });

  await t.test('a proposal cannot touch data-rev marks', async () => {
    const before = await readDoc();
    const out = await mcp.call('redline_propose_edits', {
      file: docFile, dryRun: false,
      edits: [{ blockId: 'r-0001', newInner: '<span data-rev="r-9999">smuggled</span>' }],
    });
    assert.equal(out.isError, true, 'refused as an apply failure');
    assert.match(out.text, /data-rev/);
    assert.equal(await readDoc(), before, 'document byte-identical');
  });

  await t.test('a proposal cannot write unbalanced markup', async () => {
    const before = await readDoc();
    const out = await mcp.call('redline_propose_edits', {
      file: docFile, dryRun: false, edits: [{ blockId: 'r-0001', newInner: '<em>oops' }],
    });
    assert.equal(out.isError, true);
    assert.equal(await readDoc(), before);
  });

  await t.test('non-ASCII from an agent is entity-encoded, never written literally', async () => {
    const out = await cli(['propose', docFile, '--edits-file', '-', '--apply', '--json'], {});
    assert.equal(out.code, 1, 'no --edits-file content on a closed stdin is a usage error');

    const editsFile = path.join(root, 'unicode.json');
    await fs.writeFile(editsFile, JSON.stringify({
      edits: [{ blockId: 'r-0001', newInner: 'The ask — first.' }],
    }));
    const applied = await cli(['propose', docFile, '--edits-file', editsFile, '--apply', '--json']);
    assert.equal(applied.code, 0);
    const source = await readDoc();
    assert.ok(source.includes('The ask &mdash; first.'), 'encoded on the way in');
    assert.ok(!/[^\x00-\x7F]/.test(source), 'document stays ASCII-only');
  });

  await t.test('a failed revise run restores the document', async () => {
    const before = await readDoc();
    stub.state.result = {
      decisions: [{ id: mcpCommentId, decision: 'addressed', summary: 'tried' }],
      edits: [{ blockId: 'r-nonexistent', newInner: 'nope' }],
    };
    await cli(['set-status', docFile, '--comment-id', mcpCommentId, '--status', 'open']);
    const out = await mcp.call('redline_run_revision', { file: docFile, commentId: mcpCommentId });
    assert.equal(out.isError, true);
    assert.match(out.text, /edit rejected/);
    assert.equal(await readDoc(), before, 'restored from the pre-run snapshot');
  });

  await t.test('every document write is recorded and undoable', async () => {
    const sidecar = await readSidecar();
    const okRuns = sidecar.runs.filter((r) => r.status === 'ok');
    assert.ok(okRuns.length >= 4, `runs recorded: ${sidecar.runs.length}`);

    // Every applied edit is attributable to a run, and every run that wrote
    // has a pre-run snapshot to go back to.
    const snapshots = new Set(await snapshotRunIds(root, 'doc.html'));
    for (const run of okRuns) {
      assert.ok(snapshots.has(run.runId), `snapshot for ${run.runId}`);
      for (const edit of run.edits) {
        assert.equal(typeof edit.blockId, 'string');
        assert.equal(typeof edit.afterInner, 'string');
      }
    }

    // The document's current content came from the last write, and undo walks
    // it back to the state before that run.
    const last = okRuns.at(-1);
    const before = await readDoc();
    const undone = await fetch(`http://127.0.0.1:${port}/api/undo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 'doc.html' }),
    });
    assert.equal(undone.status, 200);
    assert.equal((await undone.json()).runId, last.runId);
    assert.notEqual(await readDoc(), before, 'undo moved the document back');
  });

  await t.test('the sidecar records who did what, for every agent action', async () => {
    const sidecar = await readSidecar();
    for (const comment of sidecar.comments) {
      assert.equal(comment.creator, 'agent', comment.id);
      assert.ok(['mcp-agent', 'cli-agent'].includes(comment.agentName), comment.agentName);
    }
    const proposals = sidecar.runs.filter((r) => r.lane === 'proposed');
    assert.ok(proposals.length >= 1);
    for (const run of proposals) {
      assert.equal(run.actor.creator, 'agent');
      assert.ok(typeof run.actor.agentName === 'string');
    }
  });
});
