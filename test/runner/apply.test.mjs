// test/runner/apply.test.mjs — Session 5: apply, validate, undo, status + OTEL.
//
// Self-contained like the other runner tests: fixture dir in a tmpdir, the
// runner on an OS-assigned port, a stub OpenRouter server (with a 'hold' mode
// so a run can be frozen mid-flight for /api/status + concurrency checks) and
// a stub OTLP collector — NO real network calls anywhere. Covers the
// end-to-end apply happy path (entity encoding, run record, resolution,
// decision → status mapping), all-or-nothing atomicity, every validation
// failure lane (each fails the run AND restores the doc), the undo
// round-trip, /api/status through the whole lifecycle, 409 on concurrent
// runs, telemetry (endpoint null = off; configured endpoint gets one
// well-formed six-span trace), history pruning, and surgery unit checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME, DEFAULT_OTEL_ENDPOINT, loadConfig } from '../../runner/lib/config.mjs';
import {
  encodeEntities, isAsciiOnly, checkBalanced, locateBlock,
  replaceBlockInner, validateWrite, sameRevMarks, revIds,
} from '../../runner/lib/surgery.mjs';
import { applyEdits } from '../../runner/lib/apply.mjs';
import {
  saveSnapshot, listSnapshots, loadSnapshot, KEEP_PER_PAGE,
} from '../../runner/lib/history.mjs';
import { telemetryEndpoint, buildTrace, emitRunTrace } from '../../runner/lib/telemetry.mjs';

// Pin the env so a developer's real vars can't leak into these assertions.
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;
delete process.env.REDLINE_OTEL_ENDPOINT;

const DOC_HTML = [
  '<!doctype html>',
  '<html><head><title>t</title></head>',
  '<body>',
  '<p data-rev="r-0001">alpha bravo charlie</p>',
  '<div data-rev="r-0002"><div>nested inner</div> tail</div>',
  '<div data-rev="r-0003">intro <p data-rev="r-0004">child text</p> outro</div>',
  '<p data-rev="r-0005">delta echo</p>',
  '</body></html>',
  '',
].join('\n');

// --- stubs -------------------------------------------------------------------

function startAgentStub() {
  const state = { mode: 'ok', result: null, usage: null, requests: [], held: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      state.requests.push(JSON.parse(body));
      const respond = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify(state.result) } }],
          ...(state.usage ? { usage: state.usage } : {}),
        }));
      };
      if (state.mode === 'hold') state.held.push({ respond, res });
      else respond();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}/chat/completions`,
        release: () => { for (const h of state.held.splice(0)) h.respond(); },
        close: () => new Promise((r) => {
          for (const h of state.held.splice(0)) h.res.destroy();
          server.closeAllConnections?.();
          server.close(r);
        }),
      });
    });
  });
}

function startOtelStub() {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      state.requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}/v1/traces`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

async function makeRoot(agentUrl, { otelUrl = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-apply-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'test-key', endpoint: agentUrl, timeoutMs: 5000 },
    // endpoint:null = telemetry OFF — the default is now local Phoenix, and
    // these tests must never fire real exports. format json: this file's
    // OTLP stub asserts the (tested-intermediate) JSON wire shape; the
    // protobuf default is covered in trace.test.mjs.
    telemetry: { endpoint: otelUrl, format: 'json' },
  }, null, 2));
  return dir;
}

// --- helpers -------------------------------------------------------------------

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

