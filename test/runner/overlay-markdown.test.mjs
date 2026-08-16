// test/runner/overlay-markdown.test.mjs — markdown in card prose (#246).
//
// Agent replies, decision summaries and comment bodies arrive as markdown and
// used to display as literal characters. renderMarkdown builds REAL NODES for
// a small subset — innerHTML is never assigned, so model output can never
// inject markup — and stripMarkdown flattens the same subset for collapsed
// one-line surfaces. Both are pure and exposed on window.__rvTest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadOverlay as loadOverlaySet, EXT_DIR } from './_overlay-load.mjs';

// A node stub rich enough to hold a rendered tree: elements keep tag/class/
// children, text lands as child text nodes or ownText (el()'s textContent
// assignment). No innerHTML property exists AT ALL — an innerHTML assignment
// anywhere in the renderer would land on a plain property and show up as a
// tree with no children, failing the structure assertions below.
function makeElement(tag) {
  return {
    tag: String(tag).toLowerCase(),
    className: '',
    ownText: '',
    children: [],
    attrs: {},
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    set textContent(v) { this.ownText = String(v); this.children = []; },
    get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); },
  };
}
const makeText = (data) => ({ tag: '#text', children: [], textContent: String(data) });
const makeFragment = () => ({ tag: '#fragment', children: [], appendChild(c) { this.children.push(c); return c; } });

function loadOverlay() {
  return loadOverlaySet({
    createElement: makeElement,
    globals: {
      document: {
        readyState: 'loading',
        addEventListener() {},
        body: {},
        createElement: makeElement,
        createTextNode: makeText,
        createDocumentFragment: makeFragment,
      },
    },
  });
}

const textOf = (node) => node.tag === '#text' || node.children.length === 0
  ? node.textContent
  : (node.ownText || '') + node.children.map(textOf).join('');

// Depth-first list of every element with a given tag.
function findAll(node, tag) {
  const out = [];
  const walk = (n) => {
    if (n.tag === tag) out.push(n);
    for (const c of n.children || []) walk(c);
  };
  walk(node);
  return out;
}

// ---- the subset, element by element -----------------------------------------

test('**bold**, *italic* and _italic_ become strong/em, text preserved', () => {
  const { renderMarkdown } = loadOverlay();
  const frag = renderMarkdown('a **bold** and *starred* and _scored_ word');
  assert.equal(textOf(frag), 'a bold and starred and scored word');
  const [b] = findAll(frag, 'strong');
  assert.equal(textOf(b), 'bold');
  assert.deepEqual(findAll(frag, 'em').map(textOf), ['starred', 'scored']);
});

test('`code` becomes a code element holding its literal content', () => {
  const { renderMarkdown } = loadOverlay();
  const frag = renderMarkdown('run `node test.mjs --fast` first');
  const [code] = findAll(frag, 'code');
  assert.equal(textOf(code), 'node test.mjs --fast');
  assert.equal(textOf(frag), 'run node test.mjs --fast first');
});

test('a fenced block becomes pre>code with the fence lines gone', () => {
  const { renderMarkdown } = loadOverlay();
  const frag = renderMarkdown('before\n```js\nconst a = 1;\nconst b = 2;\n```\nafter');
  const [pre] = findAll(frag, 'pre');
  assert.ok(pre, 'a pre element exists');
  assert.equal(textOf(pre), 'const a = 1;\nconst b = 2;');
  assert.ok(!textOf(frag).includes('```'), 'no fence characters survive');
});

test('- and * bullets become one ul; 1. lines become one ol', () => {
  const { renderMarkdown } = loadOverlay();
  const frag = renderMarkdown('- first\n* second\n\n1. one\n2. two');
  const [ul] = findAll(frag, 'ul');
  assert.deepEqual(findAll(ul, 'li').map(textOf), ['first', 'second']);
  const [ol] = findAll(frag, 'ol');
  assert.deepEqual(findAll(ol, 'li').map(textOf), ['one', 'two']);
});

test('#–### headings render as styled heading divs; #### stays literal', () => {
  const { renderMarkdown } = loadOverlay();
  const frag = renderMarkdown('# One\n## Two\n### Three\n#### Four');
  const heads = frag.children.filter((c) => /rv-md-h\d/.test(c.className || ''));
  assert.deepEqual(heads.map(textOf), ['One', 'Two', 'Three']);
  assert.deepEqual(heads.map((h) => h.className), ['rv-md-h rv-md-h1', 'rv-md-h rv-md-h2', 'rv-md-h rv-md-h3']);
  assert.ok(textOf(frag).includes('#### Four'), 'four hashes are outside the subset');
});

test('> lines group into one blockquote', () => {
  const { renderMarkdown } = loadOverlay();
  const frag = renderMarkdown('> quoted line one\n> quoted line two');
  const [bq] = findAll(frag, 'blockquote');
  assert.ok(bq, 'a blockquote exists');
  assert.match(textOf(bq), /quoted line one/);
  assert.match(textOf(bq), /quoted line two/);
  assert.ok(!textOf(frag).includes('>'), 'the markers are consumed');
});

test('blank lines split paragraphs; a single newline is a hard break', () => {
  const { renderMarkdown } = loadOverlay();
  const frag = renderMarkdown('para one line one\npara one line two\n\npara two');
  const paras = findAll(frag, 'p');
  assert.equal(paras.length, 2);
  assert.equal(findAll(paras[0], 'br').length, 1, 'the in-paragraph newline is a <br>, not a space');
  assert.equal(textOf(paras[1]), 'para two');
});

// ---- pipe tables: monospace wall, never a <table> (AC 2b) -------------------

