// test/runner/overlay-liveness.test.mjs — the runner going away and COMING BACK.
//
// Every other overlay test in this suite reads the source and asserts on its
// shape. That is how #196 shipped twice with a hole in it: 29 tests proved the
// offline banner exists, renders three states and is wired to setRunnerDown,
// and none proved a dead runner ever REACHES setRunnerDown. Then the same
// again, one commit later, in the other direction: a detector that owned the
// down edge and nothing that owned the up edge, so a tab that went offline
// stayed offline forever. Mechanism tested, trigger not — three times in one
// week, in one file.
//
// So this file does not read overlay.js. It BOOTS it: init() runs against a DOM
// stub and a fetch stub, and the tests drive the trigger — the runner stops
// answering, then starts again — and assert on what the panel actually did.
//
// The live repro that motivates the whole file: the runner comes back at THE
// SAME `rev`. Recovery used to hang off refresh(), which the watch tick reaches
// only when the sidecar moved, so a page with a second writer recovered by
// accident and a solo page — the one the offline buffer exists to serve — never
// recovered at all.

import test from 'node:test';
import assert from 'node:assert/strict';
// The harness lives in _overlay-boot.mjs so #189/#191's tests can drive the
// same booted overlay rather than growing a second, subtly different stub.
import { boot } from './_overlay-boot.mjs';

const ANCHORED = (n) => ({
  id: `c-${n}`, body: `comment ${n}`, anchor: { blockId: `r-000${n}`, quote: `q${n}` },
  status: 'open', createdAt: '2026-08-02T10:00:00Z', creator: 'human', replies: [],
});
const HELD = (localId, body, over, extra = {}) => ({
  localId, body, anchor: { blockId: over, quote: body.slice(0, 8) },
  asNote: false, createdAt: '2026-08-01T10:00:00Z', failed: null, ...extra,
});

// ---- the harness itself is load-bearing; prove it boots ----------------------

test('the overlay boots against the stub and draws no indicator when healthy', async () => {
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();
  assert.equal(app.bannerText(), '', 'a healthy runner shows nothing in the slot');
  assert.ok(app.state.calls.some((u) => u.includes('/api/comments')), 'it talked to the runner');
});

// ---- the up edge: THE bug ---------------------------------------------------

test('a runner that stops answering paints the offline banner', async () => {
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();
  app.state.down = true;
  await app.tick();
  assert.match(app.bannerText(), /Runner offline/);
});

test('a runner that starts answering again clears the offline state WITH NO REV CHANGE', async () => {
  // The exact live repro. Nothing about the page moves while the runner is
  // away, so it comes back at the same rev — and recovery must not depend on
  // anything having moved.
  const app = boot({ comments: [ANCHORED(1)], status: { rev: 7 } });
  await app.settle();
  const revBefore = app.state.rev;

  app.state.down = true;
  await app.tick();
  assert.match(app.bannerText(), /Runner offline/, 'down first');

  app.state.down = false;
  await app.tick();

  assert.equal(app.state.rev, revBefore, 'the sidecar did not move — that is the point');
  assert.equal(app.bannerText(), '', 'and the tab noticed anyway');
});

test('the quieter the page, the longer it used to stay broken — a solo page recovers too', async () => {
  // The failure was inverted: a page with a second writer bumped `rev`, which
  // reached refresh(), which was the only place that cleared the flag. A page
  // where you are the only author never got that accident — and that is
  // precisely the page the offline buffer exists to serve.
  const app = boot({ comments: [], status: { rev: 3 } });
  await app.settle();
  app.state.down = true;
  await app.tick();
  assert.match(app.bannerText(), /Runner offline/);

  app.state.down = false;
  await app.tick(); // rev still 3, no comments, no runs, nothing whatsoever moved
  assert.equal(app.bannerText(), '', 'no second writer required');
});

test('any resolved response proves liveness — a 404 is a live runner answering', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  app.state.down = true;
  await app.tick();
  assert.match(app.bannerText(), /Runner offline/);

  // The runner is back but this particular call 404s. It ANSWERED, so it is up.
  app.state.down = false;
  const calls = [];
  vmFetchOverride(app, async (url) => {
    calls.push(url);
    return { ok: false, status: 404, json: async () => ({ error: 'no such page' }) };
  });
  await app.tick();
  assert.ok(calls.length > 0);
  assert.equal(app.bannerText(), '', 'a refusal from a running process is not an outage');
});

