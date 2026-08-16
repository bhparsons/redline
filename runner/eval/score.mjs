// runner/eval/score.mjs — score one fixture against an actual run outcome.
//
// score(fixture, outcome) → { score: 0..1, breakdown, notes }
//
// The outcome is a run record (or anything shaped like one): { archetype,
// decisions, edits, status? }. Edits may be run-record edit records
// ({blockId, beforeInner, afterInner}) or raw agent edits ({blockId,
// newInner}) — both are accepted.
//
// Five equally-weighted components, each 0..1:
//   archetype       classified archetype matches the fixture
//   blockId         edits target exactly the expected block — or, for
//                   section fixtures carrying expectedBlockIds, only
//                   blocks from that list (or, for no-edit fixtures,
//                   there are none)
//   decision        a decision is present and valid (0.5) and matches the
//                   expected decision (1.0)
//   editSimilarity  the applied inner HTML satisfies the fixture's
//                   expectedInnerPattern (RegExp or predicate), or a
//                   normalized string distance when the fixture carries an
//                   expectedInner string instead
//   appliedCleanly  the edits survive the REAL surgery validation pipeline
//                   (replaceBlockInner + validateWrite from runner/lib —
//                   never a reimplementation) on a doc built from the fixture
//
// Scoring never throws on malformed outcomes — a garbage outcome scores 0.

import { replaceBlockInner, validateWrite } from '../lib/surgery.mjs';
import { buildDoc } from './fixtures.mjs';

export const COMPONENTS = Object.freeze([
  'archetype', 'blockId', 'decision', 'editSimilarity', 'appliedCleanly',
]);

const VALID_DECISIONS = new Set(['addressed', 'declined', 'deferred']);

// Normalized Levenshtein similarity: 1 = identical, 0 = nothing in common.
export function similarity(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const row = [i];
    for (let j = 1; j <= m; j++) {
      row.push(Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      ));
    }
    prev = row;
  }
  return 1 - prev[m] / Math.max(n, m);
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// The replacement inner of an edit in either accepted shape.
function innerOf(edit) {
  if (typeof edit?.newInner === 'string') return edit.newInner;
  if (typeof edit?.afterInner === 'string') return edit.afterInner;
  return null;
}

export function score(fixture, outcome) {
  const notes = [];
  const edits = Array.isArray(outcome?.edits) ? outcome.edits : [];
  const decisions = Array.isArray(outcome?.decisions) ? outcome.decisions : [];
  const expectsEdit = fixture.expectsEdit === true;

  // 1. archetype
  const archetype = outcome?.archetype === fixture.expectedArchetype ? 1 : 0;
  if (!archetype) notes.push(`archetype: got ${outcome?.archetype ?? 'none'}, expected ${fixture.expectedArchetype}`);

  // 2. blockId — section fixtures allow any block from expectedBlockIds.
  const targetIds = Array.isArray(fixture.expectedBlockIds)
    ? fixture.expectedBlockIds
    : [fixture.expectedBlockId];
  let blockId;
  if (expectsEdit) {
    if (edits.length === 0) {
      blockId = 0;
      notes.push('expected an edit, got none');
    } else if (edits.every((e) => targetIds.includes(e?.blockId))) {
      blockId = 1;
    } else {
      blockId = 0;
      notes.push(`edit targets wrong block(s): ${edits.map((e) => e?.blockId).join(', ')}`);
    }
  } else {
    blockId = edits.length === 0 ? 1 : 0;
    if (!blockId) notes.push(`expected no edits, got ${edits.length}`);
  }

  // 3. decision — present + valid earns half; matching the expectation, full.
  let decision = 0;
  const d = decisions[0];
  if (d !== null && typeof d === 'object' && !Array.isArray(d)
    && VALID_DECISIONS.has(d.decision)
    && typeof d.summary === 'string' && d.summary.length > 0) {
    decision = d.decision === fixture.expectedDecision ? 1 : 0.5;
    if (decision !== 1) notes.push(`decision: got ${d.decision}, expected ${fixture.expectedDecision}`);
  } else {
    notes.push('decision missing or invalid');
  }
  if (decisions.length > 1) notes.push(`agent returned ${decisions.length} decisions for one comment`);

  // 4. edit similarity — section fixtures judge the concatenation of every
  // applied inner (the pattern speaks for the section as a whole).
  let editSimilarity;
  if (!expectsEdit) {
    editSimilarity = edits.length === 0 ? 1 : 0;
  } else {
    let after;
    if (Array.isArray(fixture.expectedBlockIds)) {
      const inners = edits.filter((e) => targetIds.includes(e?.blockId))
        .map(innerOf).filter((v) => v !== null);
      after = inners.length > 0 ? inners.join('\n') : null;
    } else {
      const target = edits.find((e) => e?.blockId === fixture.expectedBlockId);
      after = target === undefined ? null : innerOf(target);
    }
    if (after === null) {
      editSimilarity = 0;
    } else {
      const pattern = fixture.expectedInnerPattern;
      if (pattern instanceof RegExp) {
        editSimilarity = pattern.test(after) ? 1 : 0;
      } else if (typeof pattern === 'function') {
        let v;
        try { v = pattern(after); } catch { v = 0; }
        editSimilarity = v === true ? 1 : clamp01(v);
      } else if (typeof fixture.expectedInner === 'string') {
        editSimilarity = similarity(after, fixture.expectedInner);
      } else {
        editSimilarity = 0;
        notes.push('fixture has no expectedInnerPattern/expectedInner to judge the edit');
      }
      if (editSimilarity === 0) notes.push('edit does not satisfy the expected inner pattern');
    }
  }

  // 5. applied cleanly — replay the edits through the real surgery pipeline
  // on a fresh doc built from the fixture block.
  let appliedCleanly;
  if (edits.length === 0) {
    appliedCleanly = expectsEdit ? 0 : 1;
  } else {
    appliedCleanly = 1;
    const original = buildDoc(fixture.blockHtml);
    let current = original;
    for (const edit of edits) {
      const inner = innerOf(edit);
      const replaced = replaceBlockInner(current, String(edit?.blockId ?? ''), inner ?? '');
      if (!replaced.ok) {
        appliedCleanly = 0;
        notes.push(`apply failed (${replaced.code}): ${replaced.error}`);
        break;
      }
      const valid = validateWrite(original, replaced.source);
      if (!valid.ok) {
        appliedCleanly = 0;
        notes.push(`apply failed (${valid.code}): ${valid.error}`);
        break;
      }
      current = replaced.source;
    }
  }
  if (typeof outcome?.status === 'string' && outcome.status !== 'ok') {
    notes.push(`run status: ${outcome.status}`);
  }

  const breakdown = { archetype, blockId, decision, editSimilarity, appliedCleanly };
  const total = COMPONENTS.reduce((sum, key) => sum + breakdown[key], 0) / COMPONENTS.length;
  return { score: Math.round(total * 1000) / 1000, breakdown, notes };
}

