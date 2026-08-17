// runner/lib/api.mjs — the runner's JSON API.
//
//   POST /api/comment                {page, body, anchor, aiEdits?} → created
//                                    comment (201). aiEdits at CREATION (#185):
//                                    absent keeps the per-creator default,
//                                    false is born a note.
//   GET  /api/comments?page=...      → {comments: [...]}
//   POST /api/comment/:id/reply      {page, body}         → updated comment
//   POST /api/comment/:id/status     {page, status}       → updated comment
//   POST /api/comment/:id/ai-edits   {page, value:bool}   → updated comment (#96)
//   POST /api/comment/:id/anchor     {page, anchor}       → updated comment (#157)
//   POST /api/run                    {page, commentId}    → run record (200)
//   POST /api/edit                   {page, blockId, newInner} → direct-edit run (200)
//                                    or {page, commentIds: [...]} — Send All
//                                    batch (contract amendment 2026-07-22):
//                                    one lock, one snapshot, sequential
//                                    per-comment agent calls, strict
//                                    atomicity, one run record, one undo unit
//   GET  /api/status?page=...        → {running, runId?, lastRun?, session,
//                                        hold,
//                                        pendingConfirmation? {runId, scope, createdAt}}
//   POST /api/hold                   {page, hold:bool} → hold state + the
//                                    count held back since it went on (#190)
//
// Presence (#187) — one watching agent per page, TTL'd, in memory:
//
//   POST /api/session/claim          {page, agentName, pid?, ttlMs?} → the
//                                    claim, or 409 naming the holder
//   POST /api/session/heartbeat      {sessionId} → the extended claim
//   POST /api/session/release        {sessionId} → {ok, released}
//
// Holdable block leases (#188) — the same ledger #38 already runs, given verbs
// so a session can hold blocks ACROSS several calls instead of for one:
//
//   POST   /api/lease                {page, blocks[], sessionId, ttlMs?} →
//                                    {leaseId, expiresAt, …} or 409 in the
//                                    existing refusal vocabulary
//   POST   /api/lease/renew          {leaseId, ttlMs?} → the extended lease
//   DELETE /api/lease/:id            ?sessionId=… (the holder) or ?force=1
//                                    (break glass, recorded in runs[])
//   DELETE /api/lease?page=…&force=1 break every hold on a page
//   POST /api/undo                   {page}               → undone run record
//   POST /api/instrument             {page}               → {ok, added, total}
//                                    (idempotent data-rev stamping)
//
// The agent access layer (M2 WP2) adds three read/propose surfaces and one
// provenance rule; everything else is unchanged. See docs/AGENT-CONTRACT.md.
//
//   GET  /api/info                   → {root, port, pid, startedAt, version, hasApiKey}
//   GET  /api/source?page=...        → {page, source, bytes, blocks:[{id,tag,text}]}
//   POST /api/propose-edits          {page, commentId?, dryRun?, decisions?,
//                                    edits?, inserts?, scope?} → validation
//                                    verdict (dryRun, default true), the
//                                    applied run record, or a
//                                    {pendingConfirmation} scope ask (#195).
//                                    Same payload shape the model returns
//                                    inside a run, same validator, same writer,
//                                    same snapshot/undo semantics, and since
//                                    #195 the same scope guardrail.
//
// Provenance: /api/comment, /reply, /status and /propose-edits all accept
// optional {creator: 'agent'|'human', agentName}. ABSENT means human — legacy
// sidecars are never migrated, so absence must keep reading as human forever.
//
// Everything is validated server-side: unknown page → 404, missing/oversized
// body → 400, unknown comment id → 404, bad JSON → 400. Request payloads are
// capped at 64 KB.
//
// /api/run (Session 5: the full loop) — snapshot → route (WP3: small-model
// router, keyword-classifier fallback) → prompt → runAgent → applyEdits →
// sidecar update → telemetry. One run at a time per
// page (in-memory lock; concurrent POST → 409). The agent only ever returns
// JSON: every document write goes through apply.mjs/surgery.mjs, and any
// failure after the snapshot restores the doc from it and records the run as
// failed. Agent transport failures → 502; validation/apply failures → 422 —
// both with a safe fixed message (no API key, no upstream body) plus the
// failed run record. Comment statuses gain the decision vocabulary
// (addressed | declined | deferred) on top of Session 3's open | resolved;
// the manual /status endpoint still accepts only open | resolved, and "open"
// reopens a comment from any state.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { load, update, applyOps, resolvePage, newId, now, atomicWriteFile, onSave } from './store.mjs';
import { createEventHub } from './events.mjs';
import { routeComment, modelForRoute } from './router.mjs';
import { tacticalEligible, runTactical } from './tactical.mjs';
import { loadSkills } from './skills.mjs';
import { runAgent, validateAgentPayload, usageFromEnvelope, MODEL_MAX } from './agent.mjs';
import { locateBlock, findQuoteBlock, checkBalanced, revIds } from './surgery.mjs';
import { instrumentSource, CONTAINER_TAGS } from './instrument.mjs';
import { applyEdits } from './apply.mjs';
import {
  computeScope, confirmationDecision, scopeSummary, describeReach, gateRecord,
} from './scope.mjs';
import { saveSnapshot, loadSnapshot, restoreDoc } from './history.mjs';
import { emitRunTrace, truncateAttr } from './telemetry.mjs';
import { promptManifest, usageManifest, manifestAttributes } from './context-manifest.mjs';
import { writeTraceFile, traceFileName, traceDir } from './trace.mjs';
import { listDirectory } from './directory.mjs';
import { loadSecret, verifyToken } from './identity.mjs';
import {
  createRunRegistry, PAGE, HOLD_LANE, normalizeLeaseTtl,
} from './leases.mjs';
import { createSessionRegistry } from './sessions.mjs';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_BODY_CHARS = 10_000;
const MAX_QUOTE_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 200;
const MAX_BATCH_COMMENTS = 20;
// open | resolved are the author's manual vocabulary; addressed | declined |
// deferred are what a run writes onto a comment — accepted here too (M2 WP2)
// so an agent can restore a state the runner itself produces. "open" reopens
// a comment from any state.
const STATUSES = new Set(['open', 'resolved', 'addressed', 'declined', 'deferred']);
const CREATORS = new Set(['human', 'agent']);
const AGENT_NAME_RE = /^[\w.-]{1,64}$/;
// Characters of block text carried in the /api/source block index.
const SOURCE_TEXT_CHARS = 120;

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Read the request payload, capped. Resolves {over:true} or {text}.
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? { over: true } : { text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ over: true }));
  });
}

// Parse the JSON request payload; on any problem, sends the 400 and returns null.
async function readJson(req, res) {
  const body = await readBody(req);
  if (body.over) {
    sendJson(res, 400, { error: 'request body too large' });
    return null;
  }
  let value;
  try {
    value = JSON.parse(body.text);
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' });
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    sendJson(res, 400, { error: 'invalid JSON' });
    return null;
  }
  return value;
}

// Comment/reply body: non-empty string after trimming, capped.
function validBody(raw) {
  if (typeof raw !== 'string') return null;
  const body = raw.trim();
  if (body.length === 0 || body.length > MAX_BODY_CHARS) return null;
  return body;
}

// Anchor shape: {blockId?, quote, prefix?, suffix?}. Values are stored
// verbatim after shape validation — resolution/fallback is a later session.
function validAnchor(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.quote !== 'string' || raw.quote.length === 0 || raw.quote.length > MAX_QUOTE_CHARS) return null;
  const anchor = { quote: raw.quote };
  if (raw.blockId !== undefined) {
    if (typeof raw.blockId !== 'string' || !/^[\w-]{1,64}$/.test(raw.blockId)) return null;
    anchor.blockId = raw.blockId;
  }
  for (const key of ['prefix', 'suffix']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || raw[key].length > MAX_CONTEXT_CHARS) return null;
    anchor[key] = raw[key];
  }
  return anchor;
}

// Provenance fields, accepted on every write endpoint an agent can reach
// (M2 WP2): {creator: 'agent'|'human', agentName}. Returns the fields to
// record — {} when the caller said nothing (absent = human, and absence is
// what every M1 sidecar carries) — or null when either field is malformed.
// agentName without creator:'agent' is dropped: an actor is only named when
// it declared itself an agent.
function validActor(raw) {
  const actor = {};
  if (raw.creator !== undefined) {
    if (typeof raw.creator !== 'string' || !CREATORS.has(raw.creator)) return null;
    actor.creator = raw.creator;
  }
  if (raw.agentName !== undefined) {
    if (typeof raw.agentName !== 'string' || !AGENT_NAME_RE.test(raw.agentName)) return null;
    if (actor.creator === 'agent') actor.agentName = raw.agentName;
  }
  return actor;
}

// #41: token-aware actor resolution for the comment-thread writes. A VALID
// signed token is a verified identity: the actor comes from it and the
// payload's self-declared creator/agentName are ignored. An INVALID token is
// a 400 — someone presented a credential and it failed, which must never
// degrade to the honor system. An ABSENT token keeps today's behavior
// exactly. Secrets are per served root, cached after first read.
const identitySecrets = new Map();
async function identitySecret(root) {
  if (!identitySecrets.has(root)) identitySecrets.set(root, await loadSecret(root));
  return identitySecrets.get(root);
}
async function resolveActor(root, payload) {
  if (payload.token !== undefined) {
    const id = typeof payload.token === 'string'
      ? verifyToken(payload.token, await identitySecret(root))
      : null;
    if (id === null) return { error: 'invalid token' };
    return { actor: { creator: 'human', author: id.name, role: id.role } };
  }
  const actor = validActor(payload);
  if (actor === null) return { error: 'invalid creator or agentName' };
  return { actor };
}

async function createComment(root, req, res) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  const htmlPath = await resolvePage(root, payload.page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  const body = validBody(payload.body);
  if (body === null) {
    sendJson(res, 400, { error: 'missing or invalid body' });
    return;
  }
  const anchor = validAnchor(payload.anchor);
  if (anchor === null) {
    sendJson(res, 400, { error: 'missing or invalid anchor' });
    return;
  }
  const resolved = await resolveActor(root, payload);
  if (resolved.error) {
    sendJson(res, 400, { error: resolved.error });
    return;
  }
  const actor = resolved.actor;
  // #185: the actionable/note flag AT CREATION. The overlay used to POST the
  // comment and then POST /ai-edits, and between those two writes — two revs,
  // two SSE frames — a note was indistinguishable from an edit request, so any
  // watcher could action text the author had marked do-not-touch. Born with its
  // audience, the intermediate state does not exist. Absent keeps the defaults
  // below, so every existing caller is unchanged.
  if (payload.aiEdits !== undefined && typeof payload.aiEdits !== 'boolean') {
    sendJson(res, 400, { error: 'aiEdits must be a boolean' });
    return;
  }
  // #165: an AGENT's comment defaults to a note — out of the Send-All batch
  // until a human flags it in. A person writes every comment deliberately, so
  // opt-out is right for them; an agent drops observations and questions into
  // a thread, and silence there would mean "spend money revising this".
  // Enforced here rather than in mcp-tools so the CLI, MCP and any direct
  // HTTP agent get the same default and the surfaces cannot drift. An explicit
  // aiEdits overrides the default in either direction.
  const actionable = payload.aiEdits !== undefined ? payload.aiEdits : actor.creator !== 'agent';
  const comment = {
    id: newId('c'),
    body,
    anchor,
    status: 'open',
    replies: [],
    createdAt: now(),
    ...actor,
    // Storage convention is store.mjs's: only `false` is recorded, absent = in.
    ...(actionable ? {} : { aiEdits: false }),
  };
  await update(htmlPath, (data) => {
    applyOps(data, [{ op: 'addComment', comment }]);
  });
  sendJson(res, 201, comment);
}

/**
 * Which comments quote text the document no longer contains (R-006)?
 *
 * Compared against the block the anchor NAMES, not the whole document: a quote
 * that still exists somewhere else is still orphaned from the paragraph the
 * author was talking about, and saying otherwise would be worse than saying
 * nothing. A comment with no quote, or naming a block that is gone, is not
 * reported here — a missing block is a different fault and inventing a flag for
 * it would blur the one this answers.
 *
 * Whitespace is normalised on both sides because the source is wrapped and the
 * quote came from a rendered selection; entities are decoded for the same
 * reason. Anything else compares a paragraph against how it happens to be typed.
 *
 * Never throws: a document that cannot be read means we do not know, and "we do
 * not know" must not read as "everything is fine" OR take the whole endpoint
 * down with it — so it reports nothing orphaned and the comments still come back.
 */