// Swap the fetch the booted context sees. Defined below its use for reading
// order; the tests above read as a story and this is plumbing.
function vmFetchOverride(app, fn) { app.state.fetchOverride = fn; }

// ---- the replay chain -------------------------------------------------------

test('a comment written during an outage replays on the reconnect edge', async () => {
  // End to end and in that order — a HEALTHY boot first, so the tab has a
  // status and a `rev` to compare against. That detail is the whole bug: a tab
  // that booted while the runner was already down had no previous status, so
  // its first successful tick counted as "changed" and recovered by accident.
  // A tab that was working and then lost the runner had one, matching at the
  // same rev, and never recovered at all.
  const app = boot({ comments: [] });
  await app.settle();

  app.state.down = true;
  await app.tick();
  await app.writeComment('r-0001', 'written while the runner was away');
  assert.equal(app.state.posted.length, 0, 'nothing was posted while down');
  assert.ok(app.store.get('rv-buffer:/spec.html'), 'it went to this device instead');
  assert.equal(app.popover(), null, 'and the composer closed, accepted');

  app.state.down = false;
  await app.tick();

  const created = app.state.posted.filter((p) => p.url.endsWith('/api/comment'));
  assert.equal(created.length, 1, 'the held comment went to the runner on the edge');
  assert.equal(created[0].body.body, 'written while the runner was away');
  assert.equal(created[0].body.aiEdits, true, 'and carried its audience in the one write (#185)');
  assert.equal(app.store.get('rv-buffer:/spec.html'), undefined, 'and the buffer was evicted');
  assert.equal(app.bannerText(), '', 'the banner is gone with it');
});

test('a comment written during an outage is refused nowhere and lost nowhere', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  app.state.down = true;
  await app.tick();
  await app.writeComment('r-0001', 'the one write that survives an outage');
  const held = JSON.parse(app.store.get('rv-buffer:/spec.html'));
  assert.equal(held.length, 1);
  assert.equal(held[0].body, 'the one write that survives an outage');
  // #207 as amended by Blake, 2026-08-15: the sub line COUNTS what it is
  // promising to keep. One buffered comment takes the singular verb — "1
  // comment IS saved" — because "1 comments are saved" is the kind of thing
  // that makes a person doubt the rest of the sentence.
  assert.match(app.bannerText(), /1 comment is saved and will sync when the runner is back online\./);
});

test('a buffered comment that outlived its tab replays at BOOT', async () => {
  // No edge exists here: runnerDown starts false and the runner is healthy, so
  // nothing ever transitions. Blake's buffer survived a hard reload exactly as
  // designed and was then stranded — three comments recovered by hand out of
  // localStorage.
  const app = boot({
    comments: [],
    buffer: [
      HELD('local-a', 'from a previous session', 'r-0001'),
      HELD('local-b', 'and another', 'r-0002', { asNote: true }),
    ],
  });
  await app.settle();

  const created = app.state.posted.filter((p) => p.url.endsWith('/api/comment'));
  assert.equal(created.length, 2, 'both replayed without any reconnect');
  assert.equal(created[1].body.aiEdits, false, 'a note replays as a note');
  assert.equal(app.store.get('rv-buffer:/spec.html'), undefined);
});

test('a boot with a live runner and an empty buffer posts nothing', async () => {
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();
  assert.equal(app.state.posted.length, 0, 'the boot flush is not a write of its own');
});

test('a buffered comment whose text is gone is kept, not posted', async () => {
  // locateAnchor is the only place this is checkable — the runner stores an
  // anchor verbatim, so an orphan would POST happily. The stub finds nothing,
  // which is the "document moved on" case.
  const app = boot({
    comments: [],
    buffer: [HELD('local-a', 'stale', 'r-9999')],
  });
  await app.settle();
  assert.equal(app.state.posted.filter((p) => p.url.endsWith('/api/comment')).length, 0);
  const held = JSON.parse(app.store.get('rv-buffer:/spec.html'));
  assert.equal(held.length, 1, 'still here — nothing is ever thrown away');
  assert.match(held[0].failed, /no longer in the document|gone from the document/);
});

