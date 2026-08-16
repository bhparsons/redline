// runner/lib/telemetry.mjs — one OTLP/HTTP trace per revise run.
//
// The endpoint resolves env REDLINE_OTEL_ENDPOINT (wins; the string "off"
// disables export) → config telemetry.endpoint (null disables) — loadConfig
// defaults that to local Arize Phoenix, so a configured runner exports by
// default. Emission is FIRE-AND-FORGET: the run path calls emitRunTrace()
// without awaiting it, so telemetry can never delay or fail a run; every
// export error is swallowed and logged to stderr — ONCE per endpoint, so a
// Phoenix that simply isn't running doesn't spam every run. Config
// telemetry.headers rides along on the POST (e.g. collector auth).
//
// WIRE FORMAT: OTLP/HTTP PROTOBUF by default — the mandatory-to-implement
// OTLP encoding, and the only one local Phoenix accepts (its /v1/traces
// returns 415 for application/json; verified 2026-07-22, amending frontload
// decision 2's JSON assumption). buildTrace() still produces the OTLP-JSON
// object shape as the tested intermediate; encodeTraceProtobuf() maps it to
// bytes at the edge. Collectors that only take JSON: telemetry.format
// "json" in redline.config.json.
//
// Attribute values are TRUNCATED at ATTR_MAX_CHARS (truncateAttr) — the
// trace bundle on disk (lib/trace.mjs) is the untruncated ground truth.
//
// Trace shape per run: root span `revise-run` (runId, page, archetype, model,
// status, error if any) with children `route` (archetype/scope/tier/source),
// `load-context`, `agent-request` (model, duration, truncated prompt/response
// text, token counts when the OpenRouter response included usage),
// `apply-edits` (edit count, validation duration, success, rejection
// code/error on failure), `save-sidecar`.

import crypto from 'node:crypto';

const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

// Resolve the configured endpoint: env wins ("off" = off), then config,
// else null (off). The local-Phoenix DEFAULT lives in loadConfig — an
// ad-hoc config object without an endpoint stays off.
export function telemetryEndpoint(config, env = process.env) {
  if (typeof env.REDLINE_OTEL_ENDPOINT === 'string' && env.REDLINE_OTEL_ENDPOINT.length > 0) {
    return env.REDLINE_OTEL_ENDPOINT === 'off' ? null : env.REDLINE_OTEL_ENDPOINT;
  }
  return config?.telemetry?.endpoint ?? null;
}

// Cap for one attribute value on the wire. Local trace-bundle files carry
// the full text.
export const ATTR_MAX_CHARS = 16_384;

export function truncateAttr(text) {
  const s = String(text ?? '');
  if (s.length <= ATTR_MAX_CHARS) return s;
  return `${s.slice(0, ATTR_MAX_CHARS)}... [truncated ${s.length - ATTR_MAX_CHARS} chars; full text in the trace bundle]`;
}

function otlpValue(v) {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number' && Number.isInteger(v)) return { intValue: String(v) };
  if (typeof v === 'number') return { doubleValue: v };
  return { stringValue: String(v) };
}

function otlpAttributes(obj) {
  return Object.entries(obj ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, v]) => ({ key, value: otlpValue(v) }));
}

const nanos = (ms) => String(Math.round(ms * 1e6));

// Build the OTLP/HTTP JSON payload for one run. Pure — exported for tests.
// spans: [{name, startMs, endMs, attributes?}] (epoch milliseconds).
export function buildTrace({ runId, page, archetype, model, status, error, startMs, endMs, spans = [] }) {
  const traceId = crypto.randomBytes(16).toString('hex');
  const rootSpanId = crypto.randomBytes(8).toString('hex');
  const root = {
    traceId,
    spanId: rootSpanId,
    name: 'revise-run',
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(startMs),
    endTimeUnixNano: nanos(endMs),
    // openinference.span.kind makes the tree read as a pipeline in Phoenix
    // (WP12): the run is a CHAIN, the agent call an LLM span, phases CHAINs.
    attributes: otlpAttributes({ 'openinference.span.kind': 'CHAIN', runId, page, archetype, model, status, error }),
    status: status === 'ok'
      ? { code: STATUS_OK }
      : { code: STATUS_ERROR, message: error ?? String(status) },
  };
  const children = spans.map((s) => ({
    traceId,
    spanId: crypto.randomBytes(8).toString('hex'),
    parentSpanId: rootSpanId,
    name: s.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(s.startMs),
    endTimeUnixNano: nanos(s.endMs),
    attributes: otlpAttributes({
      'openinference.span.kind': s.name === 'agent-request' ? 'LLM' : 'CHAIN',
      ...s.attributes,
    }),
    status: {},
  }));
  return {
    resourceSpans: [{
      resource: { attributes: otlpAttributes({ 'service.name': 'redline-runner' }) },
      scopeSpans: [{ scope: { name: 'redline-runner' }, spans: [root, ...children] }],
    }],
  };
}

// ---- OTLP protobuf encoding --------------------------------------------------
//
// A hand-rolled encoder for exactly the subset buildTrace() emits — no
// dependency, no schema compiler. Field numbers from the OTLP v1 protos
// (trace_service.proto / trace.proto / common.proto / resource.proto).

function varint(n) {
  let v = BigInt(n);
  const out = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return Buffer.from(out);
}

