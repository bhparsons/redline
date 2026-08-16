// test/runner/overlay-leases.test.mjs — the HUMAN side of the lease ledger (#189).
//
// The case, observed live on 2026-07-31: Send now was pressed on a comment a
// watching session was already researching. Both did the work. The browser's
// paid run won at 5.6¢ and declined; the session had a validated zero-cost edit
// ready and stood down. No error, no warning — just duplicated effort and a
// wasted call, because the human side of the ledger did not exist. Opening the
// composer, or the in-place editor, claimed NOTHING.
//
// These tests boot the overlay and drive the real triggers: a composer opening,
// a selection that must NOT lock, a 409 from the ledger, a renewal failing
// mid-compose, a tab going away. Nothing here greps overlay.js — the file this
// harness came from exists because reading source proved a mechanism three
// times and a trigger none.

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './_overlay-boot.mjs';

const ANCHORED = (n) => ({
  id: `c-${n}`, body: `comment ${n}`, anchor: { blockId: `r-000${n}`, quote: `q${n}` },
  status: 'open', createdAt: '2026-08-02T10:00:00Z', creator: 'human', replies: [],
});

const OK = (body) => ({ ok: true, status: 200, json: async () => body });
const REFUSED = (body) => ({ ok: false, status: 409, json: async () => body });
const GONE = () => ({
  ok: false, status: 404,
  json: async () => ({ error: 'unknown or expired lease', reason: 'unknown-lease' }),
});

const LEASE = (leaseId, blocks) => OK({
  leaseId, page: '/spec.html', blocks, sessionId: 'human-x',
  expiresAt: Date.now() + 120000, ttlMs: 120000, acquiredAt: '2026-08-02T10:00:00Z',
});

/** The runner grants every lease, and remembers what it was asked for. */
function grants(app, { refuse = false } = {}) {
  const seen = [];
  let n = 0;
  app.state.route = async (url, init) => {
    if (!url.includes('/api/lease')) return null;
    const body = init && init.body ? JSON.parse(init.body) : null;
    seen.push({ url, method: (init && init.method) || (body ? 'POST' : 'GET'), body });
    if (url.includes('/api/lease/renew')) return LEASE(body.leaseId, ['r-0001']);
    if ((init && init.method) === 'DELETE') return OK({ ok: true, forced: false, released: [] });
    if (refuse) {
      return REFUSED({
        error: 'another run is editing those blocks',
        reason: 'blocks-leased', runId: 'lease-agent', blocks: body.blocks,
      });
    }
    n += 1;
    return LEASE(`lease-${n}`, body.blocks);
  };
  return seen;
}

const CLAIM_LIVE = {
  page: '/spec.html', agentName: 'claude-code', pid: 4242,
  claimedAt: '2026-08-02T10:00:00Z', expiresAt: Date.now() + 60000, ttlMs: 60000,
};

const acquires = (seen) => seen.filter((r) => r.method === 'POST' && r.url.endsWith('/api/lease'));
const releases = (seen) => seen.filter((r) => r.method === 'DELETE');
const renewals = (seen) => seen.filter((r) => r.url.includes('/api/lease/renew'));

// ---- decision 6: composer-open locks, SELECTION DOES NOT ---------------------

test('opening the composer takes a lease on the block behind it', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  const seen = grants(app);

  app.openComposer('r-0001');
  await app.settle();

  assert.equal(acquires(seen).length, 1, 'exactly one lease, taken on composer-open');
  assert.deepEqual(acquires(seen)[0].body.blocks, ['r-0001'], 'and on the block the comment is about');
  assert.ok(typeof acquires(seen)[0].body.sessionId === 'string'
    && acquires(seen)[0].body.sessionId.length > 0, 'attributed to this tab');
});