// ---- the redraw stops eating the composer -----------------------------------

test('typed reply text survives an offline redraw', async () => {
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();

  // Open the card, then its reply composer, and type.
  const card = app.cardsEl().querySelector('[data-rv-comment]');
  card.fire('click', { target: card });
  await app.settle();
  const openCard = () => app.cardsEl().querySelector('[data-rv-comment]');
  const replyBtn = openCard().querySelectorAll('.rv-btn').find((b) => b.textContent === 'Reply');
  assert.ok(replyBtn, 'the card offers a reply');
  replyBtn.fire('click');
  const ta = openCard().querySelector('.rv-followup-input');
  ta.value = 'half a sentence, still typ';
  ta.fire('input');

  // The runner dies; the tab redraws for it.
  app.state.down = true;
  await app.tick();
  await app.tick();
  await app.tick();

  const after = app.cardsEl().querySelector('.rv-followup-input');
  assert.ok(after, 'the composer is still open');
  assert.equal(after.value, 'half a sentence, still typ', 'and still holds every character');
});

test('the new-comment composer survives an offline redraw as well', async () => {
  // Recorded because the live report ("as I start typing the comment, it seems
  // to close") pointed at render(), and render() is NOT what does it: the
  // popover is mounted on #rv-root, while render() only replaces the children
  // of .rv-cards. What the 4 s redraw genuinely destroyed was the CARD's reply
  // composer, above. Pinning both, so neither can start being true.
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();
  app.state.down = true;
  await app.tick();

  const popover = app.openComposer('r-0001');
  popover.querySelector('TEXTAREA').value = 'mid-sentence and not sent yet';

  await app.tick();
  await app.tick();
  await app.tick();

  const still = app.popover();
  assert.ok(still, 'the composer is still on screen');
  assert.equal(still.querySelector('TEXTAREA').value, 'mid-sentence and not sent yet');
});

test('the offline watch tick redraws nothing at all — only the EDGE does', async () => {
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();

  app.state.down = true;
  await app.tick(); // the edge — this one must redraw, the cards are stale
  const afterEdge = app.cardsEl().querySelector('[data-rv-comment]');

  await app.tick();
  await app.tick();
  assert.equal(app.cardsEl().querySelector('[data-rv-comment]'), afterEdge,
    'three more failing ticks rebuilt nothing: nothing had changed');
});

test('the retrying age still advances while nothing else redraws', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  app.state.down = true;
  await app.tick();
  const beat = app.timers.filter((t) => t.kind === 'interval' && t.ms === 1000);
  assert.equal(beat.length, 1, 'one 1 s timer, and it belongs to the banner alone');
  const before = app.bannerText();
  beat[0].fn();
  assert.match(app.bannerText(), /retrying \d+s/);
  assert.ok(before.includes('Runner offline'));
});

// ---- refusal, by enumeration ------------------------------------------------

