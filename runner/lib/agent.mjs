// runner/lib/agent.mjs — the OpenRouter agent adapter.
//
// runAgent({prompt, model, config}) POSTs one chat-completions request and
// returns a TYPED RESULT, never an uncaught throw:
//   { ok: true,  result: {decisions, edits, inserts}, usage?: {inputTokens?, outputTokens?, costUsd?} }
//   { ok: false, errorType: 'timeout'|'network'|'http'|'parse'|'shape'|'truncated', message }
// usage is present only when the OpenRouter envelope carried token counts (and
// costUsd only when it carried usage.cost) — telemetry.mjs attaches it to the
// agent-request span and api.mjs sums it onto the run record.
//
// The assistant message must be a single JSON object of the shape
//   { decisions:      [{id, decision: addressed|declined|deferred, summary, note?}],
//     edits:          [{blockId, newInner}],
//     attributeEdits: [{blockId, class?, style?}],
//     theme:          "<css declarations for the page-level body rule>",
//     inserts:        [{afterBlockId|beforeBlockId, html}] }
// (edits/attributeEdits/inserts may be empty or absent; an attributeEdit names
// class and/or style only; each insert names EXACTLY ONE of
// afterBlockId/beforeBlockId, and its html must carry no data-rev — the
// server mints ids for new blocks, never the agent.)
// Markdown code fences around the JSON are tolerated and stripped.
//
// SECURITY: error messages are fixed strings (plus a status code / timeout
// value) — they never include the API key, the endpoint response body, or
// any other upstream content, because /api/run forwards them to the browser.
//
// PROMPT CACHING (#116): OpenRouter does NOT infer a cache prefix uniformly.
// OpenAI/DeepSeek/Grok/Groq/Moonshot/Z.AI cache automatically by prefix, but
// Anthropic and Google Gemini only cache the span a request explicitly marks
// with a `cache_control: {type:'ephemeral'}` breakpoint on a structured
// content block. Our standard tier is anthropic/claude-sonnet-5, so ordering
// the prompt stable-prefix-first is necessary but NOT sufficient — the
// breakpoint has to travel on the wire. buildMessages() below is the one
// place that decides the message shape.
//
// WHAT IS CACHEABLE (#123): the response contract ONLY. #116 put the document
// inside the cached prefix too, which looked like the bigger win and measured
// as a 78% prompt-side saving — on an UNCHANGED page. Every successful run
// edits the page, so run N+1 always missed and paid the 1.25x cache-WRITE
// premium to create an entry nothing would ever read: measured at +21.7% vs
// sending no cache_control at all (design/cost-model.md, runs L2-L5).
// The contract is the only span that is genuinely invariant, so it is the
// only span before the breakpoint. It is now invariant across PAGES as well
// as runs — no {{PAGE}}, no {{DOC}} — so every revise call in a session, a
// Send-All batch included, reads the same entry after the first write.

import { DEFAULT_MODEL_REASONING } from '../config/defaults.mjs';

const DECISION_VALUES = new Set(['addressed', 'declined', 'deferred']);
const BLOCK_ID_RE = /^[\w-]{1,64}$/;

// "Send no ceiling of ours — let the model run to its own maximum." A LEGAL
// value of maxTokens, not an absence of one: completeChat still requires the
// argument, so a lane must say this on purpose and it reads as a decision in
// the code and on the run record.
export const MODEL_MAX = 'model-max';

// How long a STREAM may go silent before we call it stuck (#139).
//
// This replaces a total-elapsed deadline, and the difference is the whole point.
// Total elapsed cannot tell a long reply from a hung one, so the only way to
// avoid killing legitimate work was to set the deadline generously — which
// meant a genuinely stuck call held the page for just as long. A gap between
// chunks distinguishes them: a reply still arriving is never cut off no matter
// how long it runs, and a connection that has stopped producing is abandoned in
// a minute instead of five.
export const STREAM_IDLE_MS = 60_000;