async function until(fn, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error('until(): condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const attrOf = (span, key) => {
  const a = span.attributes.find((x) => x.key === key);
  if (!a) return undefined;
  const v = a.value;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('boolValue' in v) return v.boolValue;
  if ('doubleValue' in v) return v.doubleValue;
  return undefined;
};

// --- the full lifecycle ----------------------------------------------------------

test('run apply lifecycle: happy path, atomicity, validation, undo, status, 409', async (t) => {
  const stub = await startAgentStub();
  const root = await makeRoot(stub.url); // telemetry endpoint null — off
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const readDoc = () => fs.readFile(docPath, 'utf8');
  const readSidecar = async () => JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
  const getStatus = async (page = 'doc.html') => {
    const res = await fetch(`${base}/api/status?page=${encodeURIComponent(page)}`);
    assert.equal(res.status, 200);
    return res.json();
  };
  const runOn = (commentId) => postJson(`${base}/api/run`, { page: 'doc.html', commentId });
  const createComment = async (body, anchor) => {
    const res = await postJson(`${base}/api/comment`, { page: 'doc.html', body, anchor });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };

  let cid1;
  let run1;

  await t.test('status before any run: idle, no lastRun', async () => {
    const status = await getStatus();
    // `runs` and `leases` are ALWAYS present, empty when nothing holds the page
    // (#38) — a caller rendering the lease map should not have to distinguish
    // "no leases" from "this runner is too old to report them". `rev` is the
    // sidecar revision an idle tab polls on (#106); 0 before anything is saved.
    // `session` is always present too, and null is the NORMAL state (#187,
    // decision 20): no agent attached warrants no warning, so the overlay needs
    // to tell "nobody is watching" from "this runner predates presence".
    // `hold` (#190) is always present for the same reason — the overlay must
    // tell "not held" from "this runner does not know about hold".
    assert.deepEqual(status, {
      running: false,
      runs: [],
      leases: {},
      rev: 0,
      session: null,
      hold: { on: false, since: null, heldCount: 0, heldCommentIds: [], lastRelease: null },
    });
  });

  await t.test('happy path: edit applied exactly at the block, entity-encoded', async () => {
    cid1 = await createComment('Swap in the fancy punctuation.', { blockId: 'r-0001', quote: 'bravo' });
    stub.state.result = {
      decisions: [{ id: cid1, decision: 'addressed', summary: 'Swapped.', note: 'Entities used.' }],
      edits: [{ blockId: 'r-0001', newInner: 'alpha — “bravo” charlie' }],
    };
    const res = await runOn(cid1);
    assert.equal(res.status, 200);
    run1 = await res.json();
    assert.equal(run1.status, 'ok');
    assert.equal(run1.commentId, cid1);
    assert.equal(run1.archetype, 'tactical');
    assert.deepEqual(run1.edits, [{
      blockId: 'r-0001',
      beforeInner: 'alpha bravo charlie',
      afterInner: 'alpha &mdash; &ldquo;bravo&rdquo; charlie',
    }]);

    // The doc changed EXACTLY at the block, non-ASCII entity-encoded, and the
    // ASCII-only doc stayed ASCII-only.
    const doc = await readDoc();
    assert.equal(doc, DOC_HTML.replace('alpha bravo charlie', 'alpha &mdash; &ldquo;bravo&rdquo; charlie'));
    assert.ok(isAsciiOnly(doc), 'ASCII invariant held');

    // Sidecar: run record + resolution + decision → status mapping.
    const sidecar = await readSidecar();
    assert.equal(sidecar.runs.length, 1);
    assert.equal(sidecar.runs[0].runId, run1.runId);
    assert.equal(sidecar.runs[0].status, 'ok');
    const comment = sidecar.comments.find((c) => c.id === cid1);
    assert.equal(comment.status, 'addressed');
    assert.deepEqual(comment.resolution, {
      runId: run1.runId, decision: 'addressed', summary: 'Swapped.', note: 'Entities used.',
    });
  });

  await t.test('status after the run: idle + lastRun', async () => {
    const status = await getStatus();
    assert.equal(status.running, false);
    assert.ok(!('runId' in status), 'runId only present while running');
    assert.equal(status.lastRun.runId, run1.runId);
    assert.equal(status.lastRun.status, 'ok');
  });

  await t.test('undo round-trip: doc + comment status restored, record marked undone', async () => {
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html' });
    assert.equal(res.status, 200);
    const undone = await res.json();
    assert.equal(undone.runId, run1.runId);
    assert.equal(undone.status, 'undone');

    assert.equal(await readDoc(), DOC_HTML, 'doc restored byte-for-byte');
    const sidecar = await readSidecar();
    assert.equal(sidecar.runs[0].status, 'undone', 'record stays, marked undone');
    const comment = sidecar.comments.find((c) => c.id === cid1);
    assert.equal(comment.status, 'open', 'comment reopened to its pre-run status');
    assert.equal(comment.resolution, undefined, 'resolution dropped');
    const status = await getStatus();
    assert.equal(status.lastRun.status, 'undone');
  });

  await t.test('undo twice → 404 (nothing left to undo)', async () => {
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html' });
    assert.equal(res.status, 404);
  });

  await t.test('all-or-nothing: a valid edit before an invalid one is NOT applied', async () => {
    const cid2 = await createComment('Touch two blocks.', { blockId: 'r-0005', quote: 'delta' });
    stub.state.result = {
      decisions: [{ id: cid2, decision: 'addressed', summary: 's' }],
      edits: [
        { blockId: 'r-0005', newInner: 'delta echo foxtrot' }, // valid on its own
        { blockId: 'r-9999', newInner: 'x' },                  // unknown block
      ],
    };
    const res = await runOn(cid2);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.errorType, 'validation');
    assert.equal(body.run.status, 'failed');
    assert.ok(body.error.includes('r-9999'), 'error names the offending block');
    assert.equal(await readDoc(), DOC_HTML, 'doc byte-identical — first edit rolled back too');
  });

  await t.test('each validation failure fails the run and restores the doc', async () => {
    const cid = await createComment('Various bad edits.', { blockId: 'r-0001', quote: 'alpha' });
    const cases = [
      ['unbalanced tags', { blockId: 'r-0001', newInner: '<em>oops' }],
      ['data-rev removed', { blockId: 'r-0003', newInner: 'intro no child outro' }],
      ['data-rev altered', { blockId: 'r-0003', newInner: 'intro <p data-rev="r-9998">child text</p> outro' }],
      ['data-rev invented', { blockId: 'r-0001', newInner: 'x <span data-rev="r-7777">y</span>' }],
      ['unknown blockId', { blockId: 'r-4242', newInner: 'x' }],
    ];
    for (const [label, edit] of cases) {
      stub.state.result = {
        decisions: [{ id: cid, decision: 'addressed', summary: 's' }],
        edits: [edit],
      };
      const res = await runOn(cid);
      assert.equal(res.status, 422, label);
      const body = await res.json();
      assert.equal(body.errorType, 'validation', label);
      assert.equal(body.run.status, 'failed', label);
      assert.equal(await readDoc(), DOC_HTML, `doc restored (${label})`);
    }
    const sidecar = await readSidecar();
    assert.ok(sidecar.comments.find((c) => c.id === cid).status === 'open',
      'failed runs never resolve the comment');
  });

  await t.test('decisions referencing unknown comment ids (or none) fail the run', async () => {
    const cid = await createComment('Decision contract.', { blockId: 'r-0001', quote: 'alpha' });
    for (const decisions of [
      [{ id: 'c-doesnotexist', decision: 'addressed', summary: 's' }], // unknown id
      [],                                                              // no decision at all
    ]) {
      stub.state.result = { decisions, edits: [] };
      const res = await runOn(cid);
      assert.equal(res.status, 422, JSON.stringify(decisions));
      const body = await res.json();
      assert.equal(body.errorType, 'validation');
      assert.equal(body.run.status, 'failed');
      assert.equal(await readDoc(), DOC_HTML);
    }
  });

  await t.test('status lifecycle + 409s during a held run', async () => {
    const cid3 = await createComment('Defer me.', { blockId: 'r-0001', quote: 'charlie' });
    stub.state.result = {
      decisions: [{ id: cid3, decision: 'deferred', summary: 'Later.' }],
      edits: [],
    };
    stub.state.mode = 'hold';

    assert.equal((await getStatus()).running, false, 'idle before');
    const pending = runOn(cid3);
    const during = await until(async () => {
      const s = await getStatus();
      return s.running ? s : null;
    });
    assert.equal(during.running, true);
    assert.match(during.runId, /^run-[0-9a-f]{12}$/);

    // Concurrent run and undo are both refused while the run is active.
    assert.equal((await runOn(cid3)).status, 409);
    assert.equal((await postJson(`${base}/api/undo`, { page: 'doc.html' })).status, 409);

    stub.release();
    stub.state.mode = 'ok';
    const res = await pending;
    assert.equal(res.status, 200);
    const run = await res.json();

    const after = await getStatus();
    assert.equal(after.running, false);
    assert.equal(after.lastRun.runId, run.runId);
    assert.equal(after.lastRun.status, 'ok');
    const sidecar = await readSidecar();
    assert.equal(sidecar.comments.find((c) => c.id === cid3).status, 'deferred');
  });

  await t.test('status/undo endpoint edges: 400, 404, 405', async () => {
    assert.equal((await fetch(`${base}/api/status`)).status, 400);
    assert.equal((await fetch(`${base}/api/status?page=nope.html`)).status, 404);
    assert.equal((await postJson(`${base}/api/status?page=doc.html`, {})).status, 405);
    assert.equal((await postJson(`${base}/api/undo`, { page: 'nope.html' })).status, 404);
    assert.equal((await postJson(`${base}/api/undo`, '{nope')).status, 400);
    assert.equal((await fetch(`${base}/api/undo`)).status, 405);
  });

  await t.test('no stray .tmp files anywhere in the fixture', async () => {
    const walk = async (dir) => {
      const out = [];
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await walk(p));
        else out.push(p);
      }
      return out;
    };
    const files = await walk(root);
    assert.ok(!files.some((f) => f.endsWith('.tmp')), `leftovers: ${files}`);
  });
});