test('a SELECTION alone locks nothing — a reader who wanders off must not stall the agent', async () => {
  // Decision 6, stated as a test because it is the one that is easy to get
  // wrong in the convenient direction. Selection is ambient and has no natural
  // end: a reader who highlights a sentence and walks away would hold the
  // paragraph for as long as the tab is open, on a document nobody is editing.
  const app = boot({ comments: [] });
  await app.settle();
  const seen = grants(app);

  // Everything up to the pill, and no further.
  const block = app.document.querySelector('[data-rev="r-0001"]');
  const range = {
    startContainer: block, endContainer: block, commonAncestorContainer: block,
    startOffset: 0, endOffset: 1,
    toString: () => 'block r-0001',
    getClientRects: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 10, right: 10, width: 40, height: 12 }),
  };
  app.state.selection = {
    isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => 'block r-0001',
  };
  await app.fireDocument('mouseup', { target: block });
  for (const t of app.timers.filter((x) => x.kind === 'timeout' && x.ms === 0 && !x.done)) {
    t.done = true; t.fn();
  }
  await app.settle();

  assert.ok(app.host.querySelector('.rv-selpill'), 'the selection raised the pill');
  assert.equal(acquires(seen).length, 0, 'and claimed nothing');
  assert.deepEqual(app.rails(), [], 'nothing on the page says the block is held');
});

test('cancelling the composer hands the block straight back', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  const seen = grants(app);

  const popover = app.openComposer('r-0001');
  await app.settle();
  assert.equal(acquires(seen).length, 1);

  popover.querySelectorAll('button').find((b) => b.textContent === 'Cancel').fire('click');
  await app.settle();

  assert.equal(releases(seen).length, 1, 'released on cancel');
  assert.match(releases(seen)[0].url, /\/api\/lease\/lease-1\?sessionId=/,
    'by id, as its holder — not force-broken');
  assert.deepEqual(app.rails(), [], 'and the mark went with it');
});

test('submitting the comment releases too — the block is not held past the write', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  const seen = grants(app);

  await app.writeComment('r-0001', 'tighten this paragraph');

  assert.equal(acquires(seen).length, 1);
  assert.equal(releases(seen).length, 1, 'the composer closing is the release');
  assert.ok(app.state.posted.some((p) => p.url.endsWith('/api/comment')), 'and the comment landed');
});

// ---- the mark ---------------------------------------------------------------

test('a block this tab holds is marked as HUMAN-held, immediately', async () => {
  // Immediately matters: /api/status lags by a poll, and the mark IS the
  // feedback that the claim landed. Four seconds of nothing reads as failure.
  const app = boot({ comments: [] });
  await app.settle();
  grants(app);

  app.openComposer('r-0001');
  await app.settle();

  assert.deepEqual(app.rails(), [{ blockId: 'r-0001', kind: 'human' }]);
});

test('a block the AGENT holds is marked agent-held and names it on approach', async () => {
  const app = boot({
    comments: [],
    status: {
      session: {
        page: '/spec.html', agentName: 'claude-code', pid: 4242,
        claimedAt: '2026-08-02T10:00:00Z', expiresAt: Date.now() + 60000, ttlMs: 60000,
      },
      leases: { 'r-0002': 'lease-agent' },
      runs: [{
        runId: 'lease-agent', state: 'running', lane: 'session-hold',
        blocks: ['r-0002'], startedAt: '2026-08-02T10:00:00Z',
        expiresAt: Date.now() + 30000, ttlMs: 30000, holder: 'sess-abc',
      }],
    },
  });
  await app.settle();

  assert.deepEqual(app.rails(), [{ blockId: 'r-0002', kind: 'agent' }]);
  assert.equal(app.leaseTagText(), '', 'AT REST the rail is the whole mark — no label, no tint');

  app.hover('r-0002');
  await app.settle();
  assert.equal(app.leaseTagText(), 'claude-code is writing here', 'the name arrives on approach');
  assert.match(app.leaseTagClass(), /rv-lease-agent/, 'and carries the solid (agent) cue');

  app.hover(null);
  await app.settle();
  assert.equal(app.leaseTagText(), '', 'and leaves with the pointer');
});