// The standard lane's output ceiling (#130). It returns full replacement inner
// HTML for every block it touches, so its output scales with the document, not
// with the comment — 4096 was enough for a sentence and not for a table.
//
// It is now MODEL_MAX, on Blake's call 2026-07-27, and the reasoning is worth
// keeping because it also applies to the next person tempted to pick a number:
//
//   You are billed for tokens the model WRITES, not for the ceiling you set.
//   So the two errors are not symmetric. A ceiling set too low costs you the
//   entire call — you pay in full and get unusable output. A ceiling set too
//   high costs nothing at all unless the model actually uses the headroom.
//
// The measured history said the same thing: across 263 billed calls the median
// reply was 45 tokens and the 90th percentile 476. Exactly two calls ever hit a
// ceiling, both at 4096, both truncated, together $0.13 spent for nothing. And
// those two are censored data — a truncated reply cannot tell you how long it
// wanted to be, so we have never once observed what a large rewrite actually
// needs. Picking any number now would be guessing from a sample that excludes
// the only cases that matter.
//
// The guard against a runaway reply is therefore NOT a token ceiling; it is the
// verbosity eval (backlog) plus the per-run cost already on every record.
export const STANDARD_MAX_TOKENS = MODEL_MAX;

// ---- prompt caching ---------------------------------------------------------

// The sentinel a prompt template places at the end of its stable prefix (the
// response contract) and before everything that varies — document, comment,
// context. It stays IN the prompt text — an HTML comment the model ignores —
// so the prompt persisted in the trace bundle is byte-identical to what was
// sent.
export const CACHE_BREAKPOINT_MARKER = '<!-- redline:cache-breakpoint -->';

// Providers whose caching is opt-in per content block. Everything else infers
// the prefix on its own, so we leave the request shape alone for them rather
// than send a field their normalizer may not expect.
const EXPLICIT_CACHE_PREFIXES = ['anthropic/', 'google/'];

// Below this the marker is not worth a breakpoint: every provider has a cache
// minimum (1,024 tokens for Sonnet / OpenAI / Gemini Flash, 4,096 for Opus and
// Gemini Pro) and a shorter prefix simply never becomes a cache entry. HTML
// prompts measure ~2.9 chars/token, so 4 KB is the floor that clears 1,024
// tokens. The revise contract alone is 6.8 KB / ~1,600 tokens — past the
// Sonnet and Flash minimum, but NOT past Opus's 4,096, where it will simply
// never cache. Measured in design/cost-model.md.
export const MIN_CACHE_PREFIX_CHARS = 4096;

/** True when `model` needs an explicit cache_control breakpoint to cache. */
export function needsCacheBreakpoint(model) {
  return typeof model === 'string'
    && EXPLICIT_CACHE_PREFIXES.some((p) => model.startsWith(p));
}

/**
 * Where the stable prefix ends, or null when this prompt has no usable
 * breakpoint. The FIRST marker wins: since #123 every substituted value (the
 * page name, the document, the comment, the context packs) renders AFTER the
 * template's own sentinel, so the first occurrence is always the template's.
 * A document that happened to contain the sentinel can only add later ones,
 * and taking the first keeps injected text out of the cacheable prefix.
 */
export function cacheBreakpoint(prompt) {
  if (typeof prompt !== 'string') return null;
  const at = prompt.indexOf(CACHE_BREAKPOINT_MARKER);
  if (at === -1) return null;
  const cut = at + CACHE_BREAKPOINT_MARKER.length;
  if (cut < MIN_CACHE_PREFIX_CHARS || cut >= prompt.length) return null;
  return cut;
}

/**
 * The `messages` array for one prompt. Default shape is unchanged — a single
 * user message whose content is the prompt string. When the prompt carries a
 * breakpoint AND the model needs an explicit one, the same text ships as two
 * text blocks whose concatenation is byte-identical to the prompt, the first
 * marked cacheable.
 */