function decodeText(t) {
  // Only the five surgery.mjs encodes on the way in — this compares text, it is
  // not a parser, and a general entity decoder here would be a second, weaker
  // implementation of one that already exists.
  return t
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

async function orphanedAnchors(htmlPath, comments) {
  const flagged = new Set();
  const quoted = comments.filter((c) => typeof c?.anchor?.quote === 'string' && c.anchor.quote.trim() !== '');
  if (quoted.length === 0) return flagged;
  let source;
  try {
    source = await fs.readFile(htmlPath, 'utf8');
  } catch {
    return flagged;
  }
  // blockText() is the same tag-strip-and-collapse the rest of this file uses
  // to turn a block's inner HTML into plain text; Infinity because a quote can
  // sit anywhere in a paragraph, not just its first 120 characters.
  const norm = (t) => decodeText(String(t)).replace(/\s+/g, ' ').trim();
  const byId = new Map(stampedBlocks(source).map((b) => [b.id, norm(blockText(b.inner, Infinity))]));
  for (const c of quoted) {
    const blockId = c.anchor.blockId;
    if (typeof blockId !== 'string') continue;
    const text = byId.get(blockId);
    if (text === undefined) continue;          // block gone: a different fault
    if (!text.includes(norm(c.anchor.quote))) flagged.add(c.id);
  }
  return flagged;
}

async function listComments(root, url, res) {
  const page = url.searchParams.get('page');
  if (!page) {
    sendJson(res, 400, { error: 'missing page' });
    return;
  }
  const htmlPath = await resolvePage(root, page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  const data = await load(htmlPath);
  // #235: a read receipt records that the WATCHER has seen this rev — so only a
  // caller that presents its session capability advances it. The author's own
  // overlay poll carries no sessionId and must never mark the watcher caught
  // up (that false positive was the whole defect). markSeen is a no-op unless
  // the id names a live session watching THIS page.
  const seenBy = url.searchParams.get('sessionId');
  if (seenBy) presence.markSeen(seenBy, htmlPath, data.rev ?? 0);
  // runs[] rides along so a client can interleave the ask, the replies and every
  // decision by timestamp the way commentThread() already does for the agent
  // prompt (#199). /api/status carries live leases and a single lastRun, which is
  // not the same thing: a card that was declined, argued with and then addressed
  // needs the whole history. Read-only projection — each record already carries
  // lane and actor, so a reader can tell a browser run from a session-authored one.
  //
  // #234: hold info rides along too, so a watcher polling /api/comments can
  // see which comments are held without a second round-trip to /api/status.
  // Each currently-held comment is also flagged with `held: true`.
  const heldIds = new Set(holdView(data).heldCommentIds);
  // R-006: an anchor whose quoted text an edit rewrote points at nothing, and
  // nothing said so. The highlight lands in the wrong place, status changes are
  // accepted without complaint, and the only way to notice was to read the
  // document yourself. redline_resolve_comment already takes an `anchor` to fix
  // one — there was just no detection when a caller forgot.
  const orphaned = await orphanedAnchors(htmlPath, data.comments);
  const comments = data.comments.map((c) => (
    heldIds.has(c.id) || orphaned.has(c.id)
      ? { ...c, ...(heldIds.has(c.id) ? { held: true } : {}), ...(orphaned.has(c.id) ? { orphaned: true } : {}) }
      : c
  ));
  sendJson(res, 200, { comments, runs: data.runs ?? [], hold: holdView(data) });
}

async function updateComment(root, req, res, id, action) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  const htmlPath = await resolvePage(root, payload.page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }

  const resolved = await resolveActor(root, payload);
  if (resolved.error) {
    sendJson(res, 400, { error: resolved.error });
    return;
  }
  const actor = resolved.actor;

  let body = null;
  let status = null;
  let aiEdits = null;
  let anchor = null;
  if (action === 'reply') {
    body = validBody(payload.body);
    if (body === null) {
      sendJson(res, 400, { error: 'missing or invalid body' });
      return;
    }
  } else if (action === 'ai-edits') {
    if (typeof payload.value !== 'boolean') {
      sendJson(res, 400, { error: 'value must be a boolean' });
      return;
    }
    aiEdits = payload.value;
  } else if (action === 'anchor') {
    // Re-anchor an orphaned comment (#157) to a new location — the same anchor
    // shape a fresh comment carries, validated identically.
    anchor = validAnchor(payload.anchor);
    if (anchor === null) {
      sendJson(res, 400, { error: 'missing or invalid anchor' });
      return;
    }
  } else {
    status = payload.status;
    if (typeof status !== 'string' || !STATUSES.has(status)) {
      sendJson(res, 400, { error: `status must be one of: ${[...STATUSES].join(', ')}` });
      return;
    }
    // `resolved` means "a human accepted this" (#250). An agent accepting its
    // own work would take the comment out of the author's queue unseen.
    if (status === 'resolved' && actor.creator === 'agent') {
      sendJson(res, 403, {
        error: 'resolved is a human act — an agent may not accept its own work; '
          + 'leave the decision (addressed/declined/deferred) for the author to resolve',
      });
      return;
    }
  }

  const updated = await update(htmlPath, (data, { skip }) => {
    const comment = data.comments.find((c) => c.id === id);
    if (!comment) {
      skip(); // nothing changed — don't burn a rev on a 404
      return null;
    }
    // statusUpdatedBy: who last moved this comment, when — the status field
    // itself carries no history, and an agent flipping it must be attributable.
    const op = action === 'reply'
      ? { op: 'reply', commentId: id, entry: { id: newId('rp'), body, createdAt: now(), ...actor } }
      : action === 'ai-edits'
        ? { op: 'setAiEdits', commentId: id, value: aiEdits }
        : action === 'anchor'
          ? { op: 'setAnchor', commentId: id, anchor }
          : { op: 'setStatus', commentId: id, status, by: actor.creator !== undefined ? { ...actor, at: now() } : null };
    const ops = [op];
    // A human reply to a settled comment RE-OPENS it, in the same write (#250).
    // This rule lived in the overlay (reply, then a second status call), so
    // only the overlay obeyed it and a failure between the calls left a reply
    // with no re-open. Agent replies never re-open — an agent must not reverse
    // the author's state.
    if (action === 'reply' && comment.status !== 'open' && actor.creator !== 'agent') {
      ops.push({
        op: 'setStatus', commentId: id, status: 'open',
        by: actor.creator !== undefined ? { ...actor, at: now() } : null,
      });
    }
    applyOps(data, ops);
    return comment;
  });

  if (updated === null) {
    sendJson(res, 404, { error: 'unknown comment' });
    return;
  }
  sendJson(res, 200, updated);
}

// ---- /api/run (Session 5: the full revise loop) ----------------------------

const PROMPT_TEMPLATE_URL = new URL('../prompts/revise.md', import.meta.url);
let promptTemplateCache = null;

async function loadPromptTemplate() {
  if (promptTemplateCache === null) {
    promptTemplateCache = await fs.readFile(PROMPT_TEMPLATE_URL, 'utf8');
  }
  return promptTemplateCache;
}

function renderTemplate(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

// Describe the anchor for the prompt when no block HTML is available.
function anchorFallback(anchor) {
  const lines = [`quote: ${JSON.stringify(anchor.quote ?? '')}`];
  if (anchor.prefix !== undefined) lines.push(`prefix: ${JSON.stringify(anchor.prefix)}`);
  if (anchor.suffix !== undefined) lines.push(`suffix: ${JSON.stringify(anchor.suffix)}`);
  return lines.join('\n');
}

// ---- section-scoped context (WP2) ------------------------------------------

// Every stamped block in the source with its locateBlock() geometry, in
// document order. Duplicate/malformed ids resolve to null and are dropped.
function stampedBlocks(source) {
  return [...new Set(revIds(source))]
    .map((id) => ({ id, block: locateBlock(source, id) }))
    .filter((e) => e.block !== null)
    .map(({ id, block }) => ({ id, ...block }))
    .sort((a, b) => a.outerStart - b.outerStart);
}

const encloses = (outer, inner) =>
  outer.outerStart < inner.outerStart && inner.outerEnd <= outer.outerEnd;

// The smallest stamped CONTAINER strictly enclosing `entry` (null = top level).
function containerParent(entry, blocks) {
  let best = null;
  for (const b of blocks) {
    if (!CONTAINER_TAGS.has(b.tag) || b.id === entry.id || !encloses(b, entry)) continue;
    if (best === null || encloses(best, b)) best = b;
  }
  return best;
}

// The start of a block's text content, tags stripped and whitespace collapsed.
function blockText(inner, max) {
  return inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// One flat-index line: id, tag, and the start of the block's text content.
function indexLine(entry) {
  return `- ${entry.id} <${entry.tag}> ${blockText(entry.inner, 80) || '(no text)'}`;
}

// The {{BLOCK_HTML}} view for a comment anchored to a CONTAINER: the whole
// section's outer HTML (every child block id visible), a flat index of its
// sibling sections, and a flat index of the document's top-level blocks — so
// the agent can edit throughout the section and place inserts confidently.
// When the section IS essentially the whole page, the outer HTML is dropped
// and this points up at the document source instead (see DOC_ECHO_THRESHOLD).
function sectionView(source, anchor, section) {
  const blocks = stampedBlocks(source);
  const entry = blocks.find((b) => b.id === anchor.blockId);
  const parent = entry ? containerParent(entry, blocks) : null;
  const siblings = blocks.filter((b) =>
    b.id !== anchor.blockId && CONTAINER_TAGS.has(b.tag)
    && (containerParent(b, blocks)?.id ?? null) === (parent?.id ?? null));
  const topLevel = blocks.filter((b) => blocks.every((o) => o.id === b.id || !encloses(o, b)));
  const list = (entries) => (entries.length > 0 ? entries.map(indexLine).join('\n') : '(none)');
  const coverage = sectionCoverage(source, section);
  const body = coverage >= DOC_ECHO_THRESHOLD
    ? ['This section is essentially the WHOLE document '
      + `(${Math.round(coverage * 100)}% of the page source), so it is not repeated here — `
      + 'read it from "Document source" above, where every block you may edit appears with its '
      + '`data-rev` attribute.']
    : ['Section outer HTML:', source.slice(section.outerStart, section.outerEnd)];
  return [
    `This comment is anchored to a whole SECTION (<${section.tag}> data-rev="${anchor.blockId}").`,
    'You may edit ANY block inside it (each by its own data-rev id) and anchor inserts to any of those ids — or to the section id itself for a new sibling section.',
    '',
    ...body,
    '',
    'Sibling sections (flat index):',
    list(siblings),
    '',
    'Top-level blocks in the document (flat index):',
    list(topLevel),
  ].join('\n');
}

/**
 * The comment's history as a TIME SERIES: the original ask, the author's
 * replies, and — the part that was missing (#108) — this runner's own prior
 * decisions on the comment, interleaved in chronological order.
 *
 * Without the agent's own turns, a re-run sees `ask → reply` with nothing in
 * between, so a reply answering a decline ("ok let's try forest green
 * instead") reads as the author spontaneously retracting the ask rather than
 * conceding to an objection. That is exactly how a live run misread it and
 * declined twice. Pure; `runs` may be empty or absent.
 *
 * Returns {thread:[{at, role, ...}], latestAsk} where latestAsk is the last
 * thing the AUTHOR said — the operative request.
 */
export function commentThread(comment, runs = []) {
  const thread = [{
    at: comment.createdAt ?? '',
    role: 'reviewer',
    kind: 'ask',
    body: comment.body,
  }];

  for (const reply of Array.isArray(comment.replies) ? comment.replies : []) {
    thread.push({
      at: reply.createdAt ?? '',
      role: reply.creator === 'agent' ? 'agent' : 'reviewer',
      kind: 'reply',
      body: reply.body,
      ...(reply.agentName ? { agentName: reply.agentName } : {}),
    });
  }

  for (const run of Array.isArray(runs) ? runs : []) {
    const covers = Array.isArray(run.commentIds)
      ? run.commentIds.includes(comment.id)
      : run.commentId === comment.id;
    if (!covers) continue;
    for (const d of Array.isArray(run.decisions) ? run.decisions : []) {
      if (d.id !== comment.id) continue;
      thread.push({
        at: run.createdAt ?? '',
        role: 'agent',
        kind: 'decision',
        decision: d.decision,
        summary: d.summary,
        ...(d.note !== undefined ? { note: d.note } : {}),
        ...(run.status === 'undone' ? { undone: true } : {}),
      });
    }
  }

  // Stable chronological order; entries without a timestamp keep their
  // insertion position rather than jumping to the front.
  thread.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const lastReviewer = [...thread].reverse().find((e) => e.role === 'reviewer');
  return { thread, latestAsk: lastReviewer ? lastReviewer.body : comment.body };
}

// A container anchor's section view can already BE the document — quote
// rescue reaches for containers readily (#109), and `<main>` covers the whole
// page. Rendering both then ships the largest thing in the prompt twice:
// measured at 35% duplicated content on a live run (#115). Above this
// coverage exactly one copy is sent.
//
// WHICH copy survives changed with #116 and stays that way. #115 kept the
// section view and pointed {{DOC}} at it; #116 flipped it so the DOCUMENT is
// always sent in full and the SECTION VIEW points up at it. #123 moved the
// document back OUT of the cached prefix (it changes on every successful run,
// so caching it only bought a write premium), but the dedupe choice is
// unchanged: one canonical full copy the agent can quote block ids from beats
// a per-comment excerpt. Same invariant as #115 — the page source appears
// exactly once.
export const DOC_ECHO_THRESHOLD = 0.85;

/** How much of the page a located block's outer range covers, 0-1. Pure. */
export function sectionCoverage(source, block) {
  if (block === null || typeof source !== 'string' || source.length === 0) return 0;
  return (block.outerEnd - block.outerStart) / source.length;
}

// Build the {{BLOCK_HTML}} section: a section-scoped view when the anchor is
// a stamped container (WP2), the block's current inner HTML for ordinary
// blocks, otherwise the anchor quote/prefix/suffix plus a plain-text note
// that no stable block id exists. Exported for the dedupe tests (#115/#116).
export function blockSection(source, anchor) {
  if (anchor.blockId) {
    const block = locateBlock(source, anchor.blockId);
    if (block) {
      if (CONTAINER_TAGS.has(block.tag)) return sectionView(source, anchor, block);
      return `blockId: ${anchor.blockId}\ncurrent inner HTML of the block:\n${block.inner}`;
    }
    return `NOTE: block "${anchor.blockId}" was not found in the current page source, so no stable block id is usable for this comment.\n${anchorFallback(anchor)}`;
  }
  return `NOTE: no stable block id exists for this comment; it is anchored by quote only.\n${anchorFallback(anchor)}`;
}

// Quote rescue: when a comment's anchor lacks a usable blockId (none was
// captured, or the one it names no longer exists in the source), locate the
// anchor's quote in the document text (surgery.findQuoteBlock decodes
// entities/tags the same way the browser's textContent did). An unambiguous
// hit becomes the comment's LOCATION: stamped onto the in-memory anchor for
// this run's prompt AND persisted onto the sidecar comment via the
// rev-checked update(). Ambiguous or missing quotes change nothing — the
// prompt keeps today's quote-only fallback.
async function rescueAnchor({ htmlPath, source, comment, anchor }) {
  if (typeof anchor.quote !== 'string' || anchor.quote.length === 0) return;
  if (anchor.blockId && locateBlock(source, anchor.blockId) !== null) return;
  const blockId = findQuoteBlock(source, anchor.quote);
  if (blockId === null) return;
  anchor.blockId = blockId;
  await update(htmlPath, (data, { skip }) => {
    const { applied } = applyOps(data, [{ op: 'setAnchorBlock', commentId: comment.id, blockId }]);
    if (applied.length === 0) skip(); // comment gone / anchor-less — nothing changed
  });
}

// The run registry and block-lease ledger (#38). Runs are keyed by runId, not
// by page: several may be live on one page as long as their block sets are
// disjoint. Admission, refusal reasons and the /api/status projection all come
// from here — see runner/lib/leases.mjs for the rules.
const registry = createRunRegistry();

// The session presence ledger (#187). One watching agent per page, keyed by the
// same resolved htmlPath the run registry and the sidecar store use. See
// runner/lib/sessions.mjs for why presence could not ride on the SSE hub.
const presence = createSessionRegistry();

// The SSE hub, fed from the store's save hook (#162). save() is the single
// chokepoint every sidecar mutation goes through, so one subscription is the
// whole change-detection path.
const hub = createEventHub();
let saveHookAttached = false;

/** Subscribe the hub to sidecar saves. Called by startServer rather than at
 *  module load, because `store → server → api → store` is a cycle: a top-level
 *  call here runs while store.mjs is still paused at its own import, and
 *  touching its bindings then throws on the temporal dead zone. Idempotent, so
 *  several servers in one process (the test suite) attach only once. */
export function initEventStream() {
  if (saveHookAttached) return;
  saveHookAttached = true;
  onSave((htmlPath, rev) => hub.publish(htmlPath, rev));
}

/** End every open stream. Server shutdown must call this — an open SSE
 *  response holds a socket, and http.Server.close() waits for those. */
export function closeEventStreams() {
  hub.closeAll();
}

// A paused run's already-computed agent result, keyed by runId, so confirming
// applies EXACTLY what was previewed without re-running the agent. The LEASE
// and the scope live on the registry; only the payload lives here, because the
// ledger has no business holding an agent response.
//
// #195 puts a second KIND of pause in here. `kind:'run'` is the original: an
// agent reply waiting to be re-driven through executeRun. `kind:'proposed'` and
// `kind:'direct-edit'` are session edits — the payload is already the final
// edit set, so confirming applies it directly instead of re-entering the run
// driver. Same stash, same lease, same Allow/Decline, same
// POST /api/run/confirm: the author's surface does not change because the
// writer did.
const pendingStash = new Map();

// Turn a registry refusal into the 409 body. The `reason` enum is the one #106
// established, widened by #38 — a caller that only knows the first two values
// still gets something it can render.
function conflictBody(clash) {
  const body = { error: LEASE_ERRORS[clash.reason] ?? 'the page is busy', reason: clash.reason, runId: clash.runId };
  if (Array.isArray(clash.blocks) && clash.blocks.length > 0) body.blocks = clash.blocks;
  const stashed = pendingStash.get(clash.runId);
  if (clash.reason === 'awaiting-confirmation' && stashed !== undefined) body.scope = stashed.scope ?? null;
  return body;
}

const LEASE_ERRORS = {
  'run-active': 'a run is already active for this page',
  'awaiting-confirmation': 'a run is awaiting your confirmation',
  'blocks-leased': 'another run is editing those blocks',
};

/** The blocks a set of comments is anchored to — a run's OPENING lease. The
 *  true reach is only known after the dry run, and is added via extend(). A
 *  comment with no resolvable anchor makes the reach unknown, which the ledger
 *  reads as page-exclusive rather than as "nothing". */
function anchorLease(comments) {
  const ids = [];
  for (const c of comments) {
    const blockId = c && c.anchor ? c.anchor.blockId : null;
    if (typeof blockId !== 'string' || blockId.length === 0) return PAGE;
    ids.push(blockId);
  }
  return ids.length === 0 ? PAGE : ids;
}

// ---- the scope guardrail, for every writer (WP7, extended by #195) ----------
//
// The gate began as a run-lane feature: after the model replied, DRY-RUN the
// edits, work out how far they actually reach, and pause for the author when
// they leave the anchored section or touch the page theme. A session editing
// through /api/propose-edits or /api/edit went straight past it — so a free
// local session could rewrite twelve headers with no pause, while the paid lane
// asked before rewriting two. The threshold is UNCHANGED (decision 14); what
// changes is who it applies to.
//
// KNOWN LIMIT, stated rather than patched. The rule measures reach against the
// section the COMMENT is anchored to. A proposal that names no commentId has no
// anchored section, so `outOfSection` can never be true for it and only a theme
// edit will fire the gate. Decision 14 forbids inventing a threshold here, so
// this is recorded as a hole for whoever tunes the rule from the logs below —
// not closed by guesswork.

/** Run the gate, and LOG the decision either way. Returns
 *  {computed, gate, record}. Never throws on the trace write: a diagnostic
 *  must not fail a write that is otherwise fine. */
async function evaluateScopeGate({
  source, anchorBlockId, editRecords, agentScope = null, runId, lane, traceName = 'scope.json',
}) {
  const computed = computeScope(source, { anchorBlockId, editRecords });
  const gate = confirmationDecision({ computed, agentScope });
  const record = gateRecord({ computed, gate, agentScope });
  try {
    // Every decision, fired or not (#195). A log that only keeps the times it
    // fired cannot answer "how often does it fire when it should not", which is
    // the question the threshold is meant to be tuned on.
    await writeTraceFile(runId, traceName, { lane, at: now(), computed, gate, record });
  } catch (err) {
    console.error(`[redline] failed to log the scope decision for ${runId}: ${err?.message ?? err}`);
  }
  return { computed, gate, record };
}

/** The ask the author sees: the reach named in the document's OWN WORDS, never
 *  by `data-rev` id — a reviewer approves what they can read (#106, mock part
 *  9). Built once and both stashed and returned, so the tab that started the
 *  write and a tab that polls /api/status cannot show different asks. */
function scopeAsk({ source, computed, gate, agentScope = null, editRecords }) {
  const themeRecord = (editRecords ?? []).find((r) => r && r.op === 'theme') ?? null;
  return {
    level: computed.level,
    reasons: gate.reasons,
    summary: scopeSummary({ computed, agentScope, reasons: gate.reasons }),
    touchedThemeZone: computed.touchedThemeZone,
    touchedBlocks: computed.touchedBlocks,
    reach: describeReach(source, {
      touchedBlocks: computed.touchedBlocks,
      touchedThemeZone: computed.touchedThemeZone,
      themeCss: themeRecord === null ? null : themeRecord.afterInner,
    }),
  };
}

async function runComment(root, config, req, res) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  const htmlPath = await resolvePage(root, payload.page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  // {page, commentId} (single, unchanged) or {page, commentIds: [...]} (Send
  // All batch) — exactly one of the two forms per request.
  const batch = payload.commentIds !== undefined;
  if (batch === (payload.commentId !== undefined)) {
    sendJson(res, 400, { error: 'provide exactly one of commentId or commentIds' });
    return;
  }
  let ids;
  if (batch) {
    const raw = payload.commentIds;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH_COMMENTS
      || raw.some((id) => typeof id !== 'string' || id.length === 0)
      || new Set(raw).size !== raw.length) {
      sendJson(res, 400, { error: `commentIds must be 1-${MAX_BATCH_COMMENTS} unique comment ids` });
      return;
    }
    ids = raw;
  } else {
    if (typeof payload.commentId !== 'string' || payload.commentId.length === 0) {
      sendJson(res, 400, { error: 'missing or invalid commentId' });
      return;
    }
    ids = [payload.commentId];
  }

  // Comments are resolved BEFORE admission because the lease is derived from
  // where they are anchored — the run has to know what it wants to hold before
  // it can ask for it.
  const data = await load(htmlPath);
  const comments = [];
  for (const id of ids) {
    const comment = data.comments.find((c) => c.id === id);
    if (!comment) {
      sendJson(res, 404, { error: 'unknown comment' });
      return;
    }
    comments.push(comment);
  }

  // #169: a BATCH means "revise the ones marked for AI", so it drops comments
  // the author flagged as notes — the same rule the overlay applies when it
  // builds Send-All (overlay.js:925). Enforcing it here rather than only in
  // the browser is what stops an agent calling /api/run with explicit ids from
  // revising text the author asked to be left alone.
  //
  // #213: a SINGLE-comment run is now also checked. The "deliberate act"
  // argument applied when a human was explicitly choosing to send one comment
  // via the paid lane. In watcher mode (the V1 primary mode), the AGENT is
  // naming the comment, and the author's intention is expressed by the
  // aiEdits flag. The server enforces it so the protocol's "don't edit notes"
  // rule cannot be bypassed by calling /api/run with a single commentId.
  let skipped = [];
  if (batch) {
    skipped = comments.filter((c) => c.aiEdits === false).map((c) => c.id);
    if (skipped.length === comments.length) {
      sendJson(res, 400, {
        error: 'every comment in this batch is marked as a note — nothing to revise',
        skipped,
      });
      return;
    }
  } else {
    // Single-comment run: refuse if the comment is a note.
    if (comments[0].aiEdits === false) {
      sendJson(res, 400, {
        error: 'this comment is marked as a note (do-not-touch) — aiEdits is false',
        commentId: comments[0].id,
      });
      return;
    }
  }
  const runComments = skipped.length === 0
    ? comments
    : comments.filter((c) => c.aiEdits !== false);

  const runId = newId('run');
  // A batch (Send All) never dry-runs, so its reach is unknowable up front and
  // it takes the page. A single-comment run opens on its anchor and widens
  // after the dry run — that is the case that actually parallelizes.
  const admitted = registry.acquire({
    runId, page: htmlPath, blocks: batch ? PAGE : anchorLease(comments), lane: batch ? 'batch' : 'standard',
  });
  if (!admitted.ok) {
    sendJson(res, 409, conflictBody(admitted));
    return;
  }
  try {
    const { httpStatus, body } = await executeRun({
      root, page: payload.page, htmlPath, config, comments: runComments, batch, runId,
    });
    // Never silent: a caller that named ids gets told which ones were notes.
    sendJson(res, httpStatus, skipped.length ? { ...body, skipped } : body);
  } catch (err) {
    // Unexpected failure after the snapshot — put the doc back, always.
    console.error(`[redline] run ${runId} crashed on ${payload.page}: ${err?.stack ?? err}`);
    const scar = await restoreOrScar({ root, page: payload.page, htmlPath, runId, where: 'run-crash' });
    if (!res.headersSent) {
      sendJson(res, 500, scar === null
        ? { error: 'internal error' }
        : { error: 'internal error', restoreFailed: true, restoreError: scar.error });
    }
  } finally {
    // A run that paused for confirmation KEEPS its leases — it is holding the
    // blocks it proposes to write, and its stash is only valid while nothing
    // else can touch them. Everything else releases here.
    if (!pendingStash.has(runId)) registry.release(runId);
  }
}

// Resolve a SESSION edit paused on the scope guardrail (#195) — a proposal or
// a direct edit rather than an agent run.
//
// Two things make this shorter than the run-lane answer below, and both are
// consequences of the edits being free:
//
//   - a decline records NOTHING. #128's rule is that every call that spends
//     money is on a record; a declined proposal spent none, so a run record
//     would be an entry with no cost, no edit and no decision. The gate log
//     already carries what happened, and it is what the threshold gets tuned
//     from.
//   - nothing was written and no snapshot taken, so there is no document to
//     restore — a declined session edit leaves the file untouched by
//     construction rather than by recovery.
async function confirmSessionEdit(root, res, pending, allow) {
  if (!allow) {
    registry.release(pending.runId);
    sendJson(res, 200, { ok: true, declined: true, runId: pending.runId, lane: pending.kind });
    return;
  }

  // THE RE-BASE CHECK (#121), unchanged in spirit: the stashed edits were
  // computed against the document as it stood at dry-run time, and are still
  // valid only because this writer held leases on every block they touch the
  // whole time. If that stopped being true — the lease was force-released
  // (#188), or the reach was never covered — the stash is stale and must NOT
  // be written.
  const willTouch = Array.isArray(pending.scope?.touchedBlocks) ? pending.scope.touchedBlocks : [];
  if (!registry.covers(pending.runId, willTouch)) {
    registry.release(pending.runId);
    sendJson(res, 409, {
      error: 'the document changed under this confirmation — propose the edits again',
      reason: 'stale-confirmation',
      runId: pending.runId,
    });
    return;
  }
  registry.resume(pending.runId);
  try {
    const { status, body } = pending.kind === 'proposed'
      ? await commitProposal({
        root, page: pending.page, htmlPath: pending.htmlPath, runId: pending.runId,
        proposal: pending.proposal, commentId: pending.commentId, actor: pending.actor,
        scopeGate: pending.scopeGate,
      })
      : await commitDirectEdit({
        root, page: pending.page, htmlPath: pending.htmlPath, runId: pending.runId,
        edits: pending.edits, actor: pending.actor, scopeGate: pending.scopeGate,
      });
    sendJson(res, status, body);
  } catch (err) {
    console.error(`[redline] confirmed ${pending.kind} ${pending.runId} crashed: ${err?.stack ?? err}`);
    const scar = await restoreOrScar({
      root, page: pending.page, htmlPath: pending.htmlPath, runId: pending.runId, where: 'confirm-session-edit',
    });
    if (!res.headersSent) {
      sendJson(res, 500, scar === null
        ? { error: 'internal error' }
        : { error: 'internal error', restoreFailed: true, restoreError: scar.error });
    }
  } finally {
    registry.release(pending.runId);
  }
}

// POST /api/run/confirm — resolve a run paused on the scope guardrail (WP7).
// {page, runId, allow}: allow:true applies the stashed agent result verbatim
// (same finish/commit path as any run); allow:false discards it and restores
// the doc (nothing was written, so this is a clean release).
async function confirmRun(root, config, req, res) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  const htmlPath = await resolvePage(root, payload.page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  // Keyed by runId now, not by page — a page may hold more than one pending ask
  // once runs are lease-scoped, so the caller must say WHICH one it is
  // answering. The page is still checked, so a runId from another document
  // cannot be confirmed here.
  const pending = pendingStash.get(payload.runId);
  if (!pending || pending.htmlPath !== htmlPath) {
    sendJson(res, 404, { error: 'no matching pending confirmation for this page and run' });
    return;
  }
  pendingStash.delete(payload.runId);

  // A SESSION edit (#195) — a proposal or a direct edit that tripped the gate.
  // It has no agent reply to re-drive and cost nothing to produce, so both
  // answers are simpler than the run lane's: decline discards it with nothing
  // written and nothing to bill, allow applies the stashed edits verbatim.
  if (pending.kind === 'proposed' || pending.kind === 'direct-edit') {
    return confirmSessionEdit(root, res, pending, payload.allow === true);
  }

  if (payload.allow !== true) {
    registry.release(pending.runId);
    // Declined: nothing was ever written; drop the pre-run snapshot back in
    // (a no-op restore) and report the run as never-applied. A failed restore
    // here is still reported (#58) — the belt-and-braces restore is only safe
    // to skip silently if it actually happened.
    const scar = await restoreOrScar({ root, page: pending.page, htmlPath, runId: pending.runId, where: 'confirm-decline' });
    // The pending pass already made — and paid for — a full agent call
    // (measured at $0.056 on a 22 KB page) plus its routing call. Until #124
    // a decline recorded NOTHING: real money, invisible. #128 makes it VISIBLE:
    // the record lands in runs[] as a zero-edit 'declined' run; see
    // recordDeclinedRun.
    await recordDeclinedRun({ htmlPath, pending, config });
    sendJson(res, 200, scar === null
      ? { ok: true, declined: true, runId: pending.runId }
      : { ok: true, declined: true, runId: pending.runId, restoreFailed: true, restoreError: scar.error });
    return;
  }

  // THE RE-BASE CHECK (#121). The stashed edits were computed against the
  // document as it stood at dry-run time. They are still valid only because
  // this run has held leases on every block they touch the whole time. If that
  // is no longer true — the lease was force-released, or the reach was never
  // covered — the stash is stale and must NOT be written. Refuse loudly; a
  // silent stale write is the one outcome worse than a failed confirmation.
  const willTouch = pending.scope && Array.isArray(pending.scope.touchedBlocks)
    ? pending.scope.touchedBlocks : [];
  if (!registry.covers(pending.runId, willTouch)) {
    registry.release(pending.runId);
    const scar = await restoreOrScar({ root, page: pending.page, htmlPath, runId: pending.runId, where: 'confirm-stale' });
    sendJson(res, 409, {
      error: 'the document changed under this confirmation — re-run the comment',
      reason: 'stale-confirmation',
      runId: pending.runId,
      ...(scar === null ? {} : { restoreFailed: true, restoreError: scar.error }),
    });
    return;
  }
  registry.resume(pending.runId);
  try {
    const { httpStatus, body } = await executeRun({
      root, page: pending.page, htmlPath, config, comments: [pending.comment], batch: false,
      runId: pending.runId, confirmed: true,
      preapproved: {
        result: pending.result, route: pending.route,
        usage: pending.usage ?? null, routerUsage: pending.routerUsage ?? null,
        context: pending.context ?? null,
        // #236: the gate record from the paused pass, so the run this
        // confirmation produces carries the same scopeGate a proposal or
        // direct edit does on its confirmed path (commitProposal/
        // commitDirectEdit already thread pending.scopeGate through).
        scopeGate: pending.scopeGate ?? null,
      },
    });
    sendJson(res, httpStatus, body);
  } catch (err) {
    console.error(`[redline] confirmed run ${pending.runId} crashed on ${pending.page}: ${err?.stack ?? err}`);
    const scar = await restoreOrScar({ root, page: pending.page, htmlPath, runId: pending.runId, where: 'confirm-crash' });
    if (!res.headersSent) {
      sendJson(res, 500, scar === null
        ? { error: 'internal error' }
        : { error: 'internal error', restoreFailed: true, restoreError: scar.error });
    }
  } finally {
    registry.release(pending.runId);
  }
}

// A scope confirmation the author DECLINED, written into the run log (#128).
//
// The agent call in the pending pass is already billed by the time the
// Allow/Decline card is even drawn, and declining discards its result — so
// this is spend with nothing to show for it, which is exactly the spend most
// worth SEEING. #124 recorded it out of sight in a top-level costLedger[]; the
// UX call (#128, approved by Blake 2026-07-24) is to surface it — hiding the
// one run with nothing to show teaches the wrong lesson about what the scope
// gate costs.
//
// So it lands in runs[] as a real run record — the overlay's run log, the run
// /api/status reports as lastRun, and the array /api/undo walks — carrying the
// same fields any run does (commentId, route, model, usage, context manifest)
// with status/lane 'declined' and EMPTY decisions/edits. The empty edits are
// what makes it undo-inert: undoRun only ever reverts an 'ok' | 'partial' run,
// so a declined run sitting on top of an applied one is structurally walked
// past — there is nothing to undo, and the applied run beneath it stays
// reachable.
//
// costLedger[] is retired with this change (#128). It existed only to hold
// declined runs out of runs[]; nothing else was ever written to it (router
// spend rides on run.usage.routerCostUsd; the timeout gap records nothing
// anywhere). With the record back in runs[], a page's spend is runs[] alone.
//
// Diagnostics must never fail the request: a run write that throws is logged
// and swallowed — the decline itself already succeeded.
async function recordDeclinedRun({ htmlPath, pending, config }) {
  const run = {
    runId: pending.runId,
    commentId: pending.comment?.id ?? null,
    archetype: pending.route?.archetype ?? null,
    model: pending.route ? modelForRoute(pending.route, config) : null,
    status: 'declined',
    lane: 'declined',
    // Empty by construction: a declined run produced no decision and applied no
    // edit. Zero edits is the honest signal the run strip renders from — a
    // fixed 'declined' status plus edits.length === 0, never an applied edit.
    decisions: [],
    edits: [],
    reason: 'scope confirmation declined by the author',
    createdAt: now(),
  };
  if (pending.route) run.route = pending.route;
  const usage = { ...(pending.usage ?? {}) };
  if (Number.isFinite(pending.routerUsage?.costUsd)) usage.routerCostUsd = pending.routerUsage.costUsd;
  if (Object.keys(usage).length > 0) run.usage = usage;
  if (pending.context) run.context = pending.context;

  try {
    // The bundle gets a run.json like every other lane, so a declined run
    // reads the same way in the run-log viewer as any other trace. Written
    // once here, then again after the save so it carries the stamped run.rev
    // (#88) — exactly what finish() and directEdit() do.
    await writeTraceFile(pending.runId, 'run.json', run);
    await update(htmlPath, (data) => {
      applyOps(data, [{ op: 'addRun', run }]);
    });
    await writeTraceFile(pending.runId, 'run.json', run);
  } catch (err) {
    console.error(`[redline] failed to record declined run ${pending.runId}: ${err?.message ?? err}`);
  }
  return run;
}

// Restore the pre-run snapshot, NEVER silently (#58). A restore that throws —
// or finds no snapshot to restore from — after a failed run means the document
// may retain half-applied edits while the run record claims it was rolled
// back. That is a corruption path, so it is logged loudly and returned as a
// scar {where, error} the caller records on the run record / HTTP response.
// Returns null when the doc was actually restored.
async function restoreOrScar({ root, page, htmlPath, runId, where }) {
  let scar;
  try {
    if (await restoreDoc({ root, page, htmlPath, runId })) return null;
    scar = { where, error: 'no pre-run snapshot found to restore from' };
  } catch (err) {
    scar = { where, error: String(err?.message ?? err) };
  }
  console.error(
    `[redline] RESTORE FAILED (${where}) for run ${runId} on ${page}: ${scar.error} — `
    + 'the document may retain edits from the failed run');
  return scar;
}

// The full loop for one run: snapshot once, then for EACH sent comment
// (single sends carry one; Send All batches several, processed SEQUENTIALLY
// in request order): classify → prompt → runAgent → applyEdits. Each comment
// gets its own agent call — its prompt sees the document as the previous
// comments left it, and its decisions may reference only that comment.
// STRICT atomicity (contract amendment 2026-07-22): ANY per-comment failure
// fails the whole run and restores the pre-run snapshot, earlier comments'
// applied edits included — a batch is one undo unit exactly like a single
// run. Returns {httpStatus, body}; every outcome (ok or failed) lands as ONE
// run record in the sidecar.
//
// Every run also writes a trace bundle (lib/trace.mjs) as it goes — prompt,
// agent request/response, validation result, final run record — regardless
// of telemetry config, run outcome included: a failed run's bundle is
// exactly how you find out why it failed.
async function executeRun({ root, page, htmlPath, config, comments, batch, runId, confirmed = false, preapproved = null }) {
  const startMs = Date.now();
  const spans = [];
  const timed = async (name, fn, attrs = null) => {
    const s = Date.now();
    const out = await fn();
    spans.push({
      name,
      startMs: s,
      endMs: Date.now(),
      attributes: typeof attrs === 'function' ? attrs(out) : (attrs ?? {}),
    });
    return out;
  };

  // Single runs keep their scalar archetype/model provenance; batch runs
  // record it per comment in perComment and leave the top-level fields null.
  let archetype = null;
  let model = null;
  // The lane the run took (WP4): 'standard' (never tactical-eligible),
  // 'tactical' (fast path succeeded), 'escalated' (attempted, fell through).
  let runLane = 'standard';
  const routes = []; // per-comment route provenance, in comment order
  // The gate's verdict on this run, fired or not (#195). On the record so the
  // false-positive rate is countable from a page's own history rather than only
  // from trace files, which prune.
  let scopeGateLog = null;
  const perComment = [];
  // Prompt composition + sent-vs-billed for a single-comment run (#94); batch
  // runs carry one per comment on perComment[i].context instead.
  let runContext = null;
  const decisions = []; // accumulated across agent calls, in comment order
  const edits = [];     // accumulated apply-time edit records, in order

  // Per-comment outcome (WP8). Single runs stay all-or-nothing; a batch
  // records each comment's fate and keeps going. markFailed() stamps the
  // perComment entry with a SAFE fixed reason (never upstream body / key).
  const markFailed = (index, reason) => {
    if (perComment[index]) { perComment[index].status = 'failed'; perComment[index].error = reason; }
  };
  const markOk = (index) => { if (perComment[index]) perComment[index].status = 'ok'; };

  // Usage summed across every agent call in the run (standard + tactical). A
  // field is emitted on the run record only if at least one call reported it;
  // costUsd stays absent when no provider returned a cost (WP0).
  const usageAcc = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const usageSeen = { inputTokens: false, outputTokens: false, costUsd: false };
  const accrueUsage = (u) => {
    if (u === null || typeof u !== 'object') return;
    for (const k of ['inputTokens', 'outputTokens', 'costUsd']) {
      if (Number.isFinite(u[k])) { usageAcc[k] += u[k]; usageSeen[k] = true; }
    }
  };
  // The ROUTER's classification call, one per comment, kept in its own bucket
  // (#124). It is a fixed overhead — ~$0.00024 — that belongs to no lane, so
  // folding it into costUsd would inflate exactly the comparison the lane
  // numbers exist to make: noise next to a sonnet standard run, 38% of a
  // gemini-flash tactical one. Before this it was recorded nowhere at all.
  let routerCostUsd = 0;
  let routerCostSeen = false;
  const accrueRouterUsage = (u) => {
    if (u === null || typeof u !== 'object') return;
    if (Number.isFinite(u.costUsd)) { routerCostUsd += u.costUsd; routerCostSeen = true; }
  };
  const runUsage = () => {
    const usage = {};
    for (const k of ['inputTokens', 'outputTokens', 'costUsd']) {
      if (usageSeen[k]) usage[k] = usageAcc[k];
    }
    // Additive to costUsd, never inside it: run.usage.costUsd is the revise
    // lane's spend and routerCostUsd is the routing overhead on top.
    if (routerCostSeen) usage.routerCostUsd = routerCostUsd;
    // The output ceiling this run actually ran under (#130), recorded next to
    // the tokens it used. Pairing the two is the whole point: outputTokens
    // alone cannot tell a reply that finished from a reply that was cut off,
    // and headroom across real runs is the evidence the next revision of
    // STANDARD_MAX_TOKENS should come from.
    if (maxTokensSeen !== null) usage.maxTokens = maxTokensSeen;
    // Provenance, when the number did not come back with the reply (#125). A
    // cost recovered afterwards by generation id is as real as one the envelope
    // reported, but it is not the same kind of fact — it means we hung up and
    // asked later, and a reader comparing runs deserves to know which.
    if (usageSource !== null) usage.source = usageSource;
    return Object.keys(usage).length > 0 ? usage : null;
  };
  let usageSource = null;
  const noteUsageSource = (s) => { if (typeof s === 'string') usageSource = s; };
  let maxTokensSeen = null;
  // Records the string MODEL_MAX as readily as a number: "we imposed no
  // ceiling" is as much a fact about a run as "we imposed 4096", and a reader
  // comparing outputTokens against it needs to know which was in force.
  const noteMaxTokens = (n) => {
    if (Number.isFinite(n) || n === MODEL_MAX) maxTokensSeen = n;
  };

  // What a BATCH run's dollars were actually spent on (#118). The scalar
  // archetype/model stay null on a batch — a run over five comments has no
  // single value, and inventing one would put one comment's model on the
  // whole run in the overlay's provenance line. The honest record is the SET
  // each comment routed to, sorted and de-duplicated, so run.usage.costUsd is
  // attributable to a tier instead of being un-attributable. Omitted (not
  // empty) when nothing routed — a batch that died before the first route has
  // no models to name.
  const distinct = (key) => {
    const seen = new Set();
    for (const entry of perComment) {
      if (typeof entry?.[key] === 'string' && entry[key].length > 0) seen.add(entry[key]);
    }
    return [...seen].sort();
  };

  // The one exit path: restore the doc on failure, record the run (and on
  // success each comment's resolution) in the sidecar, emit the trace, and
  // shape the HTTP response.
  const finish = async ({ status, httpStatus, error, errorType }) => {
    // 'partial' (WP8) KEEPS the successful comments' edits — only a hard
    // 'failed' rolls the doc back to the pre-run snapshot. A restore that
    // fails is a scar on the run record, never a silent swallow (#58).
    let restoreScar = null;
    if (status === 'failed') {
      restoreScar = await restoreOrScar({ root, page, htmlPath, runId, where: 'finish' });
    }
    const run = batch
      ? { runId, commentIds: comments.map((c) => c.id), perComment, archetype, model, status, decisions, edits, createdAt: now() }
      : { runId, commentId: comments[0].id, archetype, model, status, decisions, edits, createdAt: now() };
    if (!batch && routes.length > 0) run.route = routes[0];
    if (batch) {
      const models = distinct('model');
      const archetypes = distinct('archetype');
      if (models.length > 0) run.models = models;
      if (archetypes.length > 0) run.archetypes = archetypes;
    }
    run.lane = runLane;
    if (scopeGateLog !== null) run.scopeGate = scopeGateLog;
    if (restoreScar !== null) {
      run.restoreFailed = true;
      run.restoreError = restoreScar.error;
    }
    const usage = runUsage();
    if (usage !== null) run.usage = usage;
    if (runContext !== null) run.context = runContext; // #94
    if (error !== undefined) run.error = error;
    await writeTraceFile(runId, 'run.json', run);
    try {
      // update() = rev-checked save with retry: if ANOTHER runner process
      // wrote this sidecar mid-cycle, the mutation re-applies on fresh data —
      // this run's record can no longer be clobbered away.
      await timed('save-sidecar', () => update(htmlPath, (data) => {
        const ops = [{ op: 'addRun', run }];
        // 'ok' and 'partial' both write resolutions: each sent comment lands
        // its agent decision, and a comment that FAILED in a partial batch is
        // marked 'failed' with the reason (WP8). A comment deleted mid-run
        // surfaces in applyOps' `missing` and is simply not resolved.
        if (status === 'ok' || status === 'partial') {
          for (const [index, sent] of comments.entries()) {
            const decision = decisions.find((d) => d.id === sent.id);
            if (decision) {
              const resolution = { runId, decision: decision.decision, summary: decision.summary };
              if (decision.note !== undefined) resolution.note = decision.note;
              ops.push({ op: 'resolve', commentId: sent.id, status: decision.decision, resolution });
            } else if (perComment[index] && perComment[index].status === 'failed') {
              ops.push({
                op: 'resolve', commentId: sent.id, status: 'failed',
                resolution: { runId, decision: 'failed', summary: perComment[index].error ?? 'edit could not be applied' },
              });
            }
          }
        }
        applyOps(data, ops);
      }));
      // The save stamped run.rev (#88) — rewrite the bundle's run.json so it
      // stays byte-equal to the record the API returns and the sidecar holds.
      await writeTraceFile(runId, 'run.json', run);
    } catch {
      const scar = await restoreOrScar({ root, page, htmlPath, runId, where: 'record-run' });
      emitRunTrace({ config, run: { runId, page, archetype, model, status: 'failed', error: 'failed to record the run', startMs, endMs: Date.now() }, spans });
      return {
        httpStatus: 500,
        body: scar === null
          ? { error: 'internal error: failed to record the run' }
          : { error: 'internal error: failed to record the run', restoreFailed: true, restoreError: scar.error },
      };
    }
    // Fire-and-forget: never awaited in the run path (see telemetry.mjs).
    emitRunTrace({ config, run: { runId, page, archetype, model, status, error, startMs, endMs: Date.now() }, spans });
    // 'ok' and 'partial' (WP8) both return the run record; only a hard failure
    // wraps it in an error envelope.
    const success = status === 'ok' || status === 'partial';
    return { httpStatus, body: success ? run : { error, errorType, run } };
  };

  // Snapshot doc + sidecar under <root>/.history/ before anything else —
  // ONE snapshot for the whole run, the batch's single restore point.
  await saveSnapshot({ root, page, htmlPath, runId, kind: 'pre-run' });

  // Prior runs on this page, read once, so each comment's prompt can show the
  // agent its OWN earlier decisions alongside the author's replies (#108).
  // Diagnostics-grade: an unreadable sidecar must not fail the run.
  let priorRuns = [];
  try {
    const existing = await load(htmlPath);
    if (Array.isArray(existing.runs)) priorRuns = existing.runs;
  } catch {
    priorRuns = [];
  }

  for (const [index, comment] of comments.entries()) {
    const tname = (base, ext) => traceFileName(base, ext, { batch, index });

    const anchor = comment.anchor ?? {};
    // Re-read per comment: in a batch, comment N's prompt (and the blocks
    // its edits target) must see the document as comments 1..N-1 left it.
    const source = await fs.readFile(htmlPath, 'utf8');
    // Rescue a blockId-less (or stale-blockId) anchor from its quote before
    // routing, so both the router and the prompt see a real location. Never
    // fails the run — a failed rescue just keeps the quote-only fallback.
    await rescueAnchor({ htmlPath, source, comment, anchor });

    // Confirmed run (WP7): the agent already ran in the pending pass; apply the
    // stashed result verbatim through the same pipeline, then finish/commit —
    // no re-route, no re-agent, so what lands is exactly what was previewed.
    if (preapproved !== null) {
      const r = preapproved.route ?? null;
      if (r) routes.push(r);
      if (!batch) {
        archetype = r?.archetype ?? null;
        model = r ? modelForRoute(r, config) : null;
      }
      // The pending pass's agent call is this run's only agent call — its
      // cost and prompt composition belong on this record (#118). The routing
      // call it also paid for comes through the same way (#124): the confirmed
      // pass never re-routes, so nothing else would ever record it.
      accrueUsage(preapproved.usage ?? null);
      accrueRouterUsage(preapproved.routerUsage ?? null);
      if (!batch && preapproved.context) runContext = preapproved.context;
      // #236: this pass never re-evaluates the gate (there is nothing left to
      // dry-run — the stashed result is applied verbatim), so scopeGateLog
      // would otherwise stay null and finish() would write no scopeGate at
      // all. Carry forward the verdict from the pass that actually paused —
      // fired:true, by construction, since only a fired gate stashes a run.
      if (preapproved.scopeGate) scopeGateLog = preapproved.scopeGate;
      const pre = preapproved.result;
      const applied = await timed('apply-edits', () => applyEdits({
        root, page, edits: pre.edits, attributeEdits: pre.attributeEdits, theme: pre.theme, inserts: pre.inserts,
      }), (rr) => ({
        editCount: (pre.edits?.length ?? 0) + (pre.attributeEdits?.length ?? 0)
          + (pre.theme !== undefined ? 1 : 0) + (pre.inserts?.length ?? 0),
        success: rr.ok === true, lane: 'confirmed',
      }));
      await writeTraceFile(runId, tname('validation', 'json'), applied.ok
        ? { ok: true, changed: applied.changed, editRecords: applied.editRecords } : applied);
      if (!applied.ok) {
        decisions.push(...pre.decisions);
        const where = applied.blockId ? ` on block "${applied.blockId}"` : '';
        return finish({
          status: 'failed', httpStatus: 422, errorType: 'validation',
          error: `edit rejected${where}: ${applied.error}`,
        });
      }
      runLane = 'confirmed';
      decisions.push(...pre.decisions);
      edits.push(...applied.editRecords);
      continue;
    }

    // Route: one cheap small-model call → archetype/scope/tier/skills; any
    // failure falls back to the keyword classifier (source: 'fallback').
    const located = anchor.blockId ? locateBlock(source, anchor.blockId) : null;
    const routeCapture = {};
    const route = await timed('route', () => routeComment({
      comment: { id: comment.id, body: comment.body }, blockInner: located?.inner ?? '', config,
      capture: routeCapture,
    }), (r) => {
      const attrs = {
        commentId: comment.id, archetype: r.archetype, scope: r.scope,
        tier: r.tier, canTactical: r.canTactical, source: r.source,
      };
      // The router call bills like any other (#124) — on the span so Phoenix
      // shows it, and accrued below so the run record carries it.
      const u = routeCapture.usage ?? null;
      if (u) {
        if (Number.isFinite(u.inputTokens)) attrs['gen_ai.usage.input_tokens'] = u.inputTokens;
        if (Number.isFinite(u.outputTokens)) attrs['gen_ai.usage.output_tokens'] = u.outputTokens;
        if (Number.isFinite(u.costUsd)) attrs['gen_ai.usage.cost'] = u.costUsd;
      }
      return attrs;
    });
    accrueRouterUsage(routeCapture.usage ?? null);
    routes.push(route);
    const lane = route.archetype;
    const laneModel = modelForRoute(route, config);
    perComment.push({
      commentId: comment.id, archetype: lane, model: laneModel,
      tier: route.tier, routeSource: route.source,
    });
    if (!batch) {
      archetype = lane;
      model = laneModel;
    }

    // Tactical lane (WP4): a single-comment run the router deems tactical
    // tries one small fast call against the block alone. Success skips the
    // standard lane entirely; ANY failure escalates to it — recorded on the
    // run, never surfaced as an error.
    if (tacticalEligible({ batch, route, block: located })) {
      const tacticalCapture = {};
      const attempt = await timed('tactical', () => runTactical({
        comment: { id: comment.id, body: comment.body },
        block: { id: anchor.blockId, inner: located.inner },
        runId, route, config, capture: tacticalCapture,
      }), (a) => {
        const attrs = { commentId: comment.id, success: a.ok === true };
        if (a.ok && a.usage) {
          if (Number.isFinite(a.usage.inputTokens)) attrs['gen_ai.usage.input_tokens'] = a.usage.inputTokens;
          if (Number.isFinite(a.usage.outputTokens)) attrs['gen_ai.usage.output_tokens'] = a.usage.outputTokens;
          if (Number.isFinite(a.usage.costUsd)) attrs['gen_ai.usage.cost'] = a.usage.costUsd;
        }
        if (!a.ok) attrs.reason = truncateAttr(a.reason);
        return attrs;
      });
      // Read the bill off the ENVELOPE, not off a successful attempt (#124):
      // a call whose reply was unparseable, wrongly shaped, or an explicit
      // escalation was still charged for, and accruing only on attempt.ok
      // dropped that money on the floor.
      accrueUsage(usageFromEnvelope(tacticalCapture.envelope ?? null));

      // What the tactical prompt was made of, and what it billed. #94 built
      // this inside the standard-lane block only, so run.context was null on
      // every tactical run — the lane we most want traffic on was the one we
      // could say least about (#124).
      let tacticalContext = null;
      if (typeof attempt.prompt === 'string') {
        tacticalContext = { prompt: promptManifest(attempt.prompt) };
        const billed = usageManifest(tacticalCapture.envelope?.usage ?? null, attempt.prompt.length);
        if (billed !== null) tacticalContext.usage = billed;
      }

      let tacticalApplied = null;
      if (attempt.ok) {
        tacticalApplied = await timed('apply-edits', () => applyEdits({ root, page, edits: attempt.edits, inserts: [] }),
          (r) => {
            const attrs = { editCount: attempt.edits.length, success: r.ok === true, lane: 'tactical' };
            if (!r.ok) {
              attrs.code = r.code;
              attrs.error = truncateAttr(r.error);
              if (r.blockId) attrs.blockId = r.blockId;
            }
            return attrs;
          });
      }

      if (attempt.ok && tacticalApplied.ok) {
        // The tactical exchange IS this run's agent exchange — it gets the
        // canonical bundle files, exactly like a standard run.
        await writeTraceFile(runId, tname('prompt', 'md'), attempt.prompt);
        await writeTraceFile(runId, tname('agent-request', 'json'), tacticalCapture.request ?? null);
        await writeTraceFile(runId, tname('agent-response', 'json'), {
          httpStatus: tacticalCapture.httpStatus ?? null,
          envelope: tacticalCapture.envelope ?? null,
          content: tacticalCapture.content ?? null,
          outcome: { ok: true },
        });
        await writeTraceFile(runId, tname('validation', 'json'),
          { ok: true, changed: tacticalApplied.changed, editRecords: tacticalApplied.editRecords });
        if (tacticalContext !== null) {
          if (perComment[index]) perComment[index].context = tacticalContext;
          if (!batch) runContext = tacticalContext;
        }
        decisions.push(...attempt.decisions);
        edits.push(...tacticalApplied.editRecords);
        runLane = 'tactical';
        continue;
      }

      // Escalate: keep the attempt's evidence under tactical-* names; the
      // standard lane below writes the canonical files.
      runLane = 'escalated';
      if (attempt.prompt !== undefined) {
        await writeTraceFile(runId, 'tactical-prompt.md', attempt.prompt);
      }
      await writeTraceFile(runId, 'tactical-request.json', tacticalCapture.request ?? null);
      await writeTraceFile(runId, 'tactical-response.json', {
        httpStatus: tacticalCapture.httpStatus ?? null,
        envelope: tacticalCapture.envelope ?? null,
        content: tacticalCapture.content ?? null,
        outcome: { ok: false, reason: attempt.ok ? `tactical edit rejected: ${tacticalApplied.error}` : attempt.reason },
      });
      if (attempt.ok) await writeTraceFile(runId, 'tactical-validation.json', tacticalApplied);
    }

    const prompt = await timed('load-context', async () => {
      // A successful route narrows the skill set to what the router named
      // (default pack + projectContext always survive); the fallback path
      // keeps the pre-router selection (archetype pack + keyword matches).
      const { text: contextText } = await loadSkills({
        comment: comment.body, archetype: lane, config, only: route.skills,
      });
      return renderTemplate(await loadPromptTemplate(), {
        PAGE: page,
        ARCHETYPE: lane,
        COMMENT_ID: comment.id,
        COMMENT: JSON.stringify(
          {
            id: comment.id,
            body: comment.body,
            anchor,
            replies: comment.replies ?? [],
            // The full exchange in time order, including THIS runner's prior
            // decisions, plus which utterance is the operative ask (#108).
            ...commentThread(comment, priorRuns),
          },
          null, 2,
        ),
        BLOCK_HTML: blockSection(source, anchor),
        // The full page source — the document is the edit surface, so the
        // agent sees every data-rev block, not just the anchored one. It
        // renders AFTER the cache breakpoint (#123): every successful run
        // edits the page, so a document inside the cached prefix guaranteed a
        // miss AND a 1.25x write premium on bytes nothing would ever read.
        // The section view still points here instead of repeating the page
        // when the anchored container is essentially the whole doc (#115).
        DOC: source,
        // Last on purpose: substituted after every other placeholder so pack /
        // project-file content can never be re-expanded as a template variable.
        CONTEXT: contextText,
      });
    }, (p) => ({ promptChars: p.length, ...manifestAttributes(promptManifest(p)) }));
    await writeTraceFile(runId, tname('prompt', 'md'), prompt);

    // What this prompt is actually made of (#94) — recorded per comment so a
    // run says WHICH layer cost the tokens, not just how many there were.
    const contextManifest = { prompt: promptManifest(prompt) };

    const capture = {};
    const outcome = await timed('agent-request', () => runAgent({ prompt, model: laneModel, config, capture }), (o) => {
      // Prompt/response text ride on the span (truncated) so Phoenix shows
      // the exchange inline; the bundle files carry the full text.
      const attrs = { model: laneModel, ok: o.ok === true, 'input.value': truncateAttr(prompt) };
      if (typeof capture.content === 'string') attrs['output.value'] = truncateAttr(capture.content);
      if (o.ok && o.usage) {
        if (Number.isFinite(o.usage.inputTokens)) attrs['gen_ai.usage.input_tokens'] = o.usage.inputTokens;
        if (Number.isFinite(o.usage.outputTokens)) attrs['gen_ai.usage.output_tokens'] = o.usage.outputTokens;
        if (Number.isFinite(o.usage.costUsd)) attrs['gen_ai.usage.cost'] = o.usage.costUsd;
      }
      // Sent-vs-billed (#94): a cache read makes a big prompt cheap, and that
      // difference is invisible in the token total alone.
      const billed = usageManifest(capture.envelope?.usage ?? null, prompt.length);
      if (billed !== null) {
        if (Number.isFinite(billed.cachedTokens)) attrs['redline.context.cached_tokens'] = billed.cachedTokens;
        if (Number.isFinite(billed.cachedShare)) attrs['redline.context.cached_share'] = billed.cachedShare;
        if (Number.isFinite(billed.charsPerToken)) attrs['redline.context.chars_per_token'] = billed.charsPerToken;
      }
      return attrs;
    });
    {
      const billed = usageManifest(capture.envelope?.usage ?? null, prompt.length);
      if (billed !== null) contextManifest.usage = billed;
      if (perComment[index]) perComment[index].context = contextManifest;
      if (!batch) runContext = contextManifest;
    }
    // Usage accrues whether or not the call SUCCEEDED (#130). A truncated reply
    // is billed in full for the tokens it did generate; before this, only
    // `outcome.ok` accrued, so the one failure mode that costs money and
    // produces nothing recorded $0 — the same blind spot #124/#128 closed for
    // declined confirmations, and the one #125 still has for timeouts.
    accrueUsage(outcome.usage);
    noteMaxTokens(outcome.maxTokens);
    noteUsageSource(outcome.usageSource);
    await writeTraceFile(runId, tname('agent-request', 'json'), capture.request ?? null);
    await writeTraceFile(runId, tname('agent-response', 'json'), {
      httpStatus: capture.httpStatus ?? null,
      envelope: capture.envelope ?? null,
      content: capture.content ?? null,
      outcome: outcome.ok
        ? { ok: true }
        : { ok: false, errorType: outcome.errorType, message: outcome.message },
    });
    if (!outcome.ok) {
      await writeTraceFile(runId, tname('validation', 'json'),
        { ok: false, skipped: true, reason: `agent call failed: ${outcome.message}` });
      // Safe fixed message only — never the key, never upstream body content.
      const error = `agent run failed: ${outcome.message}`;
      if (batch) { markFailed(index, error); continue; } // partial apply (WP8)
      // 502 says "the thing upstream of me failed". A truncation is OUR output
      // ceiling stopping OUR request, so it reports as a server-side 500 (#130)
      // — the status code is the first thing read when a run fails, and it was
      // pointing at the provider for a budget we set.
      const httpStatus = outcome.errorType === 'truncated' ? 500 : 502;
      return finish({ status: 'failed', httpStatus, errorType: outcome.errorType, error });
    }

    const { decisions: got, edits: gotEdits, attributeEdits: gotAttrEdits, theme: gotTheme, inserts } = outcome.result;
    // Each agent call must decide exactly the ONE comment it was sent —
    // anything else is a contract violation and fails the run. (The id is
    // agent content; it is deliberately not echoed into the error message.)
    if (got.some((d) => d.id !== comment.id)) {
      const error = 'agent decisions reference a comment id other than the one sent in this agent call';
      await writeTraceFile(runId, tname('validation', 'json'), { ok: false, code: 'decision-coverage', error });
      if (batch) { markFailed(index, error); continue; } // partial apply (WP8)
      decisions.push(...got);
      return finish({ status: 'failed', httpStatus: 422, errorType: 'validation', error });
    }
    if (!got.some((d) => d.id === comment.id)) {
      const error = 'agent returned no decision for the comment';
      await writeTraceFile(runId, tname('validation', 'json'), { ok: false, code: 'decision-coverage', error });
      if (batch) { markFailed(index, error); continue; } // partial apply (WP8)
      return finish({ status: 'failed', httpStatus: 422, errorType: 'validation', error });
    }

    // Scope guardrail (WP7): before applying, DRY-RUN to see how far these
    // edits actually reach. A single-comment run whose reach exceeds the
    // anchored section (or touches the page theme) pauses for author
    // confirmation — unless the agent explicitly waived it. Batch runs and
    // already-confirmed runs skip the gate. The stashed result is applied
    // verbatim on confirm, so what lands is exactly what was previewed.
    if (!batch && !confirmed) {
      const dry = await applyEdits({
        root, page, edits: gotEdits, attributeEdits: gotAttrEdits, theme: gotTheme, inserts, dryRun: true,
      });
      if (dry.ok) {
        const agentScope = outcome.result.scope ?? null;
        const { computed, gate, record: gateLog } = await evaluateScopeGate({
          source, anchorBlockId: anchor.blockId, editRecords: dry.editRecords,
          // `lane` here names the WRITER — run | proposed | direct-edit — so
          // the gate log can be counted per writer. The run's own archetype
          // lane is on run.json.
          agentScope, runId, lane: 'run', traceName: tname('scope', 'json'),
        });
        scopeGateLog = gateLog;

        // The run was admitted on the blocks its comment is ANCHORED to; the
        // dry run has just revealed where the edits actually land. Widen the
        // lease to cover that before writing a byte — a run must never write
        // outside what it holds, which is the whole point of the ledger (#38).
        // A theme edit reaches every block, so it escalates to the page.
        const reach = computed.touchedThemeZone ? PAGE : computed.touchedBlocks;
        const widened = registry.extend(runId, reach);
        if (!widened.ok) {
          // Another run holds a block this one turned out to need. Refusing
          // late is unfortunate; racing it would be a corruption bug.
          return { httpStatus: 409, body: conflictBody(widened) };
        }

        if (gate.required) {
          const scopeBlock = scopeAsk({
            source, computed, gate, agentScope, editRecords: dry.editRecords,
          });
          // The agent call is already PAID FOR at this point. Carry its usage
          // and context manifest into the pending record so the confirmed run
          // records what the pending pass actually spent (#118) — without
          // this a scope-gated run reports no cost at all.
          // The run PAUSES holding its (now-widened) leases: it owns exactly
          // the blocks it proposes to write, which is what keeps the stash
          // valid until a human answers. The ledger tracks the lease and the
          // scope; only the agent payload lives in the stash.
          registry.markPending(runId, scopeBlock);
          pendingStash.set(runId, {
            kind: 'run',
            runId, page, htmlPath, comment, route, result: outcome.result,
            usage: outcome.usage ?? null, routerUsage: routeCapture.usage ?? null,
            context: contextManifest, createdAt: now(), scope: scopeBlock,
            // #236: the gate's own verdict (fired:true, by construction — this
            // stash only exists because it fired), carried into the confirmed
            // pass below so the run record it produces says so too. Without
            // this, a confirmed run and one that never paused were recorded
            // identically — the one fact that distinguishes "ran straight
            // through" from "a human authorized this at a checkpoint" was lost
            // the moment the pause happened.
            scopeGate: gateLog,
          });
          return {
            httpStatus: 200,
            body: { pendingConfirmation: true, runId, page, scope: scopeBlock },
          };
        }
      }
    }

    const applied = await timed('apply-edits', () => applyEdits({ root, page, edits: gotEdits, attributeEdits: gotAttrEdits, theme: gotTheme, inserts }),
      (r) => {
        const attrs = { editCount: gotEdits.length + (gotAttrEdits?.length ?? 0) + (gotTheme !== undefined ? 1 : 0) + (inserts?.length ?? 0), success: r.ok === true };
        if (!r.ok) {
          attrs.code = r.code;
          attrs.error = truncateAttr(r.error);
          if (r.blockId) attrs.blockId = r.blockId;
        }
        return attrs;
      });
    await writeTraceFile(runId, tname('validation', 'json'), applied.ok
      ? { ok: true, changed: applied.changed, editRecords: applied.editRecords }
      : applied);
    if (!applied.ok) {
      const where = applied.blockId ? ` on block "${applied.blockId}"` : '';
      const error = `edit rejected${where}: ${applied.error}`;
      if (batch) { markFailed(index, error); continue; } // partial apply (WP8)
      decisions.push(...got);
      return finish({ status: 'failed', httpStatus: 422, errorType: 'validation', error });
    }

    decisions.push(...got);
    edits.push(...applied.editRecords);
    markOk(index);
  }

  // Batch (WP8): keep the comments that landed; the run is 'partial' when any
  // failed, else 'ok'. Single runs are always 'ok' here (failures returned above).
  if (batch) {
    const anyFailed = perComment.some((pc) => pc.status === 'failed');
    return finish({ status: anyFailed ? 'partial' : 'ok', httpStatus: 200 });
  }
  return finish({ status: 'ok', httpStatus: 200 });
}

// ---- POST /api/instrument ----------------------------------------------------

// Idempotent data-rev stamping for a served page (the overlay's "Prepare
// page" button). Same resolvePage guard as every endpoint; the write is
// atomic; a fully stamped page is a no-op that still returns 200. A page
// whose markup fails the balance check is refused (422) rather than stamped
// blind — stamping inserts attributes by raw-source offsets, and unbalanced
// tag soup makes those offsets unreliable.
async function instrumentPage(root, req, res) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  const htmlPath = await resolvePage(root, payload.page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  // Stamping rewrites the whole file by raw-source offsets, so it cannot share
  // the page with anything: a page-wide conflict check, not a lease, because
  // the work is synchronous and short.
  const stampClash = registry.conflict(htmlPath, PAGE);
  if (stampClash !== null) {
    sendJson(res, 409, conflictBody(stampClash));
    return;
  }
  const source = await fs.readFile(htmlPath, 'utf8');
  const balance = checkBalanced(source);
  if (!balance.ok) {
    sendJson(res, 422, { error: `page markup fails the tag-balance check: ${balance.error}` });
    return;
  }
  const { source: out, added, total, themeCreated } = instrumentSource(source);
  if (added > 0 || themeCreated) await atomicWriteFile(htmlPath, out);
  sendJson(res, 200, { ok: true, added, total });
}

// ---- GET /api/trace ----------------------------------------------------------

// Read-only view of one run's trace bundle (WP6: the overlay's run-log
// viewer). runId is strictly validated and the only path input; file names
// come from readdir and are regex-filtered — nothing outside the bundle
// directory is ever readable. ?mode=list returns names only (the overlay's
// cheap existence probe that decides whether to show the button).
const RUN_ID_RE = /^run-[\w-]{1,64}$/;
const TRACE_FILE_RE = /^[\w][\w.-]*$/;
// Reading order for the viewer: the run record and failure reason first.
const TRACE_ORDER = ['run.json', 'prompt.md', 'agent-request.json', 'agent-response.json', 'validation.json'];

async function traceBundle(url, res) {
  const runId = url.searchParams.get('runId');
  if (!runId || !RUN_ID_RE.test(runId)) {
    sendJson(res, 400, { error: 'missing or invalid runId' });
    return;
  }
  const dir = traceDir(runId);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    sendJson(res, 404, { error: 'no trace bundle for that run' });
    return;
  }
  names = names.filter((n) => TRACE_FILE_RE.test(n)).sort((a, b) => {
    const ia = TRACE_ORDER.indexOf(a);
    const ib = TRACE_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? TRACE_ORDER.length : ia) - (ib === -1 ? TRACE_ORDER.length : ib);
    return a < b ? -1 : 1;
  });
  if (url.searchParams.get('mode') === 'list') {
    sendJson(res, 200, { runId, files: names });
    return;
  }
  const files = [];
  for (const name of names) {
    files.push({ name, content: await fs.readFile(path.join(dir, name), 'utf8') });
  }
  sendJson(res, 200, { runId, files });
}

