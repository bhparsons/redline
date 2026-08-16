// test/runner/panel-search.test.mjs — the panel search axis (#268), and the
// handle bug that had to be fixed for it to be worth having (DECISION 8a).
//
// Two halves, and the split is deliberate. The first drives the model's pure
// functions the way filter-composition.test.mjs does — a rule node can RUN
// rather than read. The second boots the overlay and types in the real input,
// because the lesson _overlay-boot.mjs was extracted for is exactly this one:
// a tested mechanism with an untested trigger is an untested feature.
//
// One thing here IS source-pinned, honestly and on purpose: the three copies
// of REF_ALPHABET live in three languages' worth of files (a content script, a
// node example, a markdown contract), and the only way to prove they still
// agree is to read the two that are not executable from here. The overlay's
// copy is executed, not read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOverlay, EXT_DIR } from './_overlay-load.mjs';
import { boot } from './_overlay-boot.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const {
  shortRef, REF_ALPHABET, HANDLE_EXCLUDED, HANDLE_LEN,
  foldSearchText, handleShape, prepareSearch, searchableText,
  isHandleMatch, matchesSearchText, matchesSearch, searchReachedPast, searchHits,
  passesFilters, passesAxisFilters,
} = loadOverlay();

const ALL = { filter: 'all', audienceFilter: 'all', rowFilter: null };
const search = (q) => prepareSearch(q, shortRef);

// ---- DECISION 8a: the handle alphabet, pinned in all three copies ----------

test('the handle alphabet excludes exactly the characters that are ambiguous aloud', () => {
  assert.equal(REF_ALPHABET.length, 30);
  for (const bad of HANDLE_EXCLUDED) {
    assert.ok(!REF_ALPHABET.includes(bad), `${bad} is confusable and must not be in the alphabet`);
  }
  // The complement: every other lowercase alphanumeric IS emittable, so the
  // guard below refuses nothing a real handle could contain.
  for (const ch of '0123456789abcdefghijklmnopqrstuvwxyz') {
    assert.equal(REF_ALPHABET.includes(ch), !HANDLE_EXCLUDED.includes(ch), ch);
  }
});

test('all three copies of REF_ALPHABET agree — the overlay note included', () => {
  // The overlay's copy is the one that RUNS: derive it rather than read it.
  const emitted = new Set();
  for (let i = 0; i < 4000; i += 1) {
    for (const ch of shortRef(`c-${i.toString(16).padStart(12, '0')}`)) emitted.add(ch);
  }
  assert.equal([...emitted].sort().join(''), [...REF_ALPHABET].sort().join(''),
    'the overlay emits exactly the alphabet it declares');

  // The other two are not executable from here, so they are read.
  const example = readFileSync(path.join(ROOT, 'examples', 'watch-collaborate.mjs'), 'utf8');
  const contract = readFileSync(path.join(ROOT, 'docs', 'AGENT-CONTRACT.md'), 'utf8');
  for (const [name, src] of [['watch-collaborate.mjs', example], ['AGENT-CONTRACT.md', contract]]) {
    assert.ok(src.includes(`'${REF_ALPHABET}'`), `${name} carries the same alphabet`);
    assert.ok(/no 0\/1\/i\/l\/o\/u/.test(src), `${name} names the exclusions correctly`);
  }

  // And the overlay's own NOTE — the copy that was wrong until #268, and the
  // one an agent reimplementing the handle reads. It listed "no 0/O/1/l/i",
  // omitting o and u, which is how bwau and cubg got minted and cited.
  const overlay = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  assert.ok(/over an alphabet with no 0\/1\/i\/l\/o\/u/.test(overlay),
    'the overlay note names the exclusions correctly where it defines the handle');
  // The old wrong list survives ONLY inside the note's account of the bug —
  // never as the definition. Anything else means it was joined, not fixed.
  assert.equal((overlay.match(/no 0\/O\/1\/l\/i/g) || []).length, 1);
  assert.ok(/it said "no 0\/O\/1\/l\/i"/.test(overlay), 'and it is quoted as history, not asserted');
});

