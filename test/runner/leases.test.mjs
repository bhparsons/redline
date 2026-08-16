// test/runner/leases.test.mjs — the run registry and block-lease ledger (#38).
//
// These pin the admission rules #121's acceptance criteria are written against:
// disjoint runs proceed, overlapping runs wait and can say WHICH run and WHICH
// block they wait on, a gated run keeps its leases, and a stale stash cannot be
// applied. The ledger is a standalone module precisely so these run without a
// server or an agent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunRegistry, PAGE, RUNNING, AWAITING } from '../../runner/lib/leases.mjs';

const PG = 'doc.html';

test('disjoint runs proceed; overlapping runs wait', async (t) => {
  await t.test('two runs on disjoint blocks both hold leases', () => {
    const reg = createRunRegistry();
    assert.equal(reg.acquire({ runId: 'a', page: PG, blocks: ['r-1', 'r-2'] }).ok, true);
    const b = reg.acquire({ runId: 'b', page: PG, blocks: ['r-8', 'r-9'] });
    assert.equal(b.ok, true, 'a comment on paragraph 9 does not wait on paragraph 4');
    assert.equal(reg.size, 2);
  });

  await t.test('an overlapping run is refused, and names the run and the block', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: PG, blocks: ['r-1', 'r-2'] });
    const b = reg.acquire({ runId: 'b', page: PG, blocks: ['r-2', 'r-3'] });
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'blocks-leased');
    assert.equal(b.runId, 'a', 'says which run it is waiting on');
    assert.deepEqual(b.blocks, ['r-2'], 'and which block is contended');
  });

  await t.test('runs on different pages never interact', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: 'one.html', blocks: ['r-1'] });
    assert.equal(reg.acquire({ runId: 'b', page: 'two.html', blocks: ['r-1'] }).ok, true);
  });

  await t.test('a refused run holds nothing — no lease leaks on the failed path', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });
    reg.acquire({ runId: 'b', page: PG, blocks: ['r-1'] });
    assert.equal(reg.has('b'), false);
    assert.equal(reg.size, 1);
    reg.release('a');
    assert.equal(reg.acquire({ runId: 'c', page: PG, blocks: ['r-1'] }).ok, true);
  });
});

test('page-exclusive leases', async (t) => {
  await t.test('PAGE blocks everything, and everything blocks PAGE', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: PG, blocks: PAGE });
    const b = reg.acquire({ runId: 'b', page: PG, blocks: ['r-1'] });
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'run-active');

    const reg2 = createRunRegistry();
    reg2.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });
    const c = reg2.acquire({ runId: 'c', page: PG, blocks: PAGE });
    assert.equal(c.ok, false);
    assert.equal(c.reason, 'run-active');
  });

  await t.test('a run naming no blocks has UNKNOWN reach and takes the page', () => {
    const reg = createRunRegistry();
    const a = reg.acquire({ runId: 'a', page: PG, blocks: [] });
    assert.equal(a.ok, true);
    assert.equal(a.run.blocks, PAGE, 'unknown reach is total, never "leases nothing"');
    assert.equal(reg.acquire({ runId: 'b', page: PG, blocks: ['r-1'] }).ok, false);
  });
});

test('a gated run keeps its leases', async (t) => {
  const reg = createRunRegistry();
  reg.acquire({ runId: 'a', page: PG, blocks: ['r-1', 'r-2'] });
  reg.markPending('a', { level: 'section', summary: 's' });

  await t.test('it still holds them — that is what the gate IS', () => {
    const b = reg.acquire({ runId: 'b', page: PG, blocks: ['r-2'] });
    assert.equal(b.ok, false);
    assert.equal(b.runId, 'a');
  });

  await t.test('the refusal reports awaiting-confirmation, not blocks-leased', () => {
    const b = reg.acquire({ runId: 'b', page: PG, blocks: ['r-2'] });
    assert.equal(b.reason, AWAITING,
      'the blocker a human can act on is the one worth naming');
  });

  await t.test('but it does not block disjoint work', () => {
    assert.equal(reg.acquire({ runId: 'c', page: PG, blocks: ['r-9'] }).ok, true,
      'a pending ask no longer freezes the whole page');
  });

  await t.test('a pending run is NOT counted as running', () => {
    const reg2 = createRunRegistry();
    reg2.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });
    reg2.markPending('a');
    const s = reg2.statusFor(PG);
    assert.equal(s.running, false, 'the #106 trap, preserved under leases');
    assert.equal(s.runs[0].state, AWAITING, 'runs[] carries the truth instead');
  });

  await t.test('resuming keeps the leases unbroken — no window to slip through', () => {
    const reg2 = createRunRegistry();
    reg2.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });
    reg2.markPending('a');
    reg2.resume('a');
    assert.equal(reg2.acquire({ runId: 'b', page: PG, blocks: ['r-1'] }).ok, false);
    assert.equal(reg2.statusFor(PG).running, true);
  });
});