export function buildMessages(prompt, model = null) {
  const cut = needsCacheBreakpoint(model) ? cacheBreakpoint(prompt) : null;
  if (cut === null) return [{ role: 'user', content: prompt }];
  return [{
    role: 'user',
    content: [
      { type: 'text', text: prompt.slice(0, cut), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: prompt.slice(cut) },
    ],
  }];
}

/**
 * The inverse of buildMessages: the prompt text a request carried, whichever
 * shape it used. Readers of a request body (the eval harness, tests) go
 * through here so the wire shape stays an adapter detail.
 */
export function promptText(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  const parts = [];
  for (const m of list) {
    const content = m?.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block?.text === 'string') parts.push(block.text);
      }
    }
  }
  return parts.join('');
}

// Strip a single surrounding markdown code fence (``` or ```json ... ```).
export function stripFences(text) {
  const trimmed = text.trim();
  const m = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

// Validate + normalize the agent's payload. Returns {decisions, edits} or
// null on any shape mismatch. Unknown extra fields are ignored.
export function validateAgentPayload(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Array.isArray(value.decisions)) return null;
  const decisions = [];
  for (const raw of value.decisions) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
    if (typeof raw.decision !== 'string' || !DECISION_VALUES.has(raw.decision)) return null;
    if (typeof raw.summary !== 'string') return null;
    const decision = { id: raw.id, decision: raw.decision, summary: raw.summary };
    if (raw.note !== undefined) {
      if (typeof raw.note !== 'string') return null;
      decision.note = raw.note;
    }
    decisions.push(decision);
  }
  const rawEdits = value.edits === undefined ? [] : value.edits;
  if (!Array.isArray(rawEdits)) return null;
  const edits = [];
  for (const raw of rawEdits) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.blockId !== 'string' || !BLOCK_ID_RE.test(raw.blockId)) return null;
    if (typeof raw.newInner !== 'string') return null;
    edits.push({ blockId: raw.blockId, newInner: raw.newInner });
  }
  // Attribute edits (WP4): {blockId, class?, style?} — class/style only, both
  // strings, at least one present. Any other key is a shape violation.
  const rawAttrEdits = value.attributeEdits === undefined ? [] : value.attributeEdits;
  if (!Array.isArray(rawAttrEdits)) return null;
  const attributeEdits = [];
  for (const raw of rawAttrEdits) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.blockId !== 'string' || !BLOCK_ID_RE.test(raw.blockId)) return null;
    const entry = { blockId: raw.blockId };
    if (raw.class !== undefined) {
      if (typeof raw.class !== 'string') return null;
      entry.class = raw.class;
    }
    if (raw.style !== undefined) {
      if (typeof raw.style !== 'string') return null;
      entry.style = raw.style;
    }
    if (entry.class === undefined && entry.style === undefined) return null;
    for (const key of Object.keys(raw)) {
      if (key !== 'blockId' && key !== 'class' && key !== 'style') return null;
    }
    attributeEdits.push(entry);
  }

  const rawInserts = value.inserts === undefined ? [] : value.inserts;
  if (!Array.isArray(rawInserts)) return null;
  const inserts = [];
  for (const raw of rawInserts) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const hasAfter = raw.afterBlockId !== undefined;
    const hasBefore = raw.beforeBlockId !== undefined;
    if (hasAfter === hasBefore) return null; // exactly one anchor key
    const anchor = hasAfter ? raw.afterBlockId : raw.beforeBlockId;
    if (typeof anchor !== 'string' || !BLOCK_ID_RE.test(anchor)) return null;
    if (typeof raw.html !== 'string' || raw.html.length === 0) return null;
    inserts.push(hasAfter
      ? { afterBlockId: anchor, html: raw.html }
      : { beforeBlockId: anchor, html: raw.html });
  }

  const result = { decisions, edits, attributeEdits, inserts };
  // Optional page-level theme edit (WP6): a string of CSS declarations. Only
  // present in the result when the agent sent one, so callers that never theme
  // keep the {decisions, edits, attributeEdits, inserts} shape.
  if (value.theme !== undefined) {
    if (typeof value.theme !== 'string') return null;
    result.theme = value.theme;
  }
  // Optional scope report (WP7): the agent's own read of how wide the change
  // is. The runner recomputes scope independently; this only lets the agent
  // request a confirmation (requiresConfirmation:true) or waive a broad-scope
  // one the user explicitly authorized (requiresConfirmation:false).
  if (value.scope !== undefined) {
    const s = value.scope;
    if (s === null || typeof s !== 'object' || Array.isArray(s)) return null;
    const scope = {};
    if (s.level !== undefined) {
      if (s.level !== 'block' && s.level !== 'section' && s.level !== 'page') return null;
      scope.level = s.level;
    }
    if (s.requiresConfirmation !== undefined) {
      if (typeof s.requiresConfirmation !== 'boolean') return null;
      scope.requiresConfirmation = s.requiresConfirmation;
    }
    if (s.summary !== undefined) {
      if (typeof s.summary !== 'string') return null;
      scope.summary = s.summary;
    }
    result.scope = scope;
  }
  return result;
}