// ---- GET /api/dir (#129) ----------------------------------------------------

// One directory level under root, dirs first: the same listing the runner's
// directory index page renders, exposed as JSON so a file-nav panel (#67)
// reads the same data instead of scraping the page. Guards live in
// listDirectory(); a rejected path is a 400 and a missing one a 404, matching
// the legacy /api/dir this ports.
async function dirListing(root, url, res) {
  try {
    sendJson(res, 200, await listDirectory(root, url.searchParams.get('path') ?? ''));
  } catch (err) {
    if (err.code === 'EBADDIRPATH') sendJson(res, 400, { error: 'bad path' });
    else if (err.code === 'ENOTDIRECTORY') sendJson(res, 404, { error: 'not a directory' });
    else throw err;
  }
}

// ---- GET /api/source (M2 WP2) -----------------------------------------------

// The document as an agent needs to see it: the raw source (the truth every
// edit is a string replacement against) plus the index of stamped blocks in
// document order, which is what an anchor or an edit has to name. An
// unstamped page returns blocks: [] — POST /api/instrument first.
async function pageSource(root, url, res) {
  const page = url.searchParams.get('page');
  if (!page) {
    sendJson(res, 400, { error: 'missing page' });
    return;
  }
  const htmlPath = await resolvePage(root, page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  const source = await fs.readFile(htmlPath, 'utf8');
  sendJson(res, 200, {
    page,
    source,
    bytes: Buffer.byteLength(source, 'utf8'),
    blocks: stampedBlocks(source).map((b) => ({
      id: b.id, tag: b.tag, text: blockText(b.inner, SOURCE_TEXT_CHARS),
    })),
  });
}

// ---- POST /api/propose-edits (M2 WP2) ---------------------------------------

// An agent's own edits, in the exact payload shape the model returns inside a
// run — validated by the same validateAgentPayload(), applied by the same
// applyEdits(), snapshotted like a run so /api/undo reverts them.
//
// dryRun (DEFAULT true) reports the verdict and writes nothing: for a dry run
// the verdict IS the result, so an invalid proposal is a 200 carrying
// {valid:false, code, blockId, error}, not an HTTP error. An APPLY that fails
// validation is a 422 with the same fields — the request did not do what it
// asked for — and nothing was written, so there is nothing to restore.
async function proposeEdits(root, req, res) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  const page = payload.page;
  const htmlPath = await resolvePage(root, page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  const actor = validActor(payload);
  if (actor === null) {
    sendJson(res, 400, { error: 'invalid creator or agentName' });
    return;
  }
  if (payload.dryRun !== undefined && typeof payload.dryRun !== 'boolean') {
    sendJson(res, 400, { error: 'dryRun must be a boolean' });
    return;
  }
  const dryRun = payload.dryRun !== false; // absent → validate only
  const proposal = validateAgentPayload({
    decisions: payload.decisions ?? [],
    edits: payload.edits,
    attributeEdits: payload.attributeEdits,
    ...(payload.theme !== undefined ? { theme: payload.theme } : {}),
    inserts: payload.inserts,
    // #195: the scope waiver, the same field the model returns inside a run.
    // It lets a session declare document-wide intent UP FRONT, so a deliberate
    // sweep ("change all the headers") asks once with its intent stated instead
    // of looking like an accident. It can only ADD a confirmation or waive a
    // broad one — it can never make the runner miss a theme edit or an
    // out-of-section reach, because the runner computes reach itself.
    ...(payload.scope !== undefined ? { scope: payload.scope } : {}),
  });
  if (proposal === null) {
    sendJson(res, 400, { error: 'proposal did not match the {decisions, edits, attributeEdits, theme, inserts, scope} shape' });
    return;
  }

  // A decision resolves a comment, so it needs one named: same rule as a run,
  // where each agent call decides exactly the one comment it was sent.
  let commentId = null;
  // The comment this proposal answers, when it names one. Its anchor is what
  // the scope gate measures reach against (#195) — no comment, no section.
  let anchoredComment = null;
  if (payload.commentId !== undefined) {
    if (typeof payload.commentId !== 'string' || payload.commentId.length === 0) {
      sendJson(res, 400, { error: 'missing or invalid commentId' });
      return;
    }
    commentId = payload.commentId;
    const data = await load(htmlPath);
    anchoredComment = data.comments.find((c) => c.id === commentId) ?? null;
    if (anchoredComment === null) {
      sendJson(res, 404, { error: 'unknown comment' });
      return;
    }
    if (proposal.decisions.some((d) => d.id !== commentId)) {
      sendJson(res, 400, { error: 'decisions must reference the commentId this proposal names' });
      return;
    }
    // #213: enforce the note flag — but only when the proposal actually
    // changes the document. A decision-only proposal (e.g. "declined") is
    // the agent saying "I won't edit this," which is the right response to
    // a note. The flag blocks edits, not decisions.
    const hasEdits = (proposal.edits && proposal.edits.length > 0)
      || (proposal.attributeEdits && proposal.attributeEdits.length > 0)
      || proposal.theme
      || (proposal.inserts && proposal.inserts.length > 0);
    if (anchoredComment.aiEdits === false && hasEdits) {
      sendJson(res, 400, {
        error: 'this comment is marked as a note (do-not-touch) — aiEdits is false',
        commentId,
      });
      return;
    }
  } else if (proposal.decisions.length > 0) {
    sendJson(res, 400, { error: 'decisions require a commentId' });
    return;
  }

  // An agent proposal names its own blocks, so it leases exactly those and can
  // run beside an unrelated revise — the same disjointness rule as any run.
  const proposedBlocks = [...new Set((proposal.edits ?? [])
    .map((e) => (e && typeof e.blockId === 'string' ? e.blockId : null))
    .filter((id) => id !== null))];
  const runId = newId('run');
  // #231: same exemption as /api/edit — a proposal written under a lease the
  // caller already holds is admitted past that one lease.
  const own = heldLeaseFor(payload, htmlPath, proposedBlocks);
  const admitted = registry.acquire({
    runId, page: htmlPath, blocks: proposedBlocks, lane: 'proposed',
    ignoreRunId: own === null ? null : own.runId,
  });
  if (!admitted.ok) {
    sendJson(res, 409, conflictBody(admitted));
    return;
  }
  try {
    // One validation pass first, always: it decides the dry-run verdict AND
    // keeps a rejected apply from leaving a snapshot behind.
    const check = await applyEdits({
      root, page, edits: proposal.edits, attributeEdits: proposal.attributeEdits,
      theme: proposal.theme, inserts: proposal.inserts, dryRun: true,
    });
    if (!check.ok) {
      const body = { valid: false, code: check.code, error: check.error };
      if (check.blockId) body.blockId = check.blockId;
      if (dryRun) sendJson(res, 200, { ok: true, dryRun: true, ...body });
      else sendJson(res, 422, { error: check.error, ...body });
      return;
    }
    if (dryRun) {
      sendJson(res, 200, {
        ok: true, dryRun: true, valid: true, changed: check.changed, editRecords: check.editRecords,
      });
      return;
    }

    // The scope gate (#195). A session applying edits goes through the same
    // guardrail a paid run does — before #195 a free local session could
    // rewrite twelve headers with no pause while the paid lane asked before
    // rewriting two.
    const source = await fs.readFile(htmlPath, 'utf8');
    const anchorBlockId = anchoredComment?.anchor?.blockId ?? null;
    const { computed, gate, record: scopeGateLog } = await evaluateScopeGate({
      source, anchorBlockId, editRecords: check.editRecords,
      agentScope: proposal.scope ?? null, runId, lane: 'proposed',
    });

    // The proposal was admitted on the blocks its `edits` named; the dry run
    // has just revealed everything else it touches (attribute edits, inserts,
    // the theme). Widen the lease before writing a byte — a writer must never
    // write outside what it holds (#38). This was missing before #195: a
    // proposal that only inserted or only restyled leased NOTHING it wrote.
    const reach = computed.touchedThemeZone ? PAGE : computed.touchedBlocks;
    const widened = registry.extend(runId, reach);
    if (!widened.ok) {
      sendJson(res, 409, conflictBody(widened));
      return;
    }

    if (gate.required) {
      const scopeBlock = scopeAsk({
        source, computed, gate, agentScope: proposal.scope ?? null, editRecords: check.editRecords,
      });
      // Pause holding the (now-widened) leases, exactly as a gated run does:
      // the stash stays valid precisely because nothing else may touch those
      // blocks while the author decides. Nothing has been written and no
      // snapshot taken — a declined proposal costs nothing and leaves nothing.
      registry.markPending(runId, scopeBlock);
      pendingStash.set(runId, {
        kind: 'proposed',
        runId, page, htmlPath, proposal, commentId, actor,
        scopeGate: scopeGateLog, createdAt: now(), scope: scopeBlock,
      });
      sendJson(res, 200, { pendingConfirmation: true, runId, page, scope: scopeBlock });
      return;
    }

    const { status, body } = await commitProposal({
      root, page, htmlPath, runId, proposal, commentId, actor, scopeGate: scopeGateLog,
    });
    sendJson(res, status, body);
  } finally {
    // A gated proposal keeps its leases until the author answers; everything
    // else hands them back here.
    if (!pendingStash.has(runId)) registry.release(runId);
  }
}

// Apply a validated proposal, snapshot it, and record the run. Shared by
// /api/propose-edits and the confirm path, so a proposal the author allowed
// lands byte-for-byte as the ungated one would have — same writer, same
// snapshot, same undo unit.
async function commitProposal({ root, page, htmlPath, runId, proposal, commentId, actor, scopeGate }) {
  await saveSnapshot({ root, page, htmlPath, runId, kind: 'pre-run' });
  const applied = await applyEdits({
    root, page, edits: proposal.edits, attributeEdits: proposal.attributeEdits,
    theme: proposal.theme, inserts: proposal.inserts,
  });
  if (!applied.ok) {
    // Nothing was written (applyEdits is all-or-nothing), but the doc is
    // put back anyway — a partial write here would be a bug, not a state.
    const scar = await restoreOrScar({ root, page, htmlPath, runId, where: 'propose-apply' });
    const body = { valid: false, code: applied.code, error: applied.error };
    if (applied.blockId) body.blockId = applied.blockId;
    if (scar !== null) { body.restoreFailed = true; body.restoreError = scar.error; }
    return { status: 422, body: { error: applied.error, ...body } };
  }

  const run = {
    runId,
    ...(commentId === null ? {} : { commentId }),
    archetype: null,
    model: null,
    status: 'ok',
    decisions: proposal.decisions,
    edits: applied.editRecords,
    createdAt: now(),
    lane: 'proposed',
    ...(Object.keys(actor).length > 0 ? { actor } : {}),
    ...(scopeGate ? { scopeGate } : {}),
  };
  await update(htmlPath, (data) => {
    const ops = [{ op: 'addRun', run }];
    const decision = proposal.decisions.find((d) => d.id === commentId);
    if (commentId !== null && decision) {
      const resolution = { runId, decision: decision.decision, summary: decision.summary };
      if (decision.note !== undefined) resolution.note = decision.note;
      ops.push({ op: 'resolve', commentId, status: decision.decision, resolution });
    }
    applyOps(data, ops);
  });
  // #233: run.json in the trace bundle, AFTER the sidecar save so it carries
  // the stamped run.rev — the same pattern commitDirectEdit follows (#88). A
  // session-authored run was the only lane whose bundle held scope.json and
  // nothing else.
  await writeTraceFile(runId, 'run.json', run);
  return { status: 200, body: run };
}

// ---- POST /api/edit — direct author edit of one block (WP10) -----------------

// A quick manual fix: replace one block's inner HTML. The runner applies it
// through the SAME surgery/apply pipeline as an agent edit (the browser never
// writes the file), snapshots it for undo, and records a run with
// lane 'direct-edit' plus optional creator/agentName provenance. All-or-nothing.
// #231: does this payload name a HELD lease that covers the blocks it is
// about to write, on this page? Returns the lease when yes, else null — and
// null means "behave exactly as if no leaseId was sent": attempt the acquire,
// refuse on clash, never an escalation. The leaseId is a capability (the
// runner only ever showed it to the acquirer), so knowing it is proof of
// holding; a stranger's blocks still refuse because their lease is not this
// one and stays in the conflict check.
function heldLeaseFor(payload, htmlPath, blocks) {
  if (typeof payload.leaseId !== 'string' || payload.leaseId.length === 0) return null;
  const lease = registry.get(payload.leaseId);
  if (lease === null || lease.lane !== HOLD_LANE || lease.page !== htmlPath) return null;
  if (lease.blocks === PAGE) return lease;
  const held = lease.blocks;
  return blocks.every((b) => held.has(b)) ? lease : null;
}

async function directEdit(root, req, res) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  const htmlPath = await resolvePage(root, payload.page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  if (typeof payload.blockId !== 'string' || payload.blockId.length === 0) {
    sendJson(res, 400, { error: 'missing or invalid blockId' });
    return;
  }
  if (typeof payload.newInner !== 'string') {
    sendJson(res, 400, { error: 'newInner must be a string' });
    return;
  }
  const actor = validActor(payload);
  if (actor === null) {
    sendJson(res, 400, { error: 'invalid creator or agentName' });
    return;
  }
  // #213: close the third watcher-reachable write path. A note (aiEdits:false)
  // is the author saying "do not touch this text"; /api/run and
  // /api/propose-edits already refuse it, but /api/edit named no comment and so
  // checked nothing. A direct edit justifies itself with no comment, so an
  // AGENT editing a block that carries an open note is refused here. The
  // author's own Edit-text affordance is never gated — it declares no
  // creator:'agent', and the author set the flag and may edit their own text.
  if (actor.creator === 'agent') {
    const data = await load(htmlPath);
    const notes = data.comments.filter((c) =>
      c.aiEdits === false
      && c.anchor && c.anchor.blockId === payload.blockId
      && c.status !== 'resolved');
    if (notes.length > 0) {
      sendJson(res, 403, {
        error: 'this block carries a note marked do-not-touch (aiEdits:false) — a watcher may not edit it directly',
        blockId: payload.blockId,
        notes: notes.map((c) => c.id),
      });
      return;
    }
  }
  // #38's promise, and the one users actually feel: a direct edit touches ONE
  // block, so it only waits on a run holding THAT block. Editing paragraph 9
  // while a run works on paragraph 4 now goes through instead of 409ing.
  const runId = newId('run');
  // #231: a caller that already holds the block names its lease and writes
  // under it — no release-before-write race. An invalid or foreign leaseId
  // degrades to exactly the old behavior.
  const own = heldLeaseFor(payload, htmlPath, [payload.blockId]);
  const admitted = registry.acquire({
    runId, page: htmlPath, blocks: [payload.blockId], lane: 'direct-edit',
    ignoreRunId: own === null ? null : own.runId,
  });
  if (!admitted.ok) {
    sendJson(res, 409, conflictBody(admitted));
    return;
  }
  const edits = [{ blockId: payload.blockId, newInner: payload.newInner }];
  try {
    // The scope gate (#195), on the direct-edit path too. It cannot fire as
    // things stand — one block, measured against its own section, is always
    // inside it — so what this buys today is the LOG: every direct edit's
    // computed reach, on the record, alongside the run and proposal lanes.
    // #185 called this out: "a one-block direct edit has its reach by
    // construction. If session-driven editing ever grows past one block per
    // action, that guarantee is gone." When it does, the gate is already here.
    const source = await fs.readFile(htmlPath, 'utf8');
    const dry = await applyEdits({ root, page: payload.page, edits, dryRun: true });
    let scopeGateLog = null;
    if (dry.ok) {
      const { computed, gate, record } = await evaluateScopeGate({
        source, anchorBlockId: payload.blockId, editRecords: dry.editRecords,
        agentScope: null, runId, lane: 'direct-edit',
      });
      scopeGateLog = record;
      if (gate.required) {
        const scopeBlock = scopeAsk({
          source, computed, gate, agentScope: null, editRecords: dry.editRecords,
        });
        registry.markPending(runId, scopeBlock);
        pendingStash.set(runId, {
          kind: 'direct-edit',
          runId, page: payload.page, htmlPath, edits, actor,
          scopeGate: record, createdAt: now(), scope: scopeBlock,
        });
        sendJson(res, 200, { pendingConfirmation: true, runId, page: payload.page, scope: scopeBlock });
        return;
      }
    }

    const { status, body } = await commitDirectEdit({
      root, page: payload.page, htmlPath, runId, edits, actor, scopeGate: scopeGateLog,
    });
    sendJson(res, status, body);
  } catch (err) {
    console.error(`[redline] direct edit ${runId} crashed on ${payload.page}: ${err?.stack ?? err}`);
    const scar = await restoreOrScar({ root, page: payload.page, htmlPath, runId, where: 'direct-edit-crash' });
    if (!res.headersSent) {
      sendJson(res, 500, scar === null
        ? { error: 'internal error' }
        : { error: 'internal error', restoreFailed: true, restoreError: scar.error });
    }
  } finally {
    // A gated direct edit keeps its lease until the author answers.
    if (!pendingStash.has(runId)) registry.release(runId);
  }
}

// Apply one block's inner, snapshot it, record the run. Shared by /api/edit and
// the confirm path so an allowed edit lands exactly as an ungated one would.
async function commitDirectEdit({ root, page, htmlPath, runId, edits, actor, scopeGate }) {
  await saveSnapshot({ root, page, htmlPath, runId, kind: 'pre-run' });
  const applied = await applyEdits({ root, page, edits });
  if (!applied.ok) {
    const scar = await restoreOrScar({ root, page, htmlPath, runId, where: 'direct-edit-apply' });
    const body = { error: applied.error, code: applied.code };
    if (applied.blockId) body.blockId = applied.blockId;
    if (scar !== null) { body.restoreFailed = true; body.restoreError = scar.error; }
    return { status: 422, body };
  }
  const run = {
    runId, status: 'ok', lane: 'direct-edit',
    edits: applied.editRecords, createdAt: now(),
    ...(Object.keys(actor).length > 0 ? { actor } : {}),
    ...(scopeGate ? { scopeGate } : {}),
  };
  await update(htmlPath, (data) => {
    applyOps(data, [{ op: 'addRun', run }]);
  });
  // After the save so run.json carries the stamped rev (#88).
  await writeTraceFile(runId, 'run.json', run);
  return { status: 200, body: run };
}

// ---- POST /api/hold — hold mode (#190) --------------------------------------
//
// A live watcher that acts within seconds is wrong for a common case: you are
// reading a section and want to leave four comments that belong together.
// Actioned one at a time, the agent makes four disconnected edits and may undo
// its own earlier reasoning. Hold lets you think, then hand the set over.
//
// WHAT HOLD IS NOT. It gates INTAKE only (decision 15): anything released
// before it went on is already in the agent's hands, and there is no
// stop-what-you-are-doing control — undo covers regret after the fact. So the
// count means "held back since hold went on", never "not yet done".
//
// The runner EXPOSES hold; it does not enforce it. Nothing in /api/run refuses
// a held comment, for the same reason the actionable rule is not
// server-enforced: the human pressing Send All means it, and a rule in two
// places is a rule that drifts. Hold is a signal to the watcher, and the
// watcher is what stops.
//
// It rides the EXISTING stream: hold lives in the sidecar, so setting it bumps
// `rev` and every client already listening learns that something changed and
// refetches. No new frame type, no second endpoint to poll — which is what
// keeps events.mjs's "state, not delta" property intact.

/** Which actionable comments are being held back right now. Notes are excluded
 *  because a note is never actioned (decision 2) — counting one as "held" would
 *  promise the author something hold never did. */
function heldComments(data) {
  const hold = data.hold ?? null;
  if (hold === null || hold.on !== true || typeof hold.since !== 'string') return [];
  return data.comments.filter((c) => c.aiEdits !== false
    && typeof c.createdAt === 'string' && c.createdAt >= hold.since);
}

function holdView(data) {
  const hold = data.hold ?? null;
  const held = heldComments(data);
  return {
    on: hold?.on === true,
    since: hold?.on === true ? hold.since : null,
    ...(hold?.by ? { by: hold.by } : {}),
    // "4 queued" is the minimum the overlay must show: held-and-accumulating
    // must not look like nothing-happening.
    heldCount: held.length,
    heldCommentIds: held.map((c) => c.id),
    lastRelease: hold?.lastRelease ?? null,
  };
}

async function setHold(root, req, res) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  const htmlPath = await resolvePage(root, payload.page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  if (typeof payload.hold !== 'boolean') {
    sendJson(res, 400, { error: 'hold must be a boolean' });
    return;
  }
  const actor = validActor(payload);
  if (actor === null) {
    sendJson(res, 400, { error: 'invalid creator or agentName' });
    return;
  }
  const view = await update(htmlPath, (data) => {
    // Computed under the lock and BEFORE the op, because releasing clears
    // `since` — the set being handed over has to be read while it still exists.
    const commentIds = payload.hold ? [] : heldComments(data).map((c) => c.id);
    applyOps(data, [{
      op: 'setHold',
      on: payload.hold,
      at: now(),
      commentIds,
      ...(Object.keys(actor).length > 0 ? { by: { ...actor, at: now() } } : {}),
    }]);
    return holdView(data);
  });
  sendJson(res, 200, view);
}

// ---- /api/lease — holdable block leases (#188) -------------------------------
//
//   POST   /api/lease           {page, blocks[], sessionId, ttlMs?}
//                               → {leaseId, blocks, expiresAt, ttlMs}
//                               or 409 in the EXISTING refusal vocabulary
//   POST   /api/lease/renew     {leaseId, ttlMs?} → the extended lease
//   DELETE /api/lease/:id?sessionId=…            → the holder gives it back
//   DELETE /api/lease/:id?force=1                → break glass, recorded
//   DELETE /api/lease?page=…&force=1             → break every hold on a page
//
// The locking itself is not new: runner/lib/leases.mjs has done per-block
// disjointness since #38. What was missing is that a run's lease is
// REQUEST-SCOPED — acquired inside an endpoint, released in a `finally` — so a
// collaborating session could hold a block only for the duration of one call
// and never across the several it takes to read, think and write. These verbs
// are that surface over the same ledger. No second locking mechanism, and no
// second refusal vocabulary: a caller that only understands 'run-active' and
// 'awaiting-confirmation' still gets a 409 it can render.
//
// TTL and force-release are mandatory rather than nice-to-have, and for one
// reason: first holder wins and the human WAITS (decision 5). Preemption is off
// the table, so a crashed session with a lease would otherwise lock a paragraph
// out of its author's own document with no way to tell a slow agent from a dead
// one. The TTL handles the dead one; force-release is the door for when the
// machine is simply wrong, and "restart the runner" is not an answer a document
// editor may give.

const MAX_LEASE_BLOCKS = 200;

function leaseView(root, lease) {
  return {
    leaseId: lease.runId,
    page: pageIdFor(root, lease.page),
    blocks: lease.blocks === PAGE ? PAGE : [...lease.blocks],
    sessionId: lease.holder,
    expiresAt: lease.expiresAt,
    ttlMs: lease.ttlMs,
    acquiredAt: lease.startedAt,
  };
}

/** Drop every hold a session owns. Called when that session releases its claim
 *  (#187): the lease belongs to the SESSION, so it goes when the session does,
 *  rather than sitting on the author's paragraph until its own TTL runs out. */
function releaseLeasesForSession(sessionId) {
  const held = registry.heldBy(sessionId);
  for (const lease of held) registry.release(lease.runId);
  return held.map((l) => l.runId);
}

async function acquireLease(root, req, res) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  const htmlPath = await resolvePage(root, payload.page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
    sendJson(res, 400, { error: 'missing or invalid sessionId' });
    return;
  }
  // Explicit blocks only. The ledger reads an empty block set as PAGE — the
  // right default for a RUN whose reach is not yet known, and the wrong one
  // here: a session that forgot to name its blocks would silently take the
  // whole document out of its author's hands.
  const blocks = payload.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > MAX_LEASE_BLOCKS
    || blocks.some((b) => typeof b !== 'string' || !/^[\w-]{1,64}$/.test(b))) {
    sendJson(res, 400, { error: `blocks must be 1-${MAX_LEASE_BLOCKS} data-rev block ids` });
    return;
  }
  if (payload.ttlMs !== undefined && !Number.isFinite(payload.ttlMs)) {
    sendJson(res, 400, { error: 'ttlMs must be a number' });
    return;
  }
  const leaseId = newId('lease');
  const admitted = registry.acquire({
    runId: leaseId,
    page: htmlPath,
    blocks,
    lane: HOLD_LANE,
    ttlMs: normalizeLeaseTtl(payload.ttlMs),
    holder: payload.sessionId,
  });
  if (!admitted.ok) {
    sendJson(res, 409, conflictBody(admitted));
    return;
  }
  sendJson(res, 200, leaseView(root, admitted.run));
}

