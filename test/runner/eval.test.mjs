// test/runner/eval.test.mjs — Phase 4: the eval harness.
//
// Covers the fixture-set invariants (22 fixtures: 4 per archetype + 2
// section-anchored, bodies
// that actually classify to their expected archetype, well-formed stub
// responses that pass the real surgery validation), the scoring logic
// component by component (including applied-cleanly re-validation through
// runner/lib/surgery.mjs), the similarity helper, and one harness smoke run
// in stub mode over a few fixtures — no real network anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, ARCHETYPES } from '../../runner/lib/classify.mjs';
import { validateAgentPayload } from '../../runner/lib/agent.mjs';
import { FIXTURES, buildDoc, COMMENT_ID_PLACEHOLDER } from '../../runner/eval/fixtures.mjs';
import { score, similarity, COMPONENTS } from '../../runner/eval/score.mjs';

const execFileP = promisify(execFile);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A well-behaved outcome for a fixture: exactly what the run flow produces
// when the agent returns the fixture's own stubResponse.
function perfectOutcome(fixture, commentId = 'c-abcdef012345') {
  const payload = JSON.parse(
    JSON.stringify(fixture.stubResponse).split(COMMENT_ID_PLACEHOLDER).join(commentId));
  return {
    archetype: fixture.expectedArchetype,
    status: 'ok',
    decisions: payload.decisions,
    edits: payload.edits,
  };
}

// --- fixture-set invariants ----------------------------------------------------

test('fixture set invariants', async (t) => {
  await t.test('22 fixtures, >=4 per archetype, 2 section cases, unique names and block ids', () => {
    assert.equal(FIXTURES.length, 22);
    for (const archetype of ARCHETYPES) {
      assert.ok(FIXTURES.filter((f) => f.expectedArchetype === archetype).length >= 4, archetype);
    }
    const sections = FIXTURES.filter((f) => Array.isArray(f.expectedBlockIds));
    assert.equal(sections.length, 2, 'two section-anchored fixtures (WP2/WP5)');
    for (const f of sections) {
      assert.ok(f.blockHtml.startsWith('<section'), `${f.name}: anchors to a <section>`);
      for (const id of f.expectedBlockIds) {
        assert.ok(f.blockHtml.includes(`data-rev="${id}"`), `${f.name}: child id ${id} present`);
      }
    }
    assert.equal(new Set(FIXTURES.map((f) => f.name)).size, 22, 'names unique');
    assert.equal(new Set(FIXTURES.map((f) => f.expectedBlockId)).size, 22, 'block ids unique');
  });

  await t.test('every body classifies to its expected archetype', () => {
    for (const f of FIXTURES) {
      assert.equal(classify(f.body), f.expectedArchetype, `${f.name}: "${f.body}"`);
    }
  });

  await t.test('every blockHtml carries its expected data-rev id and builds an ASCII doc', () => {
    for (const f of FIXTURES) {
      assert.ok(f.blockHtml.includes(`data-rev="${f.expectedBlockId}"`), f.name);
      assert.match(buildDoc(f.blockHtml), /^[\x00-\x7F]*$/, `${f.name}: doc is ASCII-only`);
    }
  });

  await t.test('every stubResponse is a valid agent payload with the expected decision', () => {
    for (const f of FIXTURES) {
      const validated = validateAgentPayload(f.stubResponse);
      assert.notEqual(validated, null, `${f.name}: stubResponse passes agent validation`);
      assert.equal(validated.decisions.length, 1, `${f.name}: exactly one decision`);
      assert.equal(validated.decisions[0].id, COMMENT_ID_PLACEHOLDER, f.name);
      assert.equal(validated.decisions[0].decision, f.expectedDecision, f.name);
      if (f.expectsEdit) {
        assert.ok(validated.edits.length > 0, `${f.name}: expectsEdit fixtures stub an edit`);
        const allowed = f.expectedBlockIds ?? [f.expectedBlockId];
        assert.ok(validated.edits.every((e) => allowed.includes(e.blockId)), f.name);
      } else {
        assert.equal(validated.edits.length, 0, `${f.name}: no-edit fixtures stub no edits`);
        assert.equal(f.expectedInnerPattern, null, f.name);
      }
    }
  });

  await t.test('every stubResponse scores a perfect 1.0 (the offline ceiling)', () => {
    for (const f of FIXTURES) {
      const { score: s, breakdown, notes } = score(f, perfectOutcome(f));
      assert.equal(s, 1, `${f.name}: ${JSON.stringify({ breakdown, notes })}`);
    }
  });
});