test('the human and agent marks differ by more than hue', async () => {
  // Decision 22 makes teal and violet carry distinct meaning, and they are a
  // common confusion pair — worst at the low saturation this chrome uses. So
  // the kind is on the element, the tag names the holder in words, and the CSS
  // gives the human tag a dashed border where the agent's is solid.
  const app = boot({
    comments: [],
    status: {
      leases: { 'r-0002': 'lease-agent' },
      runs: [{ runId: 'lease-agent', state: 'running', lane: 'session-hold', blocks: ['r-0002'], holder: 'sess-abc' }],
    },
  });
  await app.settle();
  grants(app);
  app.openComposer('r-0001');
  await app.settle();

  const rails = app.rails().slice().sort((a, b) => a.blockId.localeCompare(b.blockId));
  assert.deepEqual(rails, [
    { blockId: 'r-0001', kind: 'human' },
    { blockId: 'r-0002', kind: 'agent' },
  ], 'both on screen at once, told apart without reading a colour');

  app.hover('r-0001');
  await app.settle();
  assert.equal(app.leaseTagText(), 'you are editing');
  assert.match(app.leaseTagClass(), /rv-lease-human/);
});

// ---- decision 5: first holder wins ------------------------------------------

test('a 409 does not stop you commenting — only writes are gated', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  const seen = grants(app, { refuse: true });

  const popover = app.openComposer('r-0001');
  await app.settle();

  assert.equal(acquires(seen).length, 1, 'it asked');
  assert.ok(app.popover(), 'and the composer is still there after being told no');
  const ta = popover.querySelector('TEXTAREA');
  ta.value = 'you can still say this';
  popover.querySelectorAll('button').find((b) => b.textContent === 'Comment').fire('click');
  await app.settle();
  assert.ok(app.state.posted.some((p) => p.url.endsWith('/api/comment')),
    'the comment landed on a block held by somebody else, which is the rule');
});

test('Edit text on an agent-held block is REFUSED and names the holder', async () => {
  const app = boot({
    comments: [],
    status: {
      session: {
        page: '/spec.html', agentName: 'claude-code', pid: 4242,
        claimedAt: '2026-08-02T10:00:00Z', expiresAt: Date.now() + 60000, ttlMs: 60000,
      },
      leases: { 'r-0001': 'lease-agent' },
      runs: [{ runId: 'lease-agent', state: 'running', lane: 'session-hold', blocks: ['r-0001'], holder: 'sess-abc' }],
    },
  });
  await app.settle();
  grants(app, { refuse: true });

  await app.startEdit('r-0001');

  const block = app.document.querySelector('[data-rev="r-0001"]');
  assert.equal(block.getAttribute('contenteditable'), null,
    'the block never became editable — first holder wins, nothing is preempted');
  assert.equal(app.leaseTagText(), 'claude-code is writing here',
    'and the refusal says who has it, unprompted');
  assert.match(app.pencil().className, /rv-pencil-held/,
    'the affordance stays and changes state; a missing one would teach nothing');
});

test('the refusal carries a door — a held lease can be forced, and it is recorded', async () => {
  // First holder wins and there is no eviction verb, but "restart the runner"
  // is not an answer a document editor may give its author. The door is at the
  // bottom of an explanation you had to reach for, and the runner writes a
  // lane:'lease-force-release' record so the yanked session can learn why its
  // next write failed.
  const app = boot({
    comments: [],
    status: {
      session: CLAIM_LIVE,
      leases: { 'r-0001': 'lease-agent' },
      runs: [{ runId: 'lease-agent', state: 'running', lane: 'session-hold', blocks: ['r-0001'], holder: 'sess-abc' }],
    },
  });
  await app.settle();
  grants(app, { refuse: true });

  await app.startEdit('r-0001');
  const take = app.pencil().querySelector('.rv-cap-action');
  assert.ok(take && !take.classList.contains('rv-hidden'), 'the door is offered on a HELD lease');
  assert.equal(take.textContent, 'Take the block back');

  app.state.route = null; // the runner accepts the break-glass
  take.fire('click');
  await app.settle();

  const forced = app.requests().filter((r) => r.method === 'DELETE' && r.url.includes('force=1'));
  assert.equal(forced.length, 1);
  assert.match(forced[0].url, /\/api\/lease\/lease-agent\?force=1/);
});