test('EVERY write control on a card refuses through the capsule when the runner is down', async () => {
  // By ENUMERATION, deliberately: a control added to a card later cannot
  // quietly skip the capsule, because this walks what the card actually
  // renders rather than a list someone remembered to update. The audience chip
  // is what prompted it — it disabled itself with a native `title`, which is
  // slow, easy to miss and read as "clicking does nothing, no indication why".
  const app = boot({
    comments: [
      { ...ANCHORED(1), replies: [] },
      { ...ANCHORED(2), status: 'resolved' }, // Reopen instead of Send now
      // Two orphans, so both re-anchor shapes render: the one with a suggested
      // block, and the bare "Re-anchor…" fallback.
      { ...ANCHORED(3), id: 'c-3', anchor: { blockId: 'r-gone', quote: 'block body text stuff' } },
      { ...ANCHORED(4), id: 'c-4', anchor: { blockId: 'r-gone', quote: 'zz' } },
    ],
    filter: 'all',
  });
  await app.settle();

  app.state.down = true;
  await app.tick();

  const seen = [];
  for (const card of app.cardsEl().querySelectorAll('[data-rv-comment]')) {
    card.fire('click', { target: card }); // expand it, so zone 4 renders too
    await app.settle();
    const live = app.cardsEl().querySelectorAll('[data-rv-comment]')
      .find((c) => c.getAttribute('data-rv-comment') === card.getAttribute('data-rv-comment'));
    const buttons = live.querySelectorAll('button');
    assert.ok(buttons.length > 0);
    for (const btn of buttons) {
      if (!btn.disabled) continue; // a live control has nothing to explain
      const name = btn.textContent || btn.getAttribute('aria-label') || btn.className;
      seen.push(name);
      const wrap = btn.parentElement;
      assert.ok(wrap && wrap.classList.contains('rv-explaining'),
        `a refused control must be wrapped for the capsule: "${name}" (${btn.className})`);
      // #214: the capsule is raised into #rv-root on approach rather than
      // living nested inside the card, where it was clipped. The reason rides
      // on the wrap as data so it stays assertable without a hover.
      assert.ok((wrap.getAttribute('data-cap-title') || '').length > 0,
        `and name a reason: "${name}"`);
      wrap.fire('mouseenter');
      const capsule = app.host.querySelector('.rv-capsule-float');
      assert.ok(capsule, `and raise a capsule on approach: "${name}"`);
      assert.ok(capsule.querySelector('.rv-cap-title').textContent.length > 0);
      wrap.fire('mouseleave');
      assert.equal(app.host.querySelector('.rv-capsule-float'), null,
        `and take it away with the cursor: "${name}"`);
      assert.equal(btn.title, '', 'and no native tooltip competing with it');
    }
  }
  // The enumeration above is the real assertion; this only proves it walked a
  // card list with something on it rather than passing over an empty room.
  // Reply is deliberately absent: replies BUFFER offline now (#241), so the
  // composer stays live like the comment path does.
  for (const expected of ['AI', 'Approve', 'Send now', 'Reopen',
    'Re-anchor…', 'Re-anchor here', 'Pick another']) {
    assert.ok(seen.includes(expected), `${expected} should have been among the refused (saw ${seen.join(', ')})`);
  }
});

test('the audience chip and the tick are refused the same way as everything else', async () => {
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();
  app.state.down = true;
  await app.tick();

  const card = app.cardsEl().querySelector('[data-rv-comment]');
  const chip = card.querySelector('.rv-mini-ai');
  const tick = card.querySelector('.rv-approve');
  for (const [name, control] of [['the audience chip', chip], ['the tick', tick]]) {
    assert.ok(control, `${name} is still rendered — a refusal teaches, a removal does not`);
    assert.equal(control.disabled, true, `${name} refuses`);
    assert.ok(control.parentElement.classList.contains('rv-explaining'), `${name} explains why`);
    assert.equal(control.title, '', `${name} drops the native tooltip`);
  }
});

test('Reply stays live offline, and a draft written before the outage survives (#241)', async () => {
  // Three eras of this test: it first asserted the toggle stayed live
  // ("opening a composer is not a write"), then 2026-08-05 flipped it to a
  // refusal — a reply had nowhere to go, so the composer only invited text
  // with no destination. #241 gave replies the buffer, which retires the
  // refusal: the toggle is live again, and this time the words have somewhere
  // to go (the buffered-reply tests in overlay-offline.test.mjs).
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();
  const card = app.cardsEl().querySelector('[data-rv-comment]');
  card.fire('click', { target: card });
  await app.settle();

  // While the runner is UP: open the composer and write something.
  let live = app.cardsEl().querySelector('[data-rv-comment]');
  const replyBtn = live.querySelectorAll('.rv-btn').find((b) => b.textContent === 'Reply');
  assert.equal(replyBtn.disabled, false, 'live, the toggle opens normally');
  replyBtn.fire('click');
  const ta = live.querySelector('.rv-followup-input');
  ta.value = 'half a thought';
  ta.fire('input');

  // Now lose the runner.
  app.state.down = true;
  await app.tick();
  live = app.cardsEl().querySelector('[data-rv-comment]');

  const offlineReply = live.querySelectorAll('.rv-btn').find((b) => b.textContent === 'Reply');
  assert.equal(offlineReply.disabled, false, 'the toggle stays live — a reply buffers now');

  // …and the words already written are still there.
  const survived = live.querySelector('.rv-followup-input');
  assert.ok(survived, 'the composer is still rendered');
  assert.equal(survived.value, 'half a thought', 'the draft is not thrown away by the outage');
});

