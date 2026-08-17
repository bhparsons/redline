#!/usr/bin/env node
// report.mjs — render a page's review sidecar into a self-contained HTML report.
//
//   node report.mjs <page.html> [out.html]     (default out: <page>.review-report.html)
//
// The audit-trail artifact for sharing with a client or teammate who wasn't in
// the loop: every comment, how it was resolved (with before/after diffs), the
// replies it collected, and the run history with model, cost and scope-gate
// result — one file, inline CSS, no scripts, safe to email or drop on any
// static host. Read-only: touches neither the doc nor the sidecar.
//
// Reads the REBUILD sidecar shape: {comments[], runs[], rev}. A comment carries
// its own status and replies; how it was resolved lives on the RUN that actioned
// it (runs[].decisions[].id points back at the comment), so the report joins the
// two rather than expecting a resolution on the comment itself.

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
const comments = sc.comments ?? [];
const runs = sc.runs ?? [];

// Every string from the sidecar is untrusted author/agent text — escape all of it.
const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const when = (iso) => (iso ? esc(String(iso).replace('T', ' ').slice(0, 16)) : '');
const money = (n) => (typeof n === 'number' ? '$' + n.toFixed(4) : '—');

// Who acted: a bare comment/reply is the author; agents identify themselves.
const actorName = (o) => (o?.creator === 'agent' ? (o.agentName || 'agent') : (o?.creator || 'you'));

// A run actions comments either through decisions[] (standard/tactical lanes)
// or through a bare commentId (older single-comment records).
const decisionsFor = (commentId) => {
  const out = [];
  for (const r of runs) {
    const ds = Array.isArray(r.decisions) ? r.decisions : [];
    for (const d of ds) if (d.id === commentId) out.push({ run: r, decision: d });
    if (!ds.length && r.commentId === commentId) out.push({ run: r, decision: null });
  }
  return out;
};

const directEditRuns = runs.filter((r) => r.lane === 'direct-edit');
const byStatus = (s) => comments.filter((c) => c.status === s);
const counts = {
  addressed: byStatus('addressed').length,
  resolved: byStatus('resolved').length,
  declined: byStatus('declined').length,
  deferred: byStatus('deferred').length,
  failed: byStatus('failed').length,
  open: comments.filter((c) => ['open', 'reopened', 'sent'].includes(c.status)).length,
};
const totalCost = runs.reduce(
  (sum, r) => sum + (r.usage?.costUsd ?? 0) + (r.usage?.routerCostUsd ?? 0), 0);

function diffHtml(edits) {
  if (!Array.isArray(edits) || edits.length === 0) return '';
  return edits.map((e) => (
    `<div class="diff">${e.blockId ? `<div class="blockid">block ${esc(e.blockId)}</div>` : ''}`
    + `<del>${esc(e.beforeInner ?? e.before)}</del><ins>${esc(e.afterInner ?? e.after)}</ins></div>`
  )).join('');
}

function commentCard(c) {
  const acted = decisionsFor(c.id);
  const replies = (c.replies ?? []).filter((r) => r.body);
  const resolution = acted.map(({ run, decision }) => {
    const head = decision?.summary
      ? `<b>${esc(decision.summary)}</b>${decision.note ? ' — ' + esc(decision.note) : ''}`
      : `<b>${esc(run.status)}</b>`;
    const prov = `<span class="at">${esc(run.lane ?? 'run')} · ${esc(run.model ?? 'no model call')}`
      + `${run.usage?.costUsd != null ? ' · ' + money(run.usage.costUsd) : ''} · ${when(run.createdAt)}</span>`;
    // Only the blocks this run touched for THIS comment are shown; a batch run
    // records every block it wrote, so fall back to all of them rather than lie
    // about which one belonged to which comment.
    const edits = (run.edits ?? []).filter((e) => !decision?.blockIds || decision.blockIds.includes(e.blockId));
    return `<p class="res">${head} ${prov}</p>${diffHtml(edits)}`;
  }).join('');
  return `<article class="card st-${esc(c.status)}">
<header><span class="chip">${esc(c.status)}</span>${c.aiEdits === false ? '<span class="chip">note only</span>' : ''}
<b>${esc(actorName(c))}</b> · ${when(c.createdAt)}${c.anchor?.blockId ? ' · block ' + esc(c.anchor.blockId) : ''}</header>
${c.anchor?.quote ? `<p class="quote">“${esc(c.anchor.quote)}”</p>` : ''}
<p class="ask">${esc(c.body)}</p>
${resolution}
${replies.length ? '<ul class="thread">' + replies.map((r) => `<li><b>${esc(actorName(r))}</b> ${esc(r.body)} <span class="at">${when(r.createdAt)}</span></li>`).join('') + '</ul>' : ''}
</article>`;
}