async function renewLease(root, req, res) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  if (typeof payload.leaseId !== 'string' || payload.leaseId.length === 0) {
    sendJson(res, 400, { error: 'missing or invalid leaseId' });
    return;
  }
  if (payload.ttlMs !== undefined && !Number.isFinite(payload.ttlMs)) {
    sendJson(res, 400, { error: 'ttlMs must be a number' });
    return;
  }
  const lease = registry.get(payload.leaseId);
  if (lease === null || lease.lane !== HOLD_LANE) {
    // 404 covers both "never existed" and "expired while you were thinking".
    // A renewal cannot resurrect a lease: the blocks may already be someone
    // else's, and re-admitting without re-checking is how two writers meet.
    sendJson(res, 404, { error: 'unknown or expired lease', reason: 'unknown-lease' });
    return;
  }
  const renewed = registry.renew(payload.leaseId, payload.ttlMs === undefined
    ? null : normalizeLeaseTtl(payload.ttlMs));
  if (!renewed.ok) {
    sendJson(res, 404, { error: 'unknown or expired lease', reason: renewed.reason });
    return;
  }
  sendJson(res, 200, leaseView(root, renewed.run));
}

// A force-release, written into the run log. The point is not bookkeeping: a
// session whose lease was yanked finds out only when its next write 409s or
// lands somewhere it did not expect, and "why did my lease vanish" has to be
// answerable from the document's own history. Status 'force-released' is
// undo-inert by construction — undoRun reverts only 'ok' | 'partial' — so this
// record sits in runs[] without ever becoming something undo walks into.
//
// Never fails the release: the lease is already gone by the time this runs, and
// a diagnostic that throws must not turn a successful break-glass into a 500.
async function recordForceRelease({ root, htmlPath, leases, by }) {
  const run = {
    runId: newId('run'),
    status: 'force-released',
    lane: 'lease-force-release',
    decisions: [],
    edits: [],
    reason: 'a held lease was force-released from the overlay',
    releasedLeases: leases.map((l) => ({
      leaseId: l.runId,
      sessionId: l.holder,
      blocks: l.blocks === PAGE ? PAGE : [...l.blocks],
      acquiredAt: l.startedAt,
    })),
    createdAt: now(),
    ...(by !== null ? { actor: by } : {}),
  };
  try {
    await update(htmlPath, (data) => {
      applyOps(data, [{ op: 'addRun', run }]);
    });
    await writeTraceFile(run.runId, 'run.json', run);
  } catch (err) {
    console.error(`[redline] failed to record force-release on ${pageIdFor(root, htmlPath)}: ${err?.message ?? err}`);
  }
  return run;
}