// --- telemetry ---------------------------------------------------------------------

test('telemetry: configured endpoint receives one well-formed six-span trace', async (t) => {
  const stub = await startAgentStub();
  const otel = await startOtelStub();
  const root = await makeRoot(stub.url, { otelUrl: otel.url });
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await otel.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const created = await postJson(`${base}/api/comment`, {
    // a11y-flavored: NOT tactical-eligible, so the span set stays the
    // standard lane's six (the tactical span is covered in tactical-lane.test).
    page: 'doc.html', body: 'Add an aria-label here.', anchor: { blockId: 'r-0001', quote: 'bravo' },
  });
  const cid = (await created.json()).id;
  stub.state.usage = { prompt_tokens: 321, completion_tokens: 45 };
  stub.state.result = {
    decisions: [{ id: cid, decision: 'addressed', summary: 's' }],
    edits: [{ blockId: 'r-0001', newInner: 'alpha bravo charlie!' }],
  };
  const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentId: cid });
  assert.equal(res.status, 200);
  const run = await res.json();

  // Fire-and-forget: poll the collector.
  const trace = await until(() => otel.state.requests[0] ?? null);
  assert.equal(otel.state.requests.length, 1, 'exactly one trace per run');

  const resource = trace.resourceSpans[0];
  assert.equal(attrOf({ attributes: resource.resource.attributes }, 'service.name'), 'redline-runner');
  const spans = resource.scopeSpans[0].spans;
  assert.deepEqual(spans.map((s) => s.name).sort(), [
    'agent-request', 'apply-edits', 'load-context', 'revise-run', 'route', 'save-sidecar',
  ]);

  const rootSpan = spans.find((s) => s.name === 'revise-run');
  assert.equal(attrOf(rootSpan, 'runId'), run.runId);
  assert.equal(attrOf(rootSpan, 'page'), 'doc.html');
  assert.equal(attrOf(rootSpan, 'archetype'), 'accessibility');
  assert.equal(typeof attrOf(rootSpan, 'model'), 'string');
  assert.equal(attrOf(rootSpan, 'status'), 'ok');
  assert.equal(rootSpan.status.code, 1);

  for (const span of spans) {
    assert.equal(span.traceId, rootSpan.traceId, `${span.name} shares the traceId`);
    assert.ok(Number(span.startTimeUnixNano) <= Number(span.endTimeUnixNano), `${span.name} times sane`);
    if (span !== rootSpan) assert.equal(span.parentSpanId, rootSpan.spanId, `${span.name} parented to root`);
  }

  const agentSpan = spans.find((s) => s.name === 'agent-request');
  assert.equal(attrOf(agentSpan, 'gen_ai.usage.input_tokens'), 321);
  assert.equal(attrOf(agentSpan, 'gen_ai.usage.output_tokens'), 45);
  const applySpan = spans.find((s) => s.name === 'apply-edits');
  assert.equal(attrOf(applySpan, 'editCount'), 1);
  assert.equal(attrOf(applySpan, 'success'), true);
});