test('a RUN mid-write is not forceable — that is undo’s problem, not this door’s', async () => {
  const app = boot({
    comments: [],
    status: {
      running: true,
      leases: { 'r-0001': 'run-7' },
      runs: [{ runId: 'run-7', state: 'running', lane: 'standard', blocks: ['r-0001'] }],
    },
  });
  await app.settle();

  app.hover('r-0001');
  await app.settle();
  assert.deepEqual(app.rails(), [{ blockId: 'r-0001', kind: 'agent' }], 'still marked as held');
  const pencil = app.pencil();
  if (pencil) {
    const take = pencil.querySelector('.rv-cap-action');
    assert.ok(take === null || take.classList.contains('rv-hidden'),
      'but no door: yanking it would leave the run writing outside its lease');
  }
});

// ---- the TTL problem --------------------------------------------------------

test('the lease is RENEWED while the composer stays open, and never shows a timer', async () => {
  // The runner clamps a lease to five minutes and a person can spend ten
  // writing a comment. Raising the ceiling is the wrong fix twice: it is runner
  // code the overlay does not own, and a long TTL is how a closed lid holds a
  // paragraph for an hour. Short and renewed is the answer.
  const app = boot({ comments: [] });
  await app.settle();
  const seen = grants(app);

  const popover = app.openComposer('r-0001');
  await app.settle();
  await app.fireInterval(45000);
  await app.fireInterval(45000);

  assert.equal(renewals(seen).length, 2, 'it kept the claim alive without asking the human');
  assert.equal(renewals(seen)[0].body.leaseId, 'lease-1');
  assert.equal(acquires(seen).length, 1, 'and did not churn a new lease each time');

  // Decision 7: no countdown on a human-held block, ever.
  const text = popover.textContent;
  assert.doesNotMatch(text, /\b\d+\s*(s|sec|second|min|minute)/i, 'no countdown in the composer');
  assert.doesNotMatch(text, /expir/i, 'and no expiry warning');
  assert.match(text, /released when you save or cancel/,
    'what it states instead is the release CONDITION, a fact about the control');
});

test('renewals stop when the composer closes', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  const seen = grants(app);

  const popover = app.openComposer('r-0001');
  await app.settle();
  popover.querySelectorAll('button').find((b) => b.textContent === 'Cancel').fire('click');
  await app.settle();

  const before = renewals(seen).length;
  const live = app.timers.filter((x) => x.kind === 'interval' && x.ms === 45000 && !x.cleared);
  for (const t of live) await t.fn();
  await app.settle();
  assert.equal(renewals(seen).length, before, 'a closed composer renews nothing');
});

test('a renewal that 404s takes the block again rather than pretending', async () => {
  // A renewal CANNOT resurrect a lease — the blocks may already be someone
  // else's, and re-admitting without re-checking is how two writers meet.
  const app = boot({ comments: [] });
  await app.settle();
  const seen = [];
  let renews = 0;
  let grantN = 0;
  app.state.route = async (url, init) => {
    if (!url.includes('/api/lease')) return null;
    const body = init && init.body ? JSON.parse(init.body) : null;
    seen.push({ url, method: (init && init.method) || (body ? 'POST' : 'GET'), body });
    if (url.includes('/api/lease/renew')) { renews += 1; return GONE(); }
    if ((init && init.method) === 'DELETE') return OK({ ok: true });
    grantN += 1;
    return LEASE(`lease-${grantN}`, body.blocks);
  };

  app.openComposer('r-0001');
  await app.settle();
  await app.fireInterval(45000);

  assert.equal(renews, 1);
  assert.equal(acquires(seen).length, 2, 'it re-acquired from scratch');
  assert.deepEqual(app.rails(), [{ blockId: 'r-0001', kind: 'human' }], 'and holds the block again');
});