test('the handles agent sessions actually cited could never have been handles', () => {
  // The evidence behind DECISION 8a: two of the eight contain `u`.
  for (const cited of ['bwau', 'cubg']) {
    const shape = handleShape(cited);
    assert.equal(shape.handle, null, `${cited} is refused as a handle`);
    assert.equal(shape.invalid, true);
    assert.equal(shape.bad, 'u');
  }
});

test('a four-character query with a confusable character searches as text instead', () => {
  const s = search('l0ok');
  assert.equal(s.handle, null);
  assert.equal(s.invalidHandle, true);
  assert.equal(s.active, true, 'still an active TEXT search — it is not swallowed');
  assert.equal(s.badChars, 'l 0 o', 'named in the order they were typed');
});

test('only four characters from the alphabet are read as a handle', () => {
  assert.equal(handleShape('k7mq').handle, 'k7mq');
  assert.equal(handleShape('K7MQ').handle, 'k7mq', 'typed back in caps, same handle');
  assert.equal(handleShape('  k7mq ').handle, 'k7mq');
  assert.equal(handleShape('k7m').handle, null, 'three characters is a text search');
  assert.equal(handleShape('k7mqz').handle, null, 'five characters is a text search');
  assert.equal(handleShape('k7m-').handle, null);
  assert.equal(handleShape('k7m').invalid, false, 'not a handle is not the same as an invalid one');
  assert.equal(HANDLE_LEN, 4);
});

// ---- DECISION 11: normalisation ------------------------------------------

test('curly punctuation folds to what a keyboard produces', () => {
  assert.equal(foldSearchText('don’t').folded, "don't");
  assert.equal(foldSearchText('“quoted”').folded, '"quoted"');
  assert.equal(foldSearchText('a — b').folded, 'a - b');
  // Both sides fold, so a straight apostrophe finds a curly one.
  const c = { id: 'c-1', body: 'the runner’s job' };
  assert.equal(matchesSearchText(c, search("runner's job")), true);
});

test('accents fold, so cafe finds café', () => {
  assert.equal(foldSearchText('Café').folded, 'cafe');
  assert.equal(matchesSearchText({ id: 'c-1', body: 'a café in Zürich' }, search('cafe')), true);
  assert.equal(matchesSearchText({ id: 'c-1', body: 'a café in Zürich' }, search('zurich')), true);
});

test('whitespace collapses on both sides, so a wrapped phrase still matches', () => {
  assert.equal(foldSearchText('  a \n\t b  ').folded, 'a b');
  assert.equal(matchesSearchText({ id: 'c-1', body: 'the whole\ntrust argument' }, search('trust argument')), true);
});

test('matching is case-insensitive and substring, never fuzzy', () => {
  const c = { id: 'c-1', body: 'Say this earlier' };
  assert.equal(matchesSearchText(c, search('SAY THIS')), true);
  assert.equal(matchesSearchText(c, search('this earl')), true, 'a substring, not a word match');
  assert.equal(matchesSearchText(c, search('say earlier')), false, 'no fuzzy gap-jumping');
});

// ---- DECISION 13: markdown out before matching ----------------------------

test('a phrase spanning **bold** matches what the card displays', () => {
  const c = { id: 'c-1', body: 'the **trust** argument' };
  assert.equal(matchesSearchText(c, search('trust argument')), true);
  assert.equal(searchableText(c).includes('**'), false, 'syntax never reaches the haystack');
});

// ---- DECISION 10: what the search reads -----------------------------------

test('the search reads body, anchor quote, reply bodies, and the names on the card', () => {
  const c = {
    id: 'c-1',
    body: 'Say this earlier',
    creator: 'agent',
    agentName: 'claude-code',
    anchor: { quote: 'the runner is the only writer' },
    replies: [{ body: 'Pulled it up into the opening', creator: 'user' }],
  };
  for (const q of ['say this', 'only writer', 'into the opening', 'claude-code']) {
    assert.equal(matchesSearchText(c, search(q)), true, q);
  }
  assert.equal(matchesSearchText(c, search('frobnicate')), false);
});

