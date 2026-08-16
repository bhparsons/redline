// test/runner/overlay-presence.test.mjs — who is watching, and hold (#191,
// #196 slices 2 and 3).
//
// Without this the whole phase is invisible: block leases and hold mode are
// both real and neither leaves a mark, so a user's experience of them is a
// paragraph that mysteriously will not accept an edit and a document where
// nothing happens. Invisible locking is locking nobody trusts.
//
// The strongest case on record for the health half: a watching session's
// listener died with the runner and stayed dead. From the panel, a watcher with
// nothing to do and a watcher that had silently stopped were the same picture —
// no banner, no motion, comments sitting open. Roughly an hour lost. A lapsed
// `expiresAt` is the only thing that tells them apart, so these tests drive an
// expiry and assert the panel says so.
//
// Every test boots the overlay and drives state through the fetch stub. None
// reads overlay.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_overlay-boot.mjs';

const ANCHORED = (n) => ({
  id: `c-${n}`, body: `comment ${n}`, anchor: { blockId: `r-000${n}`, quote: `q${n}` },
  status: 'open', createdAt: '2026-08-02T10:00:00Z', creator: 'human', replies: [],
});

const CLAIM = (over = {}) => ({
  page: '/spec.html', agentName: 'claude-code', pid: 4242,
  claimedAt: '2026-08-02T10:00:00Z',
  expiresAt: Date.now() + 60000, ttlMs: 60000,
  ...over,
});

const HOLD = (over = {}) => ({
  on: false, since: null, heldCount: 0, heldCommentIds: [], lastRelease: null, ...over,
});

const holds = (app) => app.state.posted.filter((p) => p.url.endsWith('/api/hold'));

// ---- decision 20: absence is the DEFAULT --------------------------------

test('no attached session shows NOTHING — absence of an agent is not a problem', async () => {
  const app = boot({ comments: [ANCHORED(1)], status: { session: null, hold: HOLD() } });
  await app.settle();
  assert.equal(app.bannerText(), '', 'the slot is empty, which is the state you are in most of the time');
});

test('an attached session is a small green banner that NAMES it and shows a heartbeat age', async () => {
  const app = boot({
    comments: [ANCHORED(1)],
    status: { session: CLAIM({ expiresAt: Date.now() + 45000, ttlMs: 60000 }), hold: HOLD() },
  });
  await app.settle();

  assert.match(app.bannerText(), /claude-code/, 'named — "an agent" would not be actionable');
  assert.match(app.bannerText(), /is watching/);
  assert.ok(app.banner().classList.contains('rv-abn-live'), 'green: an agent is attached');
  // The age is what makes the green honest. A name alone cannot tell watching
  // from wedged, and 15s here is now - (expiresAt - ttlMs).
  assert.match(app.banner().querySelector('.rv-abn-age').textContent, /^1[45]s$/);
});

test('the indicator lives below the filters and above the first section — ONE slot', async () => {
  const app = boot({ comments: [ANCHORED(1)], status: { session: CLAIM(), hold: HOLD() } });
  await app.settle();

  const panel = app.host.querySelector('.rv-panel');
  const kids = panel.children;
  const header = kids.findIndex((k) => k.classList.contains('rv-panel-header'));
  const abn = kids.findIndex((k) => k.classList.contains('rv-abn'));
  const cards = kids.findIndex((k) => k.classList.contains('rv-cards'));
  assert.ok(header < abn && abn < cards, 'header (with the filters), then the banner, then the cards');
  assert.ok(header >= 0 && panel.querySelector('.rv-filters'), 'the filters really are in that header');
  assert.equal(app.host.querySelectorAll('.rv-abn').length, 1, 'exactly one indicator, never a stack');
});

// ---- decision 21: hold lives INSIDE the banner --------------------------

test('hold rides inside the agent banner, not beside it', async () => {
  const app = boot({ comments: [], status: { session: CLAIM(), hold: HOLD() } });
  await app.settle();

  const row = app.banner().querySelector('.rv-abn-hold');
  assert.ok(row, 'the switch is a child of the banner — it cannot be stranded');
  assert.match(row.textContent, /Hold new comments/);
});