test('telemetry: default off + unit checks', async (t) => {
  await t.test('no endpoint configured → resolution is null and emit is a no-op', () => {
    assert.equal(telemetryEndpoint({ telemetry: { endpoint: null } }, {}), null);
    assert.equal(telemetryEndpoint({}, {}), null);
    assert.equal(emitRunTrace({
      config: { telemetry: { endpoint: null } }, env: {},
      run: { runId: 'run-x', page: 'p', status: 'ok', startMs: 1, endMs: 2 }, spans: [],
    }), null);
  });

  await t.test('env wins over config', () => {
    assert.equal(
      telemetryEndpoint({ telemetry: { endpoint: 'http://cfg' } }, { REDLINE_OTEL_ENDPOINT: 'http://env' }),
      'http://env');
    assert.equal(telemetryEndpoint({ telemetry: { endpoint: 'http://cfg' } }, {}), 'http://cfg');
  });

  await t.test('export failure is swallowed, never thrown', async () => {
    // Unreachable endpoint: the returned promise settles without rejecting.
    await emitRunTrace({
      config: { telemetry: { endpoint: 'http://127.0.0.1:1/nope' } }, env: {},
      run: { runId: 'run-x', page: 'p', status: 'ok', startMs: 1, endMs: 2 }, spans: [],
    });
  });

  await t.test('buildTrace shape: ids, parenting, zero-length spans, error status', () => {
    const now = Date.now();
    const trace = buildTrace({
      runId: 'run-1', page: 'doc.html', archetype: 'tactical', model: 'm',
      status: 'failed', error: 'boom', startMs: now, endMs: now + 5,
      spans: [
        { name: 'load-context', startMs: now, endMs: now, attributes: {} },
        { name: 'agent-request', startMs: now, endMs: now + 3, attributes: { model: 'm' } },
      ],
    });
    const spans = trace.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 3);
    const [root, child, agent] = spans;
    assert.match(root.traceId, /^[0-9a-f]{32}$/);
    assert.match(root.spanId, /^[0-9a-f]{16}$/);
    assert.equal(root.status.code, 2, 'failed run → ERROR status');
    assert.equal(root.status.message, 'boom');
    assert.equal(attrOf(root, 'error'), 'boom');
    assert.equal(child.parentSpanId, root.spanId);
    assert.equal(child.startTimeUnixNano, child.endTimeUnixNano, 'zero-length span allowed');
    // WP12: OpenInference span kinds make the tree read as a pipeline.
    assert.equal(attrOf(root, 'openinference.span.kind'), 'CHAIN');
    assert.equal(attrOf(child, 'openinference.span.kind'), 'CHAIN');
    assert.equal(attrOf(agent, 'openinference.span.kind'), 'LLM', 'the agent call is an LLM span');
    assert.equal(agent.parentSpanId, root.spanId, 'every phase parents to the run root');
  });
});

