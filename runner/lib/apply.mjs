// runner/lib/apply.mjs — the ONLY code that writes a reviewed document.
//
// applyEdits({root, page, edits, attributeEdits, theme, inserts}) applies ALL
// of a run's ops or NONE: the new source is built in memory op-by-op (each block
// re-located against the current in-memory text, so consecutive ops
// compose), validated after every op AND over the final document, then
// written in ONE atomic step (tmp + rename, same pattern as store.mjs).
// Any failure leaves the file on disk untouched and returns a typed error
// naming the offending blockId and reason — never a throw for expected
// validation failures.
//
// Inserts run AFTER edits and mint their data-rev ids HERE (lib/instrument's
// mintId, collision-checked against every id in the current document plus
// the ids minted earlier in the same run) — the agent never invents ids.
//
// Result shapes:
//   { ok: true,  editRecords: [...], changed, flagged: [...] }
//     editRecords: {blockId, beforeInner, afterInner}                (edit)
//                | {blockId, op:'attributes', beforeInner, afterInner} (attribute
//                  edit — before/after are the block's OPEN TAG, inner untouched)
//                | {blockId:null, op:'theme', beforeInner, afterInner} (page-level
//                  theme-zone CSS edit — before/after are the zone's inner CSS)
//                | {blockId, insertedAfter|insertedBefore, afterInner} (insert
//                  — blockId is the freshly minted id; no beforeInner, the
//                  block did not exist before the run)
//     flagged: [{blockId, kind:'style'|'class', name}] — out-of-allowlist
//              style props / classes that were APPLIED but need confirmation
//              (WP7 reads this); empty on a clean run.
//   { ok: false, blockId: string|null,
//     code: 'unknown-page'|'io'|'unknown-block'|'data-rev-tampered'
//          |'unbalanced'|'ascii-regression'|'invalid-insert',
//     error: string }
//
// beforeInner/afterInner are captured at APPLY TIME — they are the run
// record's edit provenance, never a doc-wide diff after the fact.
//
// dryRun: true runs the WHOLE pipeline — locate, replace, mint, validate after
// every op and over the final document — and returns the same success/failure
// shape without the write. It is the validation half of POST /api/propose-edits
// (M2 WP2): an agent gets exactly the verdict a real apply would produce, and
// there is only ever one code path deciding whether a write is legal.

import { promises as fs } from 'node:fs';
import { resolvePage, atomicWriteFile } from './store.mjs';
import {
  replaceBlockInner, insertSiblingBlock, editBlockAttributes, editThemeZone,
  validateWrite, revIds,
} from './surgery.mjs';
import { mintId } from './instrument.mjs';
import { themeOverrides } from './theme-overrides.mjs';

