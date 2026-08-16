// test/runner/overlay-resync-guard.test.mjs — #228 (V1 decision 4): the first
// refresh of a page with no runs must NOT rewrite the DOM.
//
// The live failure (issue #228, and the "redlining a mock breaks it" session):
// a page script fills stamped blocks on load; refresh() sees a never-seen
// docSignature (null → ''), runs syncDocument, and every script-written block
// is silently replaced with the disk source — the mock renders blank, with no
// error anywhere. First sight of a no-runs page has nothing to catch up on:
// the tab just loaded the same bytes the runner serves.
//
// Booted, not read: the observable for the sync pass is the /api/source fetch
// (the stub records every call), plus the script-written text surviving.

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_overlay-boot.mjs';

const sourceFetches = (app) =>
  app.state.calls.filter((u) => u.includes('/api/source')).length;

test('first refresh of a page with no runs fetches no source and rewrites nothing', async () => {
  const app = boot({ comments: [] });
  // The "page script": content written into a stamped block after load,
  // before the overlay's first refresh settles.
  const block = app.document.querySelector('[data-rev="r-0001"]');
  block.textContent = 'rendered by the page script';
  await app.settle();

  assert.equal(sourceFetches(app), 0, 'no /api/source fetch — the sync pass never ran');
  assert.equal(block.textContent, 'rendered by the page script',
    'the script-written content survived first load');
});

test('a genuine remote change (signature moved, runs present) still syncs', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  assert.equal(sourceFetches(app), 0, 'baseline: no sync yet');

  // A run lands in another tab: lastRun appears and rev moves.
  app.state.status.lastRun = { runId: 'run-1', status: 'ok' };
  app.state.rev += 1;
  await app.tick();

  assert.equal(sourceFetches(app), 1, 'the moved signature triggered exactly one sync');

  // And the signature is remembered — the next unchanged tick does not re-sync.
  app.state.rev += 1; // a comment written elsewhere bumps rev without a new run
  await app.tick();
  assert.equal(sourceFetches(app), 1, 'same run record, no second source fetch');
});

test('a page that ALREADY has runs syncs on first sight, as before', async () => {
  const app = boot({ comments: [], status: { lastRun: { runId: 'run-0', status: 'ok' } } });
  await app.settle();
  assert.equal(sourceFetches(app), 1,
    'a non-empty signature on first sight is real drift risk — the guard is only for the no-runs case');
});
