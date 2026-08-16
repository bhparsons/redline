// test/runner/overlay-card-shape.test.mjs — Phase 10 card shape (#197-#201).
//
// Four defects in the shipped card, three of which are pure logic and one of
// which is CSS. The pure part is commentHistory() and the three things the card
// face says; both are exposed on window.__rvTest so node can execute them
// against a DOM stub. The CSS part — the gap vocabulary — is checked by
// reading the sheet, because "count the 14s, there should be three" is exactly
// the five-second check the rule was written to enable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadOverlay as loadOverlaySet, EXT_DIR } from './_overlay-load.mjs';

function makeElement(tag) {
  return {
    tag, className: '', textContent: '', title: '', children: [],
    appendChild(child) { this.children.push(child); return child; },
    setAttribute() {}, addEventListener() {},
  };
}
const loadOverlay = () => loadOverlaySet({ createElement: makeElement });
const css = () => readFileSync(path.join(EXT_DIR, 'overlay.css'), 'utf8');

// A comment that was replied to, DECLINED, argued with, then addressed — the
// worked worst case from the design, not a two-item example.
const COMMENT = {
  id: 'c-1',
  status: 'open',
  body: 'Name the exception process, and give it a number.',
  replies: [
    { body: 'Also say who approves the exception.', createdAt: '2026-07-31T09:20:00.000Z' },
    { body: 'Fair. Use the Q2 finance memo as the source.', createdAt: '2026-07-31T09:36:00.000Z' },
    { body: 'Reading the Q2 memo now.', createdAt: '2026-07-31T09:38:00.000Z', creator: 'agent', agentName: 'haiku' },
    { body: 'Two signatures is right, drop the citation.', createdAt: '2026-07-31T09:44:00.000Z' },
  ],
  // The single slot only remembers the LAST run, which is the data loss.
  resolution: { runId: 'run-51c', decision: 'addressed', summary: 'Named the two-signature exception.' },
};
const RUNS = [
  {
    runId: 'run-4a1',
    commentId: 'c-1',
    model: 'sonnet',
    status: 'ok',
    createdAt: '2026-07-31T09:31:00.000Z',
    decisions: [{ id: 'c-1', decision: 'declined', summary: 'No source in the memo for the approval chain.' }],
  },
  {
    runId: 'run-51c',
    commentIds: ['c-1', 'c-2'],
    model: 'sonnet',
    status: 'ok',
    createdAt: '2026-07-31T09:41:00.000Z',
    decisions: [
      { id: 'c-2', decision: 'addressed', summary: 'A different comment entirely.' },
      { id: 'c-1', decision: 'addressed', summary: 'Named the two-signature exception.' },
    ],
  },
];

// ---- #199: the ordering rule ------------------------------------------------

test('the history interleaves replies and decisions by timestamp', () => {
  const { commentHistory } = loadOverlay();
  const h = commentHistory(COMMENT, RUNS);
  const stamps = h.map((e) => e.at);
  assert.deepEqual(
    Array.from(stamps),
    [...stamps].sort(),
    'stamps must ascend down the card — that IS the rule',
  );
  assert.deepEqual(
    Array.from(h.filter((e) => e.kind !== 'event'), (e) => `${e.kind}:${e.at.slice(11, 16)}`),
    ['reply:09:20', 'decision:09:31', 'reply:09:36', 'reply:09:38', 'decision:09:41', 'reply:09:44'],
  );
});

test('every decision survives, not just the one in comment.resolution', () => {
  const { commentHistory } = loadOverlay();
  const decisions = commentHistory(COMMENT, RUNS).filter((e) => e.kind === 'decision');
  assert.equal(decisions.length, 2, 'the earlier decline is not lost');
  assert.equal(decisions[0].decision, 'declined');
  assert.equal(decisions[0].runId, 'run-4a1');
  assert.equal(decisions[1].decision, 'addressed');
});

test('a batch run only contributes ITS OWN comment decision', () => {
  const { commentHistory } = loadOverlay();
  const h = commentHistory(COMMENT, RUNS);
  assert.ok(!h.some((e) => e.summary === 'A different comment entirely.'));
});

test('an undone run is marked rather than dropped', () => {
  const { commentHistory } = loadOverlay();
  const runs = [{ ...RUNS[0], status: 'undone' }];
  const [d] = commentHistory({ id: 'c-1', status: 'declined' }, runs);
  assert.equal(d.undone, true);
});