test('config: telemetry key validation + env precedence', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-otelcfg-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const write = (obj) => fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify(obj));

  await t.test('absent → local Phoenix default; explicit null or env "off" → OFF', async () => {
    assert.equal((await loadConfig(dir, {})).telemetry.endpoint, DEFAULT_OTEL_ENDPOINT);
    assert.equal((await loadConfig(dir, { REDLINE_OTEL_ENDPOINT: 'off' })).telemetry.endpoint, null);
    await write({ telemetry: { endpoint: null } });
    assert.equal((await loadConfig(dir, {})).telemetry.endpoint, null);
  });

  await t.test('config endpoint accepted; env wins over config; headers carried', async () => {
    await write({ telemetry: { endpoint: 'http://127.0.0.1:9999/v1/traces', headers: { authorization: 'Bearer t' } } });
    const cfg = await loadConfig(dir, {});
    assert.equal(cfg.telemetry.endpoint, 'http://127.0.0.1:9999/v1/traces');
    assert.deepEqual(cfg.telemetry.headers, { authorization: 'Bearer t' });
    assert.equal(
      (await loadConfig(dir, { REDLINE_OTEL_ENDPOINT: 'http://127.0.0.1:8888/env' })).telemetry.endpoint,
      'http://127.0.0.1:8888/env');
  });

  await t.test('invalid telemetry shapes throw at startup', async () => {
    for (const bad of [
      { telemetry: { endpoint: 'not a url' } },
      { telemetry: { extra: true } },
      { telemetry: [] },
      { telemetry: { headers: [] } },
      { telemetry: { headers: { 'x-a': 42 } } },
      { telemetry: { format: 'xml' } },
    ]) {
      await write(bad);
      await assert.rejects(() => loadConfig(dir, {}), new RegExp(CONFIG_FILENAME), JSON.stringify(bad));
    }
  });
});