async function releaseLease(root, url, req, res, leaseId) {
  const force = url.searchParams.get('force') === '1';
  const actor = validActor({
    ...(url.searchParams.get('creator') !== null ? { creator: url.searchParams.get('creator') } : {}),
    ...(url.searchParams.get('agentName') !== null ? { agentName: url.searchParams.get('agentName') } : {}),
  });
  if (actor === null) {
    sendJson(res, 400, { error: 'invalid creator or agentName' });
    return;
  }
  const by = Object.keys(actor).length > 0 ? actor : null;

  // The page-level break-all: DELETE /api/lease?page=…&force=1. The overlay
  // needs a way out that does not require enumerating ids it read a moment ago
  // and that may have moved since.
  if (leaseId === null) {
    const pageParam = url.searchParams.get('page');
    if (!force || pageParam === null) {
      sendJson(res, 400, { error: 'DELETE /api/lease needs a lease id, or ?page=…&force=1' });
      return;
    }
    const htmlPath = await resolvePage(root, pageParam);
    if (htmlPath === null) {
      sendJson(res, 404, { error: 'unknown page' });
      return;
    }
    // Held leases only. A run's lease is NOT force-releasable: it is mid-write
    // against a document it dry-ran, and yanking it would leave it writing
    // outside its lease — the one thing the ledger exists to prevent. A stuck
    // run is undo's problem, not this door's.
    const held = registry.runsOn(htmlPath).filter((r) => r.lane === HOLD_LANE);
    for (const lease of held) registry.release(lease.runId);
    const record = held.length > 0
      ? await recordForceRelease({ root, htmlPath, leases: held, by })
      : null;
    sendJson(res, 200, {
      ok: true, forced: true,
      released: held.map((l) => leaseView(root, l)),
      ...(record !== null ? { runId: record.runId } : {}),
    });
    return;
  }

  const lease = registry.get(leaseId);
  if (lease === null || lease.lane !== HOLD_LANE) {
    sendJson(res, 404, { error: 'unknown or expired lease', reason: 'unknown-lease' });
    return;
  }
  if (!force) {
    // The holder giving its own lease back — ordinary lifecycle, unrecorded.
    // Anyone else must say `force=1` and take the log entry with it, so a
    // yanked session can find out what happened rather than guessing.
    const sessionId = url.searchParams.get('sessionId');
    if (sessionId !== lease.holder) {
      sendJson(res, 403, {
        error: 'that lease belongs to another session — release it with force=1',
        reason: 'not-your-lease',
      });
      return;
    }
    registry.release(leaseId);
    sendJson(res, 200, { ok: true, forced: false, released: [leaseView(root, lease)] });
    return;
  }
  registry.release(leaseId);
  const record = await recordForceRelease({ root, htmlPath: lease.page, leases: [lease], by });
  sendJson(res, 200, {
    ok: true, forced: true, released: [leaseView(root, lease)], runId: record.runId,
  });
}