test('without run records the resolution stands in, and sinks to the bottom', () => {
  const { commentHistory } = loadOverlay();
  // No runs at all: the card must not show LESS than it does today.
  const h = commentHistory(COMMENT, []);
  const last = h[h.length - 1];
  assert.equal(last.kind, 'decision');
  assert.equal(last.decision, 'addressed');
  assert.equal(last.at, '', 'no timestamp is invented for it');
  assert.equal(h.filter((e) => e.kind === 'decision').length, 1);
});

test('the resolution is NOT duplicated when its run record is present', () => {
  const { commentHistory } = loadOverlay();
  const summaries = commentHistory(COMMENT, RUNS)
    .filter((e) => e.kind === 'decision')
    .map((e) => e.summary);
  assert.equal(summaries.filter((s) => s.startsWith('Named the two-signature')).length, 1);
});

// ---- #236: the scope-gate outcome rides on the history, so the card can
// tell "ran straight through" apart from "stopped and a human allowed it". --

test('a decision entry carries its run\'s scopeGate verbatim', () => {
  const { commentHistory } = loadOverlay();
  const runs = [{ ...RUNS[0], scopeGate: { fired: true, level: 'section' } }];
  const [d] = commentHistory({ id: 'c-1', status: 'declined' }, runs);
  assert.deepEqual(d.scopeGate, { fired: true, level: 'section' });
});

test('a decision entry with no scopeGate on its run carries null, not undefined', () => {
  const { commentHistory } = loadOverlay();
  // RUNS[0] predates the field (no scopeGate key at all) — the shape stays
  // stable either way, which is what the render side depends on.
  const [d] = commentHistory({ id: 'c-1', status: 'declined' }, [RUNS[0]]);
  assert.equal(d.scopeGate, null);
});

test('a declined scope confirmation gets its own row, tied to the comment it asked', () => {
  const { commentHistory } = loadOverlay();
  const runs = [
    ...RUNS,
    {
      runId: 'run-decl', commentId: 'c-1', status: 'declined', lane: 'declined',
      decisions: [], edits: [], createdAt: '2026-07-31T09:33:00.000Z',
    },
  ];
  const h = commentHistory(COMMENT, runs);
  const declined = h.filter((e) => e.kind === 'gate-declined');
  assert.equal(declined.length, 1);
  assert.equal(declined[0].runId, 'run-decl');
  // It sits in timestamp order among everything else (09:31 decline-decision,
  // 09:33 this, 09:36 reply) — not bolted to the top or bottom of the thread.
  // Array.from (not a bare .map): h is built inside the vm-context overlay
  // realm, and deepEqual against an outer-realm array literal otherwise fails
  // on constructor identity even when every element is equal (see the other
  // ordering test above, same idiom).
  const order = Array.from(h.filter((e) => e.kind !== 'event'), (e) => `${e.kind}:${e.at.slice(11, 16)}`);
  assert.deepEqual(order, [
    'reply:09:20', 'decision:09:31', 'gate-declined:09:33', 'reply:09:36', 'reply:09:38', 'decision:09:41', 'reply:09:44',
  ]);
});

test('a declined run on a DIFFERENT comment produces no row here — commentId, not proximity', () => {
  const { commentHistory } = loadOverlay();
  const runs = [
    { runId: 'run-decl-2', commentId: 'c-2', status: 'declined', decisions: [], edits: [], createdAt: '2026-07-31T09:33:00.000Z' },
  ];
  const h = commentHistory(COMMENT, runs);
  assert.equal(h.filter((e) => e.kind === 'gate-declined').length, 0, 'wrong comment id — must not bleed across cards');
});

test('an OK run\'s decision is not mistaken for a declined-gate row', () => {
  const { commentHistory } = loadOverlay();
  // RUNS has no declined-status entries at all — every decision entry it
  // produces must stay kind:'decision', never kind:'gate-declined'.
  const h = commentHistory(COMMENT, RUNS);
  assert.equal(h.filter((e) => e.kind === 'gate-declined').length, 0);
});

test('replies name a person as "user" and an agent by its session name', () => {
  const { commentHistory } = loadOverlay();
  const replies = commentHistory(COMMENT, RUNS).filter((e) => e.kind === 'reply');
  assert.deepEqual(Array.from(replies, (r) => r.who), ['user', 'user', 'haiku', 'user']);
  assert.deepEqual(Array.from(replies, (r) => r.agent), [false, false, true, false]);
});

