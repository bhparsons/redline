// test/runner/send-all.test.mjs — Send All batch runs (contract amendment
// 2026-07-22, design/11-send-all-decision.html recommendation B).
//
// Self-contained like the other runner tests: fixture dir in a tmpdir, the
// runner on an OS-assigned port, and a stub OpenRouter chat-completions
// server — NO real network calls anywhere. The stub replies from a QUEUE
// (one entry per agent call) because a batch makes one call per comment,
// sequentially, in request order. Covers the batch happy path (one run
// record, per-comment provenance, sequential composition — call N's prompt
// sees call N-1's edit), strict atomicity (mid-batch transport AND
// validation failures restore everything), request validation, the page
// lock, and batch undo (one undo reverts the whole batch).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { promptText } from '../../runner/lib/agent.mjs';

// Pin the env so a developer's real OPENROUTER_* vars can't leak in.
// (test.mjs runs each file in its own process, so this is safe.)
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;

const CONFIG_KEY = 'cfg-test-key';
const UPSTREAM_SECRET = 'upstream-secret-detail-must-not-leak';

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<p data-rev="r-0002">delta echo foxtrot</p>\n'
  + '<p data-rev="r-0003">golf hotel india</p>\n</body></html>\n';

function resultFor(commentId, edits = []) {
  return {
    decisions: [{ id: commentId, decision: 'addressed', summary: 'Did the thing.' }],
    edits,
  };
}

// --- stub OpenRouter server: one queued reply per agent call ----------------

function startStub() {
  const state = { queue: [], requests: [], hung: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const chat = (content) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      };
      // WP3/WP4: comments may make ROUTER and TACTICAL calls before the
      // revise call. Answer those with garbage (→ fallback route / tactical
      // escalation, the pre-router behavior) WITHOUT consuming the queue.
      if (promptText(parsed.messages).startsWith('# Redline comment router')
        || promptText(parsed.messages).startsWith('# Redline tactical edit')) {
        return chat('not json — force the fallback path');
      }
      state.requests.push({ headers: req.headers, body: parsed });
      const entry = state.queue.shift() ?? { mode: 'ok', result: { decisions: [] } };
      switch (entry.mode) {
        case 'ok': return chat(JSON.stringify(entry.result));
        case 'http500':
          res.writeHead(500, { 'content-type': 'text/plain' });
          return res.end(UPSTREAM_SECRET);
        case 'hang': return state.hung.push(res); // never respond
        default: return chat(JSON.stringify(entry.result));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        server,
        url: `http://127.0.0.1:${server.address().port}/chat/completions`,
        close: () => new Promise((r) => {
          for (const res of state.hung) res.destroy();
          server.closeAllConnections?.();
          server.close(r);
        }),
      });
    });
  });
}

async function makeFixtureDir(stubUrl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-sendall-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: CONFIG_KEY, endpoint: stubUrl, timeoutMs: 600 },
    telemetry: { endpoint: null }, // never export from tests
    models: {
      tactical: 'test/tactical-model',
      redesign: 'test/redesign-model',
      research: 'test/research-model',
      accessibility: 'test/accessibility-model',
      content: 'test/content-model',
    },
  }, null, 2));
  return dir;
}

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function createComment(base, page, body, anchor) {
  const res = await postJson(`${base}/api/comment`, { page, body, anchor });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}

// --- POST /api/run {commentIds} ---------------------------------------------

