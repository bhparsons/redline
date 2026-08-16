// runner/lib/trace.mjs — the per-run trace bundle under tmp/review-runs/<runId>/.
//
// Every run gets a directory of ground-truth files:
//   prompt.md            the exact rendered prompt sent to the agent
//   agent-request.json   the model, messages, and parameters (never the API
//                        key — that travels in a header, not the body)
//   agent-response.json  the raw envelope and assistant content
//   validation.json      the applyEdits result, rejection reason included
//   run.json             the final run record stored in the sidecar
// Batch (Send All) runs make one agent call per comment, so the per-call
// files gain a 1-based index: prompt-1.md, agent-request-1.json, … run.json
// stays singular — one run record either way.
//
// The bundle is written REGARDLESS of telemetry config — these local files
// are the ground truth; OTLP export is a (truncatable) view of them. Writes
// are lazy (mkdir on the first file) and best-effort: a failed trace write
// logs to stderr and never fails the run. Bundles live under the runner
// repo's tmp/ (gitignored), overridable via REDLINE_TRACE_DIR (tests use
// this to isolate). runIds are server-minted (`run-<hex>`, store.newId) —
// never client input — so they are safe as path segments.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Root directory that holds one subdirectory per run.
export function traceRoot(env = process.env) {
  if (typeof env.REDLINE_TRACE_DIR === 'string' && env.REDLINE_TRACE_DIR.length > 0) {
    return env.REDLINE_TRACE_DIR;
  }
  return path.join(REPO_ROOT, 'tmp', 'review-runs');
}

// The bundle directory for one run.
export function traceDir(runId, env = process.env) {
  return path.join(traceRoot(env), runId);
}

// Per-call file name: plain for single-comment runs, 1-based index for batch.
export function traceFileName(base, ext, { batch = false, index = 0 } = {}) {
  return batch ? `${base}-${index + 1}.${ext}` : `${base}.${ext}`;
}

// Write one bundle file. Strings go verbatim; anything else is
// pretty-printed JSON. Best-effort: errors are logged, never thrown.
export async function writeTraceFile(runId, name, content, env = process.env) {
  try {
    const dir = traceDir(runId, env);
    await fs.mkdir(dir, { recursive: true });
    const text = typeof content === 'string'
      ? content
      : JSON.stringify(content ?? null, null, 2) + '\n';
    await fs.writeFile(path.join(dir, name), text, 'utf8');
  } catch (err) {
    console.error(`[trace] could not write ${name} for ${runId}: ${err?.message ?? err}`);
  }
}
