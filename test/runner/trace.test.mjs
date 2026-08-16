// test/runner/trace.test.mjs — WP1: the per-run trace bundle + OTLP additions.
//
// Self-contained like the other runner tests: fixture dir in a tmpdir, the
// runner on an OS-assigned port, a stub OpenRouter server — NO real network
// calls. REDLINE_TRACE_DIR points the bundle root at a tmpdir so parallel
// test files never share tmp/review-runs. Covers: the five bundle files on a
// happy-path run (full untruncated content, no API key anywhere), the bundle
// of a FAILED run (agent-response outcome + validation skip note), numbered
// per-call files on a Send All batch, OTLP prompt/response/validation
// attributes + custom headers, and the trace/telemetry units.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { traceRoot, traceDir, traceFileName, writeTraceFile } from '../../runner/lib/trace.mjs';
import {
  telemetryEndpoint, emitRunTrace, buildTrace, encodeTraceProtobuf,
  truncateAttr, ATTR_MAX_CHARS,
} from '../../runner/lib/telemetry.mjs';
import { promptText } from '../../runner/lib/agent.mjs';
import { collectJson } from '../helpers/json-body.mjs';

// Pin the env so a developer's real vars can't leak into these assertions,
// and isolate the bundle root for this process.
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;
delete process.env.REDLINE_OTEL_ENDPOINT;
const BUNDLE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-trace-root-'));
process.env.REDLINE_TRACE_DIR = BUNDLE_ROOT;

const CONFIG_KEY = 'trace-test-key-must-not-appear';
const UPSTREAM_SECRET = 'upstream-secret-detail-must-not-leak';

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n'
  + '<p data-rev="r-0002">delta echo foxtrot</p>\n</body></html>\n';

function startAgentStub() {
  const state = { mode: 'ok', result: null, usage: null, requests: [] };
  const server = http.createServer(async (req, res) => {
    const parsed = await collectJson(req, res, 'agent-stub');
    if (parsed === null) return; // anomalous request logged + answered, never a crash (#242)
    // Router calls (WP3) get garbage → keyword-classifier fallback, and
    // are kept out of state.requests so revise-call assertions stay exact.
    if (promptText(parsed.messages).startsWith('# Redline comment router')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'not json — force the fallback route' } }],
      }));
    }
    state.requests.push(parsed);
    if (state.mode === 'http500') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end(UPSTREAM_SECRET);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(state.result) } }],
      ...(state.usage ? { usage: state.usage } : {}),
    }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      state,
      url: `http://127.0.0.1:${server.address().port}/chat/completions`,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