// --- scoring components ----------------------------------------------------------

test('score components', async (t) => {
  const editFixture = FIXTURES.find((f) => f.name === 'tactical-typo');
  const noEditFixture = FIXTURES.find((f) => f.name === 'tactical-ambiguous-decline');

  await t.test('wrong archetype loses exactly the archetype component', () => {
    const outcome = { ...perfectOutcome(editFixture), archetype: 'content' };
    const { score: s, breakdown } = score(editFixture, outcome);
    assert.equal(breakdown.archetype, 0);
    assert.equal(s, 0.8);
  });

  await t.test('missing or invalid decision zeroes the decision component', () => {
    for (const decisions of [[], [{ id: 'c-1', decision: 'done', summary: 's' }],
      [{ id: 'c-1', decision: 'addressed', summary: '' }], undefined]) {
      const outcome = { ...perfectOutcome(editFixture), decisions };
      assert.equal(score(editFixture, outcome).breakdown.decision, 0, JSON.stringify(decisions));
    }
  });

  await t.test('valid but unexpected decision earns half credit', () => {
    const outcome = perfectOutcome(editFixture);
    outcome.decisions = [{ ...outcome.decisions[0], decision: 'deferred' }];
    assert.equal(score(editFixture, outcome).breakdown.decision, 0.5);
  });

  await t.test('edit to the wrong block zeroes blockId and appliedCleanly', () => {
    const outcome = perfectOutcome(editFixture);
    outcome.edits = [{ blockId: 'r-elsewhere', newInner: 'nope' }];
    const { breakdown } = score(editFixture, outcome);
    assert.equal(breakdown.blockId, 0);
    assert.equal(breakdown.editSimilarity, 0, 'no edit targets the expected block');
    assert.equal(breakdown.appliedCleanly, 0, 'unknown block fails real surgery');
  });

  await t.test('expected edit absent zeroes blockId, similarity, and appliedCleanly', () => {
    const outcome = { ...perfectOutcome(editFixture), edits: [] };
    const { breakdown } = score(editFixture, outcome);
    assert.equal(breakdown.blockId, 0);
    assert.equal(breakdown.editSimilarity, 0);
    assert.equal(breakdown.appliedCleanly, 0);
  });

  await t.test('spurious edit on a no-edit fixture is penalized', () => {
    const outcome = perfectOutcome(noEditFixture);
    outcome.edits = [{ blockId: noEditFixture.expectedBlockId, newInner: 'Plan A costs $50 per seat.' }];
    const { breakdown } = score(noEditFixture, outcome);
    assert.equal(breakdown.blockId, 0);
    assert.equal(breakdown.editSimilarity, 0);
    assert.equal(breakdown.appliedCleanly, 1, 'the edit itself is applicable, just unwanted');
  });

  await t.test('unbalanced inner HTML fails appliedCleanly through real surgery', () => {
    const outcome = perfectOutcome(editFixture);
    outcome.edits = [{ blockId: editFixture.expectedBlockId, newInner: 'broken <em>markup' }];
    const { breakdown, notes } = score(editFixture, outcome);
    assert.equal(breakdown.appliedCleanly, 0);
    assert.ok(notes.some((n) => n.includes('unbalanced')), notes.join('; '));
  });

  await t.test('data-rev tampering fails appliedCleanly through real surgery', () => {
    const outcome = perfectOutcome(editFixture);
    outcome.edits = [{
      blockId: editFixture.expectedBlockId,
      newInner: '<span data-rev="r-smuggled">You will receive a confirmation email.</span>',
    }];
    const { breakdown, notes } = score(editFixture, outcome);
    assert.equal(breakdown.appliedCleanly, 0);
    assert.ok(notes.some((n) => n.includes('data-rev-tampered')), notes.join('; '));
  });

  await t.test('run-record edit shape (afterInner) is accepted like agent shape (newInner)', () => {
    const outcome = perfectOutcome(editFixture);
    outcome.edits = [{
      blockId: editFixture.expectedBlockId,
      beforeInner: 'You will recieve a confirmation email within two days.',
      afterInner: 'You will receive a confirmation email within two days.',
    }];
    assert.equal(score(editFixture, outcome).score, 1);
  });

  await t.test('garbage outcomes score 0 without throwing', () => {
    for (const outcome of [undefined, null, {}, { decisions: 'x', edits: 'y' }]) {
      const { score: s } = score(editFixture, outcome);
      assert.equal(s, 0, JSON.stringify(outcome ?? String(outcome)));
    }
  });

  await t.test('breakdown always carries every component in 0..1', () => {
    const { breakdown } = score(editFixture, perfectOutcome(editFixture));
    assert.deepEqual(Object.keys(breakdown).sort(), [...COMPONENTS].sort());
    for (const v of Object.values(breakdown)) assert.ok(v >= 0 && v <= 1);
  });
});

