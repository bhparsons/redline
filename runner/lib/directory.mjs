// runner/lib/directory.mjs — the served-directory index (issue #129).
//
// Two surfaces over one listing:
//   listDirectory()  — the data, also exposed as GET /api/dir (api.mjs) so a
//                      future file-nav panel (#67) has a source that cannot
//                      drift from what the index page shows.
//   renderIndex()    — a self-contained HTML page the file server returns for
//                      a directory that has no index.html, instead of the
//                      {"error":"not found"} 404 that used to land there.
//
// The pre-rebuild stack solved this with a Finder-style miller-column browser
// (browser.js + browser.css on archive/legacy-stack) fed by GET /api/dir. The
// listing contract is ported from it; the client is not. This page ships ZERO
// JavaScript and no external assets: navigation is ordinary links to real
// directory URLs rather than hash routing, which removes the static-asset
// route, the boot-failure fallback, and every innerHTML sink the legacy
// browser had to defend by hand. Classes stay in the rvb- namespace — this is
// its own page, never injected into a reviewed document, and must not collide
// with the overlay's rv-.
//
// Guards, all inherited rather than reimplemented: paths go through
// resolvePath() (no dot segments, no escaping root), dotfiles are skipped, and
// redline.config.json is excluded because it can carry the OpenRouter API key.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolvePath } from './paths.mjs';
import { CONFIG_FILENAME } from './config.mjs';
import * as store from './store.mjs';

// A comment nobody has actioned yet. Missing status counts as open: that is
// what createComment writes and what an older sidecar may lack.
function isOpen(comment) {
  const status = comment?.status;
  return status === undefined || status === null || status === 'open';
}

// Normalize a client-supplied directory path to a root-relative POSIX string.
// Returns null for anything rejected.
//
// The dot-segment check runs on the caller's own string BEFORE resolvePath,
// because resolvePath parses through a URL and a URL silently normalizes "..":
// "docs/../../etc" would arrive there as "/etc" and list a real sibling
// directory under root. That is not an escape, but answering a traversal
// attempt with a different directory's contents is worse than refusing it.
function normalizeRel(root, rel) {
  const trimmed = String(rel ?? '').replace(/^\/+|\/+$/g, '');
  if (trimmed.split('/').some((segment) => segment.startsWith('.'))) return null;
  const abs = resolvePath(root, '/' + trimmed);
  if (abs === null) return null;
  return {
    abs,
    rel: abs === root ? '' : path.relative(root, abs).split(path.sep).join('/'),
  };
}

// Review state for one .html entry. Cheap by design — one existence check and,
// only when a sidecar is actually there, one read.
async function pageInfo(htmlPath) {
  const info = { instrumented: false, sidecar: false, comments: 0, openComments: 0 };
  try {
    info.instrumented = /\bdata-rev=/.test(await fs.readFile(htmlPath, 'utf8'));
  } catch {
    // Unreadable document: the entry still lists, just without enrichment.
  }
  try {
    await fs.stat(store.sidecarPath(htmlPath));
  } catch {
    return info; // no sidecar — never reviewed
  }
  info.sidecar = true;
  try {
    const data = await store.load(htmlPath);
    info.comments = data.comments.length;
    info.openComments = data.comments.filter(isOpen).length;
  } catch {
    // Corrupt sidecar: counts stay 0 rather than failing the whole listing.
  }
  return info;
}

// One directory level under root. Throws with .code EBADDIRPATH (traversal,
// dotfile, or otherwise rejected) or ENOTDIRECTORY (missing, or a file).
// Dirs first, then case-insensitive alpha — Finder order, ported from legacy.
export async function listDirectory(root, rel = '') {
  const resolved = normalizeRel(root, rel);
  if (resolved === null) {
    const err = new Error('bad path');
    err.code = 'EBADDIRPATH';
    throw err;
  }
  let stat;
  try {
    stat = await fs.stat(resolved.abs);
  } catch {
    const err = new Error('not a directory');
    err.code = 'ENOTDIRECTORY';
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error('not a directory');
    err.code = 'ENOTDIRECTORY';
    throw err;
  }

  const entries = [];
  for (const dirent of await fs.readdir(resolved.abs, { withFileTypes: true })) {
    if (dirent.name.startsWith('.')) continue;          // never servable anyway
    if (dirent.name === CONFIG_FILENAME) continue;      // may hold the API key
    const abs = path.join(resolved.abs, dirent.name);
    let entryStat;
    try {
      entryStat = await fs.stat(abs); // stat, not dirent: follows symlinks
    } catch {
      continue; // broken symlink, or vanished mid-listing
    }
    const isDir = entryStat.isDirectory();
    const entry = {
      name: dirent.name,
      type: isDir ? 'dir' : 'file',
      size: isDir ? null : entryStat.size,
      mtime: entryStat.mtime.toISOString(),
      ext: isDir ? null : path.extname(dirent.name).slice(1).toLowerCase(),
    };
    if (!isDir && dirent.name.toLowerCase().endsWith('.html')) {
      entry.page = await pageInfo(abs);
    }
    entries.push(entry);
  }
  entries.sort((a, b) => (a.type === b.type
    ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    : a.type === 'dir' ? -1 : 1));

  return { path: resolved.rel, entries };
}

// ---- HTML rendering ---------------------------------------------------------

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Absolute URL for a listing entry. Every segment is encoded, so a name with a
// space, '#', or '?' in it still resolves to the file it names.
function hrefFor(rel, name, isDir) {
  const segments = (rel ? rel.split('/') : []).concat(name).map(encodeURIComponent);
  return '/' + segments.join('/') + (isDir ? '/' : '');
}

