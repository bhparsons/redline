// runner/lib/instrument.mjs — idempotent data-rev block-id stamping.
//
// instrumentSource(source) stamps data-rev="r-XXXX" (4 hex chars, collision-
// checked against every id already in the document) onto leaf text blocks by
// RAW-SOURCE surgery — attribute insertions only, computed back-to-front so
// offsets stay valid. It never parses/reserializes the DOM, never alters an
// existing data-rev, and running it twice is a byte-for-byte no-op.
//
// What gets stamped (ported from the old project's instrument.mjs, the
// semantic reference; containers added in WP2):
//   - STAMP_TAGS: the leaf text blocks (p, h1-h6, li, blockquote, pre, td,
//     th, figcaption) plus the CONTAINER_TAGS (section, article, aside,
//     main, header, footer, nav) — multi-level on purpose: a container and
//     the blocks inside it are BOTH stamped, so a comment can anchor to a
//     whole section and the agent can still edit its child blocks
//     individually. Nested ids never collide (one collision-checked mint).
//   - <div>s whose content is inline-tags-only with real text (leaf text
//     divs — common in hand-authored docs, e.g. a pull-quote div).
//   - COMPOSITE <div>s: a div carrying its own visible text AND a block child
//     — a card with a bare title above a <p> (#69). Neither rule above catches
//     it, so that title used to be unanchorable: it belonged to no stamped
//     element. Detected by hasOrphanText(), in a second pass, because "is this
//     text already covered by a stamped descendant" is only answerable once
//     the first pass has decided what gets stamped. Ported from the legacy
//     root instrument.mjs (now on branch archive/legacy-stack).
//     Pure wrapper divs — all text inside stamped children — stay unstamped.
// Tags inside comments/<script>/<style> are never touched (protectedRanges),
// and already-stamped elements are skipped.
//
// mintId(taken) is the ONE id mint for the whole runner: the insert path in
// surgery-driven applies reuses it so server-minted ids for new blocks come
// from the same collision-checked pool.

import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { atomicWriteFile } from './store.mjs';
import {
  protectedRanges, scanTags, checkBalanced, isAsciiOnly, revIds,
  INLINE_TAGS, VOID_TAGS, ensureThemeZone,
} from './surgery.mjs';

// Container elements: stamped as section-level anchors (WP2). The prompt
// builds a section-scoped view when a comment anchors to one of these.
export const CONTAINER_TAGS = new Set([
  'section', 'article', 'aside', 'main', 'header', 'footer', 'nav',
]);

export const STAMP_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li',
  'blockquote', 'pre', 'td', 'th', 'figcaption',
  ...CONTAINER_TAGS,
]);

/** Mint a fresh r-XXXX id (4 hex chars) not present in `taken`; adds it. */
export function mintId(taken) {
  for (;;) {
    const id = 'r-' + crypto.randomBytes(2).toString('hex');
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

// Find the index of the matching close tag for an open tag ending at openEnd.
function matchClose(source, openEnd, tag) {
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])((?:"[^"]*"|'[^']*'|[^>"'])*)>`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1;
  let m;
  while ((m = re.exec(source))) {
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) return m.index;
    } else if (!/\/\s*$/.test(m[2])) {
      depth += 1;
    }
  }
  return -1;
}

// A div qualifies as a leaf text block: inline-tags-only content, real text.
function isLeafTextDiv(source, t) {
  const closeAt = matchClose(source, t.end, 'div');
  if (closeAt === -1) return false;
  const inner = source.slice(t.end, closeAt);
  const innerTags = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/g;
  let m;
  while ((m = innerTags.exec(inner))) {
    const tag = m[1].toLowerCase();
    if (!INLINE_TAGS.has(tag) && !VOID_TAGS.has(tag)) return false;
  }
  return /\S/.test(inner.replace(/<[^>]*>/g, ''));
}

// True if [start, end) holds visible text that sits outside every stamped
// DESCENDANT range — text that would belong to no anchorable element. Only
// ranges strictly inside this element count: an ancestor's range covers this
// text trivially and would hide every composite div in the document.
//
// `protected` is protectedRanges() — comment bodies and script/style contents
// are not anchorable text, so a wrapper holding nothing but a <script> is not
// a composite div. (The legacy implementation missed this and stamped one.)
function hasOrphanText(source, start, end, stampedRanges, protectedR) {
  const localRanges = stampedRanges.filter((r) => r.start >= start && r.end <= end);
  const covered = (k) => localRanges.some((r) => k >= r.start && k < r.end)
    || protectedR.some(([a, b]) => k >= a && k < b);
  let i = start;
  while (i < end) {
    if (source[i] === '<') {
      let j = i + 1;
      while (j < end && source[j] !== '>') j++;
      if (j < end && source[j] === '>') {
        i = j + 1;
        continue;
      }
    }
    let j = i;
    while (j < end && source[j] !== '<') j++;
    if (/\S/.test(source.slice(i, j))) {
      for (let k = i; k < j; k++) {
        if (!/\s/.test(source[k]) && !covered(k)) return true;
      }
    }
    i = j;
  }
  return false;
}