test('commentHistory tolerates an empty comment', () => {
  const { commentHistory } = loadOverlay();
  assert.equal(commentHistory({ id: 'c-9', status: 'open' }).length, 0);
});

// ---- #198: re-opening -------------------------------------------------------

test('a human reply after a decision records the re-open where it happened', () => {
  const { commentHistory } = loadOverlay();
  const h = commentHistory(COMMENT, RUNS);
  const i = h.findIndex((e) => e.kind === 'event' && e.event === 'reopened');
  assert.ok(i > 0, 'the flip is an event in the history, not a mood');
  assert.equal(h[i - 1].kind, 'reply');
  assert.equal(h[i - 1].at, '2026-07-31T09:44:00.000Z', 'at the reply that caused it');
  assert.equal(h[i].at, h[i - 1].at);
});

test('an AGENT reply does not re-open — it must not reverse the author', () => {
  const { commentHistory } = loadOverlay();
  const comment = {
    id: 'c-1',
    status: 'open',
    replies: [{ body: 'Looking.', createdAt: '2026-07-31T09:50:00.000Z', creator: 'agent', agentName: 'haiku' }],
  };
  const h = commentHistory(comment, RUNS);
  assert.ok(!h.some((e) => e.kind === 'event'));
});

test('a settled comment carries no re-open event', () => {
  const { commentHistory } = loadOverlay();
  const h = commentHistory({ ...COMMENT, status: 'addressed' }, RUNS);
  assert.ok(!h.some((e) => e.kind === 'event'));
});