test('commenting is NOT refused — it is the one write that survives an outage', async () => {
  // The pill's Comment stays live while every other write refuses: a new
  // comment is the single action that buffers (#202).
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();
  app.state.down = true;
  await app.tick();
  const pill = app.raiseSelPill('r-0001');
  const comment = pill.querySelectorAll('button')
    .find((b) => (b.getAttribute('aria-label') || '').startsWith('Comment'));
  assert.ok(comment, 'Comment is still offered');
  assert.notEqual(comment.disabled, true, 'and stays live while down');
});

test('the selection pill\'s Edit refuses through the capsule when the runner is down (#215)', async () => {
  // The pill is drawn over the document, not inside the panel, so eb2b78c's
  // enumeration of card controls never reached it — and its Edit opened an
  // inline editor that could only refuse on submit, after you had composed.
  // A direct edit is a write and no edit buffers (#202), so it must refuse to
  // OPEN, with the same capsule every other write control uses.
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();
  app.state.down = true;
  await app.tick();

  const pill = app.raiseSelPill('r-0001');
  const label = (b) => b.getAttribute('aria-label') || '';
  const buttons = pill.querySelectorAll('button');
  const edit = buttons.find((b) => label(b).startsWith('Edit text'));
  const comment = buttons.find((b) => label(b).startsWith('Comment'));

  assert.ok(edit, 'the pill still offers Edit — a refusal teaches, a removal does not');
  assert.equal(edit.disabled, true, 'and it refuses rather than opening');
  const wrap = edit.parentElement;
  assert.ok(wrap.classList.contains('rv-explaining'), 'wrapped for the capsule');
  wrap.fire('mouseenter');
  const cap = app.host.querySelector('.rv-capsule-float');
  assert.ok(cap, 'and raises one on approach');
  assert.ok(cap.querySelector('.rv-cap-title').textContent.length > 0);
  // Edit keeps a sub where five of the seven refusals lost theirs (#214): it
  // names the buffering asymmetry, which is the only non-obvious fact here —
  // a new comment survives an outage, an edit does not.
  assert.match(cap.querySelector('.rv-cap-sub').textContent, /can’t be held offline/);
  wrap.fire('mouseleave');
  assert.equal(edit.title, '', 'no native tooltip competing with it');

  // Comment is NOT refused — it is the one write that buffers offline (#202).
  assert.notEqual(comment, undefined, 'Comment is still on the pill');
  assert.notEqual(comment.disabled, true, 'and stays live while down');
});

test('neither the pill\'s Edit click nor the e shortcut can open an editor while down (#215)', async () => {
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();
  app.state.down = true;
  await app.tick();

  const pill = app.raiseSelPill('r-0001');
  const block = app.document.querySelector('[data-rev="r-0001"]');
  const edit = pill.querySelectorAll('button')
    .find((b) => (b.getAttribute('aria-label') || '').startsWith('Edit text'));

  edit.fire('click'); // the disabled button carries no handler at all
  await app.settle();
  assert.equal(block.classList.contains('rv-editing'), false, 'the click opened nothing');

  // The keyboard path routes through the same pillEdit chokepoint.
  await app.fireDocument('keydown', { key: 'e', preventDefault() {}, stopPropagation() {} });
  await app.settle();
  assert.equal(block.classList.contains('rv-editing'), false, 'and neither did the shortcut');
});

test('the pill\'s Edit opens normally when the runner is up — the refusal is down-only (#215)', async () => {
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();
  const pill = app.raiseSelPill('r-0001');
  const edit = pill.querySelectorAll('button')
    .find((b) => (b.getAttribute('aria-label') || '').startsWith('Edit text'));
  assert.ok(edit, 'Edit is offered');
  assert.notEqual(edit.disabled, true, 'and live');
  assert.equal(edit.parentElement.classList.contains('rv-explaining'), false, 'with no capsule wrap');
});

test('a healthy runner wraps nothing — the capsule cannot fire on a live control', async () => {
  const app = boot({ comments: [ANCHORED(1)] });
  await app.settle();
  const card = app.cardsEl().querySelector('[data-rv-comment]');
  card.fire('click', { target: card });
  await app.settle();
  const live = app.cardsEl().querySelector('[data-rv-comment]');
  assert.equal(live.querySelectorAll('.rv-explaining').length, 0);
  assert.equal(live.querySelectorAll('.rv-capsule').length, 0);
});