function startOtelStub() {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    // Same crash-proofing as the agent stub (#242): a torn-down socket must
    // log, not throw, and a body that fails to parse must not kill the file.
    req.on('error', (err) => {
      console.error(`[otel-stub] request stream error: ${err?.code ?? err?.message ?? err}`);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let trace = null;
      if (req.headers['content-type'] === 'application/json') {
        try {
          trace = JSON.parse(raw.toString('utf8'));
        } catch {
          console.error(`[otel-stub] unparseable JSON export (${raw.length} bytes): `
            + JSON.stringify(raw.toString('utf8').slice(0, 200)));
        }
      }
      state.requests.push({ headers: req.headers, raw, trace });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      state,
      url: `http://127.0.0.1:${server.address().port}/v1/traces`,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

async function makeRoot(agentUrl, { otelUrl = null, otelHeaders = undefined } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-trace-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: CONFIG_KEY, endpoint: agentUrl, timeoutMs: 5000 },
    // format json: the OTLP stub below asserts the JSON wire shape; the
    // protobuf DEFAULT is covered by its own test at the foot of this file.
    telemetry: { endpoint: otelUrl, format: 'json', ...(otelHeaders ? { headers: otelHeaders } : {}) },
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
  return undefined;
};

const readBundle = (runId, name) => fs.readFile(path.join(traceDir(runId), name), 'utf8');
const readBundleJson = async (runId, name) => JSON.parse(await readBundle(runId, name));

// --- the trace bundle ---------------------------------------------------------

test('trace bundle: happy path, failed run, batch numbering', async (t) => {
  const stub = await startAgentStub();
  const root = await makeRoot(stub.url); // telemetry off — bundle written anyway
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const createComment = async (body, anchor) => {
    const res = await postJson(`${base}/api/comment`, { page: 'doc.html', body, anchor });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };

  await t.test('ok run writes all six files, full content, no key anywhere', async () => {
    // a11y-flavored so the route is NOT tactical-eligible — this test pins
    // the standard lane's exact bundle. scope.json joined it in #195: the gate
    // logs EVERY decision, fired or not, because a log that only keeps the
    // times it fired cannot answer how often it fires when it should not.
    const cid = await createComment('Add a screen-reader hint for bravo.', { blockId: 'r-0001', quote: 'bravo' });
    stub.state.mode = 'ok';
    stub.state.result = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'Swapped the word.' }],
      edits: [{ blockId: 'r-0001', newInner: 'alpha delta charlie' }],
    };
    const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentId: cid });
    assert.equal(res.status, 200);
    const run = await res.json();

    const files = (await fs.readdir(traceDir(run.runId))).sort();
    assert.deepEqual(files,
      ['agent-request.json', 'agent-response.json', 'prompt.md', 'run.json', 'scope.json', 'validation.json']);

    const scope = await readBundleJson(run.runId, 'scope.json');
    assert.equal(scope.record.fired, false, 'an in-section edit does not gate');
    assert.deepEqual(scope.record.touchedBlocks, ['r-0001']);
    assert.equal(scope.lane, 'run');

    const prompt = await readBundle(run.runId, 'prompt.md');
    assert.ok(prompt.includes('alpha bravo charlie'), 'prompt carries the block HTML');
    assert.ok(prompt.includes('Add a screen-reader hint for bravo.'), 'prompt carries the comment');
    assert.ok(!prompt.includes('{{'), 'no unrendered placeholders');
    assert.equal(prompt, promptText(stub.state.requests.at(-1).messages),
      'prompt.md is the EXACT prompt on the wire, untruncated');

    const request = await readBundleJson(run.runId, 'agent-request.json');
    assert.equal(request.model, run.model);
    assert.equal(promptText(request.messages), prompt);
    assert.equal(typeof request.temperature, 'number');

    const response = await readBundleJson(run.runId, 'agent-response.json');
    assert.equal(response.httpStatus, 200);
    assert.equal(response.envelope.choices[0].message.role, 'assistant');
    assert.equal(response.content, JSON.stringify(stub.state.result));
    assert.deepEqual(response.outcome, { ok: true });

    const validation = await readBundleJson(run.runId, 'validation.json');
    assert.equal(validation.ok, true);
    assert.equal(validation.changed, true);
    assert.deepEqual(validation.editRecords, [{
      blockId: 'r-0001', beforeInner: 'alpha bravo charlie', afterInner: 'alpha delta charlie',
    }]);

    const runJson = await readBundleJson(run.runId, 'run.json');
    assert.deepEqual(runJson, run, 'run.json is the run record the API returned');

    for (const name of files) {
      const text = await readBundle(run.runId, name);
      assert.ok(!text.includes(CONFIG_KEY), `no API key in ${name}`);
    }
  });

  await t.test('failed run still gets a bundle that explains the failure', async () => {
    const cid = await createComment('This fails WCAG contrast.', { blockId: 'r-0001', quote: 'alpha' });
    stub.state.mode = 'http500';
    const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentId: cid });
    assert.equal(res.status, 502);
    const { run } = await res.json();
    stub.state.mode = 'ok';

    const files = (await fs.readdir(traceDir(run.runId))).sort();
    assert.deepEqual(files,
      ['agent-request.json', 'agent-response.json', 'prompt.md', 'run.json', 'validation.json']);
    const response = await readBundleJson(run.runId, 'agent-response.json');
    assert.equal(response.httpStatus, 500);
    assert.equal(response.envelope, null);
    assert.deepEqual(response.outcome,
      { ok: false, errorType: 'http', message: 'agent endpoint returned HTTP 500' });
    const validation = await readBundleJson(run.runId, 'validation.json');
    assert.equal(validation.ok, false);
    assert.equal(validation.skipped, true);
    const runJson = await readBundleJson(run.runId, 'run.json');
    assert.equal(runJson.status, 'failed');
    assert.match(runJson.error, /agent run failed/);
    for (const name of files) {
      const text = await readBundle(run.runId, name);
      assert.ok(!text.includes(UPSTREAM_SECRET), `no upstream body in ${name}`);
      assert.ok(!text.includes(CONFIG_KEY), `no API key in ${name}`);
    }
  });

  await t.test('batch run numbers the per-call files; run.json stays singular', async () => {
    const c1 = await createComment('Swap bravo for golf.', { blockId: 'r-0001', quote: 'bravo' });
    const c2 = await createComment('Swap echo for hotel.', { blockId: 'r-0002', quote: 'echo' });
    // The stub can't see which comment a call is for — reply per request order.
    const replies = [
      { decisions: [{ id: c1, decision: 'addressed', summary: 's' }], edits: [] },
      { decisions: [{ id: c2, decision: 'addressed', summary: 's' }], edits: [] },
    ];
    let call = 0;
    const orig = stub.state.result;
    Object.defineProperty(stub.state, 'result', {
      configurable: true,
      get: () => replies[Math.min(call++, replies.length - 1)],
    });
    const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentIds: [c1, c2] });
    Object.defineProperty(stub.state, 'result', { configurable: true, writable: true, value: orig });
    assert.equal(res.status, 200);
    const run = await res.json();

    const files = (await fs.readdir(traceDir(run.runId))).sort();
    assert.deepEqual(files, [
      'agent-request-1.json', 'agent-request-2.json',
      'agent-response-1.json', 'agent-response-2.json',
      'prompt-1.md', 'prompt-2.md',
      'run.json',
      'validation-1.json', 'validation-2.json',
    ]);
    const p2 = await readBundle(run.runId, 'prompt-2.md');
    assert.ok(p2.includes('Swap echo for hotel.'), 'second call traced second comment');
    assert.deepEqual((await readBundleJson(run.runId, 'run.json')).commentIds, [c1, c2]);
  });
});

