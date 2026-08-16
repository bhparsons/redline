// runner/lib/surgery.mjs — string-level HTML surgery: the only code allowed
// to COMPUTE a write to a reviewed document (apply.mjs is the only code that
// puts the result on disk).
//
// INVARIANTS — ported from the old project's lib/surgery.mjs; these are law:
//  - Every write is a targeted block-inner string replacement on the RAW page
//    source. NEVER DOM-parse or reserialize a reviewed document: that decodes
//    the doc's entity encoding and reformats hand-authored markup.
//  - Non-ASCII in a replacement inner is entity-encoded before it goes near
//    the source, and a document that was ASCII/entities-only must stay that
//    way (validateWrite re-checks it doc-wide as a backstop).
//  - Tag balance is validated on the changed region (the new inner) AND over
//    the whole document after replacement.
//  - data-rev attributes are never altered, removed, or invented by an edit.
//    A replacement whose inner changes the data-rev marks it contained is
//    invalid (new blocks would mint fresh ids server-side — never agent-side).

const BLOCK_ID_RE = /^[\w-]{1,64}$/;

export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Inline-level tags: used by the instrumenter's leaf-text-div detection and
// nothing else in the write path (the edit allowlist is prompt-side policy).
export const INLINE_TAGS = new Set([
  'span', 'strong', 'em', 'b', 'i', 'a', 'code', 'br', 'sup', 'sub', 'small',
]);

// ---------- entity encoding (reviewed docs may be ASCII/entities-only) ------

const NAMED_ENTITIES = new Map([
  [0x00a0, '&nbsp;'], [0x00b7, '&middot;'], [0x00d7, '&times;'],
  [0x2013, '&ndash;'], [0x2014, '&mdash;'],
  [0x2018, '&lsquo;'], [0x2019, '&rsquo;'], [0x201c, '&ldquo;'], [0x201d, '&rdquo;'],
  [0x2022, '&bull;'], [0x2026, '&hellip;'],
  [0x2190, '&larr;'], [0x2191, '&uarr;'], [0x2192, '&rarr;'], [0x2193, '&darr;'],
]);

/** Encode every non-ASCII character to a named (preferred) or numeric entity. */
export function encodeEntities(str) {
  return str.replace(/[^\x00-\x7F]/gu, (ch) => {
    const cp = ch.codePointAt(0);
    return NAMED_ENTITIES.get(cp) ?? `&#${cp};`;
  });
}

export function isAsciiOnly(str) {
  return /^[\x00-\x7F]*$/.test(str);
}

// ---------- tag scanning + balance ------------------------------------------

/** Ranges covering comments, <script>…</script>, and <style>…</style> — tag
 *  soup inside these is not markup and must not be scanned. */