/**
 * The billed usage an OpenRouter response envelope reported, or null when it
 * carried none: {inputTokens?, outputTokens?, costUsd?}.
 *
 * Exported because the envelope outlives the typed result (#124). A call whose
 * REPLY was unusable — bad JSON, wrong shape, an escalating tactical answer —
 * still cost money, and its `capture.envelope` is the only place that money is
 * visible. Callers that only read a successful result's `usage` under-report.
 */
export function usageFromEnvelope(envelope) {
  const raw = envelope?.usage;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usage = {};
  if (Number.isFinite(raw.prompt_tokens)) usage.inputTokens = raw.prompt_tokens;
  if (Number.isFinite(raw.completion_tokens)) usage.outputTokens = raw.completion_tokens;
  // OpenRouter reports the charged cost (USD) in usage.cost when the request
  // asked for it; absent for providers/models that don't return cost.
  if (Number.isFinite(raw.cost)) usage.costUsd = raw.cost;
  return Object.keys(usage).length > 0 ? usage : null;
}

function failure(errorType, message) {
  return { ok: false, errorType, message };
}

function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError'
    || err?.cause?.name === 'TimeoutError';
}

// ---- reasoning effort (#83) -------------------------------------------------

/**
 * The `reasoning` object a request should carry for `model`, or null to send
 * no reasoning field at all (today's behavior, and the right answer for any
 * model that does no reasoning to begin with).
 *
 * Sending nothing is NOT neutral on every model: OpenRouter reports
 * anthropic/claude-sonnet-5 with `default_effort: "high"`, so an unconfigured
 * request buys high-effort thinking by default. It IS neutral on
 * google/gemini-2.5-flash, which measured 0 reasoning tokens per run — and
 * because OpenRouter infers `enabled` from `effort`/`max_tokens`, sending that
 * model a reasoning object would switch thinking ON. Hence the map, not a flat
 * parameter. Table + reasoning live in runner/config/defaults.mjs.
 */
export function reasoningFor(model) {
  if (typeof model !== 'string') return null;
  return DEFAULT_MODEL_REASONING[model] ?? null;
}

