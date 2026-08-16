// runner/lib/session-log.mjs — lightweight session log for long-running
// Claude Code sessions.
//
// A post-session tool: a Claude Code agent imports this module, calls
// startSession() once, event() after every significant event, and
// completeSession() at the end. Two artifacts are maintained:
//   - `tmp/session-log.md` (or `tmp/session-log-<runId>.md` when a runId is
//     given) — an append-only Markdown transcript of the session.
//   - an instrumented HTML timeline (default `design/co-editor/session-log.html`)
//     regenerated on every renderHtml() call, with a `data-rev` id on each
//     event block so it is Redline-reviewable (the runner can serve it and
//     the overlay can anchor comments to individual events).
//
// Stdlib-only Node >=20, no dependencies, no build step. All file writes are
// best-effort: a failed write logs to stderr and never throws, so logging can
// never break the agent's real work. The module holds one session per process
// (module-level state) — exactly what a single Claude Code session needs.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Event types the agent is expected to emit. Anything else is accepted but
// rendered with an "unknown type" style so the log never silently drops a row.
export const EVENT_TYPES = new Set([
  'START', 'WP_START', 'WP_COMPLETE', 'TEST', 'DECISION',
  'BLOCKER', 'ERROR', 'COMMIT', 'PAUSE', 'RESUME', 'END',
])

// --- module-level session state (one session per process) -----------------
let session = null

function mintRevId(taken) {
  for (;;) {
    const id = 'r-' + crypto.randomBytes(2).toString('hex')
    if (!taken.has(id)) {
      taken.add(id)
      return id
    }
  }
}

function isoNow() {
  return new Date().toISOString()
}

// Resolve a path that may be relative to the repo root.
function resolveOutputPath(p) {
  if (!p) return null
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p)
}

// The Markdown log path for this session.
function logPath() {
  const name = session?.runId ? `session-log-${session.runId}.md` : 'session-log.md'
  return path.join(REPO_ROOT, 'tmp', name)
}

async function appendMarkdown(text) {
  try {
    await fs.mkdir(path.dirname(logPath()), { recursive: true })
    await fs.appendFile(logPath(), text, 'utf8')
  } catch (err) {
    console.error(`[session-log] could not append to ${logPath()}: ${err?.message ?? err}`)
  }
}

// Escape text for safe interpolation into HTML (ASCII/entity-only output).
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// CSS class per event type for the timeline.
function typeClass(type) {
  const t = String(type ?? '').toUpperCase()
  if (t === 'ERROR' || t === 'BLOCKER') return 'sl-ev-error'
  if (t === 'WP_COMPLETE' || t === 'COMMIT' || t === 'END') return 'sl-ev-ok'
  if (t === 'WP_START' || t === 'START' || t === 'RESUME') return 'sl-ev-info'
  if (t === 'TEST') return 'sl-ev-test'
  if (t === 'DECISION') return 'sl-ev-decision'
  if (t === 'PAUSE') return 'sl-ev-pause'
  return 'sl-ev-other'
}

/**
 * Initialize the session log and write the Markdown header.
 * Returns the session descriptor. Calling twice resets the in-memory state
 * and rewrites the header (the previous .md file is overwritten).
 */
export async function startSession({ goal, worktree, promptFile, runId } = {}) {
  session = {
    goal: goal ?? '(unspecified)',
    worktree: worktree ?? null,
    promptFile: promptFile ?? null,
    runId: runId ?? null,
    startedAt: isoNow(),
    endedAt: null,
    status: null,
    completedWPs: [],
    remainingWPs: [],
    nextSteps: [],
    events: [],
  }
  const header = [
    '# Session Log',
    '',
    `- **Goal:** ${session.goal}`,
    session.worktree ? `- **Worktree:** ${session.worktree}` : null,
    session.promptFile ? `- **Prompt file:** ${session.promptFile}` : null,
    session.runId ? `- **Run ID:** ${session.runId}` : null,
    `- **Started:** ${session.startedAt}`,
    '',
    '## Events',
    '',
  ].filter((l) => l !== null).join('\n')
  try {
    await fs.mkdir(path.dirname(logPath()), { recursive: true })
    await fs.writeFile(logPath(), header + '\n', 'utf8')
  } catch (err) {
    console.error(`[session-log] could not write header to ${logPath()}: ${err?.message ?? err}`)
  }
  // An implicit START event so the timeline always has a first beat.
  await event('START', `Session started: ${session.goal}`)
  return { ...session }
}