function runRow(r) {
  const gate = r.scopeGate
    ? (r.scopeGate.fired
      ? `fired — ${esc((r.scopeGate.reasons ?? []).join('; ') || 'out of scope')}`
      : `clear (${esc(r.scopeGate.level ?? 'block')})`)
    : '—';
  const cost = r.usage?.costUsd != null
    ? money(r.usage.costUsd) + (r.usage.routerCostUsd ? ` <span class="at">+${money(r.usage.routerCostUsd)} routing</span>` : '')
    : '—';
  const edits = (r.edits ?? []).length;
  return `<tr><td>${esc(r.runId)}</td><td>${when(r.createdAt)}</td><td>${esc(r.lane ?? '—')}</td>
<td>${esc(r.model ?? '—')}</td><td>${edits}</td><td>${cost}</td><td>${gate}</td>
<td>${esc(r.status)}${r.undone ? ' · undone' : ''}</td><td>${esc(actorName(r.actor))}</td></tr>`;
}

const sections = [
  ['Needs attention (open / reopened / sent)', comments.filter((c) => ['open', 'reopened', 'sent'].includes(c.status))],
  ['Addressed — awaiting the author', byStatus('addressed')],
  ['Resolved', byStatus('resolved')],
  ['Deferred', byStatus('deferred')],
  ['Declined', byStatus('declined')],
  ['Failed', byStatus('failed')],
].filter(([, list]) => list.length);

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review report — ${esc(path.basename(DOC))}</title>
<style>
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 820px; margin: 40px auto; padding: 0 20px; color: #1c2333; }
  h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 34px; border-bottom: 1px solid #d8dce6; padding-bottom: 6px; }
  .meta { color: #5b6478; font-size: 13px; }
  .totals span { display: inline-block; margin-right: 14px; }
  .card { border: 1px solid #d8dce6; border-radius: 8px; padding: 12px 14px; margin: 12px 0; }
  .card header { font-size: 13px; color: #5b6478; margin-bottom: 6px; }
  .chip { display: inline-block; border: 1px solid #b9c0d0; border-radius: 999px; padding: 0 8px;
          font-size: 11.5px; margin-right: 8px; text-transform: uppercase; letter-spacing: .04em; }
  .st-declined .chip:first-child { border-color: #b04a4a; color: #b04a4a; }
  .st-deferred .chip:first-child { border-color: #a07724; color: #a07724; }
  .st-addressed .chip:first-child, .st-resolved .chip:first-child { border-color: #2e8b62; color: #2e8b62; }
  .st-failed .chip:first-child { border-color: #b04a4a; color: #b04a4a; }
  .quote { margin: 4px 0; color: #5b6478; font-style: italic; font-size: 14px; }
  .ask { margin: 4px 0; } .res { margin: 8px 0 4px; font-size: 14px; }
  .diff { font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 8px 0;
          border-left: 3px solid #d8dce6; padding-left: 10px; overflow-x: auto; }
  .diff .blockid { color: #8a92a6; font-size: 11px; }
  .diff del { display: block; color: #b04a4a; background: #fbeeee; text-decoration: none; padding: 2px 6px; }
  .diff ins { display: block; color: #2e8b62; background: #edf7f2; text-decoration: none; padding: 2px 6px; }
  .thread { font-size: 13px; color: #3a4358; padding-left: 18px; } .at { color: #8a92a6; font-size: 11.5px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; border-bottom: 1px solid #e4e7ef; padding: 6px 8px; vertical-align: top; }
  th { color: #5b6478; font-weight: 600; }
  .tablewrap { overflow-x: auto; }
</style>
<h1>Review report — ${esc(path.basename(DOC))}</h1>
<p class="meta">Generated ${when(new Date().toISOString())} · ${comments.length} comment${comments.length === 1 ? '' : 's'} · ${runs.length} run${runs.length === 1 ? '' : 's'} · document revision ${esc(sc.rev ?? '—')}</p>
<p class="totals">
  <span><b>${counts.open}</b> open</span><span><b>${counts.addressed}</b> addressed</span>
  <span><b>${counts.resolved}</b> resolved</span><span><b>${counts.declined}</b> declined</span>
  <span><b>${counts.deferred}</b> deferred</span>${counts.failed ? `<span><b>${counts.failed}</b> failed</span>` : ''}
  <span><b>${money(totalCost)}</b> total spend</span>
</p>
${sections.map(([title, list]) => `<h2>${esc(title)} (${list.length})</h2>\n` + list.map(commentCard).join('\n')).join('\n')}
${directEditRuns.length ? `<h2>Author's direct edits (${directEditRuns.length})</h2>\n`
  + directEditRuns.map((r) => `<article class="card"><header><span class="chip">direct edit</span><b>${esc(actorName(r.actor))}</b> · ${when(r.createdAt)}</header>${diffHtml(r.edits)}</article>`).join('\n') : ''}
${runs.length ? `<h2>Run history</h2>\n<div class="tablewrap"><table><tr><th>run</th><th>when</th><th>lane</th><th>model</th><th>edits</th><th>cost</th><th>scope gate</th><th>outcome</th><th>actor</th></tr>${runs.map(runRow).join('')}</table></div>` : ''}
`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${comments.length} comments, ${runs.length} runs, ${money(totalCost)} total spend)`);