// POST one chat-completions request and return the raw assistant content:
//   { ok: true,  content, envelope, usage? }
//   { ok: false, errorType: 'timeout'|'network'|'http'|'parse'|'shape'|'truncated', message }
// The revise loop (runAgent below) and the router (lib/router.mjs) both go
// through here — one transport, one error taxonomy, one capture hook.
//
// `capture` (optional) is filled in as the exchange progresses so the trace
// bundle (lib/trace.mjs) can persist the raw request/response: .request (the
// POST body — the key travels in a header, so the body is safe to persist),
// .httpStatus, .envelope (parsed response JSON), .content (the assistant
// message). Upstream ERROR bodies are deliberately never captured — the
// bundle is served to the browser by the run-log viewer.
export async function completeChat({
  prompt, model, config, capture = null,
  temperature = 0.2, maxTokens, timeoutMs = null, reasoning,
  stream = false, idleMs = STREAM_IDLE_MS,
}) {
  // maxTokens is REQUIRED, deliberately (#130). It used to default to 4096,
  // and the standard lane — the one lane whose output is a whole document's
  // worth of replacement HTML — was the only caller that never passed one, so
  // it silently inherited a ceiling chosen for nobody. The router (300) and the
  // tactical lane (4096) had both chosen on purpose. A default here cannot tell
  // "chose 4096" from "never thought about it"; requiring the argument can.
  //
  // MODEL_MAX is how a lane says "no ceiling of ours" — still a choice, still
  // stated at the call site, and the one shape that omits max_tokens on the
  // wire. Omitting it silently would be the original bug wearing a new hat.
  const capped = maxTokens !== MODEL_MAX;
  if (capped && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    throw new Error('completeChat: maxTokens is required — a positive integer, or MODEL_MAX');
  }
  const thinking = reasoning === undefined ? reasoningFor(model) : (reasoning ?? null);
  const { endpoint, apiKey } = config.agent;
  const timeout = timeoutMs ?? config.agent.timeoutMs ?? 60_000;

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const requestBody = {
    model,
    // One user message, or two text blocks with a cache breakpoint between
    // them when the model needs one (#116) — same text either way.
    messages: buildMessages(prompt, model),
    temperature,
    // Absent under MODEL_MAX: the field is how you impose a ceiling, so the way
    // to impose none is not to send it. The model's own maximum still applies,
    // and finish_reason still reports it if a reply somehow reaches it.
    ...(capped ? { max_tokens: maxTokens } : {}),
    // How hard the model thinks (#83). Omitted entirely unless this model has
    // an entry — see reasoningFor above for why "send nothing" is the correct
    // setting for a model that already does no reasoning. Pass `reasoning`
    // explicitly (an object, or null) to override the per-model default.
    ...(thinking === null ? {} : { reasoning: thinking }),
    // OpenRouter returns the real charged cost in usage.cost when asked.
    usage: { include: true },
  };
  if (stream) requestBody.stream = true;
  if (capture) capture.request = requestBody;

  // Streaming and non-streaming differ ONLY in transport. Both produce the same
  // envelope shape, so everything downstream — usageFromEnvelope, isTruncated,
  // the trace bundle, the run-log viewer — reads one thing and does not know or
  // care which path produced it (#139).
  const transport = stream
    ? await readStream({ endpoint, headers, requestBody, timeout, idleMs, capture })
    : await readWhole({ endpoint, headers, requestBody, timeout, capture });
  if (!transport.ok) {
    // We hung up mid-reply and never saw a usage block, but the tokens were
    // written and billed. Ask what it cost (#125). Only possible because
    // streaming surfaced the id before the abort — this is the whole reason
    // #139 had to come first.
    if (transport.usage === undefined && typeof transport.generationId === 'string') {
      const late = await fetchGenerationUsage({ config, generationId: transport.generationId });
      if (late !== null) {
        transport.usage = late;
        transport.usageSource = 'generation-lookup';
      }
    }
    return transport;
  }
  const envelope = transport.envelope;

  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    return failure('shape', 'agent response carried no assistant message');
  }
  if (capture) capture.content = content;

  const usage = usageFromEnvelope(envelope);

  // The model stopped because it hit OUR ceiling, not because it was done
  // (#130). Generation halted mid-token, so the JSON is unterminated and would
  // fail JSON.parse a moment from now — reported, before this, as
  // errorType 'parse' and HTTP 502, i.e. a budget we set surfacing to the
  // author as an upstream gateway failure. Name it for what it is, and carry
  // the usage out with the failure: those output tokens were generated and
  // billed, and spend with nothing to show for it is the spend most worth
  // seeing (#124/#128).
  if (isTruncated(envelope)) {
    const out = failure('truncated', capped
      ? `agent response hit the ${maxTokens}-token output ceiling and was cut off mid-reply`
      : "agent response hit the model's own output maximum and was cut off mid-reply");
    if (usage !== null) out.usage = usage;
    out.maxTokens = maxTokens;
    return out;
  }

  const out = { ok: true, content, envelope };
  if (usage !== null) out.usage = usage;
  out.maxTokens = maxTokens;
  return out;
}