// ---- /api/session/* — presence for a watching agent (#187) -------------------
//
//   POST /api/session/claim     {page, agentName, pid?, ttlMs?} → {sessionId, …}
//                               or 409 naming the holder
//   POST /api/session/heartbeat {sessionId}  → the extended claim
//   POST /api/session/release   {sessionId}  → {ok, released}
//
// A claim says "a session is watching this page and intends to write to it".
// It is per PAGE (decision 11), so one session may watch several documents and
// two sessions may work on different documents under one runner. The refusal is
// the point: a second session learns WHO holds the page instead of both writing
// into the same document unaware of each other.
//
// The claim is not a lock over writes. Nothing in /api/run, /api/edit or
// /api/propose-edits consults it — those are guarded by block leases (#188),
// which is the mechanism that can actually say "not this paragraph, not now".
// Presence answers a different question: is anybody home.

// A page id, relative to the served root, for reporting a claim back. The
// registry is keyed by resolved absolute path — correct for identity, useless
// to a client, which speaks in the page ids every other endpoint takes.
function pageIdFor(root, htmlPath) {
  const rel = path.relative(root, htmlPath);
  return rel.split(path.sep).join('/');
}

function sessionView(root, claim) {
  return { ...claim, page: pageIdFor(root, claim.page) };
}