function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const STYLES = `
:root { color-scheme: light dark; --rvb-fg:#1c1c1e; --rvb-dim:#6b6b70; --rvb-bg:#f6f6f7;
  --rvb-card:#fff; --rvb-line:#e3e3e6; --rvb-accent:#0b64d0; --rvb-badge:#d0341c; }
@media (prefers-color-scheme: dark) { :root { --rvb-fg:#ececf0; --rvb-dim:#9a9aa2;
  --rvb-bg:#161618; --rvb-card:#202024; --rvb-line:#33333a; --rvb-accent:#6aa8ff;
  --rvb-badge:#ff6b52; } }
.rvb-body { margin:0; padding:2rem 1.25rem 4rem; background:var(--rvb-bg); color:var(--rvb-fg);
  font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
.rvb-shell { max-width:52rem; margin:0 auto; }
.rvb-logo { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--rvb-dim); }
.rvb-crumbs { margin:.35rem 0 1.25rem; font-size:1.35rem; font-weight:600; }
.rvb-crumbs a { color:var(--rvb-accent); text-decoration:none; }
.rvb-crumbs a:hover { text-decoration:underline; }
.rvb-sep { color:var(--rvb-dim); font-weight:400; margin:0 .3rem; }
.rvb-list { list-style:none; margin:0; padding:0; background:var(--rvb-card);
  border:1px solid var(--rvb-line); border-radius:10px; overflow:hidden; }
.rvb-item { display:flex; align-items:baseline; gap:.6rem; padding:.55rem .9rem;
  border-top:1px solid var(--rvb-line); }
.rvb-item:first-child { border-top:0; }
.rvb-glyph { width:1.1rem; flex:none; color:var(--rvb-dim); text-align:center; }
.rvb-name { color:var(--rvb-accent); text-decoration:none; font-weight:500;
  overflow-wrap:anywhere; }
.rvb-name:hover { text-decoration:underline; }
.rvb-dir .rvb-name { color:var(--rvb-fg); }
.rvb-meta { margin-left:auto; flex:none; color:var(--rvb-dim); font-size:12px;
  font-variant-numeric:tabular-nums; }
.rvb-tag { flex:none; font-size:11px; color:var(--rvb-dim); border:1px solid var(--rvb-line);
  border-radius:99px; padding:.05rem .45rem; }
.rvb-tag-open { color:var(--rvb-badge); border-color:currentColor; }
.rvb-muted .rvb-name { color:var(--rvb-dim); font-weight:400; }
.rvb-empty { padding:1.5rem .9rem; color:var(--rvb-dim); }
.rvb-note { margin:1rem 0 0; color:var(--rvb-dim); font-size:12px; }
`;

function renderEntry(rel, entry) {
  const isDir = entry.type === 'dir';
  const href = hrefFor(rel, entry.name, isDir);
  const classes = ['rvb-item'];
  if (isDir) classes.push('rvb-dir');
  if (entry.name.endsWith('.review.json')) classes.push('rvb-muted');

  const tags = [];
  if (entry.page) {
    if (entry.page.openComments > 0) {
      const n = entry.page.openComments;
      tags.push(`<span class="rvb-tag rvb-tag-open">${n} open</span>`);
    } else if (entry.page.sidecar) {
      tags.push(`<span class="rvb-tag">${entry.page.comments} comment${entry.page.comments === 1 ? '' : 's'}</span>`);
    }
    if (!entry.page.instrumented) tags.push('<span class="rvb-tag">not instrumented</span>');
  }

  return `<li class="${classes.join(' ')}">`
    + `<span class="rvb-glyph" aria-hidden="true">${isDir ? '&#9656;' : '&#9675;'}</span>`
    + `<a class="rvb-name" href="${escapeHtml(href)}">${escapeHtml(entry.name)}${isDir ? '/' : ''}</a>`
    + tags.join('')
    + `<span class="rvb-meta">${escapeHtml(isDir ? '—' : formatSize(entry.size))}</span>`
    + '</li>';
}

function renderCrumbs(rootName, rel) {
  const segments = rel ? rel.split('/') : [];
  const parts = [segments.length === 0
    ? `<span>${escapeHtml(rootName)}</span>`
    : `<a href="/">${escapeHtml(rootName)}</a>`];
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    const href = '/' + segments.slice(0, i + 1).map(encodeURIComponent).join('/') + '/';
    parts.push('<span class="rvb-sep">/</span>');
    parts.push(last
      ? `<span>${escapeHtml(segment)}</span>`
      : `<a href="${escapeHtml(href)}">${escapeHtml(segment)}</a>`);
  });
  return parts.join('');
}

// The index page for one listing. Self-contained: inline styles, no scripts,
// no external requests. Never carries the overlay injection placeholder — this
// page is the runner's own UI, not a document under review.
export function renderIndex({ rootName, listing }) {
  const { path: rel, entries } = listing;
  const title = rel ? `${rootName}/${rel}` : rootName;
  const body = entries.length === 0
    ? '<div class="rvb-empty">This folder is empty.</div>'
    : `<ul class="rvb-list">\n${entries.map((e) => renderEntry(rel, e)).join('\n')}\n</ul>`;
  const htmlCount = entries.filter((e) => e.page).length;
  const note = htmlCount === 0
    ? '<p class="rvb-note">No HTML documents here — open a subfolder, or point the runner at a directory that has one.</p>'
    : '<p class="rvb-note">Open an HTML document to review it. The extension injects the overlay once the page loads.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — redline</title>
<style>${STYLES}</style>
</head>
<body class="rvb-body">
<div class="rvb-shell">
<div class="rvb-logo">redline</div>
<nav class="rvb-crumbs">${renderCrumbs(rootName, rel)}</nav>
${body}
${note}
</div>
</body>
</html>
`;
}