test('a reply’s author name is searchable too — "everything the agent replied to"', () => {
  const c = {
    id: 'c-1', body: 'a note', creator: 'user',
    replies: [{ body: 'done', creator: 'agent', agentName: 'codex' }],
  };
  assert.equal(matchesSearchText(c, search('codex')), true);
  assert.equal(matchesSearchText(c, search('user')), true, 'a human author reads as "user"');
});

test('a comment missing every optional field never throws', () => {
  assert.equal(matchesSearchText({ id: 'c-1' }, search('anything')), false);
  assert.equal(searchableText(null), '');
  assert.equal(searchableText({ id: 'c-1', replies: 'not an array' }), 'user');
});

// ---- DECISION 8: a handle reaches past the lens ----------------------------

const RESOLVED_ID = 'c-resolved-0001';
const RESOLVED = { id: RESOLVED_ID, status: 'resolved', body: 'Does this cover the theme zone too?' };
const RESOLVED_HANDLE = shortRef(RESOLVED_ID);

test('a handle match is shown past a status filter that was hiding it', () => {
  const st = { ...ALL, filter: 'active', search: search(RESOLVED_HANDLE) };
  assert.equal(passesAxisFilters(RESOLVED, st), false, 'Active hides it on its own');
  assert.equal(passesFilters(RESOLVED, st), true, 'the handle reaches past');
  assert.equal(searchReachedPast(RESOLVED, st), 'Active', 'and the notice names the lens');
});

test('a handle match reaches past the audience and row axes too', () => {
  const note = { id: RESOLVED_ID, status: 'open', aiEdits: false, body: 'x' };
  const audSt = { ...ALL, audienceFilter: 'ai', search: search(RESOLVED_HANDLE) };
  assert.equal(passesFilters(note, audSt), true);
  assert.equal(searchReachedPast(note, audSt), 'For the AI');
  const rowSt = { ...ALL, rowFilter: { ids: ['c-other'] }, search: search(RESOLVED_HANDLE) };
  assert.equal(passesFilters(RESOLVED, rowSt), true);
  assert.equal(searchReachedPast(RESOLVED, rowSt), 'row');
});

test('nothing is announced when the handle match was visible anyway', () => {
  const st = { ...ALL, search: search(RESOLVED_HANDLE) };
  assert.equal(passesFilters(RESOLVED, st), true);
  assert.equal(searchReachedPast(RESOLVED, st), null, 'no notice for a lens that was not in the way');
});

test('a TEXT match does NOT reach past the lens — only a handle overrides', () => {
  const st = { ...ALL, filter: 'active', search: search('theme zone') };
  assert.equal(matchesSearchText(RESOLVED, st.search), true, 'the words are there');
  assert.equal(passesFilters(RESOLVED, st), false, 'and Active still hides it');
  assert.equal(searchReachedPast(RESOLVED, st), null);
});

test('a buffered comment has no id, so it can only ever match by text', () => {
  const local = { local: true, status: 'open', body: `about ${RESOLVED_HANDLE} really` };
  assert.equal(isHandleMatch(local, search(RESOLVED_HANDLE)), false);
  assert.equal(matchesSearch(local, search(RESOLVED_HANDLE)), true, 'by its words, though');
});

test('an empty query is not an axis at all', () => {
  for (const q of ['', '   ']) {
    const st = { ...ALL, filter: 'active', search: search(q) };
    assert.equal(st.search.active, false);
    assert.equal(passesFilters(RESOLVED, st), false, 'the status lens is untouched');
    assert.equal(passesFilters({ id: 'c-1', status: 'open' }, st), true);
  }
});

test('search never mutates the state it is handed', () => {
  const st = { ...ALL, filter: 'active', search: search(RESOLVED_HANDLE) };
  const before = JSON.stringify({ ...st, search: { ...st.search, ref: null } });
  passesFilters(RESOLVED, st);
  assert.equal(JSON.stringify({ ...st, search: { ...st.search, ref: null } }), before);
});

// ---- the hit offsets the highlighter paints with ---------------------------

test('hits come back as offsets into the ORIGINAL string, folding and all', () => {
  const text = 'a café and a café';
  const hits = searchHits(text, search('cafe'));
  assert.equal(hits.length, 2);
  assert.equal(text.slice(hits[0].start, hits[0].end), 'café');
  assert.equal(text.slice(hits[1].start, hits[1].end), 'café');
});

