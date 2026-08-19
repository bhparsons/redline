// test/runner/overlay-undo-hidden.test.mjs — #311: the page-level Undo is
// hidden, and it stays hidden in the exact state that used to reveal it.
//
// The control was never broken; what it could not do is SAY which run it would
// revert. It is last-run-wins, so under a live watcher the run on top changes
// between reading the page and clicking. Blake hit this on a real screening
// document: he asked the watcher to undo an edit, the watcher did it through
// the MCP verb, and the header button then stood ready to revert an unrelated
// comment's run with nothing on screen naming it.
//
// This file boots the overlay in that state — a settled 'ok' run, a runner that
// is up, nothing running — and proves the button is unreachable. A weaker test
// that only asserted `UNDO_UI_ENABLED === false` in the source would pass with
// the flag read nowhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { boot, descendants } from './_overlay-boot.mjs';
import { EXT_DIR } from './_overlay-load.mjs';

const OK_RUN = {
  runId: 'run-1', lane: 'proposed', status: 'ok', commentId: 'c-1',
  edits: [{ blockId: 'r-0001', beforeInner: 'before', afterInner: 'after' }],
};

const COMMENT = {
  id: 'c-1', status: 'addressed', body: 'Change the titles to another colour.',
  anchor: { blockId: 'r-0001', quote: 'block r-0001 body text' },
  creator: 'human', createdAt: '2026-08-18T10:00:00.000Z', replies: [],
};

// Every visible Undo control in the panel, however it is nested.
function undoButtons(host) {
  return descendants(host).filter((n) => n.tag === 'BUTTON'
    && String(n._text || n.textContent || '').trim() === 'Undo');
}

function visible(node) {
  for (let n = node; n; n = n.parentElement) {
    if (n.classList && (n.classList.contains('rv-hidden') || n.classList.contains('rv-undo-off'))) return false;
  }
  return true;
}

test('the settled-ok state that used to reveal Undo no longer does', async () => {
  const ui = await boot({
    comments: [COMMENT],
    runs: [OK_RUN],
    status: { running: false, runs: [OK_RUN], lastRun: OK_RUN },
  });
  await ui.settle();
  const buttons = undoButtons(ui.host);
  assert.ok(buttons.length > 0, 'the control is hidden, not deleted — the flag must be able to bring it back');
  for (const b of buttons) {
    assert.equal(visible(b), false, 'no Undo control may be visible while #311 is open');
  }
});

test('a partial run does not reveal it either — both statuses were undoable', async () => {
  const partial = { ...OK_RUN, runId: 'run-2', status: 'partial' };
  const ui = await boot({
    comments: [COMMENT],
    runs: [partial],
    status: { running: false, runs: [partial], lastRun: partial },
  });
  await ui.settle();
  for (const b of undoButtons(ui.host)) {
    assert.equal(visible(b), false, 'partial was the second undoable status; it must be gated too');
  }
});

test('the flag is the only switch, and the click path is left intact behind it', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  assert.match(js, /const UNDO_UI_ENABLED = false;/,
    'the flag must stay a single named constant so reintroducing it is one edit');
  assert.match(js, /const canUndo = UNDO_UI_ENABLED/,
    'the reveal path must read the flag — not a second, drifting copy of the condition');
  assert.match(js, /undoBtn\.addEventListener\('click', \(\) => undoLastRun\(undoBtn\)\)/,
    'the handler stays wired: this is a hidden control, not a removed feature');
});

test('the runner still offers the targeted verbs the UI does not use yet', () => {
  const api = readFileSync(path.join(EXT_DIR, '..', 'runner', 'lib', 'api.mjs'), 'utf8');
  assert.match(api, /payload\.runId !== undefined/,
    'POST /api/undo {runId} is the per-run revert a future card affordance calls');
  assert.match(api, /payload\.expectRunId !== undefined/,
    'POST /api/undo {expectRunId} is the refuse-if-the-stack-moved guard');
});