// ---- transports ------------------------------------------------------------
//
// Both return {ok:true, envelope} or a failure(). The envelope is the
// non-streaming response shape in both cases; readStream reassembles one.

// One request, one reply, wait for all of it. Deadline is total elapsed time,
// which is correct HERE only because the callers on this path (the router at
// 300 tokens, the tactical lane) produce small replies by construction.
async function readWhole({ endpoint, headers, requestBody, timeout, capture }) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    if (isTimeout(err)) return failure('timeout', `agent request timed out after ${timeout} ms`);
    return failure('network', 'could not reach the agent endpoint');
  }

  if (capture) capture.httpStatus = response.status;
  if (!response.ok) {
    // Drain the body so the socket is released, but never surface it.
    await response.text().catch(() => {});
    return failure('http', `agent endpoint returned HTTP ${response.status}`);
  }

  let envelope;
  try {
    envelope = await response.json();
  } catch (err) {
    if (isTimeout(err)) return failure('timeout', `agent request timed out after ${timeout} ms`);
    return failure('parse', 'agent endpoint returned a non-JSON response');
  }
  if (capture) capture.envelope = envelope;
  return { ok: true, envelope };
}

// Read the reply as it is written, and reassemble the same envelope the
// non-streaming path returns (#139).
//
// Two deadlines, doing different jobs. `timeout` bounds the wait for the FIRST
// chunk — a request that never starts is stuck. After that the only clock is
// STREAM_IDLE_MS between chunks, deliberately with no total cap: a reply that
// keeps arriving is work in progress, and hanging up on it is what #130's
// timeout raise was papering over.
//
// A stream that dies mid-reply is still a failure — the JSON is incomplete, so
// there is nothing to apply — but it is a failure that HANDS BACK what it has:
// the partial text, the usage if a final frame arrived, and above all the
// generation id, which is the one thing #125 needs to ask what the call cost
// and the one thing a non-streaming abort can never produce.
async function readStream({ endpoint, headers, requestBody, timeout, idleMs, capture }) {
  const controller = new AbortController();
  let timer = null;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };

  let response;
  arm(timeout);
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, accept: 'text/event-stream' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (isAbort(err)) return failure('timeout', `agent request timed out after ${timeout} ms`);
    return failure('network', 'could not reach the agent endpoint');
  }

  if (capture) capture.httpStatus = response.status;
  if (!response.ok) {
    clearTimeout(timer);
    await response.text().catch(() => {});
    return failure('http', `agent endpoint returned HTTP ${response.status}`);
  }

  // Available before a single token is generated, which is exactly why it is
  // read here and not off the finished envelope (#125).
  const acc = {
    id: response.headers.get('x-generation-id') ?? null,
    model: null, content: '', finish: null, nativeFinish: null, usage: null, frames: 0,
  };
  if (capture && acc.id) capture.generationId = acc.id;

  if (!response.body) {
    clearTimeout(timer);
    return failure('shape', 'agent endpoint returned no response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let aborted = false;
  try {
    for await (const bytes of response.body) {
      arm(idleMs);
      const text = decoder.decode(bytes, { stream: true });
      raw += text;
      buffer += text;
      // SSE frames are newline-delimited; a frame may straddle two chunks, so
      // the trailing partial line stays in the buffer.
      let cut;
      while ((cut = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line.length === 0) continue;
        // OpenRouter sends ': OPENROUTER PROCESSING' keepalive comments. They
        // are not data, but they ARE liveness — the idle timer was already
        // rearmed above, which is the point of rearming per chunk not per frame.
        if (line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let frame;
        try { frame = JSON.parse(payload); } catch { continue; }
        absorbFrame(acc, frame);
      }
    }
  } catch (err) {
    if (isAbort(err)) aborted = true;
    else { clearTimeout(timer); return failure('network', 'the agent response stream failed'); }
  }
  clearTimeout(timer);

  // A provider behind OpenRouter may ignore `stream: true` and answer with an
  // ordinary JSON body. That is a perfectly good reply arriving in an
  // unexpected shape, so read it as one rather than discarding it for not being
  // event-stream — the alternative is failing a call we have already paid for
  // because of someone else's transport choice.
  if (!aborted && acc.frames === 0 && raw.trim().length > 0) {
    try {
      const whole = JSON.parse(raw);
      if (whole?.choices?.[0]?.message) {
        if (capture) capture.envelope = whole;
        return { ok: true, envelope: whole };
      }
    } catch { /* not JSON either — fall through to the frame-count failure */ }
  }

  const envelope = {
    id: acc.id,
    model: acc.model ?? requestBody.model,
    choices: [{
      message: { role: 'assistant', content: acc.content },
      finish_reason: acc.finish,
      native_finish_reason: acc.nativeFinish,
    }],
    ...(acc.usage ? { usage: acc.usage } : {}),
  };
  if (capture) {
    capture.envelope = envelope;
    if (acc.id) capture.generationId = acc.id;
  }

  if (aborted) {
    // Everything we hold rides out with the failure. Before streaming this
    // returned nothing at all, which is why a timed-out call could only ever
    // be recorded as $0 (#125).
    const out = failure('timeout',
      `agent response stalled for ${idleMs} ms and was abandoned mid-reply`);
    out.envelope = envelope;
    out.partialContent = acc.content;
    if (acc.id) out.generationId = acc.id;
    const usage = usageFromEnvelope(envelope);
    if (usage !== null) out.usage = usage;
    return out;
  }
  if (acc.frames === 0) return failure('shape', 'agent response stream carried no frames');
  return { ok: true, envelope };
}

// Where to ask what a generation cost, derived from the completions endpoint.
// Returns null when the endpoint is not the shape we know, because guessing a
// URL and posting an API key at it is worse than not knowing the cost.
export function generationUrl(endpoint) {
  if (typeof endpoint !== 'string') return null;
  const suffix = '/chat/completions';
  if (!endpoint.endsWith(suffix)) return null;
  return `${endpoint.slice(0, -suffix.length)}/generation`;
}

// What a call actually cost, asked AFTER the fact by generation id (#125).
//
// This exists for one case: we hung up before the reply finished, so no usage
// block ever reached us, but the tokens were generated and billed. It closes
// the last hole in "every call that spends money is on a record" — #124 and
// #128 closed the router call and the declined confirmation; this is the
// timeout.
//
// Best-effort by construction. It is diagnostics: a failed lookup must never
// turn a failed run into a differently-failed run, so every error path returns
// null and the run records what it always did. Two attempts, because a lookup
// fired the instant we abort races the provider's own accounting — the docs
// promise nothing either way, so the retry is a hedge, not a documented need.
export async function fetchGenerationUsage({ config, generationId, attempts = 2, delayMs = 400 }) {
  const url = generationUrl(config?.agent?.endpoint);
  if (url === null || typeof generationId !== 'string' || generationId.length === 0) return null;
  const apiKey = config.agent.apiKey;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await fetch(`${url}?id=${encodeURIComponent(generationId)}`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) continue;
      const body = await res.json();
      const d = body?.data;
      if (!d || typeof d !== 'object') continue;
      const usage = {};
      if (Number.isFinite(d.tokens_prompt)) usage.inputTokens = d.tokens_prompt;
      if (Number.isFinite(d.tokens_completion)) usage.outputTokens = d.tokens_completion;
      if (Number.isFinite(d.total_cost)) usage.costUsd = d.total_cost;
      if (Object.keys(usage).length === 0) continue;
      return usage;
    } catch { /* network, timeout, malformed — try again, then give up */ }
  }
  return null;
}