test('POST /api/run with commentIds (Send All batch)', async (t) => {
  const stub = await startStub();
  const root = await makeFixtureDir(stub.url);
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const sidecar = async () => JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
  const runBatch = (commentIds) => postJson(`${base}/api/run`, { page: 'doc.html', commentIds });

  // Three archetypes, three blocks — the batch routes each comment on its own.
  const c1 = await createComment(base, 'doc.html',
    'Change bravo to BRAVO.', { blockId: 'r-0001', quote: 'bravo' });
  const c2 = await createComment(base, 'doc.html',
    'Add ARIA labels so screen readers can announce this properly.',
    { blockId: 'r-0002', quote: 'echo' });
  const c3 = await createComment(base, 'doc.html',
    'Rewrite this paragraph in a warmer tone.', { blockId: 'r-0001', quote: 'alpha' });

  await t.test('happy path: one run record, per-comment routing, sequential composition', async () => {
    stub.state.queue = [
      { mode: 'ok', result: resultFor(c1, [{ blockId: 'r-0001', newInner: 'alpha BRAVO charlie' }]) },
      { mode: 'ok', result: resultFor(c2, [{ blockId: 'r-0002', newInner: 'delta <strong>echo</strong> foxtrot' }]) },
      // Third call edits the SAME block the first call edited — its newInner
      // (and the assertions below on its prompt) only make sense if it saw
      // the doc as call 1 left it.
      { mode: 'ok', result: resultFor(c3, [{ blockId: 'r-0001', newInner: 'alpha BRAVO charlie, warmly' }]) },
    ];
    const requestsBefore = stub.state.requests.length;
    const res = await runBatch([c1, c2, c3]);
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.match(run.runId, /^run-[0-9a-f]{12}$/);
    assert.equal(run.status, 'ok');
    assert.deepEqual(run.commentIds, [c1, c2, c3]);
    assert.equal(run.commentId, undefined, 'batch records carry commentIds, not commentId');
    assert.equal(run.archetype, null);
    assert.equal(run.model, null);
    // `context` is the per-comment manifest (#94) — asserted separately below
    // so this stays a check of ROUTING, not of diagnostics.
    assert.deepEqual(run.perComment.map(({ context, ...rest }) => rest), [
      { commentId: c1, archetype: 'tactical', model: 'test/tactical-model', tier: 'simple', routeSource: 'fallback', status: 'ok' },
      { commentId: c2, archetype: 'accessibility', model: 'test/accessibility-model', tier: 'standard', routeSource: 'fallback', status: 'ok' },
      { commentId: c3, archetype: 'content', model: 'test/content-model', tier: 'simple', routeSource: 'fallback', status: 'ok' },
    ]);
    // Every comment that reached the standard lane carries its own manifest.
    for (const entry of run.perComment) {
      if (entry.archetype === 'tactical') continue; // tactical lane renders its own prompt
      assert.ok(entry.context?.prompt?.chars > 0, `${entry.commentId} should carry a context manifest`);
      assert.ok(Array.isArray(entry.context.prompt.sections));
    }
    assert.deepEqual(run.decisions.map((d) => d.id), [c1, c2, c3], 'one decision per comment, in order');
    assert.deepEqual(run.edits, [
      { blockId: 'r-0001', beforeInner: 'alpha bravo charlie', afterInner: 'alpha BRAVO charlie' },
      { blockId: 'r-0002', beforeInner: 'delta echo foxtrot', afterInner: 'delta <strong>echo</strong> foxtrot' },
      { blockId: 'r-0001', beforeInner: 'alpha BRAVO charlie', afterInner: 'alpha BRAVO charlie, warmly' },
    ], 'apply-time records chain before/after across the batch');

    // One agent call per comment, in order, each on its own model, and each
    // prompt carrying only its own comment — call 3 sees call 1's edit.
    const calls = stub.state.requests.slice(requestsBefore);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((r) => r.body.model),
      ['test/tactical-model', 'test/accessibility-model', 'test/content-model']);
    const prompts = calls.map((r) => promptText(r.body.messages));
    assert.ok(prompts[0].includes('Change bravo to BRAVO.'));
    assert.ok(prompts[1].includes('Add ARIA labels'));
    assert.ok(!prompts[1].includes('Change bravo to BRAVO.'), 'each call carries only its own comment');
    assert.ok(prompts[2].includes('alpha BRAVO charlie'), 'call 3 sees the doc as call 1 left it');

    // The doc composed all three edits; the sidecar has ONE run record and
    // every comment got its own status + resolution.
    const htmlAfter = await fs.readFile(docPath, 'utf8');
    assert.ok(htmlAfter.includes('alpha BRAVO charlie, warmly'));
    assert.ok(htmlAfter.includes('delta <strong>echo</strong> foxtrot'));
    const data = await sidecar();
    assert.equal(data.runs.length, 1);
    for (const id of [c1, c2, c3]) {
      const comment = data.comments.find((c) => c.id === id);
      assert.equal(comment.status, 'addressed', id);
      assert.deepEqual(comment.resolution,
        { runId: run.runId, decision: 'addressed', summary: 'Did the thing.' }, id);
    }
  });

  await t.test('a batch of one is allowed and still records the batch shape', async () => {
    const c4 = await createComment(base, 'doc.html',
      'Change delta to DELTA.', { blockId: 'r-0002', quote: 'delta' });
    stub.state.queue = [{ mode: 'ok', result: resultFor(c4) }];
    const run = await (await runBatch([c4])).json();
    assert.equal(run.status, 'ok');
    assert.deepEqual(run.commentIds, [c4]);
    assert.equal(run.commentId, undefined);
    assert.equal(run.perComment.length, 1);
  });

  await t.test('partial apply: a mid-batch failure keeps the successes, marks the failure (WP8)', async () => {
    const d1 = await createComment(base, 'doc.html',
      'Change golf to GOLF.', { blockId: 'r-0003', quote: 'golf' });
    const d2 = await createComment(base, 'doc.html',
      'Change india to INDIA.', { blockId: 'r-0003', quote: 'india' });
    const runsBefore = (await sidecar()).runs.length;

    // Call 1 succeeds and WRITES; call 2's agent errors → partial, not rolled back.
    stub.state.queue = [
      { mode: 'ok', result: resultFor(d1, [{ blockId: 'r-0003', newInner: 'GOLF hotel india' }]) },
      { mode: 'http500' },
    ];
    const res = await runBatch([d1, d2]);
    assert.equal(res.status, 200, 'a partial batch is a 200 with a run record');
    const text = await res.text();
    const run = JSON.parse(text);
    assert.equal(run.status, 'partial');
    assert.deepEqual(run.commentIds, [d1, d2]);
    assert.ok(!text.includes(CONFIG_KEY), 'no API key leaked');
    assert.ok(!text.includes(UPSTREAM_SECRET), 'no upstream body leaked');
    // per-comment outcomes: d1 ok, d2 failed with a safe reason.
    assert.equal(run.perComment[0].status, 'ok');
    assert.equal(run.perComment[1].status, 'failed');
    assert.equal(typeof run.perComment[1].error, 'string');
    assert.ok(!run.perComment[1].error.includes(UPSTREAM_SECRET));

    // d1's edit STAYS on disk; d1 is addressed, d2 is failed.
    assert.ok((await fs.readFile(docPath, 'utf8')).includes('GOLF hotel india'), 'the successful edit stays');
    const data = await sidecar();
    assert.equal(data.runs.length, runsBefore + 1);
    assert.equal(data.comments.find((c) => c.id === d1).status, 'addressed');
    const failed = data.comments.find((c) => c.id === d2);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.resolution.decision, 'failed');
  });

  await t.test('request validation: 400s and 404s before any work starts', async () => {
    const known = (await sidecar()).comments[0].id;
    const runsBefore = (await sidecar()).runs.length;
    const cases400 = [
      { page: 'doc.html' },                                          // neither form
      { page: 'doc.html', commentId: known, commentIds: [known] },   // both forms
      { page: 'doc.html', commentIds: [] },                          // empty
      { page: 'doc.html', commentIds: 'x' },                         // not an array
      { page: 'doc.html', commentIds: [known, known] },              // duplicate
      { page: 'doc.html', commentIds: [known, 42] },                 // non-string
      { page: 'doc.html', commentIds: Array.from({ length: 21 }, (_, i) => `c-${i}`) }, // over cap
    ];
    for (const payload of cases400) {
      assert.equal((await postJson(`${base}/api/run`, payload)).status, 400, JSON.stringify(payload));
    }
    assert.equal((await runBatch([known, 'c-doesnotexist'])).status, 404, 'unknown id in the batch');
    assert.equal((await postJson(`${base}/api/run`, { page: 'nope.html', commentIds: [known] })).status, 404);
    assert.equal((await sidecar()).runs.length, runsBefore, 'no run recorded for rejected requests');
  });

  await t.test('the page lock holds: concurrent POST /api/run during a batch → 409', async () => {
    const d1 = await createComment(base, 'doc.html', 'Reword this.', { blockId: 'r-0002', quote: 'foxtrot' });
    stub.state.queue = [{ mode: 'hang' }]; // call 1 hangs until the 600 ms timeout
    const batchPromise = runBatch([d1]);
    // Wait until the batch owns the lock, then contest it.
    let statusBody = null;
    for (let i = 0; i < 50; i += 1) {
      statusBody = await (await fetch(`${base}/api/status?page=doc.html`)).json();
      if (statusBody.running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(statusBody.running, true);
    const contested = await postJson(`${base}/api/run`, { page: 'doc.html', commentId: d1 });
    assert.equal(contested.status, 409);
    assert.equal((await contested.json()).runId, statusBody.runId);
    const settled = await batchPromise;
    // The hang times out; the batch's only comment fails → a clean 'partial'
    // 200 (WP8), and the page lock is released.
    assert.equal(settled.status, 200);
    assert.equal((await settled.json()).status, 'partial');
    assert.equal((await (await fetch(`${base}/api/status?page=doc.html`)).json()).running, false);
  });

  await t.test('undo reverts the whole batch: doc AND every comment', async () => {
    const d1 = await createComment(base, 'doc.html', 'Change golf to GOLF.', { blockId: 'r-0003', quote: 'golf' });
    const d2 = await createComment(base, 'doc.html', 'Change india to INDIA.', { blockId: 'r-0003', quote: 'india' });
    const docBefore = await fs.readFile(docPath);
    stub.state.queue = [
      { mode: 'ok', result: resultFor(d1, [{ blockId: 'r-0003', newInner: 'GOLF hotel india' }]) },
      { mode: 'ok', result: resultFor(d2, [{ blockId: 'r-0003', newInner: 'GOLF hotel INDIA' }]) },
    ];
    const run = await (await runBatch([d1, d2])).json();
    assert.equal(run.status, 'ok');
    assert.ok((await fs.readFile(docPath, 'utf8')).includes('GOLF hotel INDIA'));
    assert.equal((await sidecar()).comments.find((c) => c.id === d2).status, 'addressed');

    const undoRes = await postJson(`${base}/api/undo`, { page: 'doc.html' });
    assert.equal(undoRes.status, 200);
    const undone = await undoRes.json();
    assert.equal(undone.runId, run.runId);
    assert.equal(undone.status, 'undone');
    assert.equal(Buffer.compare(docBefore, await fs.readFile(docPath)), 0, 'doc restored wholesale');
    const data = await sidecar();
    for (const id of [d1, d2]) {
      const comment = data.comments.find((c) => c.id === id);
      assert.equal(comment.status, 'open', `${id} reopened by the one undo`);
      assert.equal(comment.resolution, undefined, `${id} resolution dropped`);
    }
    assert.equal(data.runs.find((r) => r.runId === run.runId).status, 'undone');
  });

  await t.test('single-comment runs are unchanged by the batch lane', async () => {
    const data = await sidecar();
    const id = data.comments.find((c) => c.status === 'open').id;
    stub.state.queue = [{ mode: 'ok', result: resultFor(id) }];
    const run = await (await postJson(`${base}/api/run`, { page: 'doc.html', commentId: id })).json();
    assert.equal(run.status, 'ok');
    assert.equal(run.commentId, id);
    assert.equal(run.commentIds, undefined, 'single records carry commentId, not commentIds');
    assert.equal(run.perComment, undefined);
    assert.equal(typeof run.archetype, 'string');
    assert.equal(typeof run.model, 'string');
  });
});

// --- extension wiring (static, mirrors extension-ui.test.mjs) ----------------

test('overlay Send all wiring (static)', async () => {
  const extDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
  const overlayJs = await fs.readFile(path.join(extDir, 'overlay.js'), 'utf8');
  const overlayCss = await fs.readFile(path.join(extDir, 'overlay.css'), 'utf8');
  // The batch send rides the same single fetch site and the frozen /api/run
  // literal (extension-ui.test.mjs pins both); here: the batch payload key,
  // the header button, and its stylesheet hook exist.
  assert.match(overlayJs, /\bcommentIds\b/, 'overlay.js posts commentIds for batches');
  assert.match(overlayJs, /rv-send-all/, 'overlay.js renders the Send all button');
  assert.match(overlayJs, /sendableComments/, 'batch scope = open comments under the active filter');
  assert.match(overlayCss, /\.rv-send-all/, 'overlay.css styles the Send all button');
});