export async function applyEdits({ root, page, edits, attributeEdits, theme, inserts, dryRun = false }) {
  const htmlPath = await resolvePage(root, page);
  if (htmlPath === null) {
    return { ok: false, blockId: null, code: 'unknown-page', error: 'unknown page' };
  }

  let original;
  try {
    original = await fs.readFile(htmlPath, 'utf8');
  } catch {
    return { ok: false, blockId: null, code: 'io', error: 'could not read the document' };
  }

  let current = original;
  const editRecords = [];
  const flagged = []; // out-of-allowlist style/class items, for the scope gate (WP7)
  for (const edit of Array.isArray(edits) ? edits : []) {
    const replaced = replaceBlockInner(current, edit.blockId, edit.newInner);
    if (!replaced.ok) {
      return { ok: false, blockId: String(edit.blockId ?? ''), code: replaced.code, error: replaced.error };
    }
    // Doc-wide validation after EVERY op so the offending op is the one
    // named, not just the last one before a final check.
    const valid = validateWrite(original, replaced.source);
    if (!valid.ok) {
      return { ok: false, blockId: String(edit.blockId), code: valid.code, error: valid.error };
    }
    current = replaced.source;
    editRecords.push({
      blockId: edit.blockId,
      beforeInner: replaced.beforeInner,
      afterInner: replaced.afterInner,
    });
  }

  // Attribute edits (class/style) — the block's own open tag, never its inner
  // (WP4). Out-of-allowlist items don't fail the write; they surface in
  // `flagged` for the confirmation gate.
  for (const attrEdit of Array.isArray(attributeEdits) ? attributeEdits : []) {
    const { blockId, ...attrs } = attrEdit;
    const result = editBlockAttributes(current, blockId, attrs);
    if (!result.ok) {
      return { ok: false, blockId: String(blockId ?? ''), code: result.code, error: result.error };
    }
    const valid = validateWrite(original, result.source);
    if (!valid.ok) {
      return { ok: false, blockId: String(blockId), code: valid.code, error: valid.error };
    }
    current = result.source;
    for (const f of result.flagged) flagged.push({ blockId, ...f });
    editRecords.push({
      blockId,
      op: 'attributes',
      beforeInner: result.beforeOpenTag,
      afterInner: result.afterOpenTag,
    });
  }

  // Theme zone (WP6): a page-level `body { … }` rule in <style data-rev-theme>.
  // At most one per run; created on demand if the page has no zone yet.
  if (typeof theme === 'string') {
    const result = editThemeZone(current, theme);
    if (!result.ok) {
      return { ok: false, blockId: null, code: result.code, error: result.error };
    }
    const valid = validateWrite(original, result.source);
    if (!valid.ok) {
      return { ok: false, blockId: null, code: valid.code, error: valid.error };
    }
    current = result.source;
    for (const f of result.flagged) flagged.push({ blockId: null, ...f });
    // Which blocks will IGNORE this theme because they declare the property
    // themselves (#111). Recorded so the outcome can say so instead of the
    // author discovering it by looking at an unchanged paragraph.
    const overrides = themeOverrides(current, theme);
    editRecords.push({
      blockId: null,
      op: 'theme',
      beforeInner: result.beforeInner,
      afterInner: result.afterInner,
      ...(overrides === null ? {} : { overrides }),
    });
  }

  // Inserts: mint against every id present after the edits above, so a
  // multi-insert run can never collide with the doc or with itself.
  const insertList = Array.isArray(inserts) ? inserts : [];
  const taken = insertList.length > 0 ? new Set(revIds(current)) : null;
  for (const insert of insertList) {
    const position = insert.afterBlockId !== undefined ? 'after' : 'before';
    const anchorBlockId = insert.afterBlockId ?? insert.beforeBlockId;
    const inserted = insertSiblingBlock(current, {
      anchorBlockId, position, html: insert.html, newBlockId: mintId(taken),
    });
    if (!inserted.ok) {
      return { ok: false, blockId: String(anchorBlockId ?? ''), code: inserted.code, error: inserted.error };
    }
    const valid = validateWrite(original, inserted.source);
    if (!valid.ok) {
      return { ok: false, blockId: String(anchorBlockId), code: valid.code, error: valid.error };
    }
    current = inserted.source;
    const record = { blockId: inserted.blockId, afterInner: inserted.afterInner };
    if (position === 'after') record.insertedAfter = anchorBlockId;
    else record.insertedBefore = anchorBlockId;
    editRecords.push(record);
  }

  // Final doc-wide validation (belt and braces — also covers zero ops).
  const finalCheck = validateWrite(original, current);
  if (!finalCheck.ok) {
    return {
      ok: false,
      blockId: editRecords.at(-1)?.blockId ?? null,
      code: finalCheck.code,
      error: finalCheck.error,
    };
  }

  const changed = current !== original;
  if (dryRun) return { ok: true, editRecords, changed, flagged, dryRun: true };
  if (changed) {
    try {
      await atomicWriteFile(htmlPath, current);
    } catch {
      return { ok: false, blockId: null, code: 'io', error: 'could not write the document' };
    }
  }
  return { ok: true, editRecords, changed, flagged };
}