// --- OTLP additions -----------------------------------------------------------

test('OTLP: prompt/response/validation attributes + custom headers', async (t) => {
  const stub = await startAgentStub();
  const otel = await startOtelStub();
  const root = await makeRoot(stub.url, { otelUrl: otel.url, otelHeaders: { 'x-phoenix-key': 'h1' } });
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await otel.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const created = await postJson(`${base}/api/comment`, {
    page: 'doc.html', body: 'Fix it.', anchor: { blockId: 'r-0001', quote: 'bravo' },
  });
  const cid = (await created.json()).id;
  stub.state.result = {
    decisions: [{ id: cid, decision: 'addressed', summary: 's' }],
    edits: [{ blockId: 'r-0001', newInner: 'alpha bravo charlie!' }],
  };
  assert.equal((await postJson(`${base}/api/run`, { page: 'doc.html', commentId: cid })).status, 200);

  const seen = await until(() => otel.state.requests[0] ?? null);
  assert.equal(seen.headers['x-phoenix-key'], 'h1', 'config telemetry.headers on the wire');
  assert.equal(seen.headers['content-type'], 'application/json', 'our content-type wins');

  const spans = seen.trace.resourceSpans[0].scopeSpans[0].spans;
  const agentSpan = spans.find((s) => s.name === 'agent-request');
  assert.ok(attrOf(agentSpan, 'input.value').includes('alpha bravo charlie'), 'prompt on the span');
  assert.equal(attrOf(agentSpan, 'output.value'), JSON.stringify(stub.state.result), 'response on the span');
  const applySpan = spans.find((s) => s.name === 'apply-edits');
  assert.equal(attrOf(applySpan, 'success'), true);
});

// --- GET /api/trace (WP6: the run-log viewer's data source) -------------------