test('a renewal that 404s and CANNOT be retaken says the claim ended', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  let first = true;
  app.state.route = async (url, init) => {
    if (!url.includes('/api/lease')) return null;
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (url.includes('/api/lease/renew')) return GONE();
    if ((init && init.method) === 'DELETE') return OK({ ok: true });
    if (first) { first = false; return LEASE('lease-1', body.blocks); }
    return REFUSED({ error: 'another run is editing those blocks', reason: 'blocks-leased', runId: 'lease-agent' });
  };
  app.state.status = {
    ...app.state.status,
    session: {
      page: '/spec.html', agentName: 'claude-code', pid: 1,
      claimedAt: '2026-08-02T10:00:00Z', expiresAt: Date.now() + 60000, ttlMs: 60000,
    },
  };
  await app.tick();

  const popover = app.openComposer('r-0001');
  await app.settle();
  await app.fireInterval(45000);

  assert.match(popover.textContent, /claim on this block ended/,
    'the words the author wrote are untouched; the PROTECTION is what ended');
  assert.match(popover.textContent, /claude-code/, 'and it names who may be there now');
  assert.deepEqual(app.rails(), [], 'the violet rail is gone rather than lying about');
});

// ---- the tab going away -----------------------------------------------------

test('the tab going away hands the block back, with keepalive', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  grants(app);

  app.openComposer('r-0001');
  await app.settle();
  await app.fireWindow('pagehide');

  const del = app.requests().filter((r) => r.method === 'DELETE');
  assert.equal(del.length, 1, 'released on the way out');
  assert.deepEqual(app.rails(), []);
});

test('a hidden tab releases, and coming back re-takes the block', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  const seen = grants(app);

  app.openComposer('r-0001');
  await app.settle();

  app.document.visibilityState = 'hidden';
  await app.fireDocument('visibilitychange');
  assert.equal(releases(seen).length, 1, 'a backgrounded tab is not holding anybody up');

  app.document.visibilityState = 'visible';
  await app.fireDocument('visibilitychange');
  assert.equal(acquires(seen).length, 2, 'and the still-open composer takes it back');
});

// ---- writing through the lease ---------------------------------------------

test('a direct edit writes UNDER its lease and releases after (#231)', async () => {
  // The old order released FIRST — a held lease used to refuse its own
  // holder's write — which opened a millisecond window between release and
  // write. /api/edit now accepts the held leaseId and exempts exactly that
  // lease, so the write carries it and the release follows the write.
  const app = boot({ comments: [] });
  await app.settle();
  grants(app);

  await app.startEdit('r-0001');
  const block = app.document.querySelector('[data-rev="r-0001"]');
  assert.equal(block.getAttribute('contenteditable'), 'true', 'the block is editable');
  assert.deepEqual(app.rails(), [{ blockId: 'r-0001', kind: 'human' }], 'and claimed while it is');

  block.textContent = 'rewritten by hand';
  block.fire('keydown', { key: 'Enter', shiftKey: false });
  await app.settle();

  const touched = app.requests()
    .filter((r) => r.url.includes('/api/lease/') || r.url.endsWith('/api/edit'));
  const order = touched.map((r) => (r.url.endsWith('/api/edit') ? 'edit' : 'release'));
  assert.deepEqual(order, ['edit', 'release'], 'lease -> write -> release, no gap');
  const edit = touched.find((r) => r.url.endsWith('/api/edit'));
  assert.equal(edit.body.leaseId, 'lease-1', 'the write NAMES the lease it holds');
});

test('Escape out of an in-place edit releases the block', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  const seen = grants(app);

  await app.startEdit('r-0001');
  const block = app.document.querySelector('[data-rev="r-0001"]');
  block.fire('keydown', { key: 'Escape' });
  await app.settle();

  assert.equal(releases(seen).length, 1);
  assert.deepEqual(app.rails(), []);
});