export function protectedRanges(source) {
  const ranges = [];
  const re = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/gi;
  let m;
  while ((m = re.exec(source))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function inRanges(index, ranges) {
  return ranges.some(([a, b]) => index >= a && index < b);
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/** Iterate real tags (outside protected ranges).
 *  Yields {index, end, raw, tag, close, attrs, selfClose}. */
export function* scanTags(source, ranges = protectedRanges(source)) {
  const re = new RegExp(TAG_RE.source, 'g');
  let m;
  while ((m = re.exec(source))) {
    if (inRanges(m.index, ranges)) continue;
    yield {
      index: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      close: m[1] === '/',
      tag: m[2].toLowerCase(),
      attrs: m[3],
      selfClose: /\/\s*$/.test(m[3]),
    };
  }
}

/** Strict open/close balance check. Returns {ok:true} or {ok:false, error}. */
export function checkBalanced(source) {
  const stack = [];
  for (const t of scanTags(source)) {
    if (VOID_TAGS.has(t.tag) || t.selfClose) continue;
    if (!t.close) {
      stack.push(t);
    } else {
      const top = stack.pop();
      if (!top || top.tag !== t.tag) {
        return {
          ok: false,
          error: `mismatched </${t.tag}> at offset ${t.index}` +
            (top ? ` (expected </${top.tag}> for <${top.tag}> at ${top.index})` : ' (nothing open)'),
        };
      }
    }
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    return { ok: false, error: `unclosed <${top.tag}> at offset ${top.index}` };
  }
  return { ok: true };
}

// ---------- block location (Session 4's locateBlock, unchanged) --------------

// Locate the block carrying data-rev="<blockId>" in `source`.
// Returns { tag, innerStart, innerEnd, inner, outerStart, outerEnd } (outer
// bounds cover the whole element, open tag through close tag — the insert
// path splices new siblings at those offsets) or null when the id is
// missing, ambiguous (appears more than once), self-closing, or the block's
// closing tag cannot be found.
export function locateBlock(source, blockId) {
  if (typeof source !== 'string' || typeof blockId !== 'string' || !BLOCK_ID_RE.test(blockId)) {
    return null;
  }
  const needle = `data-rev="${blockId}"`;
  const attrIdx = source.indexOf(needle);
  if (attrIdx === -1) return null;
  if (source.indexOf(needle, attrIdx + needle.length) !== -1) return null; // duplicate id — refuse

  const tagStart = source.lastIndexOf('<', attrIdx);
  if (tagStart === -1) return null;
  const open = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(source.slice(tagStart, attrIdx));
  if (!open) return null;
  const tag = open[1];

  const openEnd = source.indexOf('>', attrIdx + needle.length);
  if (openEnd === -1) return null;
  if (source[openEnd - 1] === '/') return null; // self-closing: no inner HTML to replace

  // Walk forward counting same-tag nesting until the matching close tag.
  const walker = new RegExp(`<${tag}(?=[\\s/>])|</${tag}\\s*>`, 'gi');
  walker.lastIndex = openEnd + 1;
  let depth = 1;
  let m;
  while ((m = walker.exec(source)) !== null) {
    if (m[0][1] === '/') {
      depth -= 1;
      if (depth === 0) {
        return {
          tag,
          innerStart: openEnd + 1,
          innerEnd: m.index,
          inner: source.slice(openEnd + 1, m.index),
          outerStart: tagStart,
          outerEnd: m.index + m[0].length,
        };
      }
    } else {
      depth += 1;
    }
  }
  return null;
}

// ---------- data-rev preservation ---------------------------------------------

/** The double-quoted data-rev ids in a fragment, in source order. */
export function revIds(html) {
  const ids = [];
  const re = /data-rev\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) ids.push(m[1]);
  return ids;
}

// Count EVERY appearance of "data-rev" (any casing, any quoting) so an edit
// can't smuggle marks past the id comparison via single quotes or unquoted
// attribute syntax. Conservative on purpose: this is a reject-only check.
function revMarkCount(html) {
  return (html.match(/data-rev/gi) ?? []).length;
}

// The fragment's TAG spans, concatenated — or null when we cannot trust the
// scan (see below). A data-rev mark can only ever be an attribute, and an
// attribute can only ever live between a tag's angle brackets, so tags are the
// only place a real mark can hide. Text content is not markup: prose that
// merely MENTIONS data-rev (documentation about this very system, an ASCII
// diagram labelling "data-rev anchored blocks") is not a mark, and rejecting it
// was a false positive that failed real edits (#99).
//
// Quote-aware on purpose: a naive /<[^>]*>/ scan would end the span at a '>'
// sitting inside a quoted attribute value, pushing a following real data-rev
// attribute OUTSIDE the scanned region — exactly the smuggling this guard
// exists to stop. Quoted chunks are consumed whole instead.
//
// When any '<' in the fragment does not open a parseable tag span, the scan is
// untrustworthy, so we return null and every caller falls back to counting the
// whole string — the strict pre-#99 behavior. Reject-only posture preserved:
// anything ambiguous still fails.
function tagsOnly(html) {
  const spans = html.match(/<(?:"[^"]*"|'[^']*'|[^>"'])*>/g) ?? [];
  const angles = (html.match(/</g) ?? []).length;
  if (spans.length !== angles) return null;
  return spans.join('');
}

/** data-rev marks carried by a fragment's TAGS (text content is not a mark). */
function revMarksInTags(html) {
  const tags = tagsOnly(html);
  return revMarkCount(tags ?? html);
}

/** True when two fragments carry exactly the same data-rev marks. */
export function sameRevMarks(before, after) {
  const b = tagsOnly(before) ?? before;
  const a = tagsOnly(after) ?? after;
  return revMarkCount(b) === revMarkCount(a)
    && JSON.stringify(revIds(b)) === JSON.stringify(revIds(a));
}

// ---------- replacement + validation -------------------------------------------

/**
 * Replace a block's inner HTML in the raw source. Entity-encodes the new
 * inner, refuses any change to the data-rev marks inside the block, and
 * validates tag balance on the changed region. Pure — never touches disk.
 *
 * Returns {ok:true, source, beforeInner, afterInner}
 *      or {ok:false, code:'unknown-block'|'data-rev-tampered'|'unbalanced', error}.
 */
export function replaceBlockInner(source, blockId, newInner) {
  const block = locateBlock(source, blockId);
  if (block === null) {
    return { ok: false, code: 'unknown-block', error: 'block not found in the page source (missing, duplicate, or malformed id)' };
  }
  const afterInner = encodeEntities(String(newInner));
  if (!sameRevMarks(block.inner, afterInner)) {
    return { ok: false, code: 'data-rev-tampered', error: 'replacement alters the data-rev marks inside the block (never allowed)' };
  }
  const balance = checkBalanced(afterInner);
  if (!balance.ok) {
    return { ok: false, code: 'unbalanced', error: `replacement inner HTML: ${balance.error}` };
  }
  return {
    ok: true,
    source: source.slice(0, block.innerStart) + afterInner + source.slice(block.innerEnd),
    beforeInner: block.inner,
    afterInner,
  };
}

// ---------- block attribute edits (WP4) -------------------------------------

// Curated inline style property allowlist (frontload decision 4). Properties
// outside it are FLAGGED for confirmation, not hard-blocked.
export const STYLE_PROP_ALLOWLIST = new Set([
  'text-align', 'font-weight', 'font-style', 'color', 'background-color',
  'text-decoration', 'padding', 'margin', 'border',
]);

// Curated utility class allowlist. Classes outside it are FLAGGED; the rv-/rvb-
// namespaces are HARD-BLOCKED (they collide with the overlay's own styles).
export const CLASS_ALLOWLIST = new Set(['text-center', 'lead', 'muted', 'highlight']);

// Characters that can't ride safely inside a double-quoted attribute value or
// would perturb tag scanning.
const UNSAFE_ATTR_CHARS = /["<>]/;

// Property names in an inline style string, lowercased, in order.
function styleProps(style) {
  return style.split(';').map((decl) => {
    const i = decl.indexOf(':');
    return (i === -1 ? decl : decl.slice(0, i)).trim().toLowerCase();
  }).filter(Boolean);
}

// Set (value non-empty) or remove (value empty) one attribute on an open-tag
// string, preserving every other attribute (data-rev included). A specific
// leading-whitespace match means data-<name> can't be hit by mistake.
function setOpenTagAttr(openTag, name, value) {
  const re = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, 'i');
  if (value === '') return openTag.replace(re, '');
  // A REPLACER FUNCTION, not a replacement string (#289). String.replace gives
  // `$&`, `` $` ``, `$'`, `$1` and `$$` special meaning INSIDE the replacement,
  // and they expand AFTER UNSAFE_ATTR_CHARS has already inspected the value and
  // found it clean. Confirmed before the fix:
  //
  //   editBlockAttributes('<p data-rev="r-01" class="x">hi</p>', 'r-01',
  //                       { class: 'a$&b' })
  //     -> <p data-rev="r-01" class="a class="x"b">hi</p>
  //     and validateWrite() said { ok: true }.
  //
  // An unbalanced quote written into a document, past the guard built to stop
  // exactly that. Both validators are quote-aware, so they agreed with each
  // other while disagreeing with the browser — agreeing validators are not
  // independent checks. A function replacement has no `$` syntax at all, so
  // the value can only ever be written literally.
  const literal = () => ` ${name}="${value}"`;
  if (re.test(openTag)) return openTag.replace(re, literal);
  // Absent: append just before the closing '>' (after data-rev and friends).
  return openTag.replace(/>$/, () => ` ${name}="${value}">`);
}

/**
 * Edit a block's own class/style attributes WITHOUT replacing its inner HTML.
 * `attrs` may carry `class` and/or `style` (strings); no other key is allowed.
 * data-rev is never touched. Values are entity-encoded and validated; the
 * curated allowlists gate class/style — out-of-list items FLAG for
 * confirmation (returned in `flagged`) rather than failing the write, while
 * the rv-/rvb- class namespaces and unsafe characters HARD-FAIL. Pure.
 *
 * Returns {ok:true, source, beforeOpenTag, afterOpenTag, flagged:[{kind,name}]}
 *      or {ok:false, code:'unknown-block'|'forbidden-attribute'|'forbidden-class'
 *                        |'invalid-attribute'|'data-rev-tampered'|'unbalanced', error}.
 */
export function editBlockAttributes(source, blockId, attrs) {
  const block = locateBlock(source, blockId);
  if (block === null) {
    return { ok: false, code: 'unknown-block', error: 'block not found in the page source (missing, duplicate, or malformed id)' };
  }
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    return { ok: false, code: 'invalid-attribute', error: 'attribute edit must be an object with class and/or style' };
  }
  const keys = Object.keys(attrs);
  const disallowedKey = keys.find((k) => k !== 'class' && k !== 'style');
  if (disallowedKey !== undefined) {
    return { ok: false, code: 'forbidden-attribute', error: `attribute "${disallowedKey}" may not be set (only class and style are editable)` };
  }
  if (keys.length === 0) {
    return { ok: false, code: 'invalid-attribute', error: 'attribute edit names neither class nor style' };
  }

  const flagged = [];
  let openTag = source.slice(block.outerStart, block.innerStart); // `<tag …>`

  if (attrs.style !== undefined) {
    if (typeof attrs.style !== 'string') {
      return { ok: false, code: 'invalid-attribute', error: 'style must be a string' };
    }
    const style = encodeEntities(attrs.style).trim().replace(/;\s*$/, '');
    if (UNSAFE_ATTR_CHARS.test(style)) {
      return { ok: false, code: 'invalid-attribute', error: 'style value contains an unsafe character (", <, or >)' };
    }
    for (const prop of styleProps(style)) {
      if (!STYLE_PROP_ALLOWLIST.has(prop)) flagged.push({ kind: 'style', name: prop });
    }
    openTag = setOpenTagAttr(openTag, 'style', style);
  }

  if (attrs.class !== undefined) {
    if (typeof attrs.class !== 'string') {
      return { ok: false, code: 'invalid-attribute', error: 'class must be a string' };
    }
    const cls = encodeEntities(attrs.class).trim().replace(/\s+/g, ' ');
    if (UNSAFE_ATTR_CHARS.test(cls)) {
      return { ok: false, code: 'invalid-attribute', error: 'class value contains an unsafe character (", <, or >)' };
    }
    for (const token of cls.split(' ').filter(Boolean)) {
      if (/^rvb?-/.test(token)) {
        return { ok: false, code: 'forbidden-class', error: `class "${token}" is in a reserved namespace (rv-/rvb-)` };
      }
      if (!CLASS_ALLOWLIST.has(token)) flagged.push({ kind: 'class', name: token });
    }
    openTag = setOpenTagAttr(openTag, 'class', cls);
  }

  // data-rev must survive untouched, and the rebuilt tag must still be one
  // well-formed open tag (belt-and-braces against a value that slipped a
  // structural character past the char guard).
  const beforeOpenTag = source.slice(block.outerStart, block.innerStart);
  if (!sameRevMarks(beforeOpenTag, openTag)) {
    return { ok: false, code: 'data-rev-tampered', error: 'attribute edit altered the block\'s data-rev mark (never allowed)' };
  }
  if (!/^<[a-zA-Z][a-zA-Z0-9-]*(?:"[^"]*"|'[^']*'|[^>"'])*>$/.test(openTag)) {
    return { ok: false, code: 'unbalanced', error: 'attribute edit produced a malformed open tag' };
  }

  return {
    ok: true,
    source: source.slice(0, block.outerStart) + openTag + source.slice(block.innerStart),
    beforeOpenTag,
    afterOpenTag: openTag,
    flagged,
  };
}

// ---------- page-level theme zone (WP6) -------------------------------------

// The one editable page-level style surface: <style data-rev-theme>…</style>.
// Its inner is a single `body { … }` rule the runner writes; the agent only
// ever supplies plain declarations, so arbitrary selectors are impossible by
// construction.
export const THEME_MARKER = 'data-rev-theme';
export const THEME_PROP_ALLOWLIST = new Set([
  'font-family', 'font-size', 'line-height', 'color', 'background-color',
]);

/** Locate the theme zone. Returns {innerStart, innerEnd, inner, outerStart,
 *  outerEnd} or null when the page has none. */
export function locateThemeZone(source) {
  const openRe = new RegExp(`<style\\b[^>]*\\b${THEME_MARKER}\\b[^>]*>`, 'i');
  const open = openRe.exec(source);
  if (!open) return null;
  const innerStart = open.index + open[0].length;
  const closeRe = /<\/style\s*>/ig;
  closeRe.lastIndex = innerStart;
  const close = closeRe.exec(source);
  if (!close) return null;
  return {
    innerStart,
    innerEnd: close.index,
    inner: source.slice(innerStart, close.index),
    outerStart: open.index,
    outerEnd: close.index + close[0].length,
  };
}

/** Ensure a theme zone exists, creating an empty one at the END of <head>
 *  (else the top of <body>, else the document start) when absent. Returns
 *  {source, created}. Idempotent. Pure. */
export function ensureThemeZone(source) {
  if (locateThemeZone(source) !== null) return { source, created: false };
  const zone = `<style ${THEME_MARKER}></style>\n`;
  // Before </head>, not after <head>: the zone must follow the doc's own
  // <style> so equal-specificity theme rules win the cascade (#95).
  const headClose = /<\/head\s*>/i.exec(source);
  if (headClose) {
    const at = headClose.index;
    return { source: `${source.slice(0, at)}${zone}${source.slice(at)}`, created: true };
  }
  const anchor = /<head\b[^>]*>/i.exec(source) ?? /<body\b[^>]*>/i.exec(source);
  if (anchor) {
    const at = anchor.index + anchor[0].length;
    return { source: `${source.slice(0, at)}\n${zone}${source.slice(at)}`, created: true };
  }
  return { source: zone + source, created: true };
}

/**
 * Replace the theme zone's inner CSS with a single `body { … }` rule built
 * from the agent's plain declarations. Creates the zone first when absent.
 * Rejects selectors / `{}` / at-rules / `!important` / non-ASCII / unsafe
 * characters; out-of-allowlist properties still apply but FLAG for
 * confirmation. Pure — never touches disk.
 *
 * Returns {ok:true, source, beforeInner, afterInner, flagged:[{kind,name}], created}
 *      or {ok:false, code:'invalid-theme'|'unbalanced', error}.
 */
export function editThemeZone(source, css) {
  if (typeof css !== 'string') {
    return { ok: false, code: 'invalid-theme', error: 'theme must be a string of CSS declarations' };
  }
  const decls = css.trim().replace(/;\s*$/, '');
  if (!isAsciiOnly(decls)) {
    return { ok: false, code: 'invalid-theme', error: 'theme CSS must be ASCII (use CSS escapes, not literal non-ASCII)' };
  }
  if (/[{}<>]/.test(decls)) {
    return { ok: false, code: 'invalid-theme', error: 'theme CSS must be plain declarations — no selectors, braces, or markup' };
  }
  if (/@\w/.test(decls)) {
    return { ok: false, code: 'invalid-theme', error: 'at-rules (@media, @keyframes, …) are not allowed in the theme zone' };
  }
  if (/!\s*important/i.test(decls)) {
    return { ok: false, code: 'invalid-theme', error: '!important is not allowed in the theme zone' };
  }

  const flagged = [];
  for (const decl of decls.split(';')) {
    const trimmed = decl.trim();
    if (trimmed === '') continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      return { ok: false, code: 'invalid-theme', error: `theme declaration "${trimmed}" is not "property: value"` };
    }
    const prop = trimmed.slice(0, colon).trim().toLowerCase();
    if (!/^[a-z-]+$/.test(prop)) {
      return { ok: false, code: 'invalid-theme', error: `invalid theme property name "${prop}"` };
    }
    if (trimmed.slice(colon + 1).trim() === '') {
      return { ok: false, code: 'invalid-theme', error: `theme property "${prop}" has no value` };
    }
    if (!THEME_PROP_ALLOWLIST.has(prop)) flagged.push({ kind: 'theme', name: prop });
  }

  const { source: withZone, created } = ensureThemeZone(source);
  const zone = locateThemeZone(withZone);
  const afterInner = decls === '' ? '' : `\n  body { ${decls}; }\n`;
  return {
    ok: true,
    source: withZone.slice(0, zone.innerStart) + afterInner + withZone.slice(zone.innerEnd),
    beforeInner: zone.inner,
    afterInner,
    flagged,
    created,
  };
}

// ---------- sibling insertion -----------------------------------------------

/**
 * Insert a NEW sibling block next to an existing data-rev block. The agent
 * supplies the markup WITHOUT any data-rev; the caller supplies newBlockId,
 * minted server-side (lib/instrument.mjs mintId — never agent-invented).
 * Same validation pipeline as replaceBlockInner: entity-encode, refuse any
 * data-rev mark in the fragment (the tamper guard, adapted: the ONLY
 * data-rev the inserted markup may carry is the one this function stamps),
 * tag balance, plus a single-root requirement so the minted id lands on
 * exactly one new block element. A void element (<hr>, <img>, <br>) is a
 * valid single root too (WP5): it carries the minted id on itself and has no
 * inner (afterInner is ''). Pure — never touches disk.
 *
 * Returns {ok:true, source, blockId, afterInner}
 *      or {ok:false, code:'unknown-block'|'data-rev-tampered'|'unbalanced'
 *                        |'invalid-insert', error}.
 */
export function insertSiblingBlock(source, { anchorBlockId, position, html, newBlockId }) {
  const anchor = locateBlock(source, anchorBlockId);
  if (anchor === null) {
    return { ok: false, code: 'unknown-block', error: 'insert anchor block not found in the page source (missing, duplicate, or malformed id)' };
  }
  if (position !== 'after' && position !== 'before') {
    return { ok: false, code: 'invalid-insert', error: 'insert position must be "after" or "before"' };
  }
  if (typeof newBlockId !== 'string' || !BLOCK_ID_RE.test(newBlockId)
    || source.includes(`data-rev="${newBlockId}"`)) {
    return { ok: false, code: 'invalid-insert', error: 'minted block id is invalid or already taken (bug upstream — ids come from mintId)' };
  }

  const encoded = encodeEntities(String(html)).trim();
  if (revMarksInTags(encoded) !== 0) {
    return { ok: false, code: 'data-rev-tampered', error: 'inserted markup must not carry data-rev marks — new ids are minted server-side' };
  }
  const balance = checkBalanced(encoded);
  if (!balance.ok) {
    return { ok: false, code: 'unbalanced', error: `inserted markup: ${balance.error}` };
  }

  // Single-root: the fragment must BE one element — open tag at the very
  // start, then either its matching close at the very end (non-void) or
  // nothing at all (void) — so the minted id has an unambiguous home.
  const open = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(encoded);
  if (!open) {
    return { ok: false, code: 'invalid-insert', error: 'inserted markup must be a single element (its own open tag at the start)' };
  }
  const rootTag = open[1];
  const stampAt = 1 + rootTag.length;
  let afterInner;

  if (VOID_TAGS.has(rootTag.toLowerCase())) {
    // A void element IS the whole fragment — nothing may follow its tag.
    if (open[0].length !== encoded.length) {
      return { ok: false, code: 'invalid-insert', error: 'a void element insert must be a single tag — nothing may follow it' };
    }
    if (rootTag.toLowerCase() === 'img' && !/\bsrc\s*=/i.test(open[2])) {
      return { ok: false, code: 'invalid-insert', error: 'an <img> insert requires a src attribute' };
    }
    afterInner = ''; // void: no inner content
  } else {
    if (/\/\s*$/.test(open[2])) {
      return { ok: false, code: 'invalid-insert', error: 'a self-closing non-void element is not a valid insert' };
    }
    const walker = new RegExp(`<${rootTag}(?=[\\s/>])|</${rootTag}\\s*>`, 'gi');
    walker.lastIndex = open[0].length;
    let depth = 1;
    let closeMatch = null;
    let m;
    while ((m = walker.exec(encoded)) !== null) {
      if (m[0][1] === '/') {
        depth -= 1;
        if (depth === 0) { closeMatch = m; break; }
      } else {
        depth += 1;
      }
    }
    if (closeMatch === null || closeMatch.index + closeMatch[0].length !== encoded.length) {
      return { ok: false, code: 'invalid-insert', error: 'inserted markup must be a single element — nothing before its open tag or after its close tag' };
    }
    afterInner = encoded.slice(open[0].length, closeMatch.index); // stamping shifts both bounds equally
  }

  const stamped = encoded.slice(0, stampAt) + ` data-rev="${newBlockId}"` + encoded.slice(stampAt);

  const at = position === 'after' ? anchor.outerEnd : anchor.outerStart;
  const fragment = position === 'after' ? `\n${stamped}` : `${stamped}\n`;
  return {
    ok: true,
    source: source.slice(0, at) + fragment + source.slice(at),
    blockId: newBlockId,
    afterInner,
  };
}

// ---------- quote → block rescue ---------------------------------------------

// Entity decoding for the quote-rescue text index ONLY — reading, never
// writing (writes stay encode-only). Named coverage: the encoder's table
// reversed, the XML five, nbsp, and the common Latin-1 accents; anything
// unknown stays literal, which at worst means "no match" and the safe
// quote-only fallback.
const DECODE_NAMED = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ['nbsp', ' '],
  ['aacute', 'á'], ['agrave', 'à'], ['acirc', 'â'], ['auml', 'ä'],
  ['eacute', 'é'], ['egrave', 'è'], ['ecirc', 'ê'], ['euml', 'ë'],
  ['iacute', 'í'], ['oacute', 'ó'], ['ocirc', 'ô'], ['ouml', 'ö'],
  ['uacute', 'ú'], ['uuml', 'ü'], ['ccedil', 'ç'], ['ntilde', 'ñ'],
]);
for (const [cp, entity] of NAMED_ENTITIES) {
  DECODE_NAMED.set(entity.slice(1, -1), String.fromCodePoint(cp));
}

