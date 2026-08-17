// test/runner/lock-honesty.test.mjs — #303 and #304, both cases of a surface
// saying something that was not true.
//
// #303: `redline propose --edits-file` forwarded three of the six fields the
//       payload validator accepts and dropped the rest — then answered ok.
// #304: startup refused a lock on a live PID alone, so a SUSPENDED runner
//       (Ctrl-Z; state T, holding its port, answering nothing) was reported as
//       "already serving".

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<section data-rev="r-sec"><p data-rev="r-0001">alpha bravo charlie</p></section>\n'
  + '<style data-rev-theme></style>\n</body></html>\n';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-lock-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ telemetry: { endpoint: null } }));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('#303: a theme in an --edits-file reaches the endpoint and trips the gate', async (t) => {
  const dir = await fixture(t);
  const server = await startServer({ root: dir, port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const { runCli } = await import('../../runner/lib/cli.mjs');
  const editsFile = path.join(dir, 'edits.json');
  await fs.writeFile(editsFile, JSON.stringify({ theme: 'color: #222;' }));

  // runCli takes its sinks, so capture both — a gated proposal may report
  // through either, and guessing which was how the first version of this test
  // parsed an empty string.
  const said = [];
  await runCli(['propose', 'doc.html', '--dir', dir, '--runner', base,
    '--edits-file', editsFile, '--apply', '--json'],
  { out: (t) => said.push(t), err: (t) => said.push(t) });

  const out = JSON.parse(said.join('\n'));
  // The page-level gate is the proof the theme arrived: it fires on a theme
  // change and on nothing else here. Before the fix this came back
  // status ok / edits [] / no gate — success, having done nothing.
  assert.equal(out.pendingConfirmation, true, 'the theme reached the endpoint and tripped the gate');
  assert.equal(out.scope?.level, 'page');
});

test('#303: attributeEdits and scope are forwarded too', async (t) => {
  const dir = await fixture(t);
  const server = await startServer({ root: dir, port: 0 });
  t.after(() => server.close());

  const { runCli } = await import('../../runner/lib/cli.mjs');
  const editsFile = path.join(dir, 'edits.json');
  await fs.writeFile(editsFile, JSON.stringify({
    attributeEdits: [{ blockId: 'r-0001', style: 'font-weight: 600' }],
    // A declared scope waives the pause — which is only observable if it is sent.
    scope: { requiresConfirmation: false, summary: 'deliberate, asked for in words' },
  }));

  const said = [];
  await runCli(['propose', 'doc.html', '--dir', dir, '--runner', `http://127.0.0.1:${server.port}`,
    '--edits-file', editsFile, '--apply', '--json'],
  { out: (t) => said.push(t), err: (t) => said.push(t) });

  const out = JSON.parse(said.join('\n'));
  assert.notEqual(out.pendingConfirmation, true, 'the declared scope waived the pause, so it was sent');
  assert.ok(Array.isArray(out.edits), 'and the attribute edit was applied as a run');
});

test('#304: a lock held by something that does not answer is named as such', async (t) => {
  const dir = await fixture(t);

  // A lock naming THIS process — alive, certainly — on a port nothing serves.
  // That is exactly the shape a Ctrl-Z'd runner leaves behind.
  const dead = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  await fs.writeFile(path.join(dir, '.redline.lock'),
    JSON.stringify({ pid: process.pid, port: dead, startedAt: new Date(0).toISOString() }));

  await assert.rejects(
    () => startServer({ root: dir, port: 0 }),
    (err) => {
      assert.match(err.message, /not responding/, 'it says the runner is not answering');
      assert.match(err.message, /suspended/, 'and names the likeliest cause');
      assert.doesNotMatch(err.message, /already serving/,
        'it must NOT claim something is being served when nothing is');
      return true;
    },
  );
});

test('#304: a lock held by a runner that DOES answer still refuses, as before', async (t) => {
  const dir = await fixture(t);
  const first = await startServer({ root: dir, port: 0 });
  t.after(() => first.close());

  await assert.rejects(
    () => startServer({ root: dir, port: 0 }),
    (err) => {
      assert.match(err.message, /already serving/, 'a real holder is still a real refusal');
      return true;
    },
  );
});
