// test/runner/_overlay-boot.mjs — BOOT the overlay, do not read it.
//
// Extracted from overlay-liveness.test.mjs (#196) so the co-editing tests
// (#189, #191) can use the same harness instead of growing a second one. The
// lesson that produced it is worth repeating where it can be seen: three times
// in one week overlay.js shipped a bug where the MECHANISM was tested and the
// TRIGGER was not — 29 tests proved a banner rendered three states and none
// proved a dead runner ever reached the setter.
//
// So nothing here reads overlay.js as text. init() runs against a DOM stub and
// a fetch stub, tests drive real triggers, and the assertions are about what
// the panel actually did.

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXT_DIR, overlayFiles } from './_overlay-load.mjs';

// ---- a DOM stub big enough to run init() ------------------------------------
//
// Deliberately small and dumb: enough element, document and window surface for
// the overlay to build its panel, render cards and read the things it reads.
// Anything the overlay only writes to (style, geometry) is a sink.

export function makeNode(tag, doc) {
  const node = {
    tag: String(tag).toUpperCase(),
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    attrs: new Map(),
    handlers: new Map(),
    style: {},
    value: '',
    disabled: false,
    selectionStart: 0,
    selectionEnd: 0,
    _text: '',
    _class: '',
    get className() { return this._class; },
    set className(v) { this._class = String(v); },
    get classList() {
      const owner = this;
      const list = () => owner._class.split(/\s+/).filter(Boolean);
      return {
        add(...names) { owner._class = [...new Set([...list(), ...names])].join(' '); },
        remove(...names) { owner._class = list().filter((c) => !names.includes(c)).join(' '); },
        contains(name) { return list().includes(name); },
        toggle(name, force) {
          const on = force === undefined ? !list().includes(name) : Boolean(force);
          if (on) this.add(name); else this.remove(name);
          return on;
        },
      };
    },
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('');
    },
    // The in-place editor (#112) reads innerHTML and clones childNodes to be
    // able to revert. Both are READS — the overlay never assigns markup.
    get childNodes() { return this.children; },
    get innerHTML() { return this.textContent; },
    set textContent(v) { this._text = String(v); this.children = []; },
    appendChild(child) {
      if (child.parentElement) child.parentElement.removeChild(child);
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    append(...kids) { for (const k of kids) this.appendChild(k); },
    insertBefore(child, ref) {
      const at = this.children.indexOf(ref);
      if (child.parentElement) child.parentElement.removeChild(child);
      child.parentElement = this;
      if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
      return child;
    },
    replaceChildren(...kids) {
      for (const c of this.children) c.parentElement = null;
      this.children = [];
      for (const k of kids) this.appendChild(k);
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      child.parentElement = null;
      return child;
    },
    remove() { if (this.parentElement) this.parentElement.removeChild(this); },
    setAttribute(name, v) {
      this.attrs.set(name, String(v));
      if (name === 'id') this.id = String(v);
    },
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; },
    removeAttribute(name) { this.attrs.delete(name); },
    hasAttribute(name) { return this.attrs.has(name); },
    addEventListener(type, fn) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const set = this.handlers.get(type) || [];
      this.handlers.set(type, set.filter((f) => f !== fn));
    },
    // rv:reveal (#60/#237) is dispatched at the document block so a host page
    // can un-hide it; the stub has no host page, so it goes nowhere.
    dispatchEvent() { return true; },
    // Test-side: fire a handler the overlay attached.
    fire(type, event = {}) {
      for (const fn of [...(this.handlers.get(type) || [])]) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
    },
    focus() { doc.activeElement = this; },
    blur() { if (doc.activeElement === this) doc.activeElement = null; },
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 10, height: 10, bottom: 10, right: 10 }; },
    get offsetParent() { return this.parentElement; },
    contains(other) {
      for (let n = other; n; n = n.parentElement) if (n === this) return true;
      return false;
    },
    closest(sel) {
      for (let n = this; n; n = n.parentElement) if (matches(n, sel)) return n;
      return null;
    },
    querySelector(sel) { return descendants(this).find((n) => matches(n, sel)) || null; },
    querySelectorAll(sel) { return descendants(this).filter((n) => matches(n, sel)); },
    cloneNode() { return makeNode(tag, doc); },
  };
  return node;
}

export function descendants(node) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } };
  walk(node);
  return out;
}