// Decoded text content of the source (tags skipped, entities decoded,
// comments/script/style excluded) plus a per-character map back to source
// offsets — how a browser-side quote (textContent) is matched against the
// raw on-disk markup.
function sourceTextMap(source) {
  const ranges = protectedRanges(source);
  const tagAt = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:"[^"]*"|'[^']*'|[^>"'])*>/y;
  const entityAt = /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/y;
  let text = '';
  const offsets = [];
  let i = 0;
  outer: while (i < source.length) {
    for (const [a, b] of ranges) {
      if (i >= a && i < b) { i = b; continue outer; }
    }
    const ch = source[i];
    if (ch === '<') {
      tagAt.lastIndex = i;
      const m = tagAt.exec(source);
      if (m) { i += m[0].length; continue; }
    } else if (ch === '&') {
      entityAt.lastIndex = i;
      const m = entityAt.exec(source);
      if (m) {
        let decoded = null;
        if (m[1][0] === '#') {
          const cp = m[1][1] === 'x' || m[1][1] === 'X'
            ? parseInt(m[1].slice(2), 16) : parseInt(m[1].slice(1), 10);
          if (Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff) decoded = String.fromCodePoint(cp);
        } else {
          decoded = DECODE_NAMED.get(m[1]) ?? null;
        }
        if (decoded !== null) {
          // One offsets entry per UTF-16 unit (NOT per code point): text is
          // indexed in units, and an astral entity (&#128512;) decodes to a
          // surrogate pair — pushing once would desync every offset after it.
          text += decoded;
          for (let k = 0; k < decoded.length; k += 1) offsets.push(i);
          i += m[0].length;
          continue;
        }
      }
    }
    text += ch;
    offsets.push(i);
    i += 1;
  }
  return { text, offsets };
}