test('similarity helper', () => {
  assert.equal(similarity('abc', 'abc'), 1);
  assert.equal(similarity('', 'abc'), 0);
  assert.equal(similarity('abcd', 'abcX'), 0.75);
  const near = similarity('The beta launched in 2025.', 'The beta launched in 2024.');
  const far = similarity('The beta launched in 2025.', 'Something else entirely!');
  assert.ok(near > far, 'closer strings score higher');
  assert.ok(near > 0.9 && far < 0.5);
});

// --- harness smoke (stub mode, a few fixtures) -----------------------------------

test('harness smoke: stub mode end to end', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-eval-out-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const outPath = path.join(outDir, 'results.json');

  // Scrub OPENROUTER_* so a developer's real credentials can't reach the run
  // (the harness scrubs too — this keeps the test hermetic either way).
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.OPENROUTER_ENDPOINT;

  const { stdout } = await execFileP(process.execPath,
    [path.join(REPO_ROOT, 'runner', 'eval', 'run.mjs'), '--only', 'tactical', '--out', outPath],
    { env, timeout: 60_000 });

  assert.ok(stdout.includes('mode=stub'), 'stub mode announced');
  assert.ok(stdout.includes('tier standard: 100.0%'), `stub fixtures score perfectly:\n${stdout}`);
  assert.ok(stdout.includes('tactical-typo'), 'per-fixture rows printed');

  const results = JSON.parse(await fs.readFile(outPath, 'utf8'));
  assert.equal(results.mode, 'stub');
  const tier = results.tiers.standard;
  assert.equal(tier.overall, 1);
  assert.equal(typeof tier.model, 'string');
  assert.equal(tier.fixtures.length, 4, 'the four tactical fixtures ran');
  for (const r of tier.fixtures) {
    assert.equal(r.runStatus, 'ok', `${r.name} run completed through the real pipeline`);
    assert.equal(r.score, 1, r.name);
    assert.equal(r.actualArchetype, 'tactical', r.name);
    assert.ok(Number.isFinite(r.latencyMs) && r.latencyMs >= 0, `${r.name}: latency recorded`);
    assert.ok(Number.isFinite(r.estCostUsd) && r.estCostUsd > 0, `${r.name}: cost estimated`);
  }
  assert.equal(tier.perArchetype.tactical.quality, 1);
  assert.ok(Number.isFinite(tier.perArchetype.tactical.avgLatencyMs));
  assert.ok(Number.isFinite(tier.perArchetype.tactical.avgCostUsd));
});

test('harness smoke: --tier all compares simple against the reference', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-eval-tiers-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const outPath = path.join(outDir, 'results.json');
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.OPENROUTER_ENDPOINT;

  const { stdout } = await execFileP(process.execPath,
    [path.join(REPO_ROOT, 'runner', 'eval', 'run.mjs'),
      '--tier', 'all', '--only', 'tactical-typo', '--out', outPath],
    { env, timeout: 90_000 });

  assert.ok(stdout.includes('tier: simple'), 'simple tier ran');
  assert.ok(stdout.includes('tier: complex'), 'complex tier ran');
  assert.ok(stdout.includes('simple vs standard'), 'comparison printed');

  const results = JSON.parse(await fs.readFile(outPath, 'utf8'));
  assert.deepEqual(Object.keys(results.tiers).sort(), ['complex', 'simple', 'standard']);
  assert.notEqual(results.tiers.simple.model, results.tiers.complex.model, 'tiers pin different models');
  const c = results.comparison.tactical;
  assert.equal(c.pass, true, 'stub runs: simple matches reference exactly');
  assert.equal(c.ratio, 1);
});

test('harness refuses --live without a key and unknown flags', async () => {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.OPENROUTER_ENDPOINT;
  const runMjs = path.join(REPO_ROOT, 'runner', 'eval', 'run.mjs');

  await assert.rejects(
    () => execFileP(process.execPath, [runMjs, '--live'], { env, timeout: 20_000 }),
    (err) => {
      assert.equal(err.code, 1);
      assert.ok(err.stderr.includes('OPENROUTER_API_KEY'));
      return true;
    });

  await assert.rejects(
    () => execFileP(process.execPath, [runMjs, '--frobnicate'], { env, timeout: 20_000 }),
    (err) => err.code === 1);
});
