// test/runner/undo-expect-run-id.test.mjs — #164: undo names the run it means.
//
// The failure: /api/undo takes no run id and reverts whichever ok|partial run
// is on top. So an agent applies an edit (run A), the human fixes a block in
// the browser (run B, lane 'direct-edit'), the agent decides run A was wrong
// and calls undo — and run B, the human's work, is what disappears. The agent
// gets 200.
//
// The pre-undo snapshot means those bytes survive in .history/, but nothing
// reads them: there is no redo endpoint and no UI, so recovery is manual.
// Refusing is cheaper than recovering.
//
// expectRunId is OPTIONAL by design — the overlay's Undo button passes no id
// and must keep working, because a human clicking it can see what is on top.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">agent will edit this one</p>\n'
  + '<p data-rev="r-0002">human will edit this one</p>\n</body></html>\n';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-undo-guard-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME),
    JSON.stringify({ telemetry: { endpoint: null } }, null, 2));
  return dir;
}

const postJson = (url, payload) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

test('#164: undo refuses when the run on top is not the one named', async (t) => {
  const root = await fixture();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const readDoc = () => fs.readFile(docPath, 'utf8');

  // Run A — the agent's edit, through the same pipeline a real run uses.
  const a = await postJson(`${base}/api/propose-edits`, {
    page: 'doc.html',
    dryRun: false,
    creator: 'agent',
    agentName: 'claude-code',
    edits: [{ blockId: 'r-0001', newInner: 'the agent rewrote this' }],
  });
  assert.equal(a.status, 200);
  const runA = (await a.json()).runId;
  assert.ok(runA, 'run A has an id');

  // Run B — the human, editing after the agent. This is the run that is now on
  // top, and the one a naive undo would revert.
  const b = await postJson(`${base}/api/edit`, {
    page: 'doc.html',
    blockId: 'r-0002',
    newInner: 'the human fixed this by hand',
  });
  assert.equal(b.status, 200);
  const runB = (await b.json()).runId;
  assert.notEqual(runA, runB);

  await t.test('naming run A while run B is on top is refused', async () => {
    const before = await readDoc();
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html', expectRunId: runA });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.expected, runA);
    assert.equal(body.actual, runB, 'the error names what is actually on top');
    assert.equal(await readDoc(), before, 'the document is untouched');
    assert.match(await readDoc(), /the human fixed this by hand/);
  });

  await t.test('a malformed expectRunId is rejected, not ignored', async () => {
    // Silently ignoring it would be the worst outcome: the caller believes it
    // is guarded and is not.
    for (const bad of ['', 42, null]) {
      const res = await postJson(`${base}/api/undo`, { page: 'doc.html', expectRunId: bad });
      assert.equal(res.status, 400, `expectRunId: ${JSON.stringify(bad)}`);
      assert.match((await res.json()).error, /expectRunId/);
    }
    assert.match(await readDoc(), /the human fixed this by hand/);
  });

  await t.test('naming the run that IS on top reverts it', async () => {
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html', expectRunId: runB });
    assert.equal(res.status, 200);
    const doc = await readDoc();
    assert.doesNotMatch(doc, /the human fixed this by hand/, 'run B is reverted');
    assert.match(doc, /the agent rewrote this/, 'run A still stands');
  });

  await t.test('omitting expectRunId keeps last-run-wins for the overlay button', async () => {
    // The human clicking Undo passes no id and can see what is on top.
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html' });
    assert.equal(res.status, 200);
    assert.match(await readDoc(), /agent will edit this one/, 'back to the original');
  });
});
