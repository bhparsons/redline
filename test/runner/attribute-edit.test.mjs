// test/runner/attribute-edit.test.mjs — WP4: block attribute/style edit op.
//
// editBlockAttributes() updates a block's own class/style on the RAW source
// without touching its inner HTML or its data-rev. Curated allowlists gate the
// values: in-list applies clean, out-of-list applies but FLAGS for the scope
// gate, and the rv-/rvb- namespaces plus unsafe characters HARD-FAIL. The
// agent payload validator accepts the new op; applyEdits threads it through the
// same all-or-nothing pipeline and surfaces the flags.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editBlockAttributes } from '../../runner/lib/surgery.mjs';
import { validateAgentPayload } from '../../runner/lib/agent.mjs';
import { applyEdits } from '../../runner/lib/apply.mjs';

const DOC = '<p data-rev="r-0001" class="lead">alpha <strong>bravo</strong></p>\n'
  + '<p data-rev="r-0002">plain</p>\n';

// ---- surgery: editBlockAttributes -----------------------------------------

test('sets an allowlisted style without touching the inner or data-rev', () => {
  const r = editBlockAttributes(DOC, 'r-0002', { style: 'text-align: center; color: red' });
  assert.equal(r.ok, true);
  assert.equal(r.flagged.length, 0);
  assert.match(r.source, /<p data-rev="r-0002" style="text-align: center; color: red">plain<\/p>/);
  assert.match(r.afterOpenTag, /data-rev="r-0002"/);
});

test('replaces an existing class attribute in place', () => {
  const r = editBlockAttributes(DOC, 'r-0001', { class: 'muted' });
  assert.equal(r.ok, true);
  assert.equal(r.flagged.length, 0);
  assert.match(r.source, /<p data-rev="r-0001" class="muted">alpha <strong>bravo<\/strong><\/p>/);
});

test('empty value removes the attribute', () => {
  const r = editBlockAttributes(DOC, 'r-0001', { class: '' });
  assert.equal(r.ok, true);
  assert.match(r.source, /<p data-rev="r-0001">alpha /);
  assert.doesNotMatch(r.afterOpenTag, /class=/);
});

test('out-of-allowlist style prop applies but is flagged', () => {
  const r = editBlockAttributes(DOC, 'r-0002', { style: 'color: blue; transform: rotate(3deg)' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.flagged.map((f) => ({ ...f })), [{ kind: 'style', name: 'transform' }]);
});

test('out-of-allowlist class applies but is flagged', () => {
  const r = editBlockAttributes(DOC, 'r-0002', { class: 'muted fancy' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.flagged.map((f) => ({ ...f })), [{ kind: 'class', name: 'fancy' }]);
});

test('rv-/rvb- classes are hard-blocked', () => {
  const a = editBlockAttributes(DOC, 'r-0002', { class: 'rv-card' });
  assert.equal(a.ok, false);
  assert.equal(a.code, 'forbidden-class');
  const b = editBlockAttributes(DOC, 'r-0002', { class: 'rvb-shell' });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'forbidden-class');
});

test('non class/style keys and unsafe characters are rejected', () => {
  assert.equal(editBlockAttributes(DOC, 'r-0002', { id: 'x' }).code, 'forbidden-attribute');
  assert.equal(editBlockAttributes(DOC, 'r-0002', { onclick: 'x' }).code, 'forbidden-attribute');
  assert.equal(editBlockAttributes(DOC, 'r-0002', { style: 'color: "red"' }).code, 'invalid-attribute');
  assert.equal(editBlockAttributes(DOC, 'r-0002', { class: 'a<b' }).code, 'invalid-attribute');
  assert.equal(editBlockAttributes(DOC, 'r-0002', {}).code, 'invalid-attribute');
});

test('an unknown block id fails', () => {
  assert.equal(editBlockAttributes(DOC, 'r-9999', { class: 'muted' }).code, 'unknown-block');
});

// ---- agent payload validation ---------------------------------------------

test('validateAgentPayload accepts attributeEdits and rejects bad shapes', () => {
  const base = { decisions: [{ id: 'c1', decision: 'addressed', summary: 's' }] };
  const ok = validateAgentPayload({ ...base, attributeEdits: [{ blockId: 'r-0001', style: 'color: red' }] });
  assert.deepEqual(ok.attributeEdits, [{ blockId: 'r-0001', style: 'color: red' }]);

  // class-only and both are fine
  assert.ok(validateAgentPayload({ ...base, attributeEdits: [{ blockId: 'r-0001', class: 'lead' }] }));
  // neither class nor style → null
  assert.equal(validateAgentPayload({ ...base, attributeEdits: [{ blockId: 'r-0001' }] }), null);
  // extra key → null
  assert.equal(validateAgentPayload({ ...base, attributeEdits: [{ blockId: 'r-0001', id: 'x' }] }), null);
  // non-string value → null
  assert.equal(validateAgentPayload({ ...base, attributeEdits: [{ blockId: 'r-0001', style: 5 }] }), null);
  // absent attributeEdits → empty array
  assert.deepEqual(validateAgentPayload(base).attributeEdits, []);
});

// ---- apply integration -----------------------------------------------------

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-attredit-'));
  await fs.writeFile(path.join(dir, 'doc.html'), `<!doctype html><body>\n${DOC}</body>\n`);
  return dir;
}

