// runner/lib/scope.mjs — the scope guardrail (WP7).
//
// After a run's edits are computed (a DRY-RUN apply, so nothing is on disk
// yet), the runner INDEPENDENTLY works out how far those edits actually reach
// — which blocks they touch and whether they touch the page theme — and
// compares that against the section the reviewer's comment was anchored to.
// The agent may ALSO report its own intended `scope`, but the agent's word can
// only ADD a confirmation (requiresConfirmation:true) or WAIVE a broad-scope
// one it says the user explicitly authorized (requiresConfirmation:false); it
// can never make the runner miss a theme edit or an out-of-section reach.
//
// Frontload decision 2:
//   - no confirmation when edits stay inside the anchored section;
//   - confirm when the edits touch the theme zone or reach blocks outside the
//     anchored section without explicit user instruction;
//   - the agent's own requiresConfirmation flag is honored either way.

import { locateBlock, revIds, plainText } from './surgery.mjs';
import { CONTAINER_TAGS } from './instrument.mjs';

// The byte range of the section a comment anchors to. If the anchor is itself
// a container it IS the section; otherwise the smallest container enclosing
// the anchor is. Returns {start, end, id} or null when there is no anchor or
// no enclosing container (i.e. the whole document — nothing is "outside").
export function sectionRange(source, anchorBlockId) {
  if (typeof anchorBlockId !== 'string' || anchorBlockId.length === 0) return null;
  const anchor = locateBlock(source, anchorBlockId);
  if (anchor === null) return null;
  if (CONTAINER_TAGS.has(anchor.tag.toLowerCase())) {
    return { start: anchor.outerStart, end: anchor.outerEnd, id: anchorBlockId };
  }
  let best = null;
  for (const id of new Set(revIds(source))) {
    if (id === anchorBlockId) continue;
    const b = locateBlock(source, id);
    if (b === null || !CONTAINER_TAGS.has(b.tag.toLowerCase())) continue;
    if (b.outerStart <= anchor.outerStart && b.outerEnd >= anchor.outerEnd) {
      const span = b.outerEnd - b.outerStart;
      if (best === null || span < best.span) best = { start: b.outerStart, end: b.outerEnd, id, span };
    }
  }
  return best === null ? null : { start: best.start, end: best.end, id: best.id };
}

// Work out the actual scope of an edit set against the pre-apply source.
// `editRecords` is a dry-run applyEdits result's editRecords (inner/attribute/
// theme edits + inserts). Returns:
//   { level: 'block'|'section'|'page', touchedThemeZone, outOfSection, touchedBlocks }
export function computeScope(source, { anchorBlockId, editRecords }) {
  const records = Array.isArray(editRecords) ? editRecords : [];
  const touchedThemeZone = records.some((r) => r && r.op === 'theme');
  const section = sectionRange(source, anchorBlockId);

  const refs = [];
  for (const r of records) {
    if (!r || r.op === 'theme') continue;
    // An insert's placement is defined by its anchor block; inner/attribute
    // edits by their own block. The minted insert id isn't in `source`, so we
    // judge the insert's REACH by where it was anchored.
    const ref = r.insertedAfter ?? r.insertedBefore ?? r.blockId;
    if (typeof ref === 'string' && ref.length > 0) refs.push(ref);
  }
  const touchedBlocks = [...new Set(refs)];

  let outOfSection = false;
  if (section !== null) {
    for (const id of touchedBlocks) {
      const b = locateBlock(source, id);
      if (b !== null && !(b.outerStart >= section.start && b.outerEnd <= section.end)) {
        outOfSection = true;
        break;
      }
    }
  }

  let level = 'block';
  if (touchedThemeZone) level = 'page';
  else if (outOfSection || touchedBlocks.length > 1
    || (touchedBlocks.length === 1 && touchedBlocks[0] !== anchorBlockId)) {
    level = 'section';
  }

  return { level, touchedThemeZone, outOfSection, touchedBlocks };
}

// Decide whether a run needs author confirmation before it is applied.
// `agentScope` is the agent's optional {level?, requiresConfirmation?, summary?}.
// Returns { required, broad, reasons: [...], level }.
export function confirmationDecision({ computed, agentScope = null }) {
  const reasons = [];
  if (computed.touchedThemeZone) reasons.push('changes the page-level theme');
  if (computed.outOfSection) reasons.push('edits blocks outside the commented section');
  const broad = reasons.length > 0;

  const agentAsks = agentScope != null && agentScope.requiresConfirmation === true;
  const agentWaives = agentScope != null && agentScope.requiresConfirmation === false;

  let required;
  if (agentAsks) required = true;         // the agent can always ask to confirm
  else if (!broad) required = false;      // stays inside the section → just apply
  else required = !agentWaives;           // broad reach → confirm unless the user authorized it

  return { required, broad, reasons, level: computed.level };
}