/**
 * Append an event to the Markdown log and the in-memory timeline.
 * `type` should be one of EVENT_TYPES; `details` (optional) is serialized as
 * a fenced JSON block in the .md and a `<details>` block in the HTML.
 */
export async function event(type, message, details) {
  if (!session) {
    console.error('[session-log] event() called before startSession(); ignoring.')
    return null
  }
  const ts = isoNow()
  const entry = { type: String(type ?? '').toUpperCase(), message, details: details ?? null, ts }
  session.events.push(entry)
  const lines = [`- **[${entry.type}]** ${ts} — ${message ?? ''}`]
  if (details !== undefined && details !== null) {
    lines.push('  ```json')
    lines.push('  ' + JSON.stringify(details, null, 2).replace(/\n/g, '\n  '))
    lines.push('  ```')
  }
  await appendMarkdown(lines.join('\n') + '\n')
  return entry
}

/**
 * Regenerate the instrumented HTML timeline at `outputPath` (relative paths
 * resolve against the repo root). Each event block carries a `data-rev` id so
 * the file is Redline-reviewable. Returns the written path.
 */
export async function renderHtml(outputPath) {
  if (!session) {
    console.error('[session-log] renderHtml() called before startSession(); ignoring.')
    return null
  }
  const out = resolveOutputPath(outputPath)
  const taken = new Set()
  const events = session.events

  const eventBlocks = events.map((e, i) => {
    const id = mintRevId(taken)
    const detailsHtml = e.details !== null && e.details !== undefined
      ? `<details class="sl-details"><summary>details</summary><pre data-rev="${mintRevId(taken)}">${esc(JSON.stringify(e.details, null, 2))}</pre></details>`
      : ''
    return `<div class="sl-event ${typeClass(e.type)}" data-rev="${id}">
  <div class="sl-event-head"><span class="sl-type">${esc(e.type)}</span><time>${esc(e.ts)}</time></div>
  <p class="sl-msg" data-rev="${mintRevId(taken)}">${esc(e.message ?? '')}</p>
  ${detailsHtml}
</div>`
  }).join('\n')

  const counts = {}
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1
  const summaryRows = Object.keys(counts).sort().map(
    (t) => `<li><span class="sl-type">${esc(t)}</span> ${counts[t]}</li>`,
  ).join('')

  const ended = session.endedAt
  const completed = (session.completedWPs ?? []).join(', ') || '—'
  const remaining = (session.remainingWPs ?? []).join(', ') || '—'
  const nextSteps = (session.nextSteps ?? [])
    .map((s) => `<li data-rev="${mintRevId(taken)}">${esc(s)}</li>`).join('') || '<li>—</li>'

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session Log</title>
<style>
  :root { --sl-bg:#fff; --sl-fg:#111; --sl-muted:#666; --sl-line:#e5e5e5; --sl-accent:#007aff; }
  body { margin:0; font:14px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif; color:var(--sl-fg); background:var(--sl-bg); }
  header { padding:24px 32px; border-bottom:1px solid var(--sl-line); }
  h1 { margin:0 0 8px; font-size:22px; }
  .sl-meta { color:var(--sl-muted); font-size:13px; }
  .sl-meta p { margin:2px 0; }
  main { display:grid; grid-template-columns:240px 1fr; gap:24px; padding:24px 32px; }
  aside { font-size:13px; }
  aside h2 { font-size:14px; margin:0 0 8px; }
  aside ul { list-style:none; padding:0; margin:0 0 16px; }
  aside li { padding:2px 0; color:var(--sl-muted); }
  .sl-type { display:inline-block; min-width:90px; font-weight:600; color:var(--sl-fg); }
  section.sl-timeline { display:flex; flex-direction:column; gap:12px; }
  .sl-event { border:1px solid var(--sl-line); border-radius:10px; padding:12px 14px; }
  .sl-event-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }
  .sl-type { display:inline-block; min-width:auto; padding:1px 8px; border-radius:6px; font-size:12px; font-weight:600; background:#f0f0f0; }
  time { color:var(--sl-muted); font-size:12px; }
  .sl-msg { margin:4px 0 0; }
  .sl-details { margin-top:8px; }
  .sl-details pre { white-space:pre-wrap; background:#fafafa; border:1px solid var(--sl-line); border-radius:6px; padding:8px; font-size:12px; overflow:auto; }
  .sl-ev-error { border-color:#ff3b30; } .sl-ev-error .sl-type { background:#ffe5e3; color:#ff3b30; }
  .sl-ev-ok { border-color:#34c759; } .sl-ev-ok .sl-type { background:#e3f9ea; color:#34c759; }
  .sl-ev-info { border-color:var(--sl-accent); } .sl-ev-info .sl-type { background:#e5f1ff; color:var(--sl-accent); }
  .sl-ev-test .sl-type { background:#fff4e0; color:#cc7a00; }
  .sl-ev-decision .sl-type { background:#f0e6ff; color:#7a3dcc; }
  .sl-ev-pause .sl-type { background:#fff8d6; color:#b07c00; }
  .sl-end { margin-top:16px; border-top:1px solid var(--sl-line); padding-top:16px; }
  .sl-end h2 { font-size:16px; margin:0 0 8px; }
  @media (max-width:720px){ main{ grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>Session Log</h1>
  <div class="sl-meta">
    <p><strong>Goal:</strong> ${esc(session.goal)}</p>
    ${session.worktree ? `<p><strong>Worktree:</strong> ${esc(session.worktree)}</p>` : ''}
    ${session.promptFile ? `<p><strong>Prompt file:</strong> ${esc(session.promptFile)}</p>` : ''}
    ${session.runId ? `<p><strong>Run ID:</strong> ${esc(session.runId)}</p>` : ''}
    <p><strong>Started:</strong> ${esc(session.startedAt)}${ended ? ` &mdash; <strong>Ended:</strong> ${esc(ended)}` : ''}</p>
  </div>
</header>
<main>
  <aside>
    <h2>Summary</h2>
    <ul>${summaryRows || '<li>—</li>'}</ul>
    <h2>Work packages</h2>
    <ul>
      <li><strong>Completed:</strong> ${esc(completed)}</li>
      <li><strong>Remaining:</strong> ${esc(remaining)}</li>
    </ul>
    <h2>Next steps</h2>
    <ul>${nextSteps}</ul>
  </aside>
  <section class="sl-timeline">
${eventBlocks}
  </section>
</main>
</body>
</html>
`
  try {
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, html, 'utf8')
  } catch (err) {
    console.error(`[session-log] could not write HTML to ${out}: ${err?.message ?? err}`)
  }
  return out
}

/**
 * Append an END event, record the final status, and re-render the HTML.
 * `status` is free-form (e.g. "complete", "paused", "blocked").
 */
export async function completeSession({ status, completedWPs, remainingWPs, nextSteps } = {}) {
  if (!session) {
    console.error('[session-log] completeSession() called before startSession(); ignoring.')
    return null
  }
  session.endedAt = isoNow()
  session.status = status ?? 'complete'
  if (Array.isArray(completedWPs)) session.completedWPs = completedWPs
  if (Array.isArray(remainingWPs)) session.remainingWPs = remainingWPs
  if (Array.isArray(nextSteps)) session.nextSteps = nextSteps
  await event('END', `Session ended: ${session.status}`, {
    status: session.status,
    completedWPs: session.completedWPs,
    remainingWPs: session.remainingWPs,
    nextSteps: session.nextSteps,
  })
  await renderHtml('design/co-editor/session-log.html')
  return { ...session }
}

// Read-only access to the current session state (for tests / inspection).
export function currentSession() {
  return session ? { ...session, events: session.events.slice() } : null
}

// A default export object so an agent can `import sessionLog from '.../session-log.mjs'`
// and call sessionLog.event(...), sessionLog.renderHtml(...), etc.
export default {
  startSession,
  event,
  renderHtml,
  completeSession,
  currentSession,
  EVENT_TYPES,
}