/**
 * Stamp every unstamped leaf text block. Pure — never touches disk.
 * Returns {source, added, total} where total counts ALL data-rev ids in the
 * returned source (pre-existing + newly minted).
 */
export function instrumentSource(source) {
  // Ensure the page-level theme zone exists first (WP6), then stamp against
  // the resulting source so offsets account for any zone we just added.
  const { source: base, created: themeCreated } = ensureThemeZone(source);
  const ranges = protectedRanges(base);
  const taken = new Set(revIds(base));

  const tags = [...scanTags(base, ranges)];

  // Pass 1 — everything the tag rules alone decide, plus the elements already
  // carrying an id. Both contribute a covered range: an ALREADY-stamped child
  // covers its text just as well as one we are about to stamp, so a wrapper
  // around it must not be re-stamped on a second run (this is what keeps the
  // whole thing idempotent).
  const stampedRanges = [];
  const stampable = new Set();
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (t.close || t.selfClose) continue;
    const already = /data-rev\s*=/i.test(t.attrs);
    const should = !already
      && (STAMP_TAGS.has(t.tag) || (t.tag === 'div' && isLeafTextDiv(base, t)));
    if (!already && !should) continue;
    if (should) stampable.add(i);
    const closeAt = matchClose(base, t.end, t.tag);
    if (closeAt !== -1) stampedRanges.push({ start: t.end, end: closeAt });
  }

  // Pass 2 — composite divs (#69): text of their own that no stamped
  // descendant covers. Each one found becomes a covered range itself, so an
  // outer wrapper around an already-rescued card is not stamped again.
  //
  // INNERMOST FIRST, which is why this walks backwards: an open tag nested
  // inside another comes later in the source, so reverse document order tests
  // the card before the deck that holds it. Forwards, a deck of composite
  // cards sees its children's titles as orphaned and stamps the deck too —
  // and "the more granular target always wins" is the settled rule
  // (design/phase4-interaction-model.md).
  for (let i = tags.length - 1; i >= 0; i--) {
    const t = tags[i];
    if (t.close || t.selfClose) continue;
    if (t.tag !== 'div' || stampable.has(i)) continue;
    if (/data-rev\s*=/i.test(t.attrs)) continue;
    const closeAt = matchClose(base, t.end, 'div');
    if (closeAt === -1) continue;
    if (!hasOrphanText(base, t.end, closeAt, stampedRanges, ranges)) continue;
    stampable.add(i);
    stampedRanges.push({ start: t.end, end: closeAt });
  }

  // Mint in document order, so a document's ids read in the order they appear
  // rather than in the order the two passes happened to find them.
  const insertions = []; // {at, text}
  for (const i of [...stampable].sort((a, b) => a - b)) {
    const t = tags[i];
    insertions.push({ at: t.index + 1 + t.tag.length, text: ` data-rev="${mintId(taken)}"` });
  }

  let out = base;
  for (const ins of insertions.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  }
  return { source: out, added: insertions.length, total: taken.size, themeCreated };
}

/**
 * Instrument a file on disk. check:true reports without writing.
 * Returns {added, total, wrote}. Throws when the source fails the balance
 * check before stamping, or (a bug guard) when stamping would break balance
 * or the ASCII invariant. Writes are atomic (tmp + rename).
 */
export async function instrumentFile(filePath, { check = false } = {}) {
  const source = await fs.readFile(filePath, 'utf8');

  const pre = checkBalanced(source);
  if (!pre.ok) {
    throw new Error(`refusing to stamp — source fails balance check: ${pre.error}`);
  }

  const { source: out, added, total, themeCreated } = instrumentSource(source);
  // Nothing to write only when no ids were stamped AND no theme zone was added.
  if ((added === 0 && !themeCreated) || check) return { added, total, themeCreated, wrote: false };

  const post = checkBalanced(out);
  if (!post.ok) throw new Error(`post-stamp balance check failed (bug): ${post.error}`);
  if (isAsciiOnly(source) && !isAsciiOnly(out)) {
    throw new Error('post-stamp ASCII check failed (bug)');
  }

  await atomicWriteFile(filePath, out);
  return { added, total, themeCreated, wrote: true };
}