// Fold one SSE frame into the accumulating reply.
function absorbFrame(acc, frame) {
  acc.frames += 1;
  if (acc.id === null && typeof frame.id === 'string') acc.id = frame.id;
  if (acc.model === null && typeof frame.model === 'string') acc.model = frame.model;
  // The usage block rides the FINAL frame (we ask for it with usage.include).
  if (frame.usage && typeof frame.usage === 'object') acc.usage = frame.usage;
  const choice = frame.choices?.[0];
  if (!choice) return;
  const piece = choice.delta?.content;
  if (typeof piece === 'string') acc.content += piece;
  // Non-streaming responses can also arrive here if a provider ignores
  // stream:true — take the whole message rather than dropping the reply.
  else if (typeof choice.message?.content === 'string') acc.content += choice.message.content;
  if (typeof choice.finish_reason === 'string') acc.finish = choice.finish_reason;
  if (typeof choice.native_finish_reason === 'string') acc.nativeFinish = choice.native_finish_reason;
}

// AbortSignal.timeout() throws TimeoutError; controller.abort() throws
// AbortError. Both mean "we gave up waiting", and the stream path uses the
// latter because its deadline moves.
function isAbort(err) {
  return isTimeout(err) || err?.name === 'AbortError';
}

// Did the provider stop generation at the token ceiling? OpenRouter passes the
// upstream reason through as `finish_reason` and additionally normalizes it
// into `native_finish_reason`; either saying "length" means truncation. Nothing
// in the runner read this field at all before #130 — the signal was on every
// response and discarded, which is why a truncation could masquerade as a parse
// error for as long as it did.
export function isTruncated(envelope) {
  const choice = envelope?.choices?.[0];
  if (!choice || typeof choice !== 'object') return false;
  return choice.finish_reason === 'length' || choice.native_finish_reason === 'length';
}

