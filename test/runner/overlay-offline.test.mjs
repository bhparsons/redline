// test/runner/overlay-offline.test.mjs — the runner-is-down surface.
//
//   #196 slice 1 — one liveness indicator in one slot, and a refused control
//                  that says why. Slices 2 and 3 need session presence (#187)
//                  and are not here.
//   #202        — comments buffered locally while the runner is down, replayed
//                  on reconnect, and never silently dropped.
//   #203        — a citable comment reference.
//
// shortRef is pure and runs against the DOM stub; the rest is checked by
// reading the two files, because the behaviour that matters is structural
// (which state exists, what is disabled, where a write can go) rather than
// arithmetic.

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
const js = () => readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
const css = () => readFileSync(path.join(EXT_DIR, 'overlay.css'), 'utf8');

// ---- #203: a citable comment reference --------------------------------------

test('shortRef turns an unsayable id into four sayable characters', () => {
  const { shortRef, REF_LEN } = loadOverlay();
  const ref = shortRef('c-5999e7a0980f');
  assert.equal(ref.length, REF_LEN);
  assert.match(ref, /^[a-z0-9]+$/);
});

test('the alphabet has no character that survives being read aloud wrong', () => {
  const { REF_ALPHABET } = loadOverlay();
  for (const bad of ['0', 'O', 'o', '1', 'l', 'I', 'i']) {
    assert.ok(!REF_ALPHABET.includes(bad), `${bad} is confusable and must not be in the alphabet`);
  }
});

test('the same id always gives the same handle — a conversation cannot go stale', () => {
  const { shortRef } = loadOverlay();
  const a = loadOverlay().shortRef('c-5999e7a0980f');
  assert.equal(shortRef('c-5999e7a0980f'), a, 'stable across reloads, not just within one');
});

test('different ids give different handles across a realistic page', () => {
  const { shortRef } = loadOverlay();
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(shortRef(`c-${i.toString(16).padStart(12, '0')}`));
  assert.equal(seen.size, 200, 'no collision at 200 comments on one page');
});

test('shortRef is derived, so nothing is stored and no schema changes', () => {
  const src = js();
  // It reads the id and nothing else — no lookup table, no counter, no write.
  assert.match(src, /function shortRef\(id\)/);
  assert.ok(!/shortRef[\s\S]{0,400}localStorage/.test(src), 'the handle is computed, never persisted');
});

test('a buffered comment gets no handle, because its id is not real yet', () => {
  const src = js();
  assert.match(src, /const ref = item\.local \? '' : shortRef\(item\.id\)/);
});

test('shortRef tolerates junk', () => {
  const { shortRef } = loadOverlay();
  assert.equal(shortRef(''), '');
  assert.equal(shortRef(undefined), '');
  assert.equal(shortRef(null), '');
});

// ---- #196 slice 1: one indicator, one slot ----------------------------------

test('a healthy runner draws no indicator at all', () => {
  const src = js();
  // The state is null unless something is actually wrong, and null hides it.
  assert.match(src, /const state = runnerDown \? 'down'/);
  assert.match(src, /banner\.className = state \? `rv-abn rv-abn-\$\{state\}` : 'rv-abn rv-hidden'/);
});

test('there is ONE indicator element, not a stack of pills', () => {
  const src = js();
  const created = [...src.matchAll(/el\('div', 'rv-abn[ ']/g)];
  assert.equal(created.length, 1, 'exactly one banner is ever constructed');
});

test('the indicator sits below the filters and above the cards', () => {
  const src = js();
  const header = src.indexOf('panel.appendChild(header)');
  const banner = src.indexOf('panel.appendChild(banner)');
  const cards = src.indexOf('panel.appendChild(cards)');
  assert.ok(header < banner && banner < cards, 'one slot, and it is that slot');
});

