// runner/lib/tactical.mjs — the tactical lane (WP4): a fast, low-cost path
// for simple single-block edits, targeting ≤15 s end to end.
//
// Eligibility (frontload decision 4): a SINGLE-comment run whose router
// route says canTactical, anchored to a located block whose inner HTML is
// ≤ TACTICAL_MAX_BLOCK_CHARS. Everything else takes the standard lane.
//
// The tactical prompt is small on purpose (frontload decision 5): the
// comment, the target block's inner HTML, and the DISTILLED skill text —
// never the full document or project-context files. The reply is
//   { runId, decisions, blockEdits: [{id, newInner}] }  or  { escalate: true }
// and the RUNNER applies blockEdits through the same surgery/apply pipeline
// as every other write — the lane changes the prompt, never the trust
// machinery.
//
// FAIL-SAFE: any problem — transport error, timeout (TACTICAL_TIMEOUT_MS,
// short so escalation is fast), bad JSON, wrong block, failed apply — makes
// the run ESCALATE to the standard lane; the tactical lane can never fail a
// run on its own. api.mjs records lane: 'tactical' (fast path taken),
// 'escalated' (attempted, fell through), or 'standard' (never eligible).

import { promises as fs } from 'node:fs';
import { completeChat, stripFences } from './agent.mjs';
import { loadSkills } from './skills.mjs';
import { CONTAINER_TAGS } from './instrument.mjs';

export const TACTICAL_MAX_BLOCK_CHARS = 4096;
export const TACTICAL_TIMEOUT_MS = 30_000;
export const TACTICAL_MAX_TOKENS = 4096;

const DECISION_VALUES = new Set(['addressed', 'declined', 'deferred']);
const PROMPT_URL = new URL('../prompts/tactical.md', import.meta.url);
let promptCache = null;

async function loadPrompt() {
  if (promptCache === null) promptCache = await fs.readFile(PROMPT_URL, 'utf8');
  return promptCache;
}

// Is this run tactical-eligible? `block` is the locateBlock() result for the
// comment's anchor (null when the anchor has no resolvable block).
export function tacticalEligible({ batch, route, block }) {
  if (batch) return false;
  if (route.canTactical !== true) return false;
  if (!block || typeof block.inner !== 'string') return false;
  // Section/container anchors are never tactical — their edits span child
  // blocks, which is exactly what the standard lane's section view is for.
  if (typeof block.tag === 'string' && CONTAINER_TAGS.has(block.tag)) return false;
  return block.inner.length <= TACTICAL_MAX_BLOCK_CHARS;
}

// Validate the tactical reply. Returns 'escalate', {decisions, edits}
// (edits in the standard {blockId, newInner} shape), or null (invalid —
// caller escalates).
export function validateTacticalPayload(value, { runId, commentId, blockId }) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.escalate === true) return 'escalate';
  // A revise-shaped reply (`edits`/`inserts` keys) is the WRONG contract —
  // reject it rather than silently dropping its edits, so the run escalates
  // to the lane that speaks that shape.
  if (value.edits !== undefined || value.inserts !== undefined) return null;
  if (value.runId !== undefined && value.runId !== runId) return null;
  if (!Array.isArray(value.decisions) || value.decisions.length !== 1) return null;
  const d = value.decisions[0];
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return null;
  if (d.id !== commentId) return null;
  if (typeof d.decision !== 'string' || !DECISION_VALUES.has(d.decision)) return null;
  if (typeof d.summary !== 'string') return null;
  const decision = { id: d.id, decision: d.decision, summary: d.summary };
  if (d.note !== undefined) {
    if (typeof d.note !== 'string') return null;
    decision.note = d.note;
  }
  const rawEdits = value.blockEdits === undefined ? [] : value.blockEdits;
  if (!Array.isArray(rawEdits) || rawEdits.length > 1) return null;
  const edits = [];
  for (const raw of rawEdits) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.id !== blockId) return null; // the ONE block, nothing else
    if (typeof raw.newInner !== 'string') return null;
    edits.push({ blockId: raw.id, newInner: raw.newInner });
  }
  return { decisions: [decision], edits };
}

// The tactical model: the author's pin for the archetype when one exists,
// else the simple tier — the lane's whole point is small and fast.
export function tacticalModel(route, config) {
  return config.modelOverrides?.[route.archetype] ?? config.modelTiers.simple;
}

// Render the tactical prompt. Skills go in DISTILLED (frontload decision 5);
// project-context files and the full document stay out by construction.
export async function buildTacticalPrompt({ comment, block, runId, route, config, log = console.warn }) {
  const { text: skillText } = await loadSkills({
    comment: comment.body, archetype: route.archetype, config,
    distilled: true, only: route.skills, log,
  });
  return (await loadPrompt())
    .split('{{RUN_ID}}').join(runId)
    .split('{{COMMENT}}').join(JSON.stringify({ id: comment.id, body: comment.body }, null, 2))
    .split('{{BLOCK_ID}}').join(block.id)
    .split('{{BLOCK_HTML}}').join(block.inner)
    .split('{{SKILLS}}').join(skillText);
}

// One tactical attempt: prompt → completeChat → validate. Returns
//   { ok: true,  prompt, decisions, edits }        (edits ready for applyEdits)
//   { ok: false, prompt?, reason }                  (caller escalates)
// Never throws. The caller applies the edits — this module never writes.
export async function runTactical({ comment, block, runId, route, config, capture = null, log = console.warn }) {
  let prompt;
  try {
    prompt = await buildTacticalPrompt({ comment, block, runId, route, config, log });
  } catch (err) {
    return { ok: false, reason: `tactical prompt build failed: ${err?.message ?? err}` };
  }

  const res = await completeChat({
    prompt,
    model: tacticalModel(route, config),
    config,
    capture,
    maxTokens: TACTICAL_MAX_TOKENS,
    timeoutMs: Math.min(TACTICAL_TIMEOUT_MS, config.agent.timeoutMs ?? TACTICAL_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, prompt, reason: `tactical call failed: ${res.message}` };

  let parsed;
  try {
    parsed = JSON.parse(stripFences(res.content));
  } catch {
    return { ok: false, prompt, reason: 'tactical reply was not valid JSON' };
  }
  const validated = validateTacticalPayload(parsed, { runId, commentId: comment.id, blockId: block.id });
  if (validated === 'escalate') return { ok: false, prompt, reason: 'agent chose to escalate' };
  if (validated === null) return { ok: false, prompt, reason: 'tactical reply did not match the expected shape' };
  return { ok: true, prompt, decisions: validated.decisions, edits: validated.edits, usage: res.usage };
}
