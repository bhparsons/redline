#!/usr/bin/env node
// report.mjs — render a page's review sidecar into a self-contained HTML report.
//
//   node report.mjs <page.html> [out.html]     (default out: <page>.review-report.html)
//
// The audit-trail artifact for sharing with a client or teammate who wasn't in
// the loop: every comment, how it was resolved (with before/after diffs), the
// author's sign-offs, and the run history — one file, inline CSS, no scripts,
// safe to email or drop on any static host. Read-only: touches neither the doc
// nor the sidecar.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DOC = process.argv[2];
if (!DOC) {
  console.error('usage: node report.mjs <page.html> [out.html]');
  process.exit(1);
}
const sidecarPath = DOC + '.review.json';
if (!existsSync(sidecarPath)) {
  console.error(`no sidecar found at ${sidecarPath} — nothing to report`);
  process.exit(1);
}
const OUT = process.argv[3] ?? DOC.replace(/\.html$/, '') + '.review-report.html';

const sc = JSON.parse(readFileSync(sidecarPath, 'utf8'));
const anns = sc.annotations ?? [];
const runs = sc.runs ?? [];

// Every string from the sidecar is untrusted author/agent text — escape all of it.
const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const when = (iso) => (iso ? esc(String(iso).replace('T', ' ').slice(0, 16)) : '');

const comments = anns.filter((a) => a['x-review']?.kind !== 'edit');
const directEdits = anns.filter((a) => a['x-review']?.kind === 'edit');
const byStatus = (s) => comments.filter((a) => a['x-review']?.status === s);
const counts = {
  addressed: byStatus('addressed').length,
  declined: byStatus('declined').length,
  deferred: byStatus('deferred').length,
  open: comments.filter((a) => ['open', 'reopened', 'sent'].includes(a['x-review']?.status)).length,
  approved: comments.filter((a) => a['x-review']?.approved).length,
};

function diffHtml(edits) {
  if (!Array.isArray(edits) || edits.length === 0) return '';
  return edits.map((e) => (
    `<div class="diff">${e.blockId ? `<div class="blockid">block ${esc(e.blockId)}</div>` : ''}`
    + `<del>${esc(e.before)}</del><ins>${esc(e.after)}</ins></div>`
  )).join('');
}

function annCard(a) {
  const x = a['x-review'] ?? {};
  const res = x.resolution ?? {};
  const thread = (x.thread ?? []).filter((t) => t.body || t.action);
  return `<article class="card st-${esc(x.status)}">
<header><span class="chip">${esc(x.status)}</span>${x.approved ? '<span class="chip ok">approved</span>' : ''}
<b>${esc(a.creator)}</b> · ${when(a.created)}${x.label ? ' · ' + esc(x.label) : ''}</header>
<p class="ask">${esc(a.body?.value)}</p>
${res.summary || res.note ? `<p class="res"><b>${esc(res.summary)}</b>${res.note ? ' — ' + esc(res.note) : ''}</p>` : ''}
${diffHtml(res.edits ?? (x.edit ? [x.edit] : []))}
${thread.length ? '<ul class="thread">' + thread.map((t) => `<li><b>${esc(t.author)}</b>${t.action ? ` <i>(${esc(t.action)})</i>` : ''} ${esc(t.body)} <span class="at">${when(t.at)}</span></li>`).join('') + '</ul>' : ''}
</article>`;
}

function runRow(r) {
  const outcome = r.status === 'done'
    ? (r.commit ? `committed ${esc(String(r.commit).slice(0, 8))}` : 'done')
    : `${esc(r.status)}${r.error ? ' — ' + esc(r.error) : ''}`;
  return `<tr><td>${esc(r.id)}</td><td>${when(r.startedAt)}</td><td>${(r.sent ?? []).length}</td>
<td>${esc(r.model ?? 'default')}</td><td>${(r.capabilities ?? []).map(esc).join(', ') || '—'}</td>
<td>${outcome}${r.undone ? ' · undone' : ''}</td></tr>`;
}

const sections = [
  ['Needs attention (open / reopened / sent)', comments.filter((a) => ['open', 'reopened', 'sent'].includes(a['x-review']?.status))],
  ['Addressed', byStatus('addressed')],
  ['Deferred (handed to an interactive session)', byStatus('deferred')],
  ['Declined', byStatus('declined')],
].filter(([, list]) => list.length);

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review report — ${esc(sc.page ?? path.basename(DOC))}</title>
<style>
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 780px; margin: 40px auto; padding: 0 20px; color: #1c2333; }
  h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 34px; border-bottom: 1px solid #d8dce6; padding-bottom: 6px; }
  .meta { color: #5b6478; font-size: 13px; }
  .totals span { display: inline-block; margin-right: 14px; }
  .card { border: 1px solid #d8dce6; border-radius: 8px; padding: 12px 14px; margin: 12px 0; }
  .card header { font-size: 13px; color: #5b6478; margin-bottom: 6px; }
  .chip { display: inline-block; border: 1px solid #b9c0d0; border-radius: 999px; padding: 0 8px;
          font-size: 11.5px; margin-right: 8px; text-transform: uppercase; letter-spacing: .04em; }
  .chip.ok { border-color: #2e8b62; color: #2e8b62; }
  .st-declined .chip:first-child { border-color: #b04a4a; color: #b04a4a; }
  .st-deferred .chip:first-child { border-color: #a07724; color: #a07724; }
  .st-addressed .chip:first-child { border-color: #2e8b62; color: #2e8b62; }
  .ask { margin: 4px 0; } .res { margin: 4px 0; font-size: 14px; }
  .diff { font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 8px 0;
          border-left: 3px solid #d8dce6; padding-left: 10px; overflow-x: auto; }
  .diff .blockid { color: #8a92a6; font-size: 11px; }
  .diff del { display: block; color: #b04a4a; background: #fbeeee; text-decoration: none; padding: 2px 6px; }
  .diff ins { display: block; color: #2e8b62; background: #edf7f2; text-decoration: none; padding: 2px 6px; }
  .thread { font-size: 13px; color: #3a4358; padding-left: 18px; } .thread .at { color: #8a92a6; font-size: 11.5px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; border-bottom: 1px solid #e4e7ef; padding: 6px 8px; vertical-align: top; }
  th { color: #5b6478; font-weight: 600; }
</style>
<h1>Review report — ${esc(sc.page ?? path.basename(DOC))}</h1>
<p class="meta">Generated ${when(new Date().toISOString())} · ${comments.length} comment${comments.length === 1 ? '' : 's'} · ${directEdits.length} direct edit${directEdits.length === 1 ? '' : 's'} · ${runs.length} revision run${runs.length === 1 ? '' : 's'}</p>
<p class="totals">
  <span><b>${counts.addressed}</b> addressed</span><span><b>${counts.declined}</b> declined</span>
  <span><b>${counts.deferred}</b> deferred</span><span><b>${counts.open}</b> open</span>
  <span><b>${counts.approved}</b> approved by author</span>
</p>
${sections.map(([title, list]) => `<h2>${esc(title)} (${list.length})</h2>\n` + list.map(annCard).join('\n')).join('\n')}
${directEdits.length ? `<h2>Author's direct edits (${directEdits.length})</h2>\n` + directEdits.map(annCard).join('\n') : ''}
${runs.length ? `<h2>Revision runs</h2>\n<table><tr><th>run</th><th>started</th><th>sent</th><th>model</th><th>grants</th><th>outcome</th></tr>${runs.map(runRow).join('')}</table>` : ''}
`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${comments.length} comments, ${runs.length} runs)`);
