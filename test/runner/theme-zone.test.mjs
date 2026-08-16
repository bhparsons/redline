// test/runner/theme-zone.test.mjs — WP6: page-level theme zone.
//
// A dedicated <style data-rev-theme> block is the only editable page-level
// style surface. The instrumenter creates one; editThemeZone() writes a single
// `body { … }` rule from plain declarations, gates properties against a narrow
// allowlist (out-of-list flags, never blocks), and refuses selectors, braces,
// at-rules, !important, and non-ASCII by construction. applyEdits threads it
// through the same all-or-nothing pipeline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureThemeZone, locateThemeZone, editThemeZone, checkBalanced,
} from '../../runner/lib/surgery.mjs';
import { instrumentSource } from '../../runner/lib/instrument.mjs';
import { validateAgentPayload } from '../../runner/lib/agent.mjs';
import { applyEdits } from '../../runner/lib/apply.mjs';

const WITH_HEAD = '<!doctype html><html><head><title>t</title></head><body>\n<p data-rev="r-0001">x</p>\n</body></html>';
const NO_HEAD = '<!doctype html><body>\n<p data-rev="r-0001">x</p>\n</body>';

// ---- ensure / locate -------------------------------------------------------

test('ensureThemeZone creates a zone at the end of <head> and is idempotent', () => {
  const first = ensureThemeZone(WITH_HEAD);
  assert.equal(first.created, true);
  // After author <head> content, immediately before </head>, so the theme
  // wins the cascade against same-specificity author rules (#95).
  assert.match(first.source, /<title>t<\/title><style data-rev-theme><\/style>\n<\/head>/);
  assert.equal(checkBalanced(first.source).ok, true);
  const second = ensureThemeZone(first.source);
  assert.equal(second.created, false);
  assert.equal(second.source, first.source);
});

test('ensureThemeZone places the zone after an author <style> in <head>', () => {
  const doc = '<!doctype html><html><head><style>body { color: #1d2230; }</style></head><body>\n<p data-rev="r-0001">x</p>\n</body></html>';
  const r = ensureThemeZone(doc);
  assert.equal(r.created, true);
  assert.ok(r.source.indexOf('data-rev-theme') > r.source.indexOf('#1d2230'));
  assert.equal(checkBalanced(r.source).ok, true);
});

test('ensureThemeZone falls back to <body> when there is no head', () => {
  const r = ensureThemeZone(NO_HEAD);
  assert.equal(r.created, true);
  assert.match(r.source, /<body>\n<style data-rev-theme><\/style>/);
  assert.ok(locateThemeZone(r.source));
});

// ---- editThemeZone ---------------------------------------------------------

test('editThemeZone writes a body rule from allowlisted declarations', () => {
  const r = editThemeZone(WITH_HEAD, 'font-family: Georgia, serif; line-height: 1.6');
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.flagged.length, 0);
  assert.match(r.source, /<style data-rev-theme>\n {2}body \{ font-family: Georgia, serif; line-height: 1\.6; \}\n<\/style>/);
});

test('editThemeZone flags out-of-allowlist properties but still applies', () => {
  const r = editThemeZone(WITH_HEAD, 'color: #222; letter-spacing: 0.02em');
  assert.equal(r.ok, true);
  assert.deepEqual(r.flagged.map((f) => ({ ...f })), [{ kind: 'theme', name: 'letter-spacing' }]);
  assert.match(r.source, /body \{ color: #222; letter-spacing: 0\.02em; \}/);
});

test('editThemeZone rejects selectors, braces, at-rules, !important, and non-ASCII', () => {
  assert.equal(editThemeZone(WITH_HEAD, 'body { color: red }').code, 'invalid-theme');
  assert.equal(editThemeZone(WITH_HEAD, '@media (x) { color: red }').code, 'invalid-theme');
  assert.equal(editThemeZone(WITH_HEAD, 'color: red !important').code, 'invalid-theme');
  assert.equal(editThemeZone(WITH_HEAD, 'color: café').code, 'invalid-theme');
  assert.equal(editThemeZone(WITH_HEAD, 'color: red; </style>').code, 'invalid-theme');
  assert.equal(editThemeZone(WITH_HEAD, 'not-a-declaration').code, 'invalid-theme');
  assert.equal(editThemeZone(WITH_HEAD, 42).code, 'invalid-theme');
});

test('editThemeZone reuses an existing zone in place', () => {
  const seeded = ensureThemeZone(WITH_HEAD).source;
  const r = editThemeZone(seeded, 'color: navy');
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.match(r.source, /body \{ color: navy; \}/);
});

// ---- instrumentSource creates the zone -------------------------------------

test('instrumentSource creates the theme zone (idempotent)', () => {
  const first = instrumentSource(WITH_HEAD);
  assert.equal(first.themeCreated, true);
  assert.ok(locateThemeZone(first.source));
  const second = instrumentSource(first.source);
  assert.equal(second.themeCreated, false);
});

// ---- agent payload ---------------------------------------------------------

test('validateAgentPayload accepts a theme string and rejects non-strings', () => {
  const base = { decisions: [] };
  assert.equal(validateAgentPayload({ ...base, theme: 'color: red' }).theme, 'color: red');
  assert.equal(validateAgentPayload({ ...base, theme: 5 }), null);
  // absent theme → the key is omitted entirely
  assert.equal('theme' in validateAgentPayload(base), false);
});

// ---- apply integration -----------------------------------------------------

test('applyEdits applies a theme and records op:theme with flags', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-theme-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'doc.html'), WITH_HEAD);

  const r = await applyEdits({ root: dir, page: 'doc.html', theme: 'font-size: 18px; opacity: 0.9' });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.editRecords.length, 1);
  assert.equal(r.editRecords[0].op, 'theme');
  assert.equal(r.editRecords[0].blockId, null);
  assert.deepEqual(r.flagged.map((f) => ({ ...f })), [{ blockId: null, kind: 'theme', name: 'opacity' }]);

  const onDisk = await fs.readFile(path.join(dir, 'doc.html'), 'utf8');
  assert.match(onDisk, /<style data-rev-theme>\n {2}body \{ font-size: 18px; opacity: 0\.9; \}\n<\/style>/);
});

test('a rejected theme leaves the document untouched', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-theme-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'doc.html'), WITH_HEAD);

  const r = await applyEdits({ root: dir, page: 'doc.html', theme: 'color: red !important' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid-theme');
  assert.equal(await fs.readFile(path.join(dir, 'doc.html'), 'utf8'), WITH_HEAD);
});