test('flipping the switch turns hold on through the runner', async () => {
  const app = boot({ comments: [], status: { session: CLAIM(), hold: HOLD() } });
  await app.settle();

  app.banner().querySelector('.rv-abn-sw').fire('click');
  await app.settle();

  assert.equal(holds(app).length, 1);
  assert.deepEqual(holds(app)[0].body, { page: '/spec.html', hold: true });
});

test('hold on names the count, and the count means HELD BACK SINCE hold went on', async () => {
  // Decision 15: hold gates intake only. Anything already released is in the
  // agent's hands and keeps moving, so the number can never mean "not yet
  // done" — and the banner has to say which it is.
  const app = boot({
    comments: [],
    status: {
      session: CLAIM(),
      hold: HOLD({ on: true, since: '2026-08-02T10:12:00Z', heldCount: 3, heldCommentIds: ['c-1', 'c-2', 'c-3'] }),
    },
  });
  await app.settle();

  const row = app.banner().querySelector('.rv-abn-hold');
  assert.match(row.textContent, /3 held back/);
  assert.doesNotMatch(row.textContent, /not yet done|pending|queued for/i);
  assert.ok(row.querySelector('.rv-abn-sw').classList.contains('rv-abn-sw-on'));
  const btn = row.querySelector('.rv-abn-hold-btn');
  assert.equal(btn.textContent, 'Release 3');

  btn.fire('click');
  await app.settle();
  assert.deepEqual(holds(app)[0].body, { page: '/spec.html', hold: false });
});

// ---- #196 slice 2: the watcher went away --------------------------------

test('a lapsed expiresAt is a DEAD watcher, and the panel says so', async () => {
  // The signal that separates a watcher with nothing to do from one that
  // silently stopped. An hour was lost to exactly this ambiguity.
  const app = boot({ comments: [ANCHORED(1)], status: { session: CLAIM(), hold: HOLD() } });
  await app.settle();
  assert.ok(app.banner().classList.contains('rv-abn-live'));

  app.state.status = { ...app.state.status, session: CLAIM({ expiresAt: Date.now() - 90000 }) };
  await app.tick();

  assert.ok(app.banner().classList.contains('rv-abn-gone'), 'amber, not red: nothing failed, something stopped');
  assert.match(app.bannerText(), /claude-code/, 'and it names who left');
  assert.match(app.bannerText(), /stopped watching/);
  assert.match(app.bannerText(), /No heartbeat for 15\ds\./, 'with how long it has been quiet');
  assert.match(app.bannerText(), /Nothing was lost, and nothing was undone/);
});

test('a released claim reads the same as a lapsed one — it merely disappears', async () => {
  const app = boot({ comments: [], status: { session: CLAIM(), hold: HOLD() } });
  await app.settle();

  app.state.status = { ...app.state.status, session: null };
  await app.tick();

  assert.ok(app.banner().classList.contains('rv-abn-gone'));
  assert.match(app.bannerText(), /claude-code stopped watching/,
    'named from what this tab last saw — /api/status carries nothing once the claim is gone');
});

test('a tab that OPENS onto an already-dead watcher still sees it', async () => {
  // No transition to observe: this tab never watched the session die. The
  // lapsed expiresAt is the whole evidence, and it has to be enough.
  const app = boot({
    comments: [],
    status: { session: CLAIM({ expiresAt: Date.now() - 30000 }), hold: HOLD() },
  });
  await app.settle();
  assert.ok(app.banner().classList.contains('rv-abn-gone'));
  assert.match(app.bannerText(), /claude-code stopped watching/);
});

test('the lapse is noticed WITHOUT a status poll', async () => {
  // A claim runs out at a known instant, so waiting for the next poll to find
  // out would leave the panel green for up to thirty seconds after the watcher
  // was provably dead. That is the same shape of hole #196 slice 1 closed.
  const app = boot({ comments: [], status: { session: CLAIM({ expiresAt: Date.now() + 40 }), hold: HOLD() } });
  await app.settle();
  assert.ok(app.banner().classList.contains('rv-abn-live'));

  const callsBefore = app.state.calls.length;
  await new Promise((r) => { setTimeout(r, 60); });
  const fired = await app.fireTimeouts((t) => t.ms > 0 && t.ms < 1000);
  assert.ok(fired > 0, 'a wake-up was scheduled for the moment the claim runs out');
  assert.equal(app.state.calls.length, callsBefore, 'and it asked the runner nothing');
  assert.ok(app.banner().classList.contains('rv-abn-gone'), 'the panel noticed on its own');
});