test('covers(): the Allow-time re-base check', async (t) => {
  await t.test('a run covers the blocks it leased', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: PG, blocks: ['r-1', 'r-2'] });
    assert.equal(reg.covers('a', ['r-1']), true);
    assert.equal(reg.covers('a', ['r-1', 'r-2']), true);
  });

  await t.test('it does NOT cover a block it never leased — the stale-write guard', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });
    assert.equal(reg.covers('a', ['r-1', 'r-3']), false,
      'a stash reaching past its leases must be refused, never applied');
  });

  await t.test('a released run covers nothing', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });
    reg.release('a');
    assert.equal(reg.covers('a', ['r-1']), false);
  });

  await t.test('a PAGE lease covers any block set', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: PG, blocks: PAGE });
    assert.equal(reg.covers('a', ['r-1', 'r-99']), true);
  });
});

test('extend(): a run widens its lease once the dry run reveals its true reach', async (t) => {
  await t.test('uncontended extra blocks are granted', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });
    assert.equal(reg.extend('a', ['r-1', 'r-2']).ok, true);
    assert.deepEqual(reg.statusFor(PG).leases, { 'r-1': 'a', 'r-2': 'a' });
  });

  await t.test('a contended extension is refused and changes NOTHING', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });
    reg.acquire({ runId: 'b', page: PG, blocks: ['r-5'] });
    const r = reg.extend('a', ['r-5']);
    assert.equal(r.ok, false);
    assert.equal(r.runId, 'b');
    assert.deepEqual(reg.statusFor(PG).leases, { 'r-1': 'a', 'r-5': 'b' },
      'all-or-nothing: a refused extension leaves the original lease intact');
  });

  await t.test('a run never conflicts with itself', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: PG, blocks: ['r-1', 'r-2'] });
    assert.equal(reg.extend('a', ['r-1']).ok, true);
  });

  await t.test('escalating to PAGE needs an otherwise-empty page', () => {
    const reg = createRunRegistry();
    reg.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });
    assert.equal(reg.extend('a', PAGE).ok, true);

    const reg2 = createRunRegistry();
    reg2.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });
    reg2.acquire({ runId: 'b', page: PG, blocks: ['r-9'] });
    assert.equal(reg2.extend('a', PAGE).ok, false);
  });

  await t.test('extending an unknown run is refused, not a crash', () => {
    assert.equal(createRunRegistry().extend('nope', ['r-1']).ok, false);
  });
});

test('blockAvailable(): the direct-edit guard', async (t) => {
  const reg = createRunRegistry();
  reg.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });

  await t.test('an unleased block stays editable while a run is in flight', () => {
    assert.equal(reg.blockAvailable(PG, 'r-7').ok, true,
      "#38's promise: manual edits stay live on unleased blocks");
  });

  await t.test('a leased block is refused, naming its holder', () => {
    const r = reg.blockAvailable(PG, 'r-1');
    assert.equal(r.ok, false);
    assert.equal(r.runId, 'a');
  });
});

test('statusFor(): the lease-aware surface', async (t) => {
  const reg = createRunRegistry();
  reg.acquire({ runId: 'a', page: PG, blocks: ['r-1', 'r-2'], lane: 'standard' });
  reg.acquire({ runId: 'b', page: PG, blocks: ['r-8'], lane: 'tactical' });
  reg.markPending('b', { level: 'page', summary: 'touches the theme' });

  const s = reg.statusFor(PG);

  await t.test('reports which blocks are held and by which run', () => {
    assert.deepEqual(s.leases, { 'r-1': 'a', 'r-2': 'a', 'r-8': 'b' });
  });

  await t.test('carries per-run state so `running` is never the only signal', () => {
    assert.equal(s.running, true, 'a is executing');
    const byId = Object.fromEntries(s.runs.map((r) => [r.runId, r]));
    assert.equal(byId.a.state, RUNNING);
    assert.equal(byId.b.state, AWAITING);
    assert.deepEqual(byId.a.blocks, ['r-1', 'r-2']);
  });

  await t.test('keeps pendingConfirmation for the overlay #106 shipped', () => {
    assert.equal(s.pendingConfirmation.runId, 'b');
    assert.equal(s.pendingConfirmation.scope.level, 'page');
    assert.deepEqual(s.pendingConfirmation.blocks, ['r-8']);
  });

  await t.test('a page with no runs is empty, not absent', () => {
    const empty = createRunRegistry().statusFor(PG);
    assert.equal(empty.running, false);
    assert.deepEqual(empty.runs, []);
    assert.deepEqual(empty.leases, {});
    assert.equal(empty.pendingConfirmation, undefined);
  });

  await t.test('a page-exclusive lease surfaces under the PAGE key', () => {
    const reg2 = createRunRegistry();
    reg2.acquire({ runId: 'z', page: PG, blocks: PAGE });
    assert.deepEqual(reg2.statusFor(PG).leases, { [PAGE]: 'z' });
  });
});

test('registering the same runId twice is a bug, not a silent no-op', () => {
  const reg = createRunRegistry();
  reg.acquire({ runId: 'a', page: PG, blocks: ['r-1'] });
  assert.throws(() => reg.acquire({ runId: 'a', page: PG, blocks: ['r-5'] }), /already registered/);
});