// POST the prompt to the configured OpenRouter-compatible endpoint and
// return the validated structured revise result. Never throws.
export async function runAgent({
  prompt, model, config, capture = null, maxTokens = STANDARD_MAX_TOKENS,
  stream = true, idleMs = STREAM_IDLE_MS,
}) {
  // The standard lane streams by default (#139). It is the lane with no output
  // ceiling and the longest replies, so it is the one where a total-elapsed
  // deadline cannot tell "writing a lot" from "stuck". The router and the
  // tactical lane keep the simple transport: their replies are small by
  // construction, so there is nothing for a gap-based clock to improve.
  const completed = await completeChat({ prompt, model, config, capture, maxTokens, stream, idleMs });
  if (!completed.ok) return completed;

  let parsed;
  try {
    parsed = JSON.parse(stripFences(completed.content));
  } catch {
    return failure('parse', 'agent reply was not valid JSON');
  }

  const result = validateAgentPayload(parsed);
  if (result === null) {
    return failure('shape', 'agent reply did not match the expected {decisions, edits} shape');
  }

  const out = { ok: true, result };
  if (completed.usage) out.usage = completed.usage;
  if (Number.isFinite(completed.maxTokens) || completed.maxTokens === MODEL_MAX) {
    out.maxTokens = completed.maxTokens;
  }
  return out;
}
