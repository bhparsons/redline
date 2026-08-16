// runner/lib/history.mjs — snapshot storage for undo, under <root>/.history/.
//
// .history is a DOT-directory on purpose: resolvePath() in paths.mjs rejects
// any URL segment that starts with ".", so nothing stored here is ever
// servable over HTTP — no extra guard needed.
//
// Layout: <root>/.history/<encodeURIComponent(page)>/<entry>/ where entry is
//   <ms13>-<seq6>__<kind>__<runId>
// (ms + a process-monotonic sequence keeps entries strictly ordered even
// inside one millisecond). Each entry holds doc.html, sidecar.json (when one
// existed), and meta.json.
//
// Before each run the API layer saves a 'pre-run' snapshot pair (doc +
// sidecar) keyed by the runId. undo() restores that pair's DOC and records
// the pre-undo state as a NEW entry first — history only grows; entries are
// never rewritten. Storage is bounded: the newest KEEP_PER_PAGE entries per
// page survive, older ones are pruned.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sidecarPath, atomicWriteFile } from './store.mjs';

export const KEEP_PER_PAGE = 20;

const ENTRY_RE = /^(\d{13,})-(\d{6})__([a-z-]+)__([\w-]+)$/;
let seq = 0;

function pageDir(root, page) {
  return path.join(root, '.history', encodeURIComponent(page));
}

// Save the page's current doc + sidecar as a new snapshot entry, then prune
// the page's history down to KEEP_PER_PAGE entries. Returns the entry name.
export async function saveSnapshot({ root, page, htmlPath, runId, kind }) {
  const doc = await fs.readFile(htmlPath, 'utf8');
  let sidecar = null;
  try {
    sidecar = await fs.readFile(sidecarPath(htmlPath), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const dir = pageDir(root, page);
  seq = (seq + 1) % 1_000_000;
  const name = `${String(Date.now()).padStart(13, '0')}-${String(seq).padStart(6, '0')}__${kind}__${runId}`;
  const entry = path.join(dir, name);
  await fs.mkdir(entry, { recursive: true });
  await fs.writeFile(path.join(entry, 'doc.html'), doc, 'utf8');
  if (sidecar !== null) await fs.writeFile(path.join(entry, 'sidecar.json'), sidecar, 'utf8');
  await fs.writeFile(
    path.join(entry, 'meta.json'),
    JSON.stringify({ page, runId, kind, createdAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  await prune(dir);
  return name;
}

// Entry names for a page, newest first. Missing history → [].
export async function listSnapshots(root, page) {
  let names;
  try {
    names = await fs.readdir(pageDir(root, page));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  return names.filter((n) => ENTRY_RE.test(n)).sort().reverse();
}

// Newest snapshot matching runId + kind → {id, doc, sidecar|null} or null.
export async function loadSnapshot({ root, page, runId, kind = 'pre-run' }) {
  for (const name of await listSnapshots(root, page)) {
    const m = ENTRY_RE.exec(name);
    if (m[3] !== kind || m[4] !== runId) continue;
    const entry = path.join(pageDir(root, page), name);
    const doc = await fs.readFile(path.join(entry, 'doc.html'), 'utf8');
    let sidecar = null;
    try {
      sidecar = await fs.readFile(path.join(entry, 'sidecar.json'), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return { id: name, doc, sidecar };
  }
  return null;
}

// Restore the DOC from the newest snapshot matching runId + kind (atomic
// write). Returns false when no such snapshot exists.
export async function restoreDoc({ root, page, htmlPath, runId, kind = 'pre-run' }) {
  const snap = await loadSnapshot({ root, page, runId, kind });
  if (snap === null) return false;
  await atomicWriteFile(htmlPath, snap.doc);
  return true;
}

async function prune(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const entries = names.filter((n) => ENTRY_RE.test(n)).sort().reverse();
  for (const name of entries.slice(KEEP_PER_PAGE)) {
    await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
  }
}