// A one-selector matcher: `.cls`, `#id`, `tag`, `[attr]`, `[attr="v"]`, and
// comma lists of those. Enough for every selector the overlay uses.
export function matches(node, selector) {
  return String(selector).split(',').some((raw) => {
    const sel = raw.trim();
    if (!sel) return false;
    if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return node.id === sel.slice(1);
    if (sel.startsWith('[')) {
      const m = sel.match(/^\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]$/);
      if (!m) return false;
      if (!node.attrs.has(m[1])) return false;
      return m[2] === undefined || node.attrs.get(m[1]) === m[2];
    }
    return node.tagName === sel.toUpperCase();
  });
}

// The harness. `comments`/`status` are what the fake runner serves; `down`
// flips whether fetch rejects. Timers are collected rather than run, so a test
// drives the watch tick itself instead of waiting four real seconds.
export function boot({ comments = [], runs = [], status = {}, buffer = null, down = false, filter = null } = {}) {
  const timers = [];
  const store = new Map();
  const eventSourceUrls = [];
  if (buffer) store.set('rv-buffer:/spec.html', JSON.stringify(buffer));

  const doc = { activeElement: null, handlers: new Map() };
  const winHandlers = new Map();
  const make = (tag) => makeNode(tag, doc);
  const state = {
    down,
    calls: [],
    posted: [],
    requests: [],
    rev: typeof status.rev === 'number' ? status.rev : 7,
  };

  const fetchStub = async (url, init) => {
    state.calls.push(String(url));
    if (state.down) throw new TypeError('Failed to fetch');
    if (state.fetchOverride) return state.fetchOverride(String(url), init);
    const u = String(url);
    state.requests.push({
      method: (init && init.method) || 'GET',
      url: u,
      body: init && init.body ? JSON.parse(init.body) : null,
    });
    if (init && init.body) state.posted.push({ url: u, body: JSON.parse(init.body) });
    // A per-URL route, consulted before the defaults: how a test makes ONE
    // endpoint answer 409 or 404 without restating the whole fake runner.
    if (state.route) {
      const routed = await state.route(u, init);
      if (routed) return routed;
    }
    let body = {};
    if (u.includes('/api/comments')) body = { comments: state.comments, runs: state.runs };
    else if (u.includes('/api/status')) body = { rev: state.rev, running: false, ...state.status };
    else if (u.includes('/api/source')) body = { source: '' };
    return { ok: true, status: 200, json: async () => body };
  };
  state.comments = comments;
  state.runs = runs;
  // Live status, so a test can make a session appear, let its claim lapse, or
  // hand a block to the agent BETWEEN ticks — which is the trigger half that
  // the file this harness came from exists to insist on.
  state.status = { ...status };

  const win = {
    __REVIEW__: {},
    location: { pathname: '/spec.html', reload() {} },
    scrollX: 0, scrollY: 0, innerHeight: 800,
    scrollTo() {},
    addEventListener(type, fn) {
      if (!winHandlers.has(type)) winHandlers.set(type, []);
      winHandlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      winHandlers.set(type, (winHandlers.get(type) || []).filter((f) => f !== fn));
    },
    getSelection: () => state.selection,
    localStorage: null, // filled in below (the same object the context has)
  };

  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  win.localStorage = storage;

  const documentEl = make('html');
  const body = make('body');
  documentEl.appendChild(body);
  // Two instrumented blocks, so locateAnchor can actually resolve an anchor
  // and a card is not orphaned by the harness rather than by the test.
  for (const id of ['r-0001', 'r-0002']) {
    const block = make('p');
    block.setAttribute('data-rev', id);
    block.textContent = `block ${id} body text`;
    body.appendChild(block);
  }

  const document = {
    readyState: 'complete',
    documentElement: documentEl,
    body,
    get activeElement() { return doc.activeElement; },
    createElement: make,
    createElementNS: (_ns, tag) => make(tag),
    createTextNode: (t) => {
      const n = make('#text');
      n.nodeType = 3;
      n._text = String(t);
      n.nodeValue = String(t);
      return n;
    },
    // renderMarkdown (#246) builds into a fragment; appending a stub fragment
    // appends the fragment node itself, which is fine for these tests — they
    // assert on text content, not on fragment-flattening semantics.
    createDocumentFragment: () => make('#fragment'),
    createRange: () => ({
      setStart() {}, setEnd() {}, selectNodeContents() {}, collapse() {}, toString: () => '',
      getClientRects: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    }),
    createTreeWalker: () => ({ nextNode: () => null }),
    getElementById: (id) => descendants(documentEl).find((n) => n.id === id) || null,
    querySelector: (sel) => descendants(documentEl).find((n) => matches(n, sel)) || null,
    querySelectorAll: (sel) => descendants(documentEl).filter((n) => matches(n, sel)),
    addEventListener(type, fn) {
      if (!doc.handlers.has(type)) doc.handlers.set(type, []);
      doc.handlers.get(type).push(fn);
    },
    removeEventListener() {},
    dispatchEvent() {},
    importNode: (n) => n,
  };

  const ctx = vm.createContext({
    window: win,
    document,
    navigator: { platform: 'MacIntel', clipboard: { writeText: async () => {} } },
    localStorage: storage,
    // The panel restores its status filter from here on load; 'all' is how a
    // test gets a resolved card on screen without clicking the dropdown.
    sessionStorage: {
      getItem: () => (filter ? JSON.stringify({ filter }) : null),
      setItem() {}, removeItem() {},
    },
    fetch: fetchStub,
    // Records the URL it was handed. The old stub swallowed it, which is how
    // `runner + path` — an OBJECT plus a string — survived from bc66281 to
    // 2026-08-02 while every test passed: the stub accepted
    // "[object Object]/api/events?…" as happily as a real URL, and a browser
    // 404'd it. A stub that cannot fail is not a test.
    EventSource: function EventSourceStub(url) {
      eventSourceUrls.push(String(url));
      return { addEventListener() {}, close() {}, onerror: null };
    },
    CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
    DOMParser: function DOMParserStub() {
      return { parseFromString: () => ({ querySelectorAll: () => [] }) };
    },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    Element: function ElementStub() {},
    CustomEvent: function CustomEventStub() {},
    getComputedStyle: () => ({ position: 'static' }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: (fn, ms = 0) => { timers.push({ fn, ms, kind: 'timeout' }); return timers.length; },
    clearTimeout() {},
    setInterval: (fn, ms) => { timers.push({ fn, ms, kind: 'interval' }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    console,
  });
  // `instanceof Element` guards in the overlay must not throw on our stubs.
  vm.runInContext('Object.defineProperty(Element, Symbol.hasInstance, { value: (o) => Boolean(o && o.nodeType === 1) });', ctx);

  for (const file of overlayFiles()) {
    vm.runInContext(readFileSync(path.join(EXT_DIR, file), 'utf8'), ctx, { filename: file });
  }
  win.__redline.init({ origin: 'http://127.0.0.1:5175', servedByRunner: true });

  const host = document.getElementById('rv-root');
  const settle = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
  return {
    state, host, store, timers, settle, document, eventSourceUrls,
    // The panel's one liveness slot.
    banner: () => host.querySelector('.rv-abn'),
    bannerText: () => {
      const b = host.querySelector('.rv-abn');
      return b && !b.classList.contains('rv-hidden') ? b.textContent : '';
    },
    cardsEl: () => host.querySelector('.rv-cards'),
    // Run the idle watch tick once, the way four seconds of wall clock would.
    async tick() {
      const t = timers.filter((x) => x.kind === 'timeout' && x.ms === 4000 && !x.done).pop();
      assert.ok(t, 'the 4 s watch tick must be scheduled');
      t.done = true;
      await t.fn();
      await settle();
    },
    // Write a comment the way an author does: select text in the document,
    // take Comment off the selection pill, type, and press the button. Going
    // through the real path matters here — the buffer is only ever filled by
    // this flow, and a test that pre-loads localStorage instead proves nothing
    // about the flow that fills it.
    async writeComment(blockId, text) {
      const popover = this.openComposer(blockId);
      popover.querySelector('TEXTAREA').value = text;
      popover.querySelectorAll('button').find((b) => b.textContent === 'Comment').fire('click');
      await settle();
    },
    // Select text in a document block and let the selection pill rise, the way
    // an author dragging over a paragraph does. Returns the pill element — the
    // surface #215 refuses on, so a test can enumerate its controls too.
    raiseSelPill(blockId, { endBlockId = blockId, text = 'block r-0001' } = {}) {
      const block = document.querySelector(`[data-rev="${blockId}"]`);
      // #226: a selection may END in a different stamped block; the common
      // ancestor is then the shared parent, exactly as a real Range reports.
      const endBlock = document.querySelector(`[data-rev="${endBlockId}"]`);
      const range = {
        startContainer: block, endContainer: endBlock,
        commonAncestorContainer: endBlock === block ? block : block.parentElement,
        startOffset: 0, endOffset: 1,
        toString: () => text,
        getClientRects: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 10, right: 10, width: 40, height: 12 }),
      };
      state.selection = {
        isCollapsed: false, rangeCount: 1, getRangeAt: () => range,
        toString: () => text,
        removeAllRanges() {}, addRange() {},
      };
      for (const fn of doc.handlers.get('mouseup') || []) {
        fn({ target: block, preventDefault() {}, stopPropagation() {} });
      }
      // The handler defers to a 0 ms timeout so the browser can settle the
      // selection first.
      for (const t of timers.filter((x) => x.kind === 'timeout' && x.ms === 0 && !x.done)) {
        t.done = true;
        t.fn();
      }
      const pill = host.querySelector('.rv-selpill');
      assert.ok(pill, 'the selection raised the pill');
      return pill;
    },
    // Everything up to the composer being on screen, unsubmitted.
    openComposer(blockId) {
      const pill = this.raiseSelPill(blockId);
      const commentBtn = pill.querySelectorAll('button')
        .find((b) => (b.getAttribute('aria-label') || '').startsWith('Comment'));
      commentBtn.fire('click');
      const popover = host.querySelector('.rv-popover');
      assert.ok(popover, 'Comment opened the composer');
      return popover;
    },
    popover: () => host.querySelector('.rv-popover'),

    // ---- co-editing surfaces (#189 · #191) --------------------------------
    // Read what the page ACTUALLY draws, never what the source says it would.

    /** Every held-block rail on screen, as {blockId, kind}. */
    rails: () => host.querySelectorAll('.rv-lease-rail').map((r) => ({
      blockId: r.getAttribute('data-rv-lease'),
      kind: r.getAttribute('data-rv-lease-kind'),
    })),
    /** The on-approach tag over a held block, or ''. */
    leaseTagText: () => {
      const tag = host.querySelector('.rv-lease-tag');
      return tag ? tag.textContent : '';
    },
    leaseTagClass: () => {
      const tag = host.querySelector('.rv-lease-tag');
      return tag ? tag.className : '';
    },
    /** Move the pointer onto a document block, the way an author approaching it does. */
    hover(blockId) {
      const block = blockId === null
        ? document.body
        : document.querySelector(`[data-rev="${blockId}"]`);
      for (const fn of doc.handlers.get('mouseover') || []) {
        fn({ target: block, preventDefault() {}, stopPropagation() {} });
      }
    },
    pencil: () => host.querySelector('.rv-edit-pencil'),
    /** Take Edit text off the selection pill — the direct-edit trigger. */
    async startEdit(blockId) {
      const popover = this.openComposer(blockId);
      // openComposer went through the pill; close the composer it opened and
      // reach for the pencil path instead.
      popover.querySelectorAll('button').find((b) => b.textContent === 'Cancel').fire('click');
      await settle();
      this.hover(blockId);
      const p = host.querySelector('.rv-edit-pencil');
      assert.ok(p, 'the pencil appeared over the block');
      p.fire('click');
      await settle();
      return p;
    },
    /** Fire every pending interval of `ms` once — the lease renewal ticker. */
    async fireInterval(ms) {
      const found = timers.filter((x) => x.kind === 'interval' && x.ms === ms && !x.cleared);
      assert.ok(found.length > 0, `an interval of ${ms} ms must be scheduled`);
      for (const t of found) await t.fn();
      await settle();
    },
    /** Fire every pending timeout matching `pred` once. */
    async fireTimeouts(pred) {
      const found = timers.filter((x) => x.kind === 'timeout' && !x.done && pred(x));
      for (const t of found) { t.done = true; await t.fn(); }
      await settle();
      return found.length;
    },
    /** Fire a window-level listener the overlay attached (pagehide, …). */
    async fireWindow(type, event = {}) {
      for (const fn of [...(winHandlers.get(type) || [])]) await fn({ ...event });
      await settle();
    },
    /** Fire a document-level listener (visibilitychange, …). */
    async fireDocument(type, event = {}) {
      for (const fn of [...(doc.handlers.get(type) || [])]) await fn({ ...event });
      await settle();
    },
    /** Every request this tab made, as {method, url, body}. */
    requests: () => state.requests,
  };
}