test('a hit spanning collapsed whitespace covers the whole run in the source', () => {
  const text = 'the whole\n  trust argument here';
  const [hit] = searchHits(text, search('trust argument'));
  assert.equal(text.slice(hit.start, hit.end), 'trust argument');
  const [wrapped] = searchHits(text, search('whole trust'));
  assert.equal(text.slice(wrapped.start, wrapped.end), 'whole\n  trust');
});

test('a hit at the very end of the string terminates on the sentinel', () => {
  const [hit] = searchHits('ends with trust', search('trust'));
  assert.equal(hit.end, 15);
  assert.equal(searchHits('nothing here', search('trust')).length, 0);
  assert.equal(searchHits('anything', search('')).length, 0, 'an empty query marks nothing');
});

// ---- the real input, driven ------------------------------------------------

const cmt = (id, over = {}) => ({
  id, status: 'open', body: 'body text', creator: 'user',
  anchor: { blockId: 'r-0001', quote: 'block r-0001' }, replies: [], ...over,
});

function panel(app) {
  const box = app.host.querySelector('.rv-search-input');
  assert.ok(box, 'the panel header carries a search input');
  return {
    box,
    async type(value) {
      box.value = value;
      box.fire('input');
      await app.settle();
    },
    title: () => app.host.querySelector('.rv-panel-title').textContent,
    note: () => {
      const n = app.host.querySelector('.rv-search-note');
      return n && !n.classList.contains('rv-hidden') ? n.textContent : '';
    },
    cardIds: () => app.host.querySelectorAll('.rv-card').map((c) => c.getAttribute('data-rv-comment')),
    sectionTitles: () => app.host.querySelectorAll('.rv-section-title').map((s) => s.textContent),
    hits: () => app.host.querySelectorAll('.rv-hit').map((m) => m.textContent),
  };
}

test('typing narrows the visible cards live, and the header counts the narrowing', async () => {
  const app = boot({
    comments: [
      cmt('c-a', { body: 'the whole **trust** argument' }),
      cmt('c-b', { body: 'something else entirely' }),
      cmt('c-c', { body: 'unrelated' }),
    ],
  });
  await app.settle();
  const p = panel(app);
  assert.equal(p.title(), '3 comments');

  await p.type('trust argument');
  assert.deepEqual(p.cardIds(), ['c-a'], 'only the match survives');
  assert.equal(p.title(), '1 of 3 comments');

  await p.type('');
  assert.equal(p.cardIds().length, 3);
  assert.equal(p.title(), '3 comments');
});

test('the matched text is marked inside the card (D13)', async () => {
  const app = boot({ comments: [cmt('c-a', { body: 'the whole **trust** argument here' })] });
  await app.settle();
  const p = panel(app);
  await p.type('argument');
  assert.ok(p.hits().includes('argument'), `expected a marked hit, got ${JSON.stringify(p.hits())}`);
  await p.type('');
  assert.equal(p.hits().length, 0, 'clearing the search unmarks everything');
});

test('a handle reaches past the Active filter, with the notice saying so (D8)', async () => {
  const hidden = cmt('c-hidden', { status: 'resolved', body: 'Does this cover the theme zone?' });
  const app = boot({ comments: [hidden, cmt('c-open')] });
  await app.settle();
  const p = panel(app);
  assert.equal(p.cardIds().includes('c-hidden'), false, 'Active hides it to start with');

  await p.type(shortRef('c-hidden'));
  assert.deepEqual(p.cardIds(), ['c-hidden'], 'the handle found it anyway');
  assert.equal(p.note(), `Handle ${shortRef('c-hidden')} — showing it past your Active filter.`);
  assert.equal(p.title(), '1 of 2 comments');
});