const keyBytes = (field, wireType) => varint((field << 3) | wireType);
const lenDelim = (field, bytes) => Buffer.concat([keyBytes(field, 2), varint(bytes.length), bytes]);
const strField = (field, s) => lenDelim(field, Buffer.from(String(s), 'utf8'));
const varintField = (field, n) => Buffer.concat([keyBytes(field, 0), varint(n)]);

function fixed64Field(field, value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([keyBytes(field, 1), buf]);
}

function doubleField(field, value) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value);
  return Buffer.concat([keyBytes(field, 1), buf]);
}

// AnyValue: string_value=1, bool_value=2, int_value=3, double_value=4.
function encodeAnyValue(value) {
  if ('stringValue' in value) return strField(1, value.stringValue);
  if ('boolValue' in value) return varintField(2, value.boolValue ? 1 : 0);
  if ('intValue' in value) return Buffer.concat([keyBytes(3, 0), varint(value.intValue)]);
  if ('doubleValue' in value) return doubleField(4, value.doubleValue);
  return strField(1, JSON.stringify(value));
}

// KeyValue: key=1, value=2(AnyValue).
const encodeKeyValue = (kv) => Buffer.concat([strField(1, kv.key), lenDelim(2, encodeAnyValue(kv.value))]);
const encodeAttributes = (field, attrs) =>
  Buffer.concat((attrs ?? []).map((kv) => lenDelim(field, encodeKeyValue(kv))));

// Span: trace_id=1, span_id=2, parent_span_id=4, name=5, kind=6,
// start=7(fixed64), end=8(fixed64), attributes=9, status=15.
function encodeSpan(span) {
  const parts = [
    lenDelim(1, Buffer.from(span.traceId, 'hex')),
    lenDelim(2, Buffer.from(span.spanId, 'hex')),
  ];
  if (span.parentSpanId) parts.push(lenDelim(4, Buffer.from(span.parentSpanId, 'hex')));
  parts.push(strField(5, span.name));
  if (span.kind) parts.push(varintField(6, span.kind));
  parts.push(fixed64Field(7, span.startTimeUnixNano));
  parts.push(fixed64Field(8, span.endTimeUnixNano));
  parts.push(encodeAttributes(9, span.attributes));
  const status = [];
  if (span.status?.message !== undefined) status.push(strField(2, span.status.message));
  if (span.status?.code !== undefined) status.push(varintField(3, span.status.code));
  if (status.length > 0) parts.push(lenDelim(15, Buffer.concat(status)));
  return Buffer.concat(parts);
}

// ExportTraceServiceRequest{resource_spans=1} / ResourceSpans{resource=1,
// scope_spans=2} / Resource{attributes=1} / ScopeSpans{scope=1, spans=2} /
// InstrumentationScope{name=1}. Exported for the wire-shape tests.
export function encodeTraceProtobuf(trace) {
  return Buffer.concat(trace.resourceSpans.map((rs) => {
    const resource = encodeAttributes(1, rs.resource?.attributes);
    const scopeSpans = Buffer.concat((rs.scopeSpans ?? []).map((ss) => {
      const scope = ss.scope?.name !== undefined ? lenDelim(1, strField(1, ss.scope.name)) : Buffer.alloc(0);
      const spans = Buffer.concat((ss.spans ?? []).map((s) => lenDelim(2, encodeSpan(s))));
      return lenDelim(2, Buffer.concat([scope, spans]));
    }));
    return lenDelim(1, Buffer.concat([lenDelim(1, resource), scopeSpans]));
  }));
}

// Endpoints whose export failure was already logged — telemetry is on by
// default now, so a collector that isn't running must not spam every run.
const loggedFailures = new Set();

// Emit the trace for one run. Returns null when telemetry is off, otherwise
// a promise that always settles (callers in the run path do NOT await it —
// it is returned so tests can). Never throws.
export function emitRunTrace({ config, env = process.env, run, spans }) {
  const endpoint = telemetryEndpoint(config, env);
  if (endpoint === null) return null;
  const json = config?.telemetry?.format === 'json';
  let body;
  try {
    const trace = buildTrace({ ...run, spans });
    body = json ? JSON.stringify(trace) : encodeTraceProtobuf(trace);
  } catch (err) {
    console.error(`[telemetry] could not build trace: ${err?.message ?? err}`);
    return null;
  }
  const logOnce = (message) => {
    if (loggedFailures.has(endpoint)) return;
    loggedFailures.add(endpoint);
    console.error(`[telemetry] ${message} (further failures for this endpoint stay quiet)`);
  };
  return fetch(endpoint, {
    method: 'POST',
    // Author headers first so ours always wins for content-type.
    headers: {
      ...(config?.telemetry?.headers ?? {}),
      'content-type': json ? 'application/json' : 'application/x-protobuf',
    },
    body,
    signal: AbortSignal.timeout(5000),
  }).then(async (res) => {
    if (!res.ok) logOnce(`OTLP endpoint ${endpoint} returned HTTP ${res.status}`);
    else loggedFailures.delete(endpoint); // recovered — log again if it re-breaks
    await res.text().catch(() => {}); // drain so the socket is released
  }).catch((err) => {
    logOnce(`trace export to ${endpoint} failed: ${err?.message ?? err}`);
  });
}
