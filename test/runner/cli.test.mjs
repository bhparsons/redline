// test/runner/cli.test.mjs — M2 WP4: the terminal-agent surface.
//
// Every case invokes bin/redline.mjs as a real subprocess, because the exit
// code is half the contract. A runner is started in-process here and found by
// the child through .redline.lock; the last group covers auto-start and the
// --no-auto-start refusal.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, LOCK_FILENAME } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { EXIT, parseArgs } from '../../runner/lib/cli.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO, 'bin', 'redline.mjs');

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<p data-rev="r-0002">second paragraph</p>\n'
  + '</body></html>\n';

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

async function makeFixtureDir(tag, stubUrl = null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `redline-cli-${tag}-`));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    telemetry: { endpoint: null },
    ...(stubUrl ? { agent: { apiKey: 'stub-key', endpoint: stubUrl, timeoutMs: 5000 } } : {}),
  }, null, 2));
  return dir;
}

/** Run the CLI. Resolves {code, stdout, stderr} — a nonzero exit is data here,
 *  never a throw. `input` is written to the child's stdin. */
function cli(args, { cwd = REPO, env = {}, input = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], {
      cwd, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

test('CLI argument parsing', async (t) => {
  await t.test('value flags, --flag=value, and switches', () => {
    const { positional, flags } = parseArgs(['doc.html', '--quote', 'q', '--body=b', '--json', '--no-auto-start']);
    assert.deepEqual(positional, ['doc.html']);
    assert.equal(flags.quote, 'q');
    assert.equal(flags.body, 'b');
    assert.equal(flags.json, true);
    assert.equal(flags['no-auto-start'], true);
  });

  await t.test('a value flag with no value is a usage error', () => {
    assert.throws(() => parseArgs(['doc.html', '--quote']), /--quote needs a value/);
    assert.throws(() => parseArgs(['doc.html', '--json=1']), /does not take a value/);
  });
});

test('CLI against a live runner', async (t) => {
  const stub = await startStub();
  const root = await makeFixtureDir('live', stub.url);
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const docFile = path.join(root, 'doc.html');
  let commentId;

  // `distill` was in this list until #158. It is not a regression that it is
  // gone: the distill loop is a feature the rebuild did not carry, and the
  // dispatcher had been pointing at a file the archive extraction deleted.
  // test/runner/cli-entry.test.mjs asserts its absence deliberately.
  await t.test('help still lists the document commands and now the agent ones', async () => {
    const { code, stdout } = await cli(['help']);
    assert.equal(code, 0);
    for (const word of ['serve', 'instrument', 'list', 'source', 'comment', 'run', 'propose', 'status']) {
      assert.match(stdout, new RegExp(`\\b${word}\\b`), word);
    }
  });

  await t.test('list on a document with no comments', async () => {
    const { code, stdout } = await cli(['list', docFile]);
    assert.equal(code, EXIT.ok);
    assert.match(stdout, /no comments on doc\.html/);
  });

  await t.test('source prints the document byte for byte', async () => {
    const { code, stdout } = await cli(['source', docFile]);
    assert.equal(code, EXIT.ok);
    assert.equal(stdout, DOC_HTML, 'no added newline — safe to redirect into a file');
  });

  await t.test('source --blocks prints the block index', async () => {
    const { code, stdout } = await cli(['source', docFile, '--blocks']);
    assert.equal(code, EXIT.ok);
    assert.match(stdout, /r-0001\s+<p>\s+alpha bravo charlie/);
    assert.match(stdout, /r-0002/);
  });

  await t.test('source --json carries the whole envelope', async () => {
    const { code, stdout } = await cli(['source', docFile, '--json']);
    assert.equal(code, EXIT.ok);
    const body = JSON.parse(stdout);
    assert.equal(body.source, DOC_HTML);
    assert.equal(body.blocks.length, 2);
  });

  await t.test('comment adds an anchored comment with agent provenance', async () => {
    const { code, stdout } = await cli([
      'comment', docFile, '--quote', 'bravo', '--block-id', 'r-0001',
      '--body', 'Lead with the ask.', '--agent-name', 'test-cli', '--ai-edits', '--json',
    ]);
    assert.equal(code, EXIT.ok);
    const comment = JSON.parse(stdout);
    assert.equal(comment.creator, 'agent');
    assert.equal(comment.agentName, 'test-cli');
    assert.equal(comment.anchor.blockId, 'r-0001');
    commentId = comment.id;
  });

  await t.test('list shows it, attributed', async () => {
    const { code, stdout } = await cli(['list', docFile]);
    assert.equal(code, EXIT.ok);
    assert.match(stdout, new RegExp(commentId));
    assert.match(stdout, /agent:test-cli/);
    assert.match(stdout, /Lead with the ask\./);
  });

  await t.test('a page id plus --dir works as well as a file path', async () => {
    const { code, stdout } = await cli(['list', 'doc.html', '--dir', root, '--json']);
    assert.equal(code, EXIT.ok);
    assert.equal(JSON.parse(stdout).comments.length, 1);
  });

  await t.test('propose dry-runs by default and exits 0 when valid', async () => {
    const editsFile = path.join(root, 'edits.json');
    await fs.writeFile(editsFile, JSON.stringify({
      edits: [{ blockId: 'r-0001', newInner: 'alpha <strong>bravo</strong> charlie' }],
    }));
    const before = await fs.readFile(docFile, 'utf8');
    const { code, stdout } = await cli(['propose', docFile, '--edits-file', editsFile]);
    assert.equal(code, EXIT.ok);
    assert.match(stdout, /valid: 1 edit\(s\) would apply/);
    assert.equal(await fs.readFile(docFile, 'utf8'), before, 'nothing written');
  });

  await t.test('an invalid dry run exits 4 and says why', async () => {
    const editsFile = path.join(root, 'bad-edits.json');
    await fs.writeFile(editsFile, JSON.stringify({ edits: [{ blockId: 'r-9999', newInner: 'x' }] }));
    const { code, stdout } = await cli(['propose', docFile, '--edits-file', editsFile]);
    assert.equal(code, EXIT.invalid);
    assert.match(stdout, /INVALID \[unknown-block\] on r-9999/);
  });

  await t.test('--apply writes through the runner and records the run', async () => {
    const editsFile = path.join(root, 'apply-edits.json');
    await fs.writeFile(editsFile, JSON.stringify({
      decisions: [{ id: commentId, decision: 'addressed', summary: 'Bolded it.' }],
      edits: [{ blockId: 'r-0001', newInner: 'alpha <strong>bravo</strong> charlie' }],
    }));
    const { code, stdout } = await cli([
      'propose', docFile, '--comment-id', commentId, '--edits-file', editsFile, '--apply', '--json',
    ]);
    assert.equal(code, EXIT.ok);
    const run = JSON.parse(stdout);
    assert.equal(run.status, 'ok');
    assert.equal(run.lane, 'proposed');
    assert.ok((await fs.readFile(docFile, 'utf8')).includes('<strong>bravo</strong>'));
  });

  await t.test('--edits-file - reads the proposal from stdin', async () => {
    const { code, stdout } = await cli(['propose', docFile, '--edits-file', '-'], {
      input: JSON.stringify({ edits: [{ blockId: 'r-0002', newInner: 'second <em>paragraph</em>' }] }),
    });
    assert.equal(code, EXIT.ok);
    assert.match(stdout, /valid: 1 edit\(s\) would apply/);
  });

  await t.test('an unreadable or malformed --edits-file is a usage error', async () => {
    let res = await cli(['propose', docFile, '--edits-file', path.join(root, 'does-not-exist.json')]);
    assert.equal(res.code, EXIT.usage);
    assert.match(res.stderr, /could not read --edits-file/);

    const junk = path.join(root, 'junk.json');
    await fs.writeFile(junk, '{not json');
    res = await cli(['propose', docFile, '--edits-file', junk]);
    assert.equal(res.code, EXIT.usage);
    assert.match(res.stderr, /is not valid JSON/);
  });

  await t.test('status reports the last run', async () => {
    const { code, stdout } = await cli(['status', docFile]);
    assert.equal(code, EXIT.ok);
    assert.match(stdout, /running: false/);
    assert.match(stdout, /last run: run-[0-9a-f]{12}\s+ok\s+lane=proposed/);
  });

  await t.test('set-status reopens the comment', async () => {
    const { code, stdout } = await cli([
      'set-status', docFile, '--comment-id', commentId, '--status', 'open', '--json',
    ]);
    assert.equal(code, EXIT.ok);
    const comment = JSON.parse(stdout);
    assert.equal(comment.status, 'open');
    assert.equal(comment.statusUpdatedBy.creator, 'agent');
  });

  await t.test('run drives the revise loop and prints the decisions', async () => {
    stub.state.result = {
      decisions: [{ id: commentId, decision: 'addressed', summary: 'Rewrote the opener.' }],
      edits: [{ blockId: 'r-0001', newInner: 'The ask, up front.' }],
    };
    const { code, stdout } = await cli(['run', docFile, '--comment-id', commentId]);
    assert.equal(code, EXIT.ok);
    assert.match(stdout, /run-[0-9a-f]{12}\s+ok/);
    assert.match(stdout, /addressed\s+Rewrote the opener\./);
    assert.ok((await fs.readFile(docFile, 'utf8')).includes('The ask, up front.'));
  });

  // ---- error surfaces -------------------------------------------------------

  await t.test('a runner refusal exits 3 with the runner\'s own message', async () => {
    const { code, stderr } = await cli(['set-status', docFile, '--comment-id', 'c-nope', '--status', 'open']);
    assert.equal(code, EXIT.api);
    assert.match(stderr, /unknown comment \(HTTP 404\)/);
  });

  await t.test('--json prints the error body instead of prose', async () => {
    const { code, stdout } = await cli([
      'set-status', docFile, '--comment-id', 'c-nope', '--status', 'open', '--json',
    ]);
    assert.equal(code, EXIT.api);
    assert.deepEqual(JSON.parse(stdout), { error: 'unknown comment' });
  });

  await t.test('usage errors exit 1', async () => {
    for (const args of [
      ['list'],
      ['list', docFile, 'extra.html'],
      ['comment', docFile, '--body', 'no quote'],
      ['run', docFile],
      ['run', docFile, '--comment-id', 'a', '--comment-ids', 'a,b'],
      ['propose', docFile],
      ['bogus', docFile],
    ]) {
      const { code } = await cli(args);
      assert.equal(code, EXIT.usage, args.join(' '));
    }
  });

  await t.test('--runner pins the base URL and skips discovery', async () => {
    const { code, stdout } = await cli([
      'status', 'doc.html', '--dir', root, '--runner', `http://127.0.0.1:${port}`,
    ]);
    assert.equal(code, EXIT.ok);
    assert.match(stdout, /running: false/);
  });
});

test('CLI auto-start', async (t) => {
  const root = await makeFixtureDir('autostart');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const docFile = path.join(root, 'doc.html');

  await t.test('starts a runner, does the work, and leaves nothing running', async () => {
    const { code, stdout } = await cli(['list', docFile]);
    assert.equal(code, EXIT.ok);
    assert.match(stdout, /no comments/);
    await assert.rejects(fs.readFile(path.join(root, LOCK_FILENAME)), /ENOENT/, 'lock released');
  });

  await t.test('--no-auto-start exits 2 with the manual command', async () => {
    const { code, stderr } = await cli(['list', docFile, '--no-auto-start']);
    assert.equal(code, EXIT.runner);
    assert.match(stderr, /auto-start is disabled/);
    assert.match(stderr, /node runner\/index\.mjs/);
  });
});
