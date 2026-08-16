// test/runner/overlay-attribution.test.mjs — WP1: author attribution.
//
// The overlay only runs in Chrome, but its pure module-level helpers are
// exposed on window.__rvTest so node can execute them against a tiny DOM
// stub. authorChip() is the one surface WP1 adds: an agent author gets a
// chip; a human (or unattributed) author gets none. The same helper serves
// comments, replies, and the run strip's run.actor (identical {creator,
// agentName} shape).

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOverlay as loadOverlaySet } from './_overlay-load.mjs';


// Minimal element/document stubs: enough for el() and authorChip().
function makeElement(tag) {
  return {
    tag, className: '', textContent: '', title: '', children: [],
    appendChild(child) { this.children.push(child); return child; },
    setAttribute() {}, addEventListener() {},
  };
}

const loadOverlay = () => loadOverlaySet({ createElement: makeElement });

test('authorChip names an agent author with its agentName', () => {
  const { authorChip } = loadOverlay();
  const chip = authorChip({ creator: 'agent', agentName: 'claude-code' });
  assert.ok(chip, 'agent author gets a chip');
  assert.equal(chip.textContent, 'claude-code');
  assert.match(chip.className, /\brv-author-chip\b/);
  assert.match(chip.className, /\brv-chip-agent\b/);
  assert.equal(chip.title, 'Authored by claude-code');
});

test('authorChip falls back to "agent" when agentName is missing', () => {
  const { authorChip } = loadOverlay();
  const chip = authorChip({ creator: 'agent' });
  assert.ok(chip);
  assert.equal(chip.textContent, 'agent');
});

test('human and unattributed authors get no chip', () => {
  const { authorChip } = loadOverlay();
  assert.equal(authorChip({ creator: 'human' }), null);
  assert.equal(authorChip({}), null, 'absent creator means human');
  assert.equal(authorChip(null), null);
  assert.equal(authorChip(undefined), null);
});

test('a run.actor drives the same chip', () => {
  const { authorChip } = loadOverlay();
  const chip = authorChip({ creator: 'agent', agentName: 'codex' });
  assert.equal(chip.textContent, 'codex');
});

// #236: scopeGateChip names a run's scope-gate outcome — the fact that
// distinguishes a run the gate stopped-and-a-human-allowed from one that
// never touched the gate at all. Same {creator/agentName}-shaped precedent as
// authorChip: null is the correct rendering for the common case, not a gap.
test('scopeGateChip badges a run the gate fired on and the author allowed', () => {
  const { scopeGateChip } = loadOverlay();
  const chip = scopeGateChip({ status: 'ok', lane: 'confirmed', scopeGate: { fired: true, level: 'section' } });
  assert.ok(chip, 'a run the gate stopped and a human allowed must carry a chip');
  assert.equal(chip.textContent, 'scope gate: allowed by you');
  assert.match(chip.className, /\brv-chip-gate-allowed\b/);
});

test('scopeGateChip badges a declined confirmation, distinctly from "allowed"', () => {
  const { scopeGateChip } = loadOverlay();
  const chip = scopeGateChip({ status: 'declined', lane: 'declined' });
  assert.ok(chip);
  assert.equal(chip.textContent, 'scope gate: declined');
  assert.match(chip.className, /\brv-chip-gate-declined\b/);
  assert.doesNotMatch(chip.className, /\brv-chip-gate-allowed\b/, 'the two outcomes must never share a class');
});

test('a run the gate never paused gets no chip — absence, not a false "allowed"', () => {
  const { scopeGateChip } = loadOverlay();
  // The gate ran a dry-run and logged fired:false (every run does, since the
  // runner fix) — that MUST NOT read as "allowed at a checkpoint", because
  // nothing was ever stopped for a human to allow.
  assert.equal(scopeGateChip({ status: 'ok', lane: 'standard', scopeGate: { fired: false } }), null);
  assert.equal(scopeGateChip({ status: 'ok', lane: 'standard' }), null, 'no scopeGate at all is also "never gated"');
  assert.equal(scopeGateChip(null), null);
  assert.equal(scopeGateChip(undefined), null);
});

test('formatCost renders cents and sub-cent precision', () => {
  const { formatCost } = loadOverlay();
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(0.0234), '$0.02');
  assert.equal(formatCost(0.0004), '$0.0004');
  assert.equal(formatCost(1.5), '$1.50');
  assert.equal(formatCost(null), '');
});