/** The decoded, tag-transparent text of a markup fragment — the same view
 *  findQuoteBlock matches a browser quote against, without the offset map.
 *
 *  DISPLAY ONLY. The result is decoded, so it is not ASCII-safe and must never
 *  be written back to a document; encodeEntities it first if it ever is. It
 *  shares sourceTextMap so what a reviewer is shown can never drift from what
 *  the matcher sees. */
export function plainText(source) {
  return sourceTextMap(source).text;
}

/**
 * Find the data-rev block that contains a reviewer's quote. The quote came
 * from browser textContent (decoded, tag-transparent), so the raw source is
 * indexed the same way before searching. Returns the innermost enclosing
 * block's id ONLY when the quote occurs exactly once in the document text;
 * missing or ambiguous quotes return null (callers fall back to quote-only
 * anchoring — a wrong rescue is worse than none).
 */
export function findQuoteBlock(source, quote) {
  if (typeof source !== 'string' || typeof quote !== 'string' || quote.length === 0) return null;
  const { text, offsets } = sourceTextMap(source);
  const at = text.indexOf(quote);
  if (at === -1) return null;
  if (text.indexOf(quote, at + 1) !== -1) return null; // ambiguous — refuse
  const startOff = offsets[at];
  const endOff = offsets[at + quote.length - 1];

  let best = null;
  for (const id of new Set(revIds(source))) {
    const block = locateBlock(source, id); // null for duplicate/malformed ids
    if (!block) continue;
    if (block.innerStart <= startOff && endOff < block.innerEnd) {
      const span = block.innerEnd - block.innerStart;
      if (best === null || span < best.span) best = { id, span };
    }
  }
  return best === null ? null : best.id;
}

/**
 * Validate an edited document against its pre-edit state before it may touch
 * disk: tags must balance doc-wide, and the ASCII/entities-only invariant
 * must not regress (our write paths always entity-encode, so any regression
 * here is a bug upstream — this is the backstop).
 *
 * Returns {ok:true} or {ok:false, code:'unbalanced'|'ascii-regression', error}.
 */
export function validateWrite(before, after) {
  const balance = checkBalanced(after);
  if (!balance.ok) return { ok: false, code: 'unbalanced', error: `tag balance: ${balance.error}` };
  if (isAsciiOnly(before) && !isAsciiOnly(after)) {
    return { ok: false, code: 'ascii-regression', error: 'ASCII invariant regressed: edit introduced literal non-ASCII characters' };
  }
  return { ok: true };
}
