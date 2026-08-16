// test/runner/contract-trim.test.mjs — #83 part 1: the agent contract stops
// asking the model to self-verify what the runner already enforces.
//
// The rule the trim ran on is NOT "the server checks it, so cut it". It is:
//
//   REPAIRED by the server  → cut. The model cannot get it wrong.
//   REJECTED by the server  → KEEP. A rejection fails the whole run and the
//                             author still pays for the call, so the sentence
//                             that prevents it earns its tokens many times over.
//   Not checked at all      → KEEP, obviously.
//
// Exactly one class of check is repaired: the ASCII/entity invariant.
// Every agent-supplied string goes through encodeEntities before it reaches
// the source (surgery.mjs replaceBlockInner / insertSiblingBlock /
// editBlockAttributes), so a raw non-ASCII character is converted, not
// refused. That instruction is now gone from the always-loaded skills pack and
// from the tactical prompt. Tag balance, `<`/`>`/`&` escaping, block-id
// existence and the data-rev guard all stay: those FAIL a run.
//
// The other half of the trim is duplication. runner/skills/default.md renders
// into {{CONTEXT}}, which sits AFTER the cache breakpoint — full price on every
// run — while runner/prompts/revise.md's contract sits before it and bills at
// the cached rate. So a rule stated in both places was being paid for twice, at
// the more expensive rate in the copy nobody needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_BREAKPOINT_MARKER, MIN_CACHE_PREFIX_CHARS } from '../../runner/lib/agent.mjs';
import { replaceBlockInner, validateWrite, isAsciiOnly } from '../../runner/lib/surgery.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFile(path.join(REPO_ROOT, rel), 'utf8');

// --- the cut is only safe because the server actually repairs it -------------

test('the ASCII invariant is REPAIRED server-side, not merely refused', () => {
  const doc = '<!doctype html>\n<html><body><p data-rev="r-0001">plain</p></body></html>\n';
  assert.equal(isAsciiOnly(doc), true, 'fixture is an ASCII/entities-only document');

  // Exactly what the cut instruction told the agent not to do.
  const raw = 'a curly ’quote’, an em—dash and an ellipsis…';
  const out = replaceBlockInner(doc, 'r-0001', raw);

  assert.equal(out.ok, true, 'raw non-ASCII is accepted, not rejected');
  assert.equal(isAsciiOnly(out.afterInner), true, 'and comes back entity-encoded');
  assert.ok(out.afterInner.includes('&rsquo;') && out.afterInner.includes('&mdash;')
    && out.afterInner.includes('&hellip;'), out.afterInner);
  assert.deepEqual(validateWrite(doc, out.source), { ok: true },
    'the doc-wide ASCII backstop passes because the repair already happened');
});

test('tag balance is REJECTED, not repaired — which is why its rule stays', () => {
  const doc = '<!doctype html>\n<html><body><p data-rev="r-0001">plain</p></body></html>\n';
  assert.equal(replaceBlockInner(doc, 'r-0001', '<em>oops').code, 'unbalanced');
  assert.equal(replaceBlockInner(doc, 'r-0002', 'no such block').code, 'unknown-block');
  assert.equal(replaceBlockInner(doc, 'r-0001', '<span data-rev="r-9">x</span>').code,
    'data-rev-tampered');
});

// --- what the prompts must and must not say now ------------------------------

test('the always-loaded skills pack drops the server-repaired ritual', async () => {
  const pack = await read('runner/skills/default.md');

  for (const gone of [/non-ASCII/i, /entity discipline/i, /&amp;mdash;/]) {
    assert.equal(gone.test(pack), false,
      `default.md must not re-state the entity/ASCII rule the server repairs: ${gone}`);
  }
  // Duplicated by the CACHED contract in revise.md, so the expensive copy goes.
  assert.equal(/Never alter, remove, or invent `data-rev`/.test(pack), false,
    'the data-rev rule is stated in the cached contract; do not pay for it twice');
  assert.equal(/Never guess at markup you have not seen/.test(pack), false,
    'also stated in the cached contract');

  // The rules a rejection would cost a paid run over, or that nothing checks.
  assert.match(pack, /balanced/, 'tag balance survives (a rejection, not a repair)');
  assert.match(pack, /Escape a literal/, 'entity-escaping `<` `>` `&` survives (never checked)');
  assert.match(pack, /`<script>`\/`<style>`/, 'the markup-minimalism rule survives (never checked)');
  assert.match(pack, /byte-for-byte/, 'least-change survives (never checked)');
  assert.match(pack, /smuggle a structural addition/,
    'inserts-vs-inner survives: nesting a <p> inside a <p> is balanced, so nothing catches it');

  assert.ok(pack.length < 1200, `pack trimmed from 1,760 chars, got ${pack.length}`);
});

test('the tactical prompt drops the same repaired rule and keeps the rest', async () => {
  const tactical = await read('runner/prompts/tactical.md');
  assert.equal(/non-ASCII/i.test(tactical), false, 'server entity-encodes it');
  assert.match(tactical, /Never alter, remove, or invent `data-rev`/,
    'tactical never sees the revise contract, so its own copy has to stay');
  assert.match(tactical, /balanced markup/);
  assert.match(tactical, /Escape a literal/);
});

test('the revise contract drops only what the payload schema makes impossible', async () => {
  const revise = await read('runner/prompts/revise.md');

  // validateAgentPayload rejects any attributeEdit key but blockId/class/style,
  // and editBlockAttributes refuses the same — there is no channel through
  // which an attributeEdit could name data-rev, so saying so is dead text.
  assert.equal(/`data-rev` is never editable/.test(revise), false);
  // `theme` is a single JSON string field; two of them cannot exist.
  assert.equal(/At most one `"theme"` per run/.test(revise), false);

  // Everything the server can only REFUSE stays stated.
  for (const kept of [
    /Only emit edits for blocks whose `data-rev` id appears/,  // unknown-block
    /at most ONE edit per block/,                              // silent overwrite, unchecked
    /Never alter, remove, or invent `data-rev` attributes/,    // data-rev-tampered
    /`rv-`\/`rvb-` class namespaces are forbidden/,            // forbidden-class
    /NO selectors, braces/,                                    // invalid-theme
    /MUST carry a `src`/,                                      // invalid-insert
    /NO `data-rev` attribute anywhere/,                        // data-rev-tampered
  ]) {
    assert.match(revise, kept, `contract must keep a rule the server can only refuse: ${kept}`);
  }
});

// --- the trim must not cost us prompt caching (#123) -------------------------

test('the trimmed contract still clears the cache floor with room to spare', async () => {
  const revise = await read('runner/prompts/revise.md');
  const cut = revise.indexOf(CACHE_BREAKPOINT_MARKER) + CACHE_BREAKPOINT_MARKER.length;

  assert.ok(cut > MIN_CACHE_PREFIX_CHARS,
    `prefix must stay above the ${MIN_CACHE_PREFIX_CHARS}-char floor, got ${cut}`);
  // Deliberate margin, not a bare pass: below the floor cacheBreakpoint returns
  // null and every run silently stops caching. The trim spent 65 of ~2,700
  // chars of headroom; a future edit that spends the rest should fail here
  // rather than in the billing.
  assert.ok(cut > MIN_CACHE_PREFIX_CHARS + 2000,
    `prefix headroom is thin (${cut - MIN_CACHE_PREFIX_CHARS} chars) — caching is about to stop`);
});