test('the disconnect warning is dismissible, and dismissing it returns the default', async () => {
  const app = boot({ comments: [], status: { session: CLAIM({ expiresAt: Date.now() - 1000 }), hold: HOLD() } });
  await app.settle();
  assert.match(app.bannerText(), /stopped watching/);

  app.banner().querySelector('.rv-abn-x').fire('click');
  await app.settle();
  assert.equal(app.bannerText(), '', 'once you know, you know');
});

test('a NEW session attaching un-dismisses — the next departure is not the last one', async () => {
  const app = boot({ comments: [], status: { session: CLAIM({ expiresAt: Date.now() - 1000 }), hold: HOLD() } });
  await app.settle();
  app.banner().querySelector('.rv-abn-x').fire('click');
  await app.settle();
  assert.equal(app.bannerText(), '');

  app.state.status = {
    ...app.state.status,
    session: CLAIM({ agentName: 'probe-b', claimedAt: '2026-08-02T11:00:00Z' }),
  };
  await app.tick();
  assert.match(app.bannerText(), /probe-b is watching/);

  app.state.status = { ...app.state.status, session: null };
  await app.tick();
  assert.match(app.bannerText(), /probe-b stopped watching/, 'the second departure is its own news');
});

// ---- decision 21 + #196 slice 3: hold persists, visibly -----------------

test('hold SURVIVES the disconnect, and the warning is where you can see it survive', async () => {
  const app = boot({
    comments: [],
    status: { session: CLAIM(), hold: HOLD({ on: true, heldCount: 3 }) },
  });
  await app.settle();

  app.state.status = { ...app.state.status, session: null };
  await app.tick();

  const row = app.banner().querySelector('.rv-abn-hold');
  assert.ok(row, 'the switch is still on the disconnect warning');
  assert.match(row.textContent, /Hold is still on/);
  assert.match(row.textContent, /3 held back/);
  assert.equal(row.querySelector('.rv-abn-hold-btn').textContent, 'Turn hold off',
    'one click from the notice that told you why you might want to');
});

test('dismissing the warning does not dismiss the FACT — hold keeps the slot', async () => {
  // This is the whole safety argument for letting hold persist. A held queue
  // with nobody watching and nothing on screen is a silent drop with extra
  // steps; #196 slice 3 is this row.
  const app = boot({
    comments: [],
    status: { session: CLAIM({ expiresAt: Date.now() - 1000 }), hold: HOLD({ on: true, heldCount: 3 }) },
  });
  await app.settle();
  app.banner().querySelector('.rv-abn-x').fire('click');
  await app.settle();

  assert.ok(app.banner().classList.contains('rv-abn-plain'), 'neutral — a setting, not a failure');
  assert.match(app.bannerText(), /Hold is on/);
  assert.match(app.bannerText(), /3 held back · no agent attached/);
  const btn = app.banner().querySelector('.rv-abn-hold-btn');
  btn.fire('click');
  await app.settle();
  assert.deepEqual(holds(app)[0].body, { page: '/spec.html', hold: false });
});

test('hold OFF and no agent leaves the slot genuinely empty', async () => {
  const app = boot({ comments: [ANCHORED(1)], status: { session: null, hold: HOLD() } });
  await app.settle();
  assert.equal(app.bannerText(), '');
  assert.equal(app.host.querySelector('.rv-abn-hold'), null, 'no switch with nothing to switch');
});

// ---- one indicator, so the states are ordered ---------------------------

test('a runner too old to report presence draws nothing rather than guessing', async () => {
  const app = boot({ comments: [ANCHORED(1)], status: {} }); // no `session`, no `hold`
  await app.settle();
  assert.equal(app.bannerText(), '');
});

test('a dead runner outranks presence — with it gone, what a watcher is doing is unknowable', async () => {
  const app = boot({ comments: [], status: { session: CLAIM(), hold: HOLD({ on: true, heldCount: 2 }) } });
  await app.settle();
  assert.match(app.bannerText(), /is watching/);

  app.state.down = true;
  await app.tick();

  assert.match(app.bannerText(), /Runner offline/);
  assert.equal(app.host.querySelectorAll('.rv-abn').length, 1, 'still one slot, not two');

  app.state.down = false;
  await app.tick();
  assert.match(app.bannerText(), /is watching/, 'and presence comes back with it');
});