// ---- latency / cost metrics (WP5) -------------------------------------------

// ROUGH per-model prices in USD per MILLION tokens {input, output} — the
// FALLBACK for stub runs, which carry no charged cost. A live run's charged
// cost always wins (see estimateCost); this table only has to be close.
//
// VERIFIED 2026-07-24 against GET https://openrouter.ai/api/v1/models (#118).
// Two entries were stale by enough to distort a tier comparison: sonnet-5 was
// listed at 3/15 (real 2/10) and opus-4-8 at 15/75 (real 5/25). That is why
// design/m1/M1-REPORT.md's eval table reads $0.24 standard / $1.08 complex —
// both estimates, over-stated 1.5x and 3x respectively, which inflated the
// standard→complex step from its true ~2.5x rate ratio to an apparent 4.5x.
// Re-verify with the same endpoint before trusting a cost column again.
//
// These are BASE input rates. Anthropic and Gemini also bill cache reads at
// 0.1x and cache writes at 1.25x base (#116), which this table cannot model —
// another reason a live run's charged cost is the number to prefer.
export const MODEL_PRICES = Object.freeze({
  'google/gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'anthropic/claude-haiku-4.5': { input: 1, output: 5 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10 },
  'anthropic/claude-opus-4-8': { input: 5, output: 25 },
  'perplexity/sonar-pro': { input: 3, output: 15 },
});
export const DEFAULT_PRICE = Object.freeze({ input: 3, output: 15 });

// USD cost of one exchange. The CHARGED cost wins whenever the provider
// returned one (`usage.costUsd`) — it already accounts for cache reads and
// writes, which no static price table can. Absent that, real token counts
// win; absent those — stub runs never carry them — tokens are estimated at
// chars/4.
export function estimateCost({ model, usage = null, promptChars = 0, responseChars = 0 }) {
  if (Number.isFinite(usage?.costUsd)) return Math.round(usage.costUsd * 1e6) / 1e6;
  const price = MODEL_PRICES[model] ?? DEFAULT_PRICE;
  const inputTokens = Number.isFinite(usage?.inputTokens) ? usage.inputTokens : promptChars / 4;
  const outputTokens = Number.isFinite(usage?.outputTokens) ? usage.outputTokens : responseChars / 4;
  const usd = (inputTokens * price.input + outputTokens * price.output) / 1e6;
  return Math.round(usd * 1e6) / 1e6; // micro-dollar precision
}
