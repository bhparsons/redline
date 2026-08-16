// test/runner/overlay-watching-hint.test.mjs — #254: the already-watching
// reassurance moves from an after-the-fact strip to a HOVER state on Send.
//
// With a watcher attached and hold off, Send dispatches nothing — the watcher
// already subscribes to the stream. The author should learn that while
// reaching for the button, not after clicking it. Source-read assertions, in
// the house style of overlay-offline.test.mjs: the states involved (live
// presence, hold) take more harness than the wiring is worth.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXT_DIR } from './_overlay-load.mjs';

const js = () => readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');

test('explainWhileLive exists and never disables its control', () => {
  const src = js();
  const fn = src.slice(src.indexOf('function explainWhileLive'), src.indexOf('function refuseWhenDown'));
  assert.ok(fn.includes("el('span', 'rv-explain rv-explaining')"), 'same capsule wrap as a refusal');
  assert.ok(fn.includes('armCapsule(wrap, control)'), 'raised on approach like a refusal');
  assert.ok(!fn.includes('disabled'), 'but the control stays LIVE — that is the whole point');
});

test('Send all hovers the watching hint when a watcher is live and hold is off', () => {
  const src = js();
  assert.match(src, /const watching = hasWatcher && !runnerDown && sendable\.length > 0\s*\n\s*&& !\(holdNow && holdNow\.on\) && !isRunning\(\);/,
    'the hint fires only in the exact no-op case: watcher live, hold off, something sendable');
  assert.match(src, /setCapsuleWhy\(sendAllWrap, 'The watcher already sees these comments',/);
  // Hold-on and no-watcher keep their existing treatments.
  assert.match(src, /setCapsuleWhy\(sendAllWrap, 'No watcher attached', 'Attach a Claude Code or Codex session'\)/);
  assert.match(src, /Hand \$\{sendable\.length\} open comment/, 'the hold-on handover title survives');
});

test('the per-card Send now carries the same hover hint', () => {
  const src = js();
  assert.match(src, /explainWhileLive\(send, 'The watcher already sees this comment',/);
});

test('clicking NUDGES for real, with a receipt (#254 amended, Blake, same day)', () => {
  const src = js();
  // The silent no-op read as "run keeps failing" in the same acceptance
  // sitting that chose it, so #254 was amended: Send now touches each sent
  // comment's status (open → open bumps the COMMENT's rev — the new-work
  // signal conforming watchers key on) and the subdued handover strip is the
  // receipt. The old always-on watching strip stays gone.
  assert.ok(!src.includes("kind: 'watching'"), 'no watching outcome is ever built');
  assert.ok(!src.includes('Already with the watcher'), 'and no acknowledgement text remains');
  const fn = src.slice(src.indexOf('async function startRun'), src.indexOf('async function settleRun'));
  assert.match(fn, /status: 'open' \}\);/, 'each sent comment gets the rev-bumping touch');
  assert.match(fn, /kind: 'handover', count: commentIds\.length, heldRelease/,
    'the handover strip is the receipt, hold released or not');
  assert.match(src, /nudged to the watcher/, 'and it says what actually happened');
});
