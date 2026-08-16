// runner/lib/context-manifest.mjs — what actually went into a prompt, and what
// the provider actually billed for it (#94).
//
// Timing and token totals tell you a run was expensive; they don't tell you
// WHICH layer paid for it. This module makes the composition attributable on
// every run instead of by hand-parsing a trace bundle:
//
//   promptManifest(prompt) → the rendered prompt split by its "## " sections,
//     largest-first, plus a redundancy signal (bytes present in more than one
//     section). The rebuild's bloat is not tool schemas — it is document text
//     shipped more than once, which is invisible in a token total.
//
//   usageManifest(rawUsage) → sent-vs-billed: prompt tokens, how many were
//     cache reads vs cache writes, and the chars-per-token ratio, so a prompt
//     that grew without the bill growing (cache hit) reads differently from
//     one that grew the bill.
//
// Pure, stdlib-only, and cheap: one pass over the prompt with no allocation
// beyond the section list. Never throws on odd input — a manifest is
// diagnostics, and diagnostics must not be able to fail a run.

// Sections are the "## Heading" blocks the prompt template renders. Anything
// before the first heading is the preamble.
const SECTION_RE = /^## (.+)$/gm;

// Long enough that a repeated line is real duplicated content, not two blocks
// that happen to share a common short string like "</p>" or an indent.
const DUP_LINE_MIN_CHARS = 40;

/**
 * Split a rendered prompt into its sections with sizes and shares.
 * Returns {chars, sections:[{name, chars, share}], largest, duplicate:{chars, share, lines}}
 * `share` is a 0-1 fraction rounded to 3 places. Sections are largest-first.
 */
export function promptManifest(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  const chars = text.length;
  if (chars === 0) {
    return { chars: 0, sections: [], largest: null, duplicate: { chars: 0, share: 0, lines: 0 } };
  }

  const heads = [];
  SECTION_RE.lastIndex = 0;
  let m;
  while ((m = SECTION_RE.exec(text)) !== null) heads.push({ start: m.index, name: m[1].trim() });

  const sections = [];
  if (heads.length === 0 || heads[0].start > 0) {
    const end = heads.length > 0 ? heads[0].start : chars;
    if (end > 0) sections.push({ name: '(preamble)', chars: end });
  }
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].start : chars;
    sections.push({ name: heads[i].name, chars: end - heads[i].start });
  }
  for (const s of sections) s.share = Math.round((s.chars / chars) * 1000) / 1000;
  sections.sort((a, b) => b.chars - a.chars);

  return {
    chars,
    sections,
    largest: sections.length > 0 ? sections[0].name : null,
    duplicate: duplicateBytes(text, chars),
  };
}

// Bytes carried by lines that appear more than once. The document being
// rendered both as "the section you pointed at" and as "the full source" shows
// up here as a large share — the signal that a prompt is paying twice for the
// same content.
function duplicateBytes(text, total) {
  const seen = new Map();
  for (const line of text.split('\n')) {
    const key = line.trim();
    if (key.length < DUP_LINE_MIN_CHARS) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let chars = 0;
  let lines = 0;
  for (const [key, count] of seen) {
    if (count < 2) continue;
    lines += count - 1;
    chars += key.length * (count - 1); // every copy after the first is waste
  }
  return { chars, share: Math.round((chars / total) * 1000) / 1000, lines };
}

/**
 * Sent-vs-billed view of an OpenRouter usage envelope. Returns null when the
 * provider reported nothing useful, so callers can omit the field entirely.
 * `promptChars` (optional) adds the chars-per-token ratio.
 */
export function usageManifest(rawUsage, promptChars = null) {
  if (rawUsage === null || typeof rawUsage !== 'object') return null;
  const out = {};
  if (Number.isFinite(rawUsage.prompt_tokens)) out.promptTokens = rawUsage.prompt_tokens;
  if (Number.isFinite(rawUsage.completion_tokens)) out.completionTokens = rawUsage.completion_tokens;

  const details = rawUsage.prompt_tokens_details;
  if (details !== null && typeof details === 'object') {
    if (Number.isFinite(details.cached_tokens)) out.cachedTokens = details.cached_tokens;
    if (Number.isFinite(details.cache_write_tokens)) out.cacheWriteTokens = details.cache_write_tokens;
  }
  // The share of the prompt that was served from cache — the number that says
  // whether a big prompt was actually expensive this turn.
  if (Number.isFinite(out.promptTokens) && out.promptTokens > 0 && Number.isFinite(out.cachedTokens)) {
    out.cachedShare = Math.round((out.cachedTokens / out.promptTokens) * 1000) / 1000;
  }
  if (Number.isFinite(promptChars) && promptChars > 0 && Number.isFinite(out.promptTokens) && out.promptTokens > 0) {
    out.charsPerToken = Math.round((promptChars / out.promptTokens) * 100) / 100;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Flatten a manifest into OTEL span attributes (scalars only — the span
 * encoder takes strings/numbers/booleans, not nested objects). Section sizes
 * ride as one compact "name=chars" list so Phoenix shows composition inline.
 */
export function manifestAttributes(manifest, prefix = 'redline.context') {
  if (manifest === null || typeof manifest !== 'object') return {};
  const attrs = {};
  if (Number.isFinite(manifest.chars)) attrs[`${prefix}.chars`] = manifest.chars;
  if (typeof manifest.largest === 'string') attrs[`${prefix}.largest_section`] = manifest.largest;
  if (Array.isArray(manifest.sections) && manifest.sections.length > 0) {
    attrs[`${prefix}.sections`] = manifest.sections.map((s) => `${s.name}=${s.chars}`).join(', ');
  }
  if (manifest.duplicate && Number.isFinite(manifest.duplicate.chars)) {
    attrs[`${prefix}.duplicate_chars`] = manifest.duplicate.chars;
    attrs[`${prefix}.duplicate_share`] = manifest.duplicate.share;
  }
  return attrs;
}