test('a handle match is pinned first and text matches follow — nothing suppressed (D9)', async () => {
  // The handle of c-target, typed as a query, ALSO appears in another
  // comment's body. Both show; the handle leads.
  const handle = shortRef('c-target');
  const app = boot({
    comments: [
      cmt('c-mentions', { status: 'addressed', body: `looked at ${handle} already` }),
      cmt('c-target', { status: 'resolved', body: 'the one you named' }),
    ],
    filter: 'all',
  });
  await app.settle();
  const p = panel(app);
  await p.type(handle);
  assert.deepEqual(p.cardIds(), ['c-target', 'c-mentions'], 'handle first, text match below');
  assert.equal(p.sectionTitles()[0], 'Resolved', 'its own lifecycle section is hoisted whole');
});

test('a four-character query the alphabet cannot emit says so and searches as text', async () => {
  const app = boot({ comments: [cmt('c-a', { body: 'the bwau reference an agent invented' })] });
  await app.settle();
  const p = panel(app);
  await p.type('bwau');
  assert.match(p.note(), /is not a valid handle — searching as text instead/);
  assert.match(p.note(), /Handles never contain 0 1 i l o u/);
  assert.deepEqual(p.cardIds(), ['c-a'], 'and the text search still ran');
});

test('no match is a dead end that carries its own way out', async () => {
  const app = boot({ comments: [cmt('c-a'), cmt('c-b')] });
  await app.settle();
  const p = panel(app);
  await p.type('frobnicate');
  const empty = app.host.querySelector('.rv-empty');
  assert.ok(empty.textContent.includes('No comments match “frobnicate”.'));
  const clear = app.host.querySelectorAll('button').find((b) => b.textContent === 'Clear search');
  assert.ok(clear, 'the empty state offers Clear search');
  clear.fire('click');
  await app.settle();
  assert.equal(p.cardIds().length, 2);
  assert.equal(p.box.value, '', 'and the input emptied with it');
});

test('Escape inside the box clears the search (D17)', async () => {
  const app = boot({ comments: [cmt('c-a'), cmt('c-b')] });
  await app.settle();
  const p = panel(app);
  await p.type('c-a-nothing');
  assert.equal(p.cardIds().length, 0);
  p.box.fire('keydown', { key: 'Escape' });
  await app.settle();
  assert.equal(p.box.value, '');
  assert.equal(p.cardIds().length, 2);
});

test('the search survives a poll re-render, input and all (#264 rule)', async () => {
  const app = boot({ comments: [cmt('c-a', { body: 'keep me' }), cmt('c-b', { body: 'drop me' })] });
  await app.settle();
  const p = panel(app);
  await p.type('keep me');
  assert.deepEqual(p.cardIds(), ['c-a']);
  const before = p.box;

  app.state.rev += 1; // the document changed under us; the panel re-renders
  await app.tick();
  assert.equal(app.host.querySelector('.rv-search-input'), before,
    'the header is never rebuilt, so the input is the SAME node — focus and caret intact');
  assert.equal(before.value, 'keep me');
  assert.deepEqual(p.cardIds(), ['c-a'], 'and it is still narrowing');
});

test('the search is review state: it rides both persistence slots', () => {
  // SOURCE-PINNED, and it is the one thing here that could not be driven:
  // _overlay-boot.mjs hands the overlay a read-only sessionStorage stub whose
  // getItem answers the same blob for every key, so neither the write nor the
  // restore can be observed from a booted panel. What CAN be proved is that
  // the query reaches both slots the sitting's rule names — the per-page
  // sessionStorage key the section folds use, and the reload blob
  // reloadPreserving writes before a run reload.
  const overlay = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  assert.match(overlay, /const SEARCH_KEY_PREFIX = 'rv-search:'/);
  assert.match(overlay, /sessionStorage\.setItem\(SEARCH_KEY_PREFIX \+ page, JSON\.stringify\(searchQuery\)\)/);
  assert.match(overlay, /sessionStorage\.getItem\(SEARCH_KEY_PREFIX \+ page\)/);
  // The reload blob: `search: searchQuery` inside reloadPreserving's payload.
  const blob = overlay.slice(overlay.indexOf('function reloadPreserving'));
  assert.match(blob.slice(0, 1400), /search: searchQuery,/);
  assert.match(overlay, /saved && typeof saved\.search === 'string'/);
});