test('applyEdits writes an attribute edit and reports flags, all-or-nothing', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const r = await applyEdits({
    root, page: 'doc.html',
    attributeEdits: [{ blockId: 'r-0002', style: 'text-align: center; transform: scale(2)' }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.editRecords.length, 1);
  assert.equal(r.editRecords[0].op, 'attributes');
  assert.equal(r.editRecords[0].blockId, 'r-0002');
  assert.deepEqual(r.flagged.map((f) => ({ ...f })), [{ blockId: 'r-0002', kind: 'style', name: 'transform' }]);

  const onDisk = await fs.readFile(path.join(root, 'doc.html'), 'utf8');
  assert.match(onDisk, /<p data-rev="r-0002" style="text-align: center; transform: scale\(2\)">plain<\/p>/);
});

test('applyEdits leaves the doc untouched when an attribute edit is rejected', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await fs.readFile(path.join(root, 'doc.html'), 'utf8');

  const r = await applyEdits({
    root, page: 'doc.html',
    edits: [{ blockId: 'r-0001', newInner: 'edited alpha' }],
    attributeEdits: [{ blockId: 'r-0001', class: 'rv-oops' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'forbidden-class');
  const after = await fs.readFile(path.join(root, 'doc.html'), 'utf8');
  assert.equal(after, before, 'a rejected attribute edit rolls back the earlier inner edit too');
});

// ---- #289: `$` in an attribute value is DATA, never replacement syntax -----
//
// Found by the trust-layer review (#282) and reproduced by hand before it was
// believed. `setOpenTagAttr` used the agent's value as a String.replace
// REPLACEMENT STRING, where `$&`, `` $` ``, `$'`, `$1` and `$$` all have
// special meaning — and they expand AFTER UNSAFE_ATTR_CHARS has inspected the
// value and found it clean.
//
// Before the fix:
//   { class: 'a$&b' } -> <p data-rev="r-01" class="a class="x"b">hello</p>
//   and validateWrite() returned { ok: true }.
//
// An unbalanced quote written into a document, past the guard built to stop
// exactly that, with both validators agreeing it was fine. They are quote-
// aware, so they agreed with each other while disagreeing with the browser.
// Agreeing validators are not independent checks — which is the reason this
// test asserts the OUTPUT TEXT rather than asking a validator.

test('a $ sequence in an attribute value is written literally, never expanded', () => {
  const src = '<p data-rev="r-01" class="x">hello</p>';
  for (const value of ['a$&b', 'a$`b', "a$'b", 'a$1b', 'a$$b']) {
    const out = editBlockAttributes(src, 'r-01', { class: value });
    assert.equal(out.ok, true, `${value} should be writable`);
    assert.equal(out.source, `<p data-rev="r-01" class="${value}">hello</p>`,
      `${value} must land exactly as given`);
    // The specific old failure: the match text leaking into the value.
    assert.ok(!out.source.includes('class="x"b'), `${value} must not re-inject the old attribute`);
    // And the consequence that made it dangerous.
    assert.equal((out.source.match(/"/g) || []).length, 4,
      `${value} must not add quotes — an unbalanced quote is what escaped the guard`);
  }
});

test('a $ sequence is literal when the attribute is ABSENT too', () => {
  // The append branch built its replacement the same way. A block with no
  // class at all took the other path, so fixing only the first would have left
  // half the hole open.
  const out = editBlockAttributes('<p data-rev="r-01">hello</p>', 'r-01', { class: 'a$&b' });
  assert.equal(out.ok, true);
  assert.equal(out.source, '<p data-rev="r-01" class="a$&b">hello</p>');
});