// --- history -------------------------------------------------------------------------

test('history: snapshot save/load, pruning, unservable over HTTP', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-hist-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const htmlPath = path.join(root, 'doc.html');
  await fs.writeFile(htmlPath, DOC_HTML);
  await fs.writeFile(`${htmlPath}.review.json`, JSON.stringify({ comments: [] }));

  await t.test('bounded storage: 25 saves keep the newest 20', async () => {
    for (let i = 0; i < 25; i++) {
      await saveSnapshot({
        root, page: 'doc.html', htmlPath,
        runId: `run-${String(i).padStart(2, '0')}`, kind: 'pre-run',
      });
    }
    const names = await listSnapshots(root, 'doc.html');
    assert.equal(names.length, KEEP_PER_PAGE);
    assert.notEqual(await loadSnapshot({ root, page: 'doc.html', runId: 'run-24' }), null, 'newest kept');
    assert.notEqual(await loadSnapshot({ root, page: 'doc.html', runId: 'run-05' }), null, 'boundary kept');
    assert.equal(await loadSnapshot({ root, page: 'doc.html', runId: 'run-04' }), null, 'oldest pruned');
  });

  await t.test('snapshot pair round-trips; sidecar optional', async () => {
    const snap = await loadSnapshot({ root, page: 'doc.html', runId: 'run-24' });
    assert.equal(snap.doc, DOC_HTML);
    assert.deepEqual(JSON.parse(snap.sidecar), { comments: [] });

    const barePath = path.join(root, 'bare.html');
    await fs.writeFile(barePath, '<body><p data-rev="r-1">x</p></body>\n');
    await saveSnapshot({ root, page: 'bare.html', htmlPath: barePath, runId: 'run-b', kind: 'pre-run' });
    const bare = await loadSnapshot({ root, page: 'bare.html', runId: 'run-b' });
    assert.equal(bare.sidecar, null, 'no sidecar existed → none stored');
  });

  await t.test('.history is never servable (dot-dir traversal guard)', async () => {
    const { port, close } = await startServer({ root, port: 0 });
    try {
      const [name] = await listSnapshots(root, 'doc.html');
      const res = await fetch(
        `http://127.0.0.1:${port}/.history/${encodeURIComponent('doc.html')}/${name}/doc.html`);
      assert.equal(res.status, 404);
    } finally {
      await close();
    }
  });
});

// --- surgery units ---------------------------------------------------------------------