test('a collapsed lifecycle section unfolds while a search is active (D13)', async () => {
  const app = boot({
    comments: [cmt('c-a', { body: 'in the open section' }), cmt('c-b', { status: 'addressed', body: 'in the open section too' })],
    filter: 'all',
  });
  await app.settle();
  const p = panel(app);
  // Fold "Addressed" by clicking its header, the way an author does.
  const head = app.host.querySelectorAll('.rv-section-head')
    .find((h) => h.textContent.startsWith('Addressed'));
  head.fire('click');
  assert.ok(head.parentElement.classList.contains('rv-collapsed'), 'it folded');

  await p.type('open section');
  const addressed = app.host.querySelectorAll('.rv-section')
    .find((s) => s.textContent.startsWith('Addressed'));
  assert.equal(addressed.classList.contains('rv-collapsed'), false,
    'a section holding a match unfolds itself');

  await p.type('');
  const again = app.host.querySelectorAll('.rv-section')
    .find((s) => s.textContent.startsWith('Addressed'));
  assert.ok(again.classList.contains('rv-collapsed'), 'and folds back when the search clears');
});

test('a folded thread entry holding a match starts open (D13)', async () => {
  // A long reply starts FOLDED (#247) unless it is the newest, so a hit inside
  // it would be invisible — the case the decision names.
  // Over four estimated lines (48 chars each, overlay-util.js) — the #247
  // threshold, or nothing here folds and the test proves nothing.
  const long = 'the trust argument runs through the whole document and needs to be said early, '
    + 'because everything after it depends on the reader having accepted it already, '
    + 'and the opening is the only place a reader is still deciding whether to believe you. '
    + 'That is the point of moving it up.';
  const app = boot({
    comments: [cmt('c-a', {
      body: 'have a look',
      replies: [
        { body: long, creator: 'agent', agentName: 'claude-code', createdAt: '2026-08-13T09:00:00Z' },
        { body: 'ok', creator: 'user', createdAt: '2026-08-13T10:00:00Z' },
      ],
    })],
  });
  await app.settle();
  const p = panel(app);
  const folded = () => app.host.querySelectorAll('.rv-entry-fold')
    .filter((e) => e.classList.contains('rv-folded')).length;
  assert.equal(folded(), 1, 'the long reply starts folded with no search running');

  await p.type('depends on the reader');
  assert.deepEqual(p.cardIds(), ['c-a'], 'the reply body is searchable');
  assert.equal(folded(), 0, 'and the entry holding the hit unfolded itself');
  assert.equal(app.host.querySelectorAll('.rv-entry-fold').length, 1,
    'the fold toggle is still there — it can be folded back by hand');

  await p.type('');
  assert.equal(folded(), 1, 'clearing the search restores the default fold');
});

test('D12: search is panel-only — the rule the gutter consumes ignores it', () => {
  // Asserted at the rule rather than at the dots: the gutter measures real
  // geometry and draws NOTHING under the DOM stub, so counting marks in a
  // booted panel would pass by counting zero either way. passesAxisFilters is
  // what overlay-gutter.js filters on, and it is the honest place to prove
  // that a search never erases the page's map.
  const open = { id: 'c-1', status: 'open', body: 'does not match' };
  const st = { ...ALL, search: search('frobnicate') };
  assert.equal(passesFilters(open, st), false, 'the panel hides it');
  assert.equal(passesAxisFilters(open, st), true, 'the gutter keeps its dot');
  // Same in the other direction: a handle override does not add a dot either.
  const handleSt = { ...ALL, filter: 'active', search: search(RESOLVED_HANDLE) };
  assert.equal(passesAxisFilters(RESOLVED, handleSt), false,
    'the gutter still applies Active, unaware a handle reached past it');
});

test('a booted panel narrowing by search draws no gutter change (the stub half)', async () => {
  const app = boot({ comments: [cmt('c-a', { body: 'matches' }), cmt('c-b', { body: 'does not' })] });
  await app.settle();
  const p = panel(app);
  await p.type('matches');
  assert.deepEqual(p.cardIds(), ['c-a'], 'the panel narrowed');
  // Not a gutter assertion — see the test above for that. This one only shows
  // the narrowing does not throw with the gutter wired up behind it.
  assert.equal(p.title(), '1 of 2 comments');
});