test('the composer states the consequence on a settled card, and only there', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  assert.match(js, /settled \? 'Reply & re-open' : 'Reply'/,
    'the label says what the button does');
  // #250: the re-open moved into the runner — the reply itself re-opens a
  // settled comment in one write, so the overlay must NOT follow up with a
  // second status call in the reply path.
  assert.ok(!/reply`, \{ page, body: text \}\);[\s\S]{0,200}status: 'open'/.test(js),
    'no second status call after posting a reply — the runner owns the re-open');
});

// ---- #201: what the card face says ------------------------------------------

test('the thread count counts turns taken, not events that merely happened', () => {
  const { commentHistory, threadCount } = loadOverlay();
  const h = commentHistory(COMMENT, RUNS);
  assert.ok(h.some((e) => e.kind === 'event'), 'there IS an event in this history');
  assert.equal(threadCount(h), 6, '4 replies + 2 decisions; the re-open is not a turn');
  assert.equal(threadCount([]), 0);
});

test('a fresh human comment carries no status and no count', () => {
  const { commentHistory, threadCount, faceStatus, lastSaid } = loadOverlay();
  const fresh = { id: 'c-2', status: 'open', body: 'Give this a number.' };
  const h = commentHistory(fresh, []);
  assert.equal(threadCount(h), 0);
  assert.equal(faceStatus(fresh, h), null, 'the common case pays no badge');
  assert.equal(lastSaid(h), null);
});

test('an open comment that was decided once reads as re-opened', () => {
  const { commentHistory, faceStatus } = loadOverlay();
  const h = commentHistory(COMMENT, RUNS);
  assert.equal(faceStatus(COMMENT, h), 're-opened');
});

test('every other status is shown verbatim', () => {
  const { faceStatus } = loadOverlay();
  for (const s of ['addressed', 'declined', 'deferred', 'failed', 'resolved']) {
    assert.equal(faceStatus({ status: s }, []), s);
  }
});

test('lastSaid is the last turn, whether that was a reply or a decision', () => {
  const { commentHistory, lastSaid } = loadOverlay();
  const afterReply = lastSaid(commentHistory(COMMENT, RUNS));
  assert.equal(afterReply.who, 'user replied');
  assert.equal(afterReply.agent, false);

  const declined = { id: 'c-1', status: 'declined' };
  const afterDecision = lastSaid(commentHistory(declined, [RUNS[0]]));
  assert.equal(afterDecision.who, 'sonnet declined');
  assert.equal(afterDecision.agent, true);
});

test('clockTime: bare time today, date-qualified before that, nothing for junk', () => {
  const { clockTime } = loadOverlay();
  // Same day: the scannable clock stamp, unchanged.
  assert.match(clockTime('2026-07-31T09:31:00.000Z', new Date('2026-07-31T18:00:00.000Z')), /^\d\d:\d\d$/);
  // Older than "today": the date rides along (Blake, acceptance 2026-08-12).
  assert.match(clockTime('2026-07-31T09:31:00.000Z', new Date('2026-08-12T09:00:00.000Z')), /^\w+ \d{1,2} \d\d:\d\d$/);
  assert.equal(clockTime(''), '');
  assert.equal(clockTime('not a date'), '');
  assert.equal(clockTime(undefined), '');
});

test('the identity slot draws two values and never a letter (#201)', () => {
  const sheet = css();
  // A person gets a round dot; a session gets an angular mark. Two shapes, so
  // the greyscale test passes without reading colour.
  assert.match(sheet, /\.rv-av-anon::after \{[^}]*border-radius: var\(--rv-radius-pill\)/);
  assert.match(sheet, /\.rv-by-agent \.rv-av::after \{[^}]*transform: rotate\(45deg\)/);
  // No initials: nothing sets a font-size on the disc, because nothing goes in it.
  assert.ok(!/\.rv-av \{[^}]*font-size/.test(sheet), 'the disc holds a mark, not a letter');
});

// ---- #197: the control row ---------------------------------------------------

test('the controls own a row of their own, so nothing can drift (#197)', () => {
  const sheet = css();
  const row = sheet.match(/#rv-root \.rv-card-controls \{([^}]*)\}/);
  assert.ok(row, '.rv-card-controls exists');
  assert.match(row[1], /align-items: center/, 'the row centres on itself');
  assert.match(row[1], /min-height: 22px/, 'a fixed 22px row, not one the quote can stretch');
  // The old fight: .rv-mini align-self:center inside a flex-start row whose
  // height came from a quote that wraps only when expanded.
  assert.ok(!/\.rv-mini \{[^}]*align-self/.test(sheet), '.rv-mini no longer opts out of its row');
  assert.ok(!/\.rv-card-top/.test(sheet), 'the mixed quote+controls row is gone');
  // The quote is a sibling BELOW the row, not a flex child inside it.
  assert.match(sheet, /#rv-root \.rv-card-quote \{[^}]*margin-top: 4px/);
});

// ---- #200: the gap vocabulary -----------------------------------------------

// Every rule between "The card" and the end of the card block. Scoped that way
// on purpose: the rule governs a card's children, not the whole overlay.
function cardRules() {
  const sheet = css();
  const start = sheet.indexOf('#rv-root .rv-card {');
  const end = sheet.indexOf('/* status chips', start);
  assert.ok(start > 0 && end > start, 'the card block is findable');
  return sheet.slice(start, end);
}

test('the card sets margin-top and never margin-bottom (#200)', () => {
  const block = cardRules();
  const offenders = [...block.matchAll(/margin-bottom\s*:|margin\s*:/g)].map((m) => m[0]);
  assert.deepEqual(offenders, [],
    'a gap is one number owned by the lower element, never the sum of two opinions');
});

test('only 4, 8 and 14 are legal, and 14 appears exactly three times (#200)', () => {
  const block = cardRules();
  const values = [...block.matchAll(/margin-top:\s*(\d+)px/g)].map((m) => Number(m[1]));
  const illegal = values.filter((v) => ![0, 4, 8, 14].includes(v));
  assert.deepEqual(illegal, [], 'three values inside a card, plus 0 for a first child');
  assert.equal(values.filter((v) => v === 14).length, 3,
    'head->ask, ask->history, history->now — count the 14s, there should be three');
});

test('the third 14 carries the card\'s only hairline (#200)', () => {
  const block = cardRules();
  const borders = [...block.matchAll(/border-top:\s*1px solid/g)];
  assert.equal(borders.length, 1, 'exactly one divider inside a card');
  assert.match(block, /#rv-root \.rv-now \{[^}]*margin-top: 14px;[^}]*border-top: 1px solid/,
    'and it belongs to zone 4');
});

test('radii inside a card come from the token sheet (#200)', () => {
  const block = cardRules();
  const radii = [...block.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const r of radii) {
    // 0 is legal: it UN-rounds something (the run-id link is a link, not a
    // button). Any other bare number would be a fourth radius vocabulary.
    assert.match(r, /^0$|var\(--rv-radius-(lg|sm|pill)\)|inherit/, `hand-rolled radius: ${r}`);
  }
});