async function claimSession(root, req, res) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  const htmlPath = await resolvePage(root, payload.page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  // The same shape agentName takes everywhere else (validActor), because a
  // watcher's name lands in the same places a writer's does.
  if (typeof payload.agentName !== 'string' || !AGENT_NAME_RE.test(payload.agentName)) {
    sendJson(res, 400, { error: 'missing or invalid agentName' });
    return;
  }
  if (payload.pid !== undefined && !Number.isInteger(payload.pid)) {
    sendJson(res, 400, { error: 'pid must be an integer' });
    return;
  }
  if (payload.ttlMs !== undefined && !Number.isFinite(payload.ttlMs)) {
    sendJson(res, 400, { error: 'ttlMs must be a number' });
    return;
  }
  const claimed = presence.claim({
    page: htmlPath,
    agentName: payload.agentName,
    pid: payload.pid ?? null,
    ttlMs: payload.ttlMs,
  });
  if (!claimed.ok) {
    // The holder's sessionId is deliberately absent: knowing who has the page
    // must not confer the ability to release it.
    sendJson(res, 409, {
      error: `${claimed.holder.agentName} is already watching this page`,
      reason: claimed.reason,
      holder: sessionView(root, claimed.holder),
    });
    return;
  }
  sendJson(res, 200, sessionView(root, claimed.session));
}

async function sessionLifecycle(root, req, res, action) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
    sendJson(res, 400, { error: 'missing or invalid sessionId' });
    return;
  }
  const result = action === 'heartbeat'
    ? presence.heartbeat(payload.sessionId)
    : presence.release(payload.sessionId);
  if (!result.ok) {
    // 404, not 409: there is nothing to contend with. `reason` separates "your
    // claim ran out — re-claim" from "no such session here — wrong runner".
    sendJson(res, 404, {
      error: result.reason === 'expired'
        ? 'that claim expired — claim the page again'
        : 'unknown session',
      reason: result.reason,
    });
    return;
  }
  if (action === 'release') {
    // #188: a lease belongs to the SESSION, so it goes with it. Otherwise a
    // watcher that shut down cleanly would still hold paragraphs out of its
    // author's hands until each lease's own TTL ran out.
    const dropped = releaseLeasesForSession(payload.sessionId);
    sendJson(res, 200, {
      ok: true, released: true,
      session: sessionView(root, presence.describe(result.session)),
      ...(dropped.length > 0 ? { leasesReleased: dropped } : {}),
    });
    return;
  }
  sendJson(res, 200, sessionView(root, result.session));
}

// ---- GET /api/info (M2 WP2) --------------------------------------------------