test('offline is red, recovery is green, a failed replay is amber', () => {
  const sheet = css();
  assert.match(sheet, /#rv-root \.rv-abn-down \{[^}]*var\(--rv-dot-declined\)/);
  assert.match(sheet, /#rv-root \.rv-abn \{[^}]*var\(--rv-dot-addressed\)/);
  assert.match(sheet, /#rv-root \.rv-abn-warn \{[^}]*var\(--rv-amber-solid\)/);
});

test('the offline banner names the reload trap in Blake\'s exact wording (#207, 2026-08-15)', () => {
  const src = js();
  // Picked 2026-08-15 after five drafts compared side by side at real panel
  // width (design/mock-chunk1-repairs.html, version D) — the previous copy
  // ran 180 characters to five or six lines at 312px and never said the one
  // thing that matters: reloading loses the page, because the runner is also
  // what serves it. The only irreversible action goes in the bold headline
  // (em dash, not a hyphen); the reassurance that comments are safe is
  // demoted to the quieter sub line because it can afford to be missed.
  assert.match(src, /Runner offline — do not reload page\./);
  assert.match(src, /saved and will sync when the runner is back online\./);
  // Blake amended it the same day: "add back the # of comments". A count you
  // can check beats a reassurance you have to take on trust. Zero is the
  // exception — "0 comments are saved" reads as a failure report, so that
  // case keeps the unnumbered sentence.
  assert.match(src, /waiting === 0/, 'zero buffered comments must not be reported as a count');
  assert.match(src, /waiting === 1 \? ' is' : 's are'/, 'one comment takes the singular verb');
});

test('the retry age advances on its own — the poll that would redraw it is what failed', () => {
  const src = js();
  assert.match(src, /downTimer = setInterval\(renderBanner, DOWN_TICK_MS\)/);
  assert.match(src, /clearInterval\(downTimer\)/, 'and stops when the runner is back');
});

test('Send all is refused offline and explains itself in a capsule', () => {
  const src = js();
  assert.match(src, /sendAllBtn\.disabled = runnerDown \|\|/);
  // #212: the capsule also appears when no watcher is attached — and #254
  // added the informational watching variant on the same wrap.
  assert.match(src, /sendAllWrap\.classList\.toggle\('rv-explaining', runnerDown \|\| needsWatcher \|\| watching\)/);
  assert.match(src, /setCapsuleWhy\(sendAllWrap, 'Needs the runner'\)/);
  // #214: the reason is data on the wrap; the capsule is built from it on
  // approach. The reassurance sub was cut — it restated the title. The
  // no-watcher variant keeps its sub because it is a next step, not a restatement.
  assert.match(src, /setCapsuleWhy\(sendAllWrap, 'No watcher attached', 'Attach a Claude Code or Codex session'\)/);
});

test('the capsule appears only on a control that is actually refused', () => {
  const src = js();
  const sheet = css();
  // #214: the reveal is no longer CSS hover on a nested node — the capsule is
  // built into #rv-root on approach. The refused-only rule survives the move
  // as the guard at the top of the handler, and it is the same rule: a live
  // Send all must not pop a capsule saying it needs the runner.
  assert.match(src, /if \(!wrap\.classList\.contains\('rv-explaining'\)\) return;/,
    'a control that is not refused shows nothing');
  // The pencil keeps its nested capsules (it already lives in #rv-root and one
  // of them holds a button), so its hover rule must stay.
  assert.match(sheet, /#rv-root \.rv-why \{[^}]*opacity: 0/);
  assert.match(sheet, /\.rv-pencil-off:hover > \.rv-why/);
});

test('the hover can actually reach the wrap that opens the capsule (#214)', () => {
  const sheet = css();
  // The capsule opens from a mouseenter listener on the WRAP. Chrome does not
  // dispatch mouse events from a disabled form control, and the wrap is exactly
  // the size of the button it holds — so without this the disabled button is the
  // hit-test target, the wrap never sees the cursor, and EVERY refusal is silent.
  //
  // This shipped broken in 0.4.12 and was caught by Blake on real hardware, not
  // here: the DOM stub's fire() dispatches straight at the node and bypasses
  // hit-testing, so 76 passing tests said nothing about whether a real mouse
  // could ever reach the listener. The old build survived on CSS :hover, which
  // hit-tests fine over a disabled child; a JS listener does not.
  assert.match(sheet, /\.rv-explaining > button:disabled \{[^}]*pointer-events: none/,
    'a disabled refused control must let the hover through to its wrap');
});

test('the capsule paints above every layer that hosts a refused control (#214)', () => {
  const sheet = css();
  const z = (sel) => {
    const m = sheet.match(new RegExp('#rv-root \\.' + sel + ' \\{([^}]*)\\}'));
    assert.ok(m, `no rule for .${sel}`);
    const zi = m[1].match(/z-index:\s*(\d+)/);
    assert.ok(zi, `.${sel} has no z-index`);
    return Number(zi[1]);
  };
  const capsule = z('rv-capsule-float');
  // Nested, the capsule sat at z-index 9 inside the PANEL's stacking context and
  // that was enough. Escaping to #rv-root put it in the root's own scale, which
  // runs ~99968-99995 — and the value carried over unchanged buried it under
  // everything. Blake saw a faint glow: the backdrop-filter compositing beneath
  // the panel. Asserted as an ordering invariant, not a magic number, so moving
  // any of these layers cannot silently re-bury it.
  for (const host of ['rv-panel', 'rv-toolbar', 'rv-popover']) {
    assert.ok(capsule > z(host),
      `the capsule (${capsule}) must paint above .${host} (${z(host)}) — it explains controls that live there`);
  }
  // …but never over the layers whose whole job is to cover the UI.
  for (const over of ['rv-scope-scrim', 'rv-cheat']) {
    assert.ok(capsule < z(over),
      `the capsule (${capsule}) must stay under .${over} (${z(over)})`);
  }
});

test('Reply composes offline and lands in the buffer (#241 revisited)', () => {
  const src = js();
  // The 2026-08-05 rule refused the opener because a reply had nowhere to go.
  // #241 gave it somewhere to go — a reply targets a STABLE comment id, so it
  // buffers like a new comment — which retires the refusal entirely.
  assert.ok(!/refuseWhenDown\(reply,/.test(src), 'the opener is no longer refused');
  assert.ok(!/refuseWhenDown\(fuSend,/.test(src), 'nor is the send button');
  // The shared submit chokepoint routes an offline reply into the buffer —
  // both the click and cmd/ctrl+Enter pass through it.
  assert.match(src, /const postReply = async \(btn\) => \{[\s\S]{0,1200}?if \(runnerDown\) \{[\s\S]{0,100}?bufferReply\(comment\.id, text, comment\.anchor\)/,
    'offline replies buffer through the one chokepoint both entry paths share');
});

test('the hold switch says why it is refused (#241)', () => {
  const src = js();
  // It was the only refused control on the surface that explained nothing:
  // greyed with no capsule and no title, which is the dead end #196 removes.
  assert.match(src, /appendChild\(refuseWhenDown\(sw, 'Needs the runner'\)\)/);
  assert.match(src, /appendChild\(refuseWhenDown\(off, 'Needs the runner'\)\)/);
});

test('the refused pencil stays put and turns red rather than vanishing', () => {
  const src = js();
  const sheet = css();
  assert.match(src, /p\.classList\.toggle\('rv-pencil-off', runnerDown\)/);
  assert.match(src, /if \(runnerDown\) return;/, 'clicking it does nothing');
  assert.match(sheet, /\.rv-pencil-off \{[^}]*border-style: dashed/);
  assert.match(src, /Comment instead — that still works/, 'and it names the alternative');
});

test('the capsule is a floating chrome layer and carries the blur (#214)', () => {
  const src = js();
  const sheet = css();
  // This assertion used to require the OPPOSITE. The rule did not weaken — the
  // capsule moved. It was banned from backdrop-filter because it sat inside a
  // card, which would have been glass-on-glass. It is now drawn over the
  // document from #rv-root, the same kind of surface as the selection pill,
  // which joined the chrome set in #150 on exactly this reasoning.
  const rule = sheet.match(/#rv-root \.rv-capsule \{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /backdrop-filter/, 'the blur Blake asked for on 0.4.11');
  // The move is what licenses it, so the move must actually be there.
  assert.match(src, /host\.appendChild\(capsuleEl\)/, 'built into the root, not the card');
  assert.match(sheet, /#rv-root \.rv-capsule-float \{[^}]*position: absolute/);
});

// ---- #202: buffering and replay ---------------------------------------------

test('the buffer is per page and survives a closed tab', () => {
  const src = js();
  assert.match(src, /BUFFER_KEY_PREFIX = 'rv-buffer:'/);
  assert.match(src, /function bufferKey\(\) \{ return `\$\{BUFFER_KEY_PREFIX\}\$\{page\}`; \}/);
  // localStorage, not sessionStorage: a closed tab must not lose writing.
  assert.match(src, /localStorage\.setItem\(bufferKey\(\)/);
  assert.ok(!/sessionStorage[^\n]*bufferKey/.test(src));
});

test('nothing evicts a buffered comment except saving it', () => {
  const src = js();
  // The only removal from the array is the line that follows a successful POST,
  // plus the author's own explicit Discard.
  const removals = [...src.matchAll(/bufferedComments = bufferedComments\.filter/g)];
  assert.equal(removals.length, 3,
    'comment replay, reply replay (#241), and the explicit Discard — nothing else');
  assert.ok(!/setTimeout[^\n]*bufferedComments/.test(src), 'no TTL — an expiry is a silent drop');
});

test('a full buffer refuses rather than dropping the oldest', () => {
  const src = js();
  assert.match(src, /if \(bufferedComments\.length >= BUFFER_MAX\) return false;/);
  assert.match(src, /This device is holding \$\{BUFFER_MAX\} unsaved comments/);
});

test('comments and replies buffer offline; edits and runs do not', () => {
  const src = js();
  // What enters the buffer: a comment body + anchor, or a reply body + its
  // parent's stable id (#241). Nothing that writes to the DOCUMENT ever does.
  assert.match(src, /function bufferComment\(body, anchor, asNote\)/);
  assert.match(src, /function bufferReply\(commentId, body, parentAnchor\)/);
  const calls = [...src.matchAll(/bufferComment\(/g)];
  assert.equal(calls.length, 3, 'one definition, two call sites — both in the composer');
  // The direct-edit path refuses instead of queueing.
  assert.ok(!/openInlineEditor[\s\S]{0,300}bufferComment/.test(src));
});

test('replay is triggered by the reconnect EDGE, once', () => {
  const src = js();
  // The edge lives in setRunnerDown, with the rest of what a liveness change
  // means. It used to live in refresh(), which the watch tick reaches only when
  // the sidecar's `rev` moved — and nothing moves while the runner is down, so
  // the trigger sat behind a gate that the situation it exists for guarantees
  // is shut. See overlay-liveness.test.mjs, which boots the overlay and drives
  // the edge rather than reading for it.
  const fn = src.match(/function setRunnerDown\(down\) \{[\s\S]*?\n    \}/)[0];
  assert.match(fn, /if \(!down\) flushBuffer\(\);/);
  assert.match(fn, /if \(down === runnerDown\) return;/, 'once per transition, not once per tick');
  assert.ok(!/wasDown/.test(src), 'and refresh() no longer has an opinion about liveness');
  assert.match(src, /if \(pending\.length === 0 \|\| replay !== null\) return;/,
    'and a flush already running is not started twice');
});

test('a comment whose anchor is gone fails the replay instead of landing orphaned', () => {
  const src = js();
  // The runner stores an anchor verbatim without resolving it, so this check
  // exists nowhere else — a missing quote would POST happily.
  assert.match(src, /if \(!locateAnchor\(item\.anchor\)\) \{/);
  assert.match(src, /The quoted text is gone from the document/);
});

test('a failed replay keeps the comment, and offers the two exits', () => {
  const src = js();
  assert.match(src, /'Re-anchor…'/);
  assert.match(src, /'Copy text'/);
  assert.match(src, /clipboard\.writeText\(comment\.body\)/, 'copy text is the floor');
  // Re-anchoring a buffered comment rewrites the local entry and retries.
  assert.match(src, /const local = bufferedComments\.find\(\(b\) => b\.localId === id\);/);
  assert.match(src, /local\.failed = null;[\s\S]{0,120}flushBuffer\(\)/);
});

test('a stuck comment gets the top of the panel and its own heading', () => {
  const src = js();
  assert.match(src, /const stuck = shown\.filter\(\(c\) => c\.local && c\.failed\);/);
  assert.match(src, /add\('Needs attention', stuck/);
  // …and it is NOT also counted among the open ones.
  assert.match(src, /groupComments\(shown\.filter\(\(c\) => !\(c\.local && c\.failed\)\)\)/);
});

test('unsaved work carries three signals, so it cannot read as saved', () => {
  const sheet = css();
  const rule = sheet.match(/#rv-root \.rv-card\.rv-buffered \{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /border-style: dashed/, '1 — dashed border');
  assert.match(sheet, /\.rv-card\.rv-buffered::before \{[^}]*repeating-linear-gradient/, '2 — segmented rail');
  assert.match(sheet, /#rv-root \.rv-local \{/, '3 — a chip naming where it lives');
  assert.match(js(), /'on this device, not saved'/);
});

test('a buffered comment cannot be sent — there is no id to send', () => {
  const src = js();
  const fn = src.match(/function sendableComments\(\) \{[\s\S]*?\n    \}/)[0];
  assert.ok(!/bufferedComments/.test(fn), 'the batch reads the SERVER list only');
});

test('a buffered card shows its audience without offering to change it', () => {
  const src = js();
  const fn = src.match(/function localCard\(comment\) \{[\s\S]*?\n    \}\n/)[0];
  assert.match(fn, /el\('span', `rv-mini rv-mini-\$\{aud\}`/, 'a span, not a button');
  assert.ok(!/rv-approve/.test(fn), 'and no tick — resolving is a write too');
});

test('buffered comments are on screen from the first paint', () => {
  const src = js();
  const load = src.indexOf('loadBuffer();');
  const first = src.indexOf('refresh()', load);
  assert.ok(load > 0 && first > load, 'loadBuffer runs before the first refresh');
});

test('and a buffer that outlived its tab is flushed at boot, edge or no edge', () => {
  const src = js();
  // Boot is the one moment no transition can carry: runnerDown starts false,
  // so a tab that opens against a healthy runner never transitions. A reload
  // therefore made the reconnect edge permanently unreachable in that tab, and
  // Blake recovered three comments by hand out of localStorage.
  assert.match(src, /refresh\(\)\.then\(\(\) => \{ if \(!runnerDown\) flushBuffer\(\); \}\);/);
});

// ---- the trigger, not just the mechanism -----------------------------------
//
// The bug these cover shipped past the tests above, and it is worth naming why:
// they all checked that the offline BANNER exists, renders three states and is
// wired to setRunnerDown. None checked that a dead runner ever REACHES
// setRunnerDown. It did not. Blake clicked Reopen against a runner that had
// died, the write failed, the button re-enabled itself, and nothing on screen
// said why — the exact hole #196 slice 1 exists to close.

test('a rejected fetch is what marks the runner down, and it is the only thing', () => {
  const src = js();
  const fn = src.match(/async function apiRaw\([\s\S]*?\n    \}/)[0];
  assert.match(fn, /catch \(err\) \{[\s\S]*setRunnerDown\(true\);[\s\S]*throw err;/,
    'a rejected fetch flips the banner and still propagates');
  // A 404 or 409 is a LIVE runner answering. Marking those offline would put a
  // red banner over a working system.
  assert.ok(!/ok: res\.ok[\s\S]{0,200}setRunnerDown/.test(fn),
    'a non-ok response must not be read as offline');
});

test('every write path reaches the detector, because they all go through apiRaw', () => {
  const src = js();
  // The point of putting it in apiRaw: no call site can forget. Nothing else
  // may set it true, or the paths drift apart again.
  const sets = [...src.matchAll(/setRunnerDown\(true\)/g)];
  assert.equal(sets.length, 1, 'exactly one detector: apiRaw. Every other path READS runnerDown');
  assert.match(src, /async function api\(path, payload\) \{\s*\n\s*const r = await apiRaw/,
    'api() delegates, so it inherits the detection');
});

test('the watch loop notices the outage but does not redraw for it', () => {
  const src = js();
  const tick = src.match(/function startWatching\(\)[\s\S]*?\n    \}/)[0];
  // a9d724f put a render() here so the disabled controls came up with the
  // banner. It fires every four seconds for as long as the outage lasts, and
  // render() rebuilds the card list wholesale — so it took the composer, and
  // the words in it, every four seconds. The redraw belongs on the EDGE, which
  // is where setRunnerDown now does it, exactly once.
  assert.ok(!/\} catch \{[\s\S]{0,600}render\(\);/.test(tick),
    'the failing tick must not rebuild a screen where nothing has changed');
  assert.match(src, /function setRunnerDown\(down\) \{[\s\S]*?\n      render\(\);/,
    'the edge redraws instead');
  // The one thing that DOES keep moving while down still has its own timer.
  assert.match(src, /downTimer = setInterval\(renderBanner, DOWN_TICK_MS\)/);
});

test('an open composer and its text are held outside the thing that gets rebuilt', () => {
  const src = js();
  assert.match(src, /let replyDrafts = new Map\(\);/);
  assert.match(src, /ta\.addEventListener\('input', \(\) => \{ replyDrafts\.set\(comment\.id, ta\.value\); \}\);/,
    'every keystroke — the redraw it survives is on a timer');
  assert.match(src, /const draft = replyDrafts\.get\(comment\.id\);/);
  // Dropped only where the words are somewhere else: a successful post, or the
  // author closing the composer on purpose.
  const drops = [...src.matchAll(/replyDrafts\.delete\(/g)];
  assert.equal(drops.length, 4,
    'posted, buffered offline (#241), cancelled, or toggled shut — and nothing else');
  assert.ok(!/setTimeout[^\n]*replyDrafts/.test(src), 'no expiry on a draft either');
});

test('the caret survives the redraw too, not just the characters', () => {
  const src = js();
  // Keeping the text but losing focus mid-word still reads as "it closed on me".
  assert.match(src, /const focused = captureCardFocus\(\);\s*\n\s*cards\.replaceChildren/);
  assert.match(src, /restoreCardFocus\(focused\);/);
  assert.match(src, /box\.setSelectionRange\(saved\.start, saved\.end\)/);
});

test('a write that cannot be buffered refuses visibly rather than failing quietly', () => {
  const src = js();
  assert.match(src, /function refuseWhenDown\(control, title, sub\)/);
  // Reopen is the one Blake hit. Every other write on a card now goes the same
  // way — ONE treatment, because two treatments for one situation is how the
  // audience chip ended up with the bad one: a native title on a disabled
  // button, which is slow, easy to miss, and read as "clicking does nothing,
  // but no indication as to why".
  for (const [label, needle] of [
    ['Reopen', /refuseWhenDown\(reopen, 'Needs the runner'/],
    ['Send now', /refuseWhenDown\(send, 'Needs the runner'/],
    ['the tick', /refuseWhenDown\(approve, 'Needs the runner'/],
    ['the audience chip', /refuseWhenDown\(audienceChip, 'Needs the runner'/],
    ['re-anchor', /refuseWhenDown\(here, \.\.\.REANCHOR_WHY\)/],
  ]) assert.match(src, needle, `${label} must refuse while the runner is down`);
  // No card control may still be doing it the old way.
  assert.ok(!/\.disabled = runnerDown;/.test(src.slice(src.indexOf('function card('))),
    'nothing on a card disables itself without the capsule');
  // The refusal drops the native tooltip rather than leaving it to compete.
  assert.match(src, /function refuseWhenDown[\s\S]{0,400}control\.title = '';/);
});

test('Undo refuses with a capsule too — it was the last one that just failed', () => {
  const src = js();
  assert.match(src, /undoWrap\.classList\.toggle\('rv-explaining', runnerDown\)/);
  assert.match(src, /undoBtn\.disabled = runnerDown;/);
  // #214: the sub was dropped — "only the runner can undo" is the title.
  assert.match(src, /setCapsuleWhy\(undoWrap, 'Needs the runner'\)/);
  assert.ok(!/Undo restores the document from the runner’s own snapshot/.test(src),
    'the restating sub is gone');
  // Hiding moved to the wrapper, or the capsule would go with the button.
  assert.match(src, /undoWrap\.classList\.toggle\('rv-hidden', !canUndo\)/);
  // …and the wrapper has to actually hide. Same specificity, .rv-explain wins
  // on source order, so without this Undo would show permanently.
  assert.match(css(), /#rv-root \.rv-explain\.rv-hidden \{ display: none; \}/);
});

test('a refused control in the card control row keeps the row rigid', () => {
  // The wrapper is the flex item now, so #197's fix by construction — a 22px
  // control row that cannot drift — has to move onto it with the chip.
  assert.match(css(), /#rv-root \.rv-card-controls > \.rv-explain \{[^}]*flex: none[^}]*height: 22px/);
});

test('a new comment still buffers — only what cannot be replayed is refused', () => {
  const src = js();
  // The rule is "disable only what is genuinely unsupported", never a blanket
  // read-only. Commenting is the one write that survives an outage.
  assert.match(src, /if \(runnerDown\) \{\s*\n\s*if \(!bufferComment\(body, pendingAnchor, asNote\)\)/);
  assert.ok(!/refuseWhenDown\(save/.test(src), 'the composer must NOT be refused');
});

// ---- #185: the note flag rides on the creating write ------------------------
//
// The overlay used to POST the comment and THEN POST the flag. The first write
// bumps `rev` and wakes every watcher, so a note was indistinguishable from an
// edit request until the second landed — and a session watching the stream did
// act inside that window during testing. The runner now takes `aiEdits` at
// creation (#185), so the window is closed rather than narrowed.

test('a comment is created in ONE write, carrying its audience', () => {
  const src = js();
  const creates = [...src.matchAll(/api\('\/api\/comment', \{[^}]*\}/g)].map((m) => m[0]);
  assert.equal(creates.length, 2, 'the composer and the replay, and nothing else');
  for (const call of creates) {
    assert.match(call, /aiEdits:/, `create must carry the flag: ${call}`);
  }
});

test('nothing follows a create with a separate ai-edits write', () => {
  const src = js();
  // The card chip still flips an EXISTING comment — that is a different thing
  // and must survive. What must not survive is a flip chasing a create.
  assert.ok(!/api\('\/api\/comment', \{[\s\S]{0,400}?\/ai-edits`/.test(src),
    'no create-then-flag sequence anywhere');
  assert.match(src, /const flipAiEdits = async \(\) => \{[\s\S]{0,200}\/ai-edits`/,
    'the card chip keeps its own ai-edits call');
});

test('the replay flushes notes as notes, one write each', () => {
  const src = js();
  const fn = src.match(/async function flushBuffer\(\)[\s\S]*?\n    \}/)[0];
  assert.match(fn, /aiEdits: !item\.asNote/, 'the buffered audience replays with the comment');
  assert.ok(!/ai-edits/.test(fn), 'and never as a second write');
});

// ---- #241: replies buffer and replay — booted, not read ---------------------

// The behavior half of the reply-buffer rule. The harness's fake runner
// records every call, so replay order and outcomes are observable directly.
const { boot } = await import('./_overlay-boot.mjs');

const SERVER_COMMENT = {
  id: 'c-1', status: 'open', body: 'the ask',
  anchor: { blockId: 'r-0001', quote: 'block r-0001' },
  creator: 'human', createdAt: '2026-08-11T10:00:00.000Z', replies: [],
};

test('an offline reply lands in the buffer and renders as a buffered card', async () => {
  const app = boot({ comments: [SERVER_COMMENT] });
  await app.settle();
  app.state.down = true;
  await app.tick();

  const card = app.host.querySelector('[data-rv-comment="c-1"]');
  card.fire('click'); // expand
  await app.settle();
  const expanded = app.host.querySelector('[data-rv-comment="c-1"]');
  expanded.querySelector('.rv-followup-input').value = 'written while the runner was away';
  // The stub matcher takes single selectors only — pick the composer's send
  // button by its class + label (the opener says Reply too, but is not primary).
  expanded.querySelectorAll('button')
    .find((b) => b.className.includes('rv-btn-primary') && b.textContent === 'Reply')
    .fire('click');
  await app.settle();

  const held = JSON.parse(app.store.get('rv-buffer:/spec.html'));
  assert.equal(held.length, 1);
  assert.equal(held[0].kind, 'reply');
  assert.equal(held[0].replyTo, 'c-1');
  assert.equal(held[0].body, 'written while the runner was away');
  assert.equal(app.state.posted.length, 0, 'nothing reached the runner');
  // The same buffered-card treatment a buffered comment gets, chip included.
  const local = app.host.querySelectorAll('.rv-buffered')
    .find((n) => n.textContent.includes('written while the runner was away'));
  assert.ok(local, 'the buffered reply is on screen');
  assert.ok(local.querySelectorAll('.rv-mini').some((c) => c.textContent === 'reply'));
});

test('replay posts buffered comments first, then replies, in order', async () => {
  const app = boot({
    comments: [SERVER_COMMENT],
    buffer: [
      { localId: 'l-r1', kind: 'reply', replyTo: 'c-1', body: 'the held reply', anchor: null, createdAt: '2026-08-11T10:01:00.000Z', failed: null },
      { localId: 'l-c1', body: 'the held comment', anchor: { blockId: 'r-0001', quote: 'block r-0001' }, asNote: false, createdAt: '2026-08-11T10:02:00.000Z', failed: null },
    ],
  });
  await app.settle();

  const writes = app.state.posted.map((p) => p.url.replace(/^.*\/api/, '/api'));
  assert.deepEqual(writes, ['/api/comment', '/api/comment/c-1/reply'],
    'the comment replays before the reply, though it was buffered after');
  assert.equal(app.store.get('rv-buffer:/spec.html'), undefined, 'the buffer is evicted');
});

test('a reply whose parent is gone fails the replay — never a silent drop', async () => {
  const app = boot({
    comments: [SERVER_COMMENT],
    buffer: [{ localId: 'l-r2', kind: 'reply', replyTo: 'c-gone', body: 'orphan reply', anchor: null, createdAt: '2026-08-11T10:03:00.000Z', failed: null }],
  });
  app.state.route = async (u) => (u.includes('/comment/c-gone/reply')
    ? { ok: false, status: 404, json: async () => ({ error: 'unknown comment' }) }
    : null);
  await app.settle();

  const held = JSON.parse(app.store.get('rv-buffer:/spec.html'));
  assert.equal(held.length, 1, 'the reply is kept, not dropped');
  assert.match(held[0].failed, /no longer on the server/);
  const stuck = app.host.querySelectorAll('.rv-failed-replay');
  assert.equal(stuck.length, 1, 'and it is on screen as a failed card');
  assert.ok(!stuck[0].textContent.includes('Re-anchor'), 'with no Re-anchor — there is no anchor to fix');
});

// ---- #207: the offline banner names the reload trap -------------------------
//
// The runner going down leaves the served page open but unreloadable — it is
// also the web server, so a reload does not reconnect, it loses the page.
// The old copy (180 characters) buried that warning in the middle of a
// sentence and ran to five or six lines at the panel's real 312px content
// width, crowding the comment list. Blake compared five drafts side by side
// at that width (design/mock-chunk1-repairs.html) and chose version D on
// 2026-08-15: the irreversible action in a bold one-line headline, the
// reassurance demoted to a quieter line beneath it. This test renders the
// banner rather than grepping the source, so it catches a wording drift that
// still happens to contain the right substrings but lands in the wrong slot.

test('the down-state banner renders exactly Blake\'s two approved lines (#207)', async () => {
  const app = boot({ comments: [] });
  await app.settle();
  app.state.down = true;
  await app.tick();

  const banner = app.banner();
  assert.ok(banner.classList.contains('rv-abn-down'), 'red, the down state');
  const who = banner.querySelector('.rv-abn-who');
  const sub = banner.querySelector('.rv-abn-subtext');
  // Line 1 — bold (rv-abn-who is font-weight: 600 in the sheet), with the
  // status dot ahead of it in the same row. Em dash, not a hyphen.
  assert.equal(who.textContent, 'Runner offline — do not reload page.');
  assert.ok(who.textContent.includes('—'), 'an em dash, not a hyphen');
  // Line 2 — smaller and quieter (rv-abn-sub carries the smaller/softer
  // styling already). Nothing is buffered in this fixture, so it is the
  // unnumbered form: a count of zero would read as a failure report.
  assert.equal(sub.textContent, 'Comments are saved and will sync when the runner is back online.');

  // Blake, 2026-08-15, looking at it live: the retry counter belongs on the
  // SUB line, hard right — not on the headline row. At 312px the headline
  // fills its row, so a counter up there wrapped to a line of its own and put
  // a stripe of nothing between the two sentences that belong together.
  // (The DOM stub matches single selectors only, so the row it belongs to is
  // read off the parent rather than with a descendant selector.)
  const age = banner.querySelector('.rv-abn-age');
  assert.ok(age, 'the retry counter is still rendered');
  assert.match(age.textContent, /^retrying \d+s$/);
  assert.ok(age.parentElement.className.includes('rv-abn-sub'),
    'it rides on the sub line, not the headline row');
  assert.ok(!age.parentElement.className.includes('rv-abn-top'));
});

test('the down banner counts what it is promising to keep (#207 amended)', async () => {
  // Blake, 2026-08-15: "add back the # of comments". The value of the sub line
  // is that it is CHECKABLE — someone who wrote two comments during an outage
  // can confirm the banner knows about two of them.
  //
  // Written through the composer rather than by seeding the buffer, because a
  // seeded buffer REPLAYS the moment the harness settles with a healthy
  // runner, and then there is nothing left to count. Going down first and
  // typing is the only way to hold comments in the buffer, and it is also
  // what a person actually does.
  const app = boot({ comments: [SERVER_COMMENT] });
  await app.settle();
  app.state.down = true;
  await app.tick();

  const sub = () => app.banner().querySelector('.rv-abn-subtext').textContent;
  assert.equal(sub(), 'Comments are saved and will sync when the runner is back online.',
    'nothing buffered yet — a count of zero would read as a failure report');

  const reply = async (text) => {
    const card = app.host.querySelector('[data-rv-comment="c-1"]');
    if (!card.querySelector('.rv-followup-input')) { card.fire('click'); await app.settle(); }
    const open = app.host.querySelector('[data-rv-comment="c-1"]');
    open.querySelector('.rv-followup-input').value = text;
    open.querySelectorAll('button')
      .find((b) => b.className.includes('rv-btn-primary') && b.textContent === 'Reply')
      .fire('click');
    await app.settle();
    await app.tick();
  };

  await reply('the first thing I wrote while it was down');
  assert.equal(sub(), '1 comment is saved and will sync when the runner is back online.',
    'one takes the singular verb — "1 comments are saved" makes a reader doubt the sentence');

  await reply('the second thing');
  assert.equal(sub(), '2 comments are saved and will sync when the runner is back online.');
});

test('a buffered write that FAILED is never counted as saved (#207 amended)', () => {
  // The one lie this banner must not tell. A failed replay stays in the buffer
  // with a `failed` reason and shows as its own red card; counting it here
  // would tell someone their work is safe when it is not.
  const src = js();
  const line = src.match(/const waiting = bufferedComments\.filter\([^\n]+/)[0];
  assert.match(line, /!b\.failed/, 'the count excludes failed writes');
});