// ---- the buffered card is expanded ON PURPOSE --------------------------------

test('a buffered card is always expanded and cannot be collapsed — by design', async () => {
  // Filed in the 2026-08-02 live pass as a bug ("clicking does not collapse it
  // the way a saved card does"). It is not one: localCard() renders
  // rv-expanded unconditionally and there is no collapse to fire, because this
  // card holds the ONLY copy of some writing and a clipped quote would hide
  // text that exists nowhere else. Recorded here so the next live pass reads
  // it as a decision instead of re-filing it.
  //
  // #216 (2026-08-15) gave the click a DIFFERENT job — reveal, not collapse —
  // so "binds no click handler at all" stopped being true; see the next test.
  const app = boot({
    comments: [],
    down: true,
    buffer: [HELD('local-a', 'the only copy of this sentence', 'r-0001')],
  });
  await app.settle();

  const card = app.cardsEl().querySelector('.rv-buffered');
  assert.ok(card, 'the held comment renders in the list beside saved ones');
  assert.ok(card.classList.contains('rv-expanded'));

  card.fire('click', { target: card });
  await app.settle();
  const after = app.cardsEl().querySelector('.rv-buffered');
  assert.ok(after.classList.contains('rv-expanded'), 'still open, still readable');
  assert.match(after.textContent, /the only copy of this sentence/);
  assert.match(after.textContent, /on this device, not saved/);
});

// ---- #216: buffered comments link back to their anchored text ---------------

test('clicking a buffered card reveals its anchor, same as a saved card', async () => {
  const app = boot({
    comments: [],
    down: true,
    buffer: [HELD('local-a', 'the only copy of this sentence', 'r-0001')],
  });
  await app.settle();

  const card = app.cardsEl().querySelector('.rv-buffered');
  assert.ok(card.handlers.get('click'), 'a listener is wired — there is something to reveal');
  assert.equal(app.host.querySelectorAll('.rv-flash').length, 0, 'nothing flashes before the click');

  card.fire('click', { target: card });
  await app.settle();

  assert.equal(app.host.querySelectorAll('.rv-flash').length, 1,
    'the click scrolled to and flashed the anchored text, the same as a saved card');
});

test('a buffered card whose anchor cannot be found gets the orphan chip, not a crash', async () => {
  const app = boot({
    comments: [],
    down: true,
    // 'nowhere' is not one of the harness's instrumented blocks (r-0001,
    // r-0002) — locateAnchor finds nothing, the same as a saved comment whose
    // block was deleted from the document.
    buffer: [HELD('local-b', 'text that has since been edited away', 'nowhere')],
  });
  await app.settle();

  const card = app.cardsEl().querySelector('.rv-buffered');
  assert.ok(card, 'the card still renders — an unlocatable anchor is not a crash');
  assert.ok(card.classList.contains('rv-orphaned'), 'the same class a saved orphaned card carries');
  assert.equal(card.handlers.get('click'), undefined, 'nothing to reveal, so no listener');
  const chip = card.querySelectorAll('.rv-mini-orphan');
  assert.equal(chip.length, 1);
  assert.equal(chip[0].textContent, 'orphan');

  card.fire('click', { target: card });
  await app.settle();
  assert.equal(app.host.querySelectorAll('.rv-flash').length, 0, 'still nothing to flash');
});

test('a buffered REPLY with no anchor of its own is not mislabelled orphan', async () => {
  const app = boot({
    comments: [{
      id: 'c-1', status: 'open', body: 'the parent ask',
      anchor: null, creator: 'human', createdAt: '2026-08-11T10:00:00.000Z', replies: [],
    }],
    down: true,
    buffer: [{
      localId: 'local-r', kind: 'reply', replyTo: 'c-1', body: 'a buffered reply',
      anchor: null, createdAt: '2026-08-15T10:00:00.000Z', failed: null,
    }],
  });
  await app.settle();

  const card = app.cardsEl().querySelector('.rv-buffered');
  assert.ok(card, 'the buffered reply renders');
  assert.equal(card.classList.contains('rv-orphaned'), false, 'no anchor to lose is not the same as a lost anchor');
  assert.equal(card.querySelectorAll('.rv-mini-orphan').length, 0);
});
