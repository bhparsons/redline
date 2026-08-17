// runner/lib/markdown.mjs — Markdown in, reviewable HTML out (#52).
//
// WHY. Markdown cannot be redlined: there is nothing to select in a browser and
// nothing to stamp a block id onto. So a document that only exists as Markdown
// is a document that never gets reviewed — which is exactly what happened to
// this repo's own README while it was the stated gate on publishing.
//
// ONE-WAY BY DECISION (Blake, 2026-08-11). The converted HTML is PROMOTED to
// the reviewed document and the .md retires from the review flow. There is no
// write-back: round-tripping edited HTML into Markdown means guessing which of
// many Markdown spellings the author meant, and guessing wrong rewrites a file
// nobody asked you to touch. **The source .md is never written.**
//
// THE PART THAT MATTERS IS THE IDS. Block ids are normally minted at random,
// which is fine for a hand-written page stamped once. It is wrong here: a
// converted document gets RE-converted every time its source changes, and
// random ids would mint a fresh set each pass, orphaning every comment anchored
// to a paragraph nobody touched. So ids here are DERIVED FROM CONTENT. Convert
// the same text twice and every id is identical; change one paragraph and only
// that paragraph's id moves. Move a paragraph and its id travels with it,
// because position is not part of the hash.
//
// The subset is what real documents here use: ATX headings, fenced code, pipe
// tables, ordered and unordered lists, blockquotes, thematic breaks, and the
// inline set. Anything unrecognised passes through as a paragraph rather than
// being dropped — silently losing the part you cared about is worse than
// rendering it plainly.
//
// Stdlib only, like the rest of runner/.

import crypto from 'node:crypto';

/** HTML-escape. Ampersand first, so `&amp;` in the source survives one pass. */
export function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline spans. Code first — nothing inside a code span is markup. */
export function inline(src) {
  const code = [];
  // NUL as the placeholder delimiter: it cannot occur in a Markdown source
  // read as UTF-8 text, whereas the digits-with-spaces form this replaced could
  // collide with ordinary prose ("section 3 of the plan") and swap a number for
  // a code span.
  let s = src.replace(/`([^`]+)`/g, (_, c) => {
    code.push(`<code>${esc(c)}</code>`);
    return `\u0000${code.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, href) => `<a href="${href}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
  return s;
}

const cell = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/**
 * Markdown → an array of top-level block strings.
 *
 * Blocks rather than one string because each one needs its own id, and finding
 * block boundaries again by re-parsing the HTML would be a second, weaker
 * parser disagreeing with this one.
 */
export function blocks(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flush();
      const body = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { flush(); i += 1; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); i += 1; continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i += 1; continue; }

    // A pipe table needs its delimiter row; without one it is just text.
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flush();
      const head = cell(line.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cell(lines[i].trim())); i += 1; }
      const parts = [`<tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`];
      for (const r of rows) parts.push(`<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      // ONE block, not three lines: a table is a thing you comment on, and an
      // id on a fragment that is not an element cannot be anchored to.
      out.push(`<table>${parts.join('')}</table>`);
      continue;
    }

    const li = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m) {
          if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1] += ` ${lines[i].trim()}`; i += 1; continue; }
          break;
        }
        items.push(m[2]);
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      out.push(`<blockquote>${inline(body.join(' '))}</blockquote>`);
      continue;
    }

    para.push(line.trim());
    i += 1;
  }
  flush();
  return out;
}

/**
 * A block id derived from the block itself.
 *
 * `nth` disambiguates genuinely identical blocks — two `<hr>`s, or the same
 * sentence twice — and is folded into the hash rather than appended, so the
 * result is still four hex characters and still looks like every other id in
 * the system. Two identical blocks therefore get DIFFERENT stable ids, and
 * swapping them swaps their ids: unavoidable, since nothing distinguishes them
 * but order.
 */
export function contentId(block, nth = 0) {
  const seed = nth === 0 ? block : `${block}\u0000${nth}`;
  return `r-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 4)}`;
}

/**
 * Stamp every block with its content-derived id.
 *
 * THE ONE CASE THIS CANNOT HOLD STABLE, stated plainly: two byte-identical
 * blocks are distinguished only by which came first, so deleting or editing the
 * earlier one renumbers the later one and moves its id. Nothing content-derived
 * can avoid that — the blocks are indistinguishable by content, which is the
 * only thing being hashed. It costs the comments on the surviving duplicate.
 *
 * In practice identical top-level blocks are rare outside `<hr>`, which carries
 * no comments worth losing. Every other block — a heading, a paragraph, a table
 * — is stable across re-conversion, which is the case the feature exists for.
 */
export function stamp(blockList) {
  const taken = new Set();
  return blockList.map((b) => {
    let id;
    for (let nth = 0; ; nth++) {
      id = contentId(b, nth);
      if (!taken.has(id)) break;
      if (nth > 10_000) throw new Error('could not derive a unique block id — the document is pathological');
    }
    taken.add(id);
    // <hr> is void: the attribute goes on the only tag it has.
    if (/^<hr\s*\/?>$/i.test(b)) return `<hr data-rev="${id}">`;
    return b.replace(/^<([a-z0-9]+)/i, `<$1 data-rev="${id}"`);
  });
}

const STYLE = `
  body { font: 16px/1.65 -apple-system, "Segoe UI", sans-serif; color: #1a1a1a;
         max-width: 52rem; margin: 3rem auto 6rem; padding: 0 1.5rem; background: #fdfdfc; }
  h1 { font-size: 1.7rem; line-height: 1.25; }
  h2 { font-size: 1.25rem; margin-top: 2.6rem; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
  h3 { font-size: 1.05rem; margin-top: 1.9rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.93rem; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  th { font-weight: 600; background: #f4f4f2; }
  code { background: #f0f0ee; padding: 0.1rem 0.32rem; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f6f6f4; border: 1px solid #e5e5e3; border-radius: 6px; padding: 0.8rem 1rem;
        overflow-x: auto; font-size: 0.86rem; line-height: 1.5; }
  pre code { background: none; padding: 0; font-size: inherit; }
  blockquote { border-left: 3px solid #cbd5e1; margin: 1rem 0; padding: 0.2rem 0 0.2rem 0.9rem; color: #555; }
  hr { border: none; border-top: 1px solid #e5e5e3; margin: 2.2rem 0; }
`;

/** The marker that says this file was generated, and from what. Its presence is
 *  what makes re-conversion safe: without it, converting would be free to
 *  overwrite a hand-written page that merely happens to share a name. */
export const SOURCE_META = 'redline-markdown-source';

export function sourceOf(html) {
  return /<meta\s+name="redline-markdown-source"\s+content="([^"]*)"/i.exec(html)?.[1] ?? null;
}

/**
 * Convert Markdown to a complete, stamped, reviewable HTML document.
 * `sourceName` is recorded so re-conversion can prove it owns the target.
 */
export function convert(md, { sourceName = 'document.md' } = {}) {
  const body = stamp(blocks(md)).join('\n');
  const title = /^#\s+(.*)$/m.exec(md)?.[1] ?? sourceName;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="${SOURCE_META}" content="${esc(sourceName)}">
<title>${esc(title)}</title>
<style>${STYLE}</style>
<style data-rev-theme></style>
</head>
<body>
${body}
</body>
</html>
`;
}