test('surgery units', async (t) => {
  await t.test('encodeEntities: named preferred, numeric fallback, ASCII untouched', () => {
    assert.equal(encodeEntities('a — b'), 'a &mdash; b');
    assert.equal(encodeEntities('“q” …'), '&ldquo;q&rdquo; &hellip;');
    assert.equal(encodeEntities('café'), 'caf&#233;');
    assert.equal(encodeEntities('plain <em>ascii</em> &amp; entities'), 'plain <em>ascii</em> &amp; entities');
  });

  await t.test('isAsciiOnly', () => {
    assert.equal(isAsciiOnly('abc &mdash; <p>'), true);
    assert.equal(isAsciiOnly('ab—c'), false);
  });

  await t.test('checkBalanced: voids, self-close, protected ranges, mismatches', () => {
    assert.equal(checkBalanced('<div><p>x</p><br><img src="y"></div>').ok, true);
    assert.equal(checkBalanced('<div><span/></div>').ok, true);
    assert.equal(checkBalanced('<!-- <div> --><p>x</p>').ok, true, 'comments are not markup');
    assert.equal(checkBalanced('<div><p>x</div>').ok, false, 'mismatched close');
    assert.equal(checkBalanced('<em>x').ok, false, 'unclosed');
    assert.match(checkBalanced('<em>x').error, /unclosed <em>/);
  });

  await t.test('locate + replace are nesting-aware (same-tag nesting)', () => {
    assert.equal(locateBlock(DOC_HTML, 'r-0002').inner, '<div>nested inner</div> tail');
    const r = replaceBlockInner(DOC_HTML, 'r-0002', '<div>new nest</div> tail2');
    assert.equal(r.ok, true);
    assert.equal(locateBlock(r.source, 'r-0002').inner, '<div>new nest</div> tail2');
    assert.equal(locateBlock(r.source, 'r-0001').inner, 'alpha bravo charlie', 'neighbors untouched');
  });

  await t.test('replaceBlockInner entity-encodes and reports before/after', () => {
    const r = replaceBlockInner(DOC_HTML, 'r-0001', 'x – y');
    assert.equal(r.ok, true);
    assert.equal(r.beforeInner, 'alpha bravo charlie');
    assert.equal(r.afterInner, 'x &ndash; y');
    assert.ok(isAsciiOnly(r.source));
  });

  await t.test('editing a stamped child block directly is allowed', () => {
    const r = replaceBlockInner(DOC_HTML, 'r-0004', 'new child text');
    assert.equal(r.ok, true, 'the block\'s own data-rev sits outside its inner');
  });

  await t.test('data-rev tampering is refused in every form', () => {
    // remove
    assert.equal(replaceBlockInner(DOC_HTML, 'r-0003', 'no child').code, 'data-rev-tampered');
    // alter
    assert.equal(replaceBlockInner(DOC_HTML, 'r-0003',
      'intro <p data-rev="r-9998">child text</p> outro').code, 'data-rev-tampered');
    // invent
    assert.equal(replaceBlockInner(DOC_HTML, 'r-0001',
      'x <span data-rev="r-7777">y</span>').code, 'data-rev-tampered');
    // smuggle via single quotes / casing — mark count still catches it
    assert.equal(replaceBlockInner(DOC_HTML, 'r-0001',
      "x <span data-rev='r-7777'>y</span>").code, 'data-rev-tampered');
    assert.equal(replaceBlockInner(DOC_HTML, 'r-0001',
      'x <span DATA-REV="r-7777">y</span>').code, 'data-rev-tampered');
    // unchanged marks pass
    assert.equal(replaceBlockInner(DOC_HTML, 'r-0003',
      'INTRO <p data-rev="r-0004">new child</p> OUTRO').ok, true);
  });

  await t.test('unbalanced replacement and unknown block are typed failures', () => {
    assert.equal(replaceBlockInner(DOC_HTML, 'r-0001', '<em>oops').code, 'unbalanced');
    assert.equal(replaceBlockInner(DOC_HTML, 'r-0001', '</em>x<em>').code, 'unbalanced');
    assert.equal(replaceBlockInner(DOC_HTML, 'r-nope', 'x').code, 'unknown-block');
  });

  await t.test('validateWrite: doc-wide balance + ASCII regression backstop', () => {
    assert.equal(validateWrite('<p>a</p>', '<p>b</p>').ok, true);
    assert.equal(validateWrite('<p>a</p>', '<p>b').code, 'unbalanced');
    assert.equal(validateWrite('<p>ascii</p>', '<p>café</p>').code, 'ascii-regression');
    assert.equal(validateWrite('<p>déjà</p>', '<p>déjà vu</p>').ok, true,
      'docs that already carry non-ASCII are not held to the ASCII invariant');
  });

  await t.test('sameRevMarks / revIds', () => {
    assert.deepEqual(revIds('<p data-rev="a">x</p><p data-rev="b">y</p>'), ['a', 'b']);
    assert.equal(sameRevMarks('<p data-rev="a">x</p>', '<p data-rev="a">z</p>'), true);
    assert.equal(sameRevMarks('<p data-rev="a">x</p>', '<p data-rev="b">x</p>'), false);
    assert.equal(sameRevMarks('x', "<i data-rev='a'>x</i>"), false);
  });

  await t.test('applyEdits: unknown page is a typed error, nothing written', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-applyunit-'));
    try {
      const out = await applyEdits({ root: dir, page: 'nope.html', edits: [] });
      assert.equal(out.ok, false);
      assert.equal(out.code, 'unknown-page');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