test('View only takes the marks off the page — a reader who put the tool away sees none of it', async () => {
  const app = boot({
    comments: [],
    status: {
      leases: { 'r-0002': 'lease-agent' },
      runs: [{ runId: 'lease-agent', state: 'running', lane: 'session-hold', blocks: ['r-0002'], holder: 'sess-abc' }],
    },
  });
  await app.settle();
  assert.deepEqual(app.rails(), [{ blockId: 'r-0002', kind: 'agent' }]);

  app.host.querySelector('.rv-sw-mode').fire('click'); // Redline active → View only
  await app.settle();
  assert.deepEqual(app.rails(), [], 'the document is native again');
});

// ---- the non-colour cue is a fact about the SHEET ---------------------------
//
// Decision 22 requires teal and violet each to carry a cue that survives the
// hue being removed. A DOM stub has no styling, so the only place this is
// checkable is the stylesheet — and unchecked it is exactly the kind of
// requirement that gets quietly dropped in a refactor.

test('the human tag is DASHED where the agent tag is solid, and the pill is not green', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { EXT_DIR } = await import('./_overlay-load.mjs');
  const css = readFileSync(path.join(EXT_DIR, 'overlay.css'), 'utf8');

  assert.match(css, /\.rv-lease-tag\.rv-lease-human \{[^}]*border-style:\s*dashed/,
    'the human tag border is dashed (design/phase10-mocks.html: .lease-tag.human)');
  assert.match(css, /\.rv-lease-rail\.rv-lease-human \{[^}]*repeating-linear-gradient/,
    'and its rail is segmented where the agent rail is a solid fill');
  assert.match(css, /\.rv-lease-rail\.rv-lease-agent \{[^}]*background:\s*var\(--rv-hold-agent\)/);

  // Decision 22's other half: green now means AN AGENT IS ATTACHED, so the
  // always-on pill must not be green.
  const pip = css.match(/#rv-root \.rv-pip \{([^}]*)\}/);
  assert.ok(pip, '.rv-pip is styled');
  assert.doesNotMatch(pip[1], /--rv-ready|#34c98a|52,\s*201,\s*138/,
    'the always-on Redline pill is neutral — "the tool is on" is not news');
});

test('an offline tab claims nothing — there is nobody to claim it from', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  const seen = grants(app);
  app.state.down = true;
  await app.tick();

  app.openComposer('r-0001');
  await app.settle();
  assert.equal(acquires(seen).length, 0, 'no lease attempt while the runner is away');
  assert.ok(app.popover(), 'and the composer still opens — the buffer needs it to');
});

test('a session-hold lease is presence, not a run — no phantom Running strip (#266)', async () => {
  // The runner counts leases in /api/status `running`, so an open composer
  // (or any watcher lease) used to be ADOPTED as "a run is in progress" —
  // and settling that phantom against an unrelated lastRun record reloaded
  // the page the moment the lease released. The jitter Blake reported as
  // "the sidecar closes and reopens" on every comment save.
  const app = boot({
    comments: [],
    status: {
      running: true,
      lastRun: { runId: 'run-old', status: 'ok', edits: [{ blockId: 'r-0001' }] },
      leases: { 'r-0002': 'lease-agent' },
      runs: [{ runId: 'lease-agent', state: 'running', lane: 'session-hold', blocks: ['r-0002'], holder: 'sess-abc' }],
    },
  });
  await app.settle();
  const strip = app.host.querySelector('.rv-run-strip');
  assert.ok(strip.classList.contains('rv-hidden'),
    'no run strip for a lease — the rail is its whole rendering');
  // The rail still shows: the lease is not hidden, just not a run.
  assert.deepEqual(app.rails(), [{ blockId: 'r-0002', kind: 'agent' }]);
});

test('a real foreign run still adopts and shows the strip', async () => {
  const app = boot({
    comments: [],
    status: {
      running: true,
      runs: [{ runId: 'run-live', state: 'running', lane: 'standard', commentIds: ['c-1'] }],
    },
  });
  await app.settle();
  const strip = app.host.querySelector('.rv-run-strip');
  assert.ok(!strip.classList.contains('rv-hidden'), 'a real run is adopted');
  assert.match(strip.textContent, /run is in progress/i);
});