// Runner identity, for discovery: which root this process serves, on which
// port, since when. `meta` is built by startServer once the port is bound.
// Deliberately NOT folded into /health — that response is the extension's
// probe and stays byte-stable.
function runnerInfo(root, res, meta, config) {
  sendJson(res, 200, {
    ok: true,
    root,
    port: meta?.port ?? null,
    pid: process.pid,
    startedAt: meta?.startedAt ?? null,
    version: meta?.version ?? null,
    // Presence ONLY — never the key value. Lets the extension popup (WP14)
    // report "API key configured/missing" without exposing the secret.
    hasApiKey: typeof config?.agent?.apiKey === 'string' && config.agent.apiKey.length > 0,
    // Every page a session is currently watching (#187), sessionId-free. This
    // is the runner-wide view — "is anyone home, and where" — for the popup;
    // /api/status?page= carries the one claim a document cares about.
    sessions: presence.all().map((s) => sessionView(root, s)),
  });
}

// ---- GET /api/status --------------------------------------------------------

// The exact shape Session 6's UI polls: {running, runId? (when running),
// lastRun? (the newest run record of any status)}.
async function runStatus(root, url, res) {
  const page = url.searchParams.get('page');
  if (!page) {
    sendJson(res, 400, { error: 'missing page' });
    return;
  }
  const htmlPath = await resolvePage(root, page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  const data = await load(htmlPath);
  const runs = Array.isArray(data.runs) ? data.runs : [];
  // The ledger owns this projection (#38). It carries `running` and
  // `pendingConfirmation` unchanged for the overlay #106 shipped, and adds
  // `runs[]` (per-run state and held blocks) plus a `leases` map.
  //
  // Branch on runs[], not on `running`. Under leases one page can have a run
  // executing WHILE another waits for a confirmation, so a single boolean can
  // no longer describe it — and `running` remains false for a gated run, the
  // trap #106 documented, because a paused run is not executing.
  const body = registry.statusFor(htmlPath);
  // The sidecar's revision, bumped on every save. It is the ONE cheap signal
  // that anything changed — a new comment, a reply, a status flip, a run
  // record — so a polling tab can tell "nothing happened" from "someone else
  // edited this" without refetching the comment list every few seconds. Runs
  // and confirmations have their own fields above; this covers the rest.
  body.rev = data.rev ?? 0;
  // The watching session, or null (#187). Null is the NORMAL state and the
  // overlay shows nothing for it (decision 20) — absence of an agent is not a
  // problem to warn about. sessionId is withheld here for the same reason the
  // 409 withholds it: this is a public read.
  const watcher = presence.holderFor(htmlPath);
  body.session = watcher === null ? null : sessionView(root, presence.describe(watcher));
  // Hold state (#190), always present. A watcher reads it here after a rev
  // bump rather than polling a second endpoint, and the overlay renders the
  // count from it.
  body.hold = holdView(data);
  if (runs.length > 0) body.lastRun = runs[runs.length - 1];
  sendJson(res, 200, body);
}

// ---- GET /api/events ---------------------------------------------------------
//
// An SSE stream of sidecar revisions for one page (#162). Replaces polling
// /api/status for change detection: the client refetches when told to, rather
// than every few seconds on the chance that something moved.
//
// It sends `{rev}` and nothing else — see runner/lib/events.mjs for why that
// choice is what lets the same stream serve multi-user unchanged.
async function watchEvents(root, url, req, res) {
  const page = url.searchParams.get('page');
  if (!page) {
    sendJson(res, 400, { error: 'missing page' });
    return;
  }
  const htmlPath = await resolvePage(root, page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  // Open with the current rev so a client knows where it stands the moment it
  // connects, instead of waiting for the next change to find out.
  const data = await load(htmlPath);
  const unsubscribe = hub.subscribe(htmlPath, res, { rev: data.rev ?? 0 });
  req.on('close', unsubscribe);
  req.on('error', unsubscribe);
}

// ---- POST /api/undo ----------------------------------------------------------

// Revert the latest ok run via its pre-run history snapshot. The doc is
// restored wholesale; in the sidecar the run record STAYS, marked "undone"
// (history only grows), and every comment the run covered (one for a single
// send, all of them for a Send All batch — one undo reverts the whole batch)
// gets its pre-run status back (resolution dropped). Comments created after
// the run are untouched.
async function undoRun(root, req, res) {
  const payload = await readJson(req, res);
  if (payload === null) return;
  const htmlPath = await resolvePage(root, payload.page);
  if (htmlPath === null) {
    sendJson(res, 404, { error: 'unknown page' });
    return;
  }
  // Undo restores the whole document from a snapshot, so it needs the page —
  // it cannot be scoped to blocks the way an edit can.
  const undoClash = registry.conflict(htmlPath, PAGE);
  if (undoClash !== null) {
    sendJson(res, 409, conflictBody(undoClash));
    return;
  }
  const page = payload.page;

  // The doc restore + pre-undo snapshot must run exactly ONCE even when a
  // cross-process rev conflict retries the sidecar mutation below — a second
  // pre-undo snapshot taken after the doc was already restored would record
  // the wrong "before" state. The sidecar edits themselves are safe to re-run
  // (they re-find the run in fresh data).
  let docRestored = false;

  const result = await update(htmlPath, async (data, { skip }) => {
    // Re-check under the lock: a run may have been dispatched between the
    // guard above and this critical section.
    const raced = registry.conflict(htmlPath, PAGE);
    if (raced !== null) {
      skip();
      return { status: 409, body: conflictBody(raced) };
    }
    const runs = Array.isArray(data.runs) ? data.runs : [];

    // ---- #232: targeted revert of a NAMED run ------------------------------
    // Naming a runId asks for tier 1 of the two-tier undo: revert that run's
    // blocks via their recorded beforeInner, through the normal edit pipeline,
    // regardless of where the run sits in the stack — PROVIDED nothing has
    // touched those blocks since (current inner === that run's afterInner for
    // every block). Anything else refuses with a machine-readable reason:
    // 'conflicted' is #194's re-derive trigger, and the LIFO snapshot path
    // below stays as the blunt escape hatch.
    if (payload.runId !== undefined) {
      if (typeof payload.runId !== 'string' || payload.runId.length === 0) {
        skip();
        return { status: 400, body: { error: 'runId must be a non-empty string' } };
      }
      const named = runs.find((r) => r.runId === payload.runId);
      if (!named) {
        skip();
        return { status: 404, body: { error: 'no such run', reason: 'no-such-run' } };
      }
      if (named.status !== 'ok' && named.status !== 'partial') {
        skip();
        return {
          status: 409,
          body: { error: `run is '${named.status}' — only an ok or partial run has edits to revert`, reason: 'not-revertible' },
        };
      }
      const records = Array.isArray(named.edits) ? named.edits : [];
      if (records.length === 0) {
        skip();
        return { status: 409, body: { error: 'the run recorded no edits — nothing to revert', reason: 'nothing-to-revert' } };
      }
      // Theme, attribute and insert records are not plain inner-text swaps
      // (a theme is page-level, an insert has no "before", an attribute record
      // holds open tags) — the snapshot path handles runs that carry them.
      const unsupported = records.some((r) => r.op !== undefined
        || r.insertedAfter !== undefined || r.insertedBefore !== undefined);
      if (unsupported) {
        skip();
        return {
          status: 409,
          body: {
            error: 'the run contains theme, attribute, or insert edits — not a plain text swap; use the snapshot undo',
            reason: 'unsupported-ops',
          },
        };
      }
      const source = await fs.readFile(htmlPath, 'utf8');
      const conflicted = records
        .filter((r) => {
          const block = locateBlock(source, r.blockId);
          return block === null || block.inner !== r.afterInner;
        })
        .map((r) => r.blockId);
      if (conflicted.length > 0) {
        skip();
        return {
          status: 409,
          body: {
            error: 'later edits touched blocks this run wrote — a mechanical revert would destroy them; re-derive instead',
            reason: 'conflicted',
            blocks: conflicted,
          },
        };
      }
      if (!docRestored) {
        // History only grows: the pre-undo state first, then the revert goes
        // through applyEdits — the same validation every write gets.
        await saveSnapshot({ root, page, htmlPath, runId: named.runId, kind: 'pre-undo' });
        const applied = await applyEdits({
          root, page, edits: records.map((r) => ({ blockId: r.blockId, newInner: r.beforeInner })),
        });
        if (!applied.ok) {
          skip();
          return { status: 500, body: { error: `revert failed: ${applied.error}`, reason: 'revert-failed' } };
        }
        docRestored = true;
      }
      const snap = await loadSnapshot({ root, page, runId: named.runId, kind: 'pre-run' });
      let snapComments = null;
      if (snap !== null && snap.sidecar !== null) {
        try {
          const parsed = JSON.parse(snap.sidecar);
          if (Array.isArray(parsed?.comments)) snapComments = parsed.comments;
        } catch { /* corrupt snapshot sidecar → fall back to reopen */ }
      }
      applyOps(data, undoOps(named, snapComments));
      return { status: 200, body: named };
    }

    // 'ok' and 'partial' (WP8) are both undoable — a partial batch reverts its
    // applied comments and reopens every comment it named, as one unit. Any
    // other status is walked past: an 'undone' run already reverted, a 'failed'
    // one applied nothing, and a 'declined' one (#128 — a scope confirmation
    // the author refused) is a billed run with edits: [] and nothing to undo.
    // So a declined run on TOP of an applied run is skipped, and undo still
    // reaches the applied run beneath it and restores its snapshot.
    const run = [...runs].reverse().find((r) => r.status === 'ok' || r.status === 'partial');
    if (!run) {
      skip();
      return { status: 404, body: { error: 'no run to undo' } };
    }

    // #164: undo is last-run-wins and takes no run id, so an agent that applies
    // an edit, has a human edit after it, then reverts "its" run actually
    // reverts the human's. `expectRunId` lets a caller name the run it means
    // and be REFUSED rather than guessed at — the trust layer's usual habit.
    // Optional: absent keeps the historical behaviour, so the overlay button
    // and every existing caller are untouched.
    if (payload.expectRunId !== undefined) {
      if (typeof payload.expectRunId !== 'string' || payload.expectRunId.length === 0) {
        skip();
        return { status: 400, body: { error: 'expectRunId must be a non-empty string' } };
      }
      if (payload.expectRunId !== run.runId) {
        skip();
        return {
          status: 409,
          body: {
            error: 'the run on top is not the one you named — refusing to undo',
            expected: payload.expectRunId,
            actual: run.runId,
          },
        };
      }
    }

    const snap = await loadSnapshot({ root, page, runId: run.runId, kind: 'pre-run' });
    if (snap === null) {
      skip();
      return { status: 404, body: { error: 'no snapshot available for that run (pruned from history)' } };
    }

    if (!docRestored) {
      // History only grows: record the pre-undo state as a NEW entry first.
      await saveSnapshot({ root, page, htmlPath, runId: run.runId, kind: 'pre-undo' });
      await atomicWriteFile(htmlPath, snap.doc);
      docRestored = true;
    }

    let snapComments = null;
    if (snap.sidecar !== null) {
      try {
        const parsed = JSON.parse(snap.sidecar);
        if (Array.isArray(parsed?.comments)) snapComments = parsed.comments;
      } catch { /* corrupt snapshot sidecar → fall back to reopen */ }
    }
    applyOps(data, undoOps(run, snapComments));
    return { status: 200, body: run };
  });

  sendJson(res, result.status, result.body);
}

// The sidecar half of any undo, targeted or snapshot: mark the run undone and
// give every comment it covered its pre-run status back (resolution dropped
// when the snapshot has none). A Send All batch names its comments in
// commentIds, single runs in commentId.
function undoOps(run, snapComments) {
  const undoIds = Array.isArray(run.commentIds) ? run.commentIds
    : (typeof run.commentId === 'string' ? [run.commentId] : []);
  const ops = [{ op: 'setRunStatus', runId: run.runId, status: 'undone' }];
  for (const id of undoIds) {
    const snapComment = snapComments?.find((c) => c.id === id) ?? null;
    ops.push({
      op: 'resolve', commentId: id, status: snapComment?.status ?? 'open',
      // Absent resolution on the op DELETES the comment's resolution.
      ...(snapComment && snapComment.resolution !== undefined ? { resolution: snapComment.resolution } : {}),
    });
  }
  return ops;
}

// ---- request-origin gate (#33) ---------------------------------------------
//
// Binding 127.0.0.1 does not stop a hostile web page: a cross-site form/fetch
// can fire no-preflight POSTs at http://127.0.0.1:<port>/api/*, and a
// DNS-rebinding page reaches the socket with a non-loopback Host. Three
// checks, all before dispatch, all cheap:
//   - Host must be loopback (kills DNS rebinding),
//   - Origin, when present, must be loopback or a browser extension — a
//     cross-site browser request always carries its page's Origin; non-browser
//     clients (CLI, MCP, curl) send none and pass,
//   - POSTs must declare application/json, which a cross-site page cannot do
//     without a CORS preflight the runner never answers.

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

function isAllowedOrigin(originHeader) {
  if (originHeader === undefined) return true; // non-browser client
  if (typeof originHeader !== 'string') return false;
  let origin;
  try {
    origin = new URL(originHeader);
  } catch {
    return false; // includes the literal "null" of sandboxed/file:// pages
  }
  if (origin.protocol === 'chrome-extension:') return true;
  return (origin.protocol === 'http:' || origin.protocol === 'https:')
    && LOOPBACK_HOSTNAMES.has(origin.hostname);
}

// The gate verdict for an /api request: null when allowed, else {status, error}.
// Exported for tests.
export function requestGateError(req) {
  if (!isLoopbackHost(req.headers.host)) {
    return { status: 403, error: 'forbidden: Host must be loopback' };
  }
  if (!isAllowedOrigin(req.headers.origin)) {
    return { status: 403, error: 'forbidden: cross-site requests are not allowed' };
  }
  if (req.method === 'POST') {
    const contentType = String(req.headers['content-type'] ?? '').trim();
    if (!/^application\/json\b/i.test(contentType)) {
      return { status: 415, error: 'POST requires content-type application/json' };
    }
  }
  return null;
}

// Handle any request whose pathname starts with /api/. Always responds.
// `meta` (optional) carries the bound port / start time / package version for
// GET /api/info; the server fills it in once it is listening.
export async function handleApi(root, req, res, config, meta = null) {
  const gate = requestGateError(req);
  if (gate !== null) return sendJson(res, gate.status, { error: gate.error });

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/comments') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return listComments(root, url, res);
  }

  if (pathname === '/api/dir') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return dirListing(root, url, res);
  }

  if (pathname === '/api/info') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return runnerInfo(root, res, meta, config);
  }

  if (pathname === '/api/source') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return pageSource(root, url, res);
  }

  if (pathname === '/api/propose-edits') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return proposeEdits(root, req, res);
  }

  if (pathname === '/api/comment') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return createComment(root, req, res);
  }

  if (pathname === '/api/run/confirm') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return confirmRun(root, config, req, res);
  }

  if (pathname === '/api/run') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return runComment(root, config, req, res);
  }

  if (pathname === '/api/edit') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return directEdit(root, req, res);
  }

  if (pathname === '/api/hold') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return setHold(root, req, res);
  }

  if (pathname === '/api/lease/renew') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return renewLease(root, req, res);
  }

  if (pathname === '/api/lease') {
    if (req.method === 'POST') return acquireLease(root, req, res);
    if (req.method === 'DELETE') return releaseLease(root, url, req, res, null);
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  if (pathname.startsWith('/api/lease/')) {
    if (req.method !== 'DELETE') return sendJson(res, 405, { error: 'method not allowed' });
    let leaseId;
    try {
      leaseId = decodeURIComponent(pathname.slice('/api/lease/'.length));
    } catch {
      return sendJson(res, 404, { error: 'unknown or expired lease', reason: 'unknown-lease' });
    }
    if (leaseId.length === 0 || leaseId.includes('/')) {
      return sendJson(res, 404, { error: 'unknown or expired lease', reason: 'unknown-lease' });
    }
    return releaseLease(root, url, req, res, leaseId);
  }

  if (pathname === '/api/session/claim') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return claimSession(root, req, res);
  }

  if (pathname === '/api/session/heartbeat' || pathname === '/api/session/release') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return sessionLifecycle(root, req, res, pathname.slice('/api/session/'.length));
  }

  if (pathname === '/api/status') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return runStatus(root, url, res);
  }

  if (pathname === '/api/events') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return watchEvents(root, url, req, res);
  }

  if (pathname === '/api/trace') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return traceBundle(url, res);
  }

  if (pathname === '/api/undo') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return undoRun(root, req, res);
  }

  if (pathname === '/api/instrument') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    return instrumentPage(root, req, res);
  }

  const match = pathname.match(/^\/api\/comment\/([^/]+)\/(reply|status|ai-edits|anchor)$/);
  if (match) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return sendJson(res, 404, { error: 'unknown comment' });
    }
    return updateComment(root, req, res, id, match[2]);
  }

  sendJson(res, 404, { error: 'not found' });
}
