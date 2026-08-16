// runner/lib/theme-overrides.mjs — which blocks will IGNORE a theme change (#111).
//
// The theme zone writes one rule: `body { … }`. Those values reach the rest of
// the page only by INHERITANCE, and inheritance applies only where nothing
// else declares the property. Any element matched by a rule that declares the
// same property keeps its own value — this is not a specificity contest that
// ordering can win (that was #95, a different mechanism), so no amount of
// moving the theme zone fixes it.
//
// Live consequence: "change all body text to neon purple" recoloured a page
// except the paragraph the comment was anchored to, because that paragraph was
// `class="meta"` and `.meta` declares its own colour. The agent knew and said
// so in a decision note nobody reads. This module turns that into structured
// data the run record carries, so it can be surfaced instead of buried.
//
// Deliberately NOT a CSS engine: it resolves class and tag selectors, which is
// what authored documents use for text colour, and reports anything it cannot
// resolve as `unresolved` rather than guessing. Pure, stdlib-only, total.

import { THEME_MARKER } from './surgery.mjs';

/** Property names declared by a block of plain CSS declarations. */
function declaredProperties(declarations) {
  const props = new Set();
  for (const decl of declarations.split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    if (/^[a-z-]+$/.test(prop)) props.add(prop);
  }
  return props;
}

/** The page's <style> contents, EXCLUDING the runner's own theme zone. */
function authorStyles(source) {
  const out = [];
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (new RegExp(`\\b${THEME_MARKER}\\b`, 'i').test(m[1])) continue; // ours
    out.push(m[2]);
  }
  return out.join('\n');
}

// Blocks in the source, as {id, tag, classes}. Open tags only — enough to
// resolve tag and class selectors without parsing the document.
function stampedBlocks(source) {
  const blocks = [];
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const attrs = m[2];
    const id = /\bdata-rev\s*=\s*"([^"]*)"/i.exec(attrs);
    if (id === null) continue;
    const cls = /\bclass\s*=\s*"([^"]*)"/i.exec(attrs);
    blocks.push({
      id: id[1],
      tag: m[1].toLowerCase(),
      classes: cls === null ? [] : cls[1].split(/\s+/).filter(Boolean),
    });
  }
  return blocks;
}

/**
 * Which author rules will override a theme that sets `themeProps`.
 *
 * Returns {properties, selectors:[{selector, properties, blockIds, unresolved}],
 *          blockIds, unresolvedSelectors} — or null when nothing overrides.
 * `blockIds` is the de-duplicated set of stamped blocks that keep their own
 * value; `unresolved` marks selectors too complex to resolve (descendant
 * combinators, pseudo-classes), which are reported, never silently dropped.
 */
export function themeOverrides(source, themeCss) {
  if (typeof source !== 'string' || typeof themeCss !== 'string') return null;
  const themeProps = declaredProperties(themeCss);
  if (themeProps.size === 0) return null;

  const css = authorStyles(source);
  if (css === '') return null;
  const blocks = stampedBlocks(source);

  const selectors = [];
  const allBlockIds = new Set();
  let unresolvedCount = 0;

  // Rule-level scan. Comments are stripped first so a commented-out rule
  // cannot be reported as an override.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(css.replace(/\/\*[\s\S]*?\*\//g, ' '))) !== null) {
    const declared = declaredProperties(m[2]);
    const hit = [...themeProps].filter((p) => declared.has(p));
    if (hit.length === 0) continue;

    for (const raw of m[1].split(',')) {
      const selector = raw.trim().replace(/\s+/g, ' ');
      if (selector === '' || selector.startsWith('@')) continue;
      // `body` is what the theme itself targets — not an override.
      if (selector.toLowerCase() === 'body') continue;

      const matched = matchSelector(selector, blocks);
      if (matched === null) {
        unresolvedCount += 1;
        selectors.push({ selector, properties: hit, blockIds: [], unresolved: true });
        continue;
      }
      for (const id of matched) allBlockIds.add(id);
      selectors.push({ selector, properties: hit, blockIds: matched, unresolved: false });
    }
  }

  if (selectors.length === 0) return null;
  return {
    properties: [...themeProps].filter((p) => selectors.some((s) => s.properties.includes(p))),
    selectors,
    blockIds: [...allBlockIds],
    unresolvedSelectors: unresolvedCount,
  };
}

// Ids of blocks matched by a simple selector; null when the selector is beyond
// what we resolve (report, don't guess).
function matchSelector(selector, blocks) {
  const cls = /^\.([\w-]+)$/.exec(selector);
  if (cls !== null) return blocks.filter((b) => b.classes.includes(cls[1])).map((b) => b.id);
  const tag = /^([a-zA-Z][a-zA-Z0-9-]*)$/.exec(selector);
  if (tag !== null) {
    const want = tag[1].toLowerCase();
    return blocks.filter((b) => b.tag === want).map((b) => b.id);
  }
  const tagCls = /^([a-zA-Z][a-zA-Z0-9-]*)\.([\w-]+)$/.exec(selector);
  if (tagCls !== null) {
    const want = tagCls[1].toLowerCase();
    return blocks.filter((b) => b.tag === want && b.classes.includes(tagCls[2])).map((b) => b.id);
  }
  return null;
}

/**
 * One plain-language line for a run summary, or null when nothing overrides.
 * `anchorBlockId` (optional) is called out first — the block the reviewer was
 * looking at is the one whose non-change they will notice.
 */
export function describeThemeOverrides(overrides, anchorBlockId = null) {
  if (overrides === null || overrides.selectors.length === 0) return null;
  const n = overrides.blockIds.length;
  const props = overrides.properties.join(', ');
  const named = overrides.selectors.filter((s) => !s.unresolved).map((s) => s.selector);
  const list = named.slice(0, 6).join(', ') + (named.length > 6 ? `, +${named.length - 6} more` : '');
  const anchored = anchorBlockId !== null && overrides.blockIds.includes(anchorBlockId);
  return `${n} block${n === 1 ? '' : 's'} keep their own ${props}`
    + `${anchored ? ' — including the one this comment is anchored to' : ''}`
    + `${named.length > 0 ? ` (${list})` : ''}`
    + '. A page-level theme only reaches elements that do not set the property themselves.';
}
