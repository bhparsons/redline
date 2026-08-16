// test/runner/proposed-run-trace.test.mjs — #233: a session-authored run
// (lane 'proposed') writes run.json into its trace bundle, symmetric with the
// direct-edit and paid lanes. It was the thinnest trace of any lane —
// scope.json and nothing else — so "what did that session do" had no answer
// in the bundle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.REDLINE_TRACE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-ptrace-'));
delete process.env.OPENROUTER_API_KEY;
delete process.env.REDLINE_OTEL_ENDPOINT;

const { startServer } = await import('../../runner/lib/server.mjs');
const { traceDir } = await import('../../runner/lib/trace.mjs');

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha</p>\n</body></html>\n';

test('a proposed run\'s bundle carries run.json alongside scope.json (#233)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-ptrace-root-'));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, 'doc.html'), DOC_HTML);

  const res = await fetch(`http://127.0.0.1:${port}/api/propose-edits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      page: 'doc.html', dryRun: false,
      edits: [{ blockId: 'r-0001', newInner: 'alpha, proposed' }],
      creator: 'agent', agentName: 'session',
    }),
  });
  assert.equal(res.status, 200);
  const run = await res.json();
  assert.equal(run.lane, 'proposed');

  const files = (await fs.readdir(traceDir(run.runId))).sort();
  assert.deepEqual(files, ['run.json', 'scope.json'],
    'the bundle holds the run record next to the scope log');
  const runJson = JSON.parse(await fs.readFile(path.join(traceDir(run.runId), 'run.json'), 'utf8'));
  assert.deepEqual(runJson, run, 'run.json is the run record the API returned');
  assert.ok(Number.isFinite(runJson.rev),
    'written AFTER the sidecar save, so it carries the stamped run.rev (#88)');
});