test('GET /api/trace serves bundles read-only', async (t) => {
  const stub = await startAgentStub();
  const root = await makeRoot(stub.url);
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  // One real run so a bundle exists.
  const created = await postJson(`${base}/api/comment`, {
    page: 'doc.html', body: 'Add a screen-reader hint here.', anchor: { blockId: 'r-0001', quote: 'bravo' },
  });
  const cid = (await created.json()).id;
  stub.state.mode = 'ok';
  stub.state.result = { decisions: [{ id: cid, decision: 'declined', summary: 's' }], edits: [] };
  const run = await (await postJson(`${base}/api/run`, { page: 'doc.html', commentId: cid })).json();

  await t.test('mode=list names the files, run.json first', async () => {
    const res = await fetch(`${base}/api/trace?runId=${run.runId}&mode=list`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.runId, run.runId);
    assert.equal(body.files[0], 'run.json', 'reading order leads with the run record');
    assert.deepEqual([...body.files].sort(),
      ['agent-request.json', 'agent-response.json', 'prompt.md', 'run.json', 'scope.json', 'validation.json']);
  });

  await t.test('full fetch returns every file with content', async () => {
    const res = await fetch(`${base}/api/trace?runId=${run.runId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.files.length, 6);
    const prompt = body.files.find((f) => f.name === 'prompt.md');
    assert.ok(prompt.content.includes('alpha bravo charlie'), 'real file content served');
    const runJson = body.files.find((f) => f.name === 'run.json');
    assert.equal(JSON.parse(runJson.content).runId, run.runId);
  });

  await t.test('unknown, invalid, and traversal-shaped runIds never read outside the bundle root', async () => {
    assert.equal((await fetch(`${base}/api/trace?runId=run-doesnotexist99`)).status, 404);
    assert.equal((await fetch(`${base}/api/trace`)).status, 400);
    for (const bad of ['../../etc/passwd', 'run-..%2F..%2Fsecrets', 'notarun', 'run-a/b']) {
      const res = await fetch(`${base}/api/trace?runId=${encodeURIComponent(bad)}`);
      assert.ok(res.status === 400 || res.status === 404, `${bad} → ${res.status}`);
    }
    assert.equal((await fetch(`${base}/api/trace?runId=${run.runId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    })).status, 405);
  });
});

// --- OTLP protobuf default ----------------------------------------------------
//
// The DEFAULT wire format is OTLP protobuf (what local Phoenix accepts; its
// /v1/traces 415s on JSON). Decode the emitted bytes with a minimal generic
// proto walker and check they carry the same trace buildTrace() described.

function protoFields(buf) {
  const fields = [];
  let i = 0;
  const readVarint = () => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (wireType === 0) fields.push({ field, value: readVarint() });
    else if (wireType === 1) { fields.push({ field, value: buf.subarray(i, i + 8) }); i += 8; }
    else if (wireType === 2) {
      const len = Number(readVarint());
      fields.push({ field, value: buf.subarray(i, i + len) });
      i += len;
    } else throw new Error(`unexpected wire type ${wireType}`);
  }
  return fields;
}
const sub = (fields, n) => fields.filter((f) => f.field === n).map((f) => f.value);