test('consecutive |-lines become one monospace pre, and no table is built', () => {
  const { renderMarkdown } = loadOverlay();
  const frag = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(findAll(frag, 'table').length, 0);
  const [pre] = findAll(frag, 'pre');
  assert.ok(pre, 'the wall is preformatted');
  assert.match(pre.className, /rv-md-pipes/);
  assert.equal(textOf(pre), '| a | b |\n|---|---|\n| 1 | 2 |', 'columns keep their own lines');
});

// ---- links: http(s) only, everything else literal (AC 3) --------------------

test('[text](https://…) and bare URLs become safe anchors', () => {
  const { renderMarkdown } = loadOverlay();
  const frag = renderMarkdown('see [the doc](https://example.com/a) or http://example.org/b');
  const anchors = findAll(frag, 'a');
  assert.equal(anchors.length, 2);
  assert.equal(textOf(anchors[0]), 'the doc');
  assert.equal(anchors[0].href, 'https://example.com/a');
  assert.equal(anchors[1].href, 'http://example.org/b');
  for (const a of anchors) {
    assert.equal(a.target, '_blank');
    assert.equal(a.rel, 'noopener noreferrer');
  }
});

test('javascript: and data: URLs never become anchors — literal text only', () => {
  const { renderMarkdown } = loadOverlay();
  for (const evil of ['[click](javascript:alert(1))', '[x](data:text/html,hi)', '[y](vbscript:no)']) {
    const frag = renderMarkdown(evil);
    assert.equal(findAll(frag, 'a').length, 0, `${evil} must not build an anchor`);
    assert.equal(textOf(frag), evil, 'the characters render as written');
  }
});

// ---- outside the subset: literal passthrough --------------------------------

test('text outside the subset renders as its literal characters', () => {
  const { renderMarkdown } = loadOverlay();
  for (const s of [
    'a * b and 2 ** 8 stay math',
    'snake_case_name survives',
    '~~strike~~ is not in the subset',
    'an <img src=x onerror=alert(1)> stays text',
  ]) {
    assert.equal(textOf(renderMarkdown(s)), s);
  }
});

test('markup in the input becomes text nodes, never elements', () => {
  const { renderMarkdown } = loadOverlay();
  const frag = renderMarkdown('**bold** <script>alert(1)</script>');
  assert.equal(findAll(frag, 'script').length, 0);
  assert.match(textOf(frag), /<script>alert\(1\)<\/script>/);
});

// ---- collapsed surfaces flatten (AC 5) --------------------------------------

test('stripMarkdown flattens the whole subset to one plain line', () => {
  const { stripMarkdown } = loadOverlay();
  const md = '# Head\n\n- **bold** item\n1. `coded` item\n\n> quoted\n[a link](https://x.dev)\nline two';
  const flat = stripMarkdown(md);
  assert.equal(flat, 'Head bold item coded item quoted a link line two');
  assert.ok(!/[*#>`]|\]\(/.test(flat), 'no markdown characters survive');
  assert.ok(!flat.includes('\n'), 'one line, so the ellipsis clamp still works');
});

test('stripMarkdown keeps fence content but drops the fence lines', () => {
  const { stripMarkdown } = loadOverlay();
  assert.equal(stripMarkdown('before\n```\ncode here\n```\nafter'), 'before code here after');
});

test('stripMarkdown leaves plain text alone', () => {
  const { stripMarkdown } = loadOverlay();
  assert.equal(stripMarkdown('just a sentence.'), 'just a sentence.');
  assert.equal(stripMarkdown(''), '');
  assert.equal(stripMarkdown(undefined), '');
});

// ---- wiring: the surfaces route through the renderer ------------------------

test('expanded prose renders markdown; collapsed surfaces strip it', () => {
  const js = readFileSync(path.join(EXT_DIR, 'overlay.js'), 'utf8');
  // Zone 2 builds BOTH faces since #265 (CSS picks by rv-expanded/rv-collapsed,
  // so the in-place toggle needs no rebuild): markdown for the open face,
  // stripped prose for the one-line collapsed clamp.
  assert.match(js, /mdBlock\('rv-card-body rv-body-full', comment\.body\)/);
  // #268 wrapped the collapsed face in hitText — the same one-line stripped
  // prose, built as text nodes plus <mark> so a search hit can be highlighted
  // in it. Still stripMarkdown, still one line; only the builder changed.
  assert.match(js, /hitText\('rv-card-body rv-body-line', stripMarkdown\(comment\.body\)\)/);
  // Replies and decision summaries render through the one history builder;
  // the collapsed last-said line strips.
  assert.match(js, /const text = isDecision \? entry\.summary : entry\.body;/);
  assert.match(js, /mdBlock\('rv-text', text\)/);
  assert.match(js, /stripMarkdown\(last\.text\)/);
  // The run-strip summary renders too.
  assert.match(js, /mdBlock\(undefined, o\.summary\)/);
  // And nothing anywhere in the overlay set ASSIGNS innerHTML (comparing it,
  // ===, is a read — the injection guard does that and is allowed).
  for (const f of ['overlay.js', 'overlay-util.js']) {
    assert.ok(!/\binnerHTML\s*=(?!=)/.test(readFileSync(path.join(EXT_DIR, f), 'utf8')), `${f} never assigns innerHTML`);
  }
});

test('the card sheet styles the markdown elements within card width', () => {
  const sheet = readFileSync(path.join(EXT_DIR, 'overlay.css'), 'utf8');
  assert.match(sheet, /#rv-root \.rv-md-pre \{[^}]*overflow-x: auto/, 'pre scrolls sideways');
  assert.match(sheet, /#rv-root \.rv-md-list \{[^}]*padding-left/, 'lists indent inside the padding');
});