// One gate decision, in a shape worth counting (#195). Every decision is
// recorded — the ones that FIRED and the ones that did not — because the
// threshold is meant to be tuned from real use, and "how often does it fire
// when it should not" cannot be answered from a log that only keeps the times
// it fired. Decision 14 keeps today's rule as-is and makes this the way to
// argue about it later with numbers instead of anecdotes.
export function gateRecord({ computed, gate, agentScope = null }) {
  return {
    level: computed.level,
    fired: gate.required,
    // `broad` is the reach verdict, `fired` the outcome. They differ exactly
    // when the agent waived a broad change, which is the case worth counting
    // separately: a waiver is the agent saying the author asked for this.
    broad: gate.broad,
    reasons: gate.reasons,
    outOfSection: computed.outOfSection,
    touchedThemeZone: computed.touchedThemeZone,
    touchedBlocks: computed.touchedBlocks,
    waived: gate.broad && !gate.required,
    agentDeclared: agentScope != null && typeof agentScope.level === 'string' ? agentScope.level : null,
  };
}

// ---- naming the reach ------------------------------------------------------
//
// A confirmation dialog that lists `r-0115, r-0116` asks the reviewer to
// approve something they cannot read. They recognise the WORDS, not the stamp
// — so the reach is described with each block's opening phrase, a section's
// heading, and the theme's changed properties. Signed off 2026-07-28
// (`design/mock-phase4-parts.html` part 9); consumed by #106's status payload.

const REACH_CHARS = 48;

// First `max` characters of a fragment's decoded text, cut on a word boundary.
function opening(html, max = REACH_CHARS) {
  const text = plainText(String(html ?? '')).replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  // Only honour the word boundary if it isn't cutting the phrase to a stub.
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.]+$/u, '')}…`;
}

// A container block is recognised by its heading when it has one — "the
// Where the sediment went section" reads better than its first sentence.
function headingOf(inner) {
  const m = /<(h[1-6])(?=[\s>])[^>]*>([\s\S]*?)<\/\1\s*>/iu.exec(inner);
  return m === null ? null : opening(m[2]);
}

// Property names from a theme rule body, so the dialog can say what the theme
// change actually is ("page theme — color") rather than that there is one.
function themeProps(css) {
  if (typeof css !== 'string' || css.length === 0) return [];
  const out = [];
  for (const m of css.matchAll(/(?:^|[{;])\s*([a-zA-Z-]+)\s*:/gu)) {
    const prop = m[1].toLowerCase();
    if (!out.includes(prop)) out.push(prop);
  }
  return out;
}

// Describe an edit set's reach in the document's own words. Returns one entry
// per touched block plus a trailing theme entry when the theme zone is
// touched: { blockId, kind: 'block'|'section'|'theme', text, props? }.
// `text` is null for a block that no longer resolves (deleted or re-stamped
// between dry run and render) — the caller renders those by id, the one case
// where an id is the honest thing to show.
export function describeReach(source, { touchedBlocks = [], touchedThemeZone = false, themeCss = null } = {}) {
  const items = [];
  for (const id of Array.isArray(touchedBlocks) ? touchedBlocks : []) {
    const block = locateBlock(source, id);
    if (block === null) {
      items.push({ blockId: id, kind: 'block', text: null });
      continue;
    }
    const isContainer = CONTAINER_TAGS.has(block.tag.toLowerCase());
    const heading = isContainer ? headingOf(block.inner) : null;
    items.push({
      blockId: id,
      kind: isContainer ? 'section' : 'block',
      text: heading ?? opening(block.inner),
    });
  }
  if (touchedThemeZone) {
    const props = themeProps(themeCss);
    items.push({ blockId: null, kind: 'theme', text: 'page theme', props });
  }
  return items;
}

// A short, human-readable summary for the confirmation card. Prefers the
// agent's own summary when it gave one.
export function scopeSummary({ computed, agentScope = null, reasons }) {
  if (agentScope != null && typeof agentScope.summary === 'string' && agentScope.summary.length > 0) {
    return agentScope.summary;
  }
  if (reasons.length > 0) {
    const head = reasons.length === 1 ? 'This change ' : 'This change ';
    return `${head}${reasons.join(' and ')}.`;
  }
  return 'This change stays within the commented section.';
}