test('OTLP protobuf default: emitted bytes decode back to the trace', async (t) => {
  const otel = await startOtelStub();
  t.after(() => otel.close());

  const now = Date.now();
  const settled = emitRunTrace({
    config: { telemetry: { endpoint: otel.url } }, // no format key → protobuf
    env: {},
    run: {
      runId: 'run-proto1', page: 'doc.html', archetype: 'tactical',
      model: 'm', status: 'failed', error: 'boom', startMs: now, endMs: now + 5,
    },
    spans: [{ name: 'route', startMs: now, endMs: now + 1, attributes: { tier: 'simple', ok: true, promptChars: 12 } }],
  });
  assert.notEqual(settled, null);
  await settled;

  const seen = await until(() => otel.state.requests[0] ?? null);
  assert.equal(seen.headers['content-type'], 'application/x-protobuf');

  // request(1: resourceSpans) → (1: resource, 2: scopeSpans) → (2: spans)
  const rs = protoFields(sub(protoFields(seen.raw), 1)[0]);
  const scopeSpans = protoFields(sub(rs, 2)[0]);
  const spans = sub(scopeSpans, 2).map((b) => protoFields(b));
  const names = spans.map((s) => sub(s, 5)[0].toString('utf8')).sort();
  assert.deepEqual(names, ['revise-run', 'route']);

  const root = spans.find((s) => sub(s, 5)[0].toString('utf8') === 'revise-run');
  assert.equal(sub(root, 1)[0].length, 16, '16-byte trace id');
  assert.equal(sub(root, 2)[0].length, 8, '8-byte span id');
  const attrs = sub(root, 9).map((b) => {
    const kv = protoFields(b);
    const value = protoFields(sub(kv, 2)[0]);
    return [sub(kv, 1)[0].toString('utf8'), value];
  });
  const attr = (key) => attrs.find(([k]) => k === key)?.[1];
  assert.equal(sub(attr('runId'), 1)[0].toString('utf8'), 'run-proto1');
  const status = protoFields(sub(root, 15)[0]);
  assert.equal(sub(status, 2)[0].toString('utf8'), 'boom');
  assert.equal(Number(sub(status, 3)[0]), 2, 'ERROR status code');

  const child = spans.find((s) => sub(s, 5)[0].toString('utf8') === 'route');
  assert.equal(sub(child, 4)[0].toString('utf8'), sub(root, 2)[0].toString('utf8'), 'parented to root');
  assert.equal(sub(child, 8)[0].readBigUInt64LE() - sub(child, 7)[0].readBigUInt64LE(), 1_000_000n,
    '1ms span in fixed64 nanos');

  // The encoder is a pure function of buildTrace()'s shape.
  const trace = buildTrace({
    runId: 'r', page: 'p', status: 'ok', startMs: now, endMs: now, spans: [],
  });
  assert.ok(encodeTraceProtobuf(trace).length > 0);
});

// --- units --------------------------------------------------------------------

test('trace + telemetry units', async (t) => {
  await t.test('traceRoot: env override wins, default under repo tmp/', () => {
    assert.equal(traceRoot({ REDLINE_TRACE_DIR: '/x/y' }), '/x/y');
    assert.ok(traceRoot({}).endsWith(path.join('tmp', 'review-runs')));
    assert.equal(traceDir('run-abc', { REDLINE_TRACE_DIR: '/x/y' }), path.join('/x/y', 'run-abc'));
  });

  await t.test('traceFileName: plain for single, 1-based index for batch', () => {
    assert.equal(traceFileName('prompt', 'md'), 'prompt.md');
    assert.equal(traceFileName('prompt', 'md', { batch: true, index: 0 }), 'prompt-1.md');
    assert.equal(traceFileName('validation', 'json', { batch: true, index: 2 }), 'validation-3.json');
  });

  await t.test('writeTraceFile: strings verbatim, objects pretty-printed, errors swallowed', async () => {
    await writeTraceFile('run-unit', 'a.md', 'raw text');
    await writeTraceFile('run-unit', 'b.json', { x: 1 });
    assert.equal(await readBundle('run-unit', 'a.md'), 'raw text');
    assert.deepEqual(await readBundleJson('run-unit', 'b.json'), { x: 1 });
    // Unwritable root → logged, never thrown.
    await writeTraceFile('run-unit', 'c.json', { x: 1 }, { REDLINE_TRACE_DIR: '/dev/null/nope' });
  });

  await t.test('telemetryEndpoint: env "off" disables even over a configured endpoint', () => {
    assert.equal(telemetryEndpoint({ telemetry: { endpoint: 'http://cfg' } }, { REDLINE_OTEL_ENDPOINT: 'off' }), null);
    assert.equal(emitRunTrace({
      config: { telemetry: { endpoint: 'http://cfg' } }, env: { REDLINE_OTEL_ENDPOINT: 'off' },
      run: { runId: 'run-x', page: 'p', status: 'ok', startMs: 1, endMs: 2 }, spans: [],
    }), null);
  });

  await t.test('truncateAttr caps long values and says where the rest lives', () => {
    assert.equal(truncateAttr('short'), 'short');
    assert.equal(truncateAttr(null), '');
    const long = 'x'.repeat(ATTR_MAX_CHARS + 500);
    const cut = truncateAttr(long);
    assert.ok(cut.length < long.length);
    assert.ok(cut.includes('truncated 500 chars'));
    assert.ok(cut.includes('trace bundle'));
  });
});
