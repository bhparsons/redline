// overlay-gutter.js — the comment gutter (#161). A narrow column beside the
// document carrying a dot per comment, level with its anchor and scrolling
// with the page. The document text stays unmarked at rest.
//
// Design: design/comment-gutter.md. Prototype: design/mock-comment-gutter.html.
//
// Factory pattern matching overlay-runlog.js: takes the host element and
// callbacks from overlay.js so it has no network code of its own.
//
// Loads after overlay-anchor.js, overlay-util.js and overlay-model.js —
// the tier mapping, cluster pass, and dot geometry are pure and live in
// overlay-model.js (#219), where node tests them directly. This file is the
// DOM half: measure anchors, render what the model decides.

(() => {
  'use strict';

  const { el } = window.__rv.util;
  const { locateAnchor } = window.__rv.anchor;
  const { anchorMarkY } = window.__rv.model;

  // The FIRST LINE BOX of the anchored block. Blake, 2026-08-15: "for a
  // multi-line block, I want it centered on the first line of the block, not
  // centered on the overall block's height."
  //
  // A range over the element's contents reports one client rect per line, so
  // rect[0] IS the first line — no font metrics, no guessing, correct at any
  // size. Note this deliberately follows the BLOCK's first line rather than
  // the quote's: a comment anchored to a sentence halfway down a paragraph
  // still marks the top of that paragraph, because the mark answers "which
  // block is this about", and clicking it flashes the exact quote anyway.
  function firstLineRectOf(loc) {
    try {
      const node = typeof loc.element === 'function' ? loc.element() : null;
      if (!node || !node.ownerDocument) return null;
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects());
      range.detach && range.detach();
      for (const r of rects) if (r && r.height > 0) return r;
      return null;
    } catch { return null; }
  }

  // The anchored element's rendered line-height, for the fallback in
  // anchorMarkY. `normal` and any non-numeric value read as 0, which the
  // fallback treats as "no better idea than the top edge".
  function lineHeightOf(loc) {
    try {
      const node = typeof loc.element === 'function' ? loc.element() : null;
      if (!node || !node.ownerDocument || !node.ownerDocument.defaultView) return 0;
      const lh = node.ownerDocument.defaultView.getComputedStyle(node).lineHeight;
      const n = parseFloat(lh);
      return Number.isFinite(n) ? n : 0;
    } catch { return 0; }
  }
  const {
    gutterTier, dominantTier, clusterGutterRows, gutterDotTop, gutterClusterBox,
    gutterEdgeCounts, GUTTER_DOT_SIZE,
    FOLD_MARK_SIZE, groupFoldRows, foldMarkTop,
  } = window.__rv.model;

  // #239 follow-up (Blake, acceptance 2026-08-12): the column hugs the TEXT,
  // not the viewport. The CSS offsets (0, or 336 under the open panel) are the
  // floor — the column never sits closer to the viewport edge than them — but
  // when the text stops short of the panel, the column slides left to sit
  // TEXT_GAP px off the widest stamped block. Pure, so the arithmetic is
  // pinned by a test: right-offset = max(floor, viewport - textRight - gap - column).
  const COLUMN_W = 46;
  const TEXT_GAP = 10;
  const PANEL_W = 336;
  function gutterRightOffset(viewportW, textRight, panelOpen) {
    const floor = panelOpen ? PANEL_W : 0;
    if (!Number.isFinite(textRight) || textRight <= 0) return floor;
    return Math.max(floor, viewportW - textRight - TEXT_GAP - COLUMN_W);
  }

  // The widest right edge among the document's stamped blocks, in viewport
  // coordinates — the text edge the column hugs.
  function contentRightEdge() {
    let max = 0;
    for (const b of document.querySelectorAll('[data-rev]')) {
      if (b.closest('#rv-root')) continue;
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.right > max) max = r.right;
    }
    return max;
  }

  function createGutter({ host, getComments, onDotClick, onDotHover, panelOpen }) {
    let gutterEl = null;
    let dotsContainer = null;
    let rafId = 0;
    let listening = false;
    // Cached dot entries: { comment, blockId, y, tier, dotEl }
    let entries = [];
    // #220: the hovered mark — its member comments, its document-coordinate
    // top (where the label sits), and a key matching the mark element's
    // data-rv-gt-key so a rebuilt mark can be recognized as "still under the
    // pointer". The tint boxes and label are the drawn state.
    let hover = null; // { key, members, top }
    let hoverBoxes = [];
    let hoverLabel = null;
    const pointer = { x: -1, y: -1 };
    // #224: off-screen counters (viewport-pinned) and the placed rows they
    // count over; the orphan flag is rendered per pass like the dots.
    let edgeTop = null;
    let edgeBot = null;
    let placedRows = [];

    // The rects a member's tint covers: the exact quoted text's line boxes
    // when the quote is still findable (#257's quoteRects), the whole
    // anchor's rects otherwise — so a wrapped quote tints every line, and a
    // block-anchored comment tints the block.
    function tintRectsFor(comment) {
      const loc = locateAnchor(comment.anchor);
      if (!loc) return [];
      // #267 (Blake, live pass 2026-08-13): NEVER tint a concealed anchor.
      // Chrome keeps real geometry on a closed <details>'s children via
      // content-visibility, so the rect filter below waves them through and
      // the tint lands where the text WOULD be if it were open — boxes over
      // blank page. Same trap #237 fixed for the persistent highlight; the
      // fold mark's hover is just the first thing to hover a hidden anchor.
      if (typeof loc.hidden === 'function' && loc.hidden()) return [];
      const exact = typeof loc.quoteRects === 'function' ? loc.quoteRects() : [];
      const rects = exact.length > 0 ? exact : loc.rects();
      return rects.filter((r) => r.width > 0 && r.height > 0);
    }

    // Draw (or clear, when hover is null) the tint: one translucent box-SET
    // per member, never merged — where two members cover the same words the
    // tints stack and read visibly darker, which is the whole answer to
    // "what is actually stacked here". Boxes live in #rv-root over the
    // document, pointer-events: none; the document DOM is never touched.
    function drawHover() {
      for (const b of hoverBoxes) b.remove();
      hoverBoxes = [];
      if (hoverLabel) { hoverLabel.remove(); hoverLabel = null; }
      if (!hover) return;
      const scroll = { x: window.scrollX, y: window.scrollY };
      for (const comment of hover.members) {
        for (const r of tintRectsFor(comment)) {
          const box = el('div', 'rv-gt-tint');
          box.style.top = `${r.top + scroll.y}px`;
          box.style.left = `${r.left + scroll.x}px`;
          box.style.width = `${r.width}px`;
          box.style.height = `${r.height}px`;
          host.appendChild(box);
          hoverBoxes.push(box);
        }
      }
      // Panel closed there are no cards to light — a one-line label beside
      // the dot says what the mark is.
      const open = typeof panelOpen === 'function' ? Boolean(panelOpen()) : false;
      if (!open && gutterEl && hover.external !== true) {
        const first = hover.members[0];
        const text = hover.members.length > 1
          ? `${hover.members.length} comments`
          : (first && first.body ? first.body : 'comment');
        hoverLabel = el('div', 'rv-gt-label', text);
        hoverLabel.style.top = `${hover.top}px`;
        gutterEl.appendChild(hoverLabel);
      }
    }

    function setHover(members, top, key, fromFocus) {
      hover = { members, top, key, focusSource: fromFocus === true };
      drawHover();
      if (typeof onDotHover === 'function') onDotHover(members);
    }

    function clearHover() {
      if (!hover) return;
      hover = null;
      drawHover();
      if (typeof onDotHover === 'function') onDotHover(null);
    }

    // #222: the floating stack drives the tint from outside the gutter — the
    // same boxes, but not tied to a mark under the pointer, so reposition()
    // redraws it instead of pointer-checking it, and no label is drawn.
    // Cleared explicitly with null (or by a reflow, which clears any hover).
    function tintExternal(members) {
      if (Array.isArray(members) && members.length > 0) {
        hover = { members, top: NaN, key: null, external: true };
        drawHover();
      } else if (hover && hover.external) {
        hover = null;
        drawHover();
      }
    }

    // Shared hover wiring for dots and chips. setAttribute, not dataset —
    // the node DOM stubs the boot tests run against carry attributes only.
    // The pointer position is kept so reposition() can tell whether the
    // rebuilt mark is still under it.
    function wireHover(mark, members, top, key) {
      mark.setAttribute('data-rv-gt-key', key);
      mark.addEventListener('mouseenter', (e) => {
        if (e) { pointer.x = e.clientX; pointer.y = e.clientY; }
        setHover(members, top, key);
      });
      mark.addEventListener('mousemove', (e) => {
        pointer.x = e.clientX; pointer.y = e.clientY;
      });
      mark.addEventListener('mouseleave', clearHover);
      // #225: focus tints the anchor EXACTLY as hover does — without this a
      // keyboard user gets the dot and never the anchor.
      mark.addEventListener('focus', () => setHover(members, top, key, true));
      mark.addEventListener('blur', clearHover);
    }

    // #225: every mark is a keyboard citizen — focusable (the render loop
    // appends in document order, so tab order follows the page), announced
    // as a button with a name carrying its count and status, activated by
    // Enter or Space.
    function wireKey(mark, label, onActivate) {
      mark.tabIndex = 0;
      mark.setAttribute('role', 'button');
      mark.setAttribute('aria-label', label);
      mark.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onActivate(e);
        }
      });
    }

    // Tier class → the word a screen reader hears.
    const TIER_WORD = {
      'rv-gt-open': 'open',
      'rv-gt-actioned': 'actioned',
      'rv-gt-resolved': 'resolved',
      'rv-gt-failed': 'failed',
    };

    // #224: jump to the nearest comment beyond the fold in one direction.
    function jumpFromEdge(dir) {
      const scrollY = window.scrollY;
      const vh = window.innerHeight;
      const candidates = dir === 'up'
        ? placedRows.filter((e) => e.y < scrollY)
        : placedRows.filter((e) => e.y > scrollY + vh);
      if (candidates.length === 0) return;
      const target = dir === 'up'
        ? candidates.reduce((a, b) => (a.y > b.y ? a : b))
        : candidates.reduce((a, b) => (a.y < b.y ? a : b));
      let reduced = false;
      try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* stub DOM */ }
      window.scrollTo({
        top: Math.max(0, target.y - vh / 3),
        behavior: reduced ? 'auto' : 'smooth',
      });
    }

    function ensureGutter() {
      if (gutterEl) return gutterEl;
      gutterEl = el('div', 'rv-gutter');
      dotsContainer = el('div', 'rv-gutter-dots');
      gutterEl.appendChild(dotsContainer);
      // #224: the two counters. Viewport-FIXED — the column box only spans
      // the first viewport-height of the document, so absolute children
      // would scroll away with the page.
      edgeTop = el('button', 'rv-gt-edge rv-gt-edge-top rv-hidden');
      edgeTop.type = 'button';
      edgeTop.addEventListener('click', (e) => { e.stopPropagation(); jumpFromEdge('up'); });
      edgeBot = el('button', 'rv-gt-edge rv-gt-edge-bot rv-hidden');
      edgeBot.type = 'button';
      edgeBot.addEventListener('click', (e) => { e.stopPropagation(); jumpFromEdge('down'); });
      gutterEl.appendChild(edgeTop);
      gutterEl.appendChild(edgeBot);
      host.appendChild(gutterEl);
      return gutterEl;
    }

    function clearGutter() {
      entries = [];
      placedRows = [];
      if (dotsContainer) dotsContainer.replaceChildren();
      if (edgeTop) edgeTop.classList.add('rv-hidden');
      if (edgeBot) edgeBot.classList.add('rv-hidden');
    }

    // #267: the closed <details> a concealed anchor sits inside, resolved to
    // the OUTERMOST one — with nested folds only the outer summary is still
    // rendered, so that is the only row a mark can honestly sit on. Returns
    // {el, y} in document coordinates, or null when nothing folded conceals
    // it (a hidden tab, a display:none block — DECISION 7).
    function foldAncestorOf(loc, scroll) {
      let node = null;
      try {
        node = typeof loc.element === 'function' ? loc.element() : null;
      } catch { return null; }
      if (!node || typeof node.parentElement === 'undefined') return null;
      try {
        if (typeof node.closest === 'function' && node.closest('#rv-root')) return null;
      } catch { /* stub DOM without closest — the walk below is still safe */ }
      let outermost = null;
      for (let n = node; n; n = n.parentElement) {
        if (n.tagName === 'DETAILS' && !n.open) outermost = n;
      }
      if (outermost === null) return null;
      // The summary is the visible remnant; a <details> without one still
      // renders a default marker row, so fall back to the element itself.
      let target = outermost;
      try {
        const summary = typeof outermost.querySelector === 'function'
          ? outermost.querySelector(':scope > summary') : null;
        if (summary) target = summary;
      } catch { /* no :scope support in the stub — the element rect will do */ }
      let rect = null;
      try {
        rect = typeof target.getBoundingClientRect === 'function'
          ? target.getBoundingClientRect() : null;
      } catch { return null; }
      if (!rect || (rect.width <= 0 && rect.height <= 0)) return null;
      // rect.TOP, not its centre (Blake, live pass 2026-08-13). Every other
      // row in this column is measured from the top of its anchor's rect, so
      // centring on the summary put the mark half a heading-height lower than
      // the rule that placed the dots — which read as a gap under the
      // heading's own mark rather than as a mark on the next row.
      return { el: outermost, y: rect.top + scroll.y };
    }

    // The fold's own name, for the mark's tooltip and accessible name.
    function foldNameOf(details) {
      try {
        const summary = typeof details.querySelector === 'function'
          ? details.querySelector(':scope > summary') : null;
        if (!summary) return '';
        return String(summary.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      } catch { return ''; }
    }

    // Compute the vertical position of each comment's anchor, group nearby
    // ones into clusters, and render dots.
    function reposition() {
      rafId = 0;
      if (!gutterEl) return;
      if (reflowing) return; // frozen until the html reflow lands (snap there)
      const comments = getComments();
      if (comments.length === 0) {
        clearHover();
        clearGutter();
        gutterEl.classList.remove('rv-gt-reflowing');
        return;
      }

      const scroll = { x: window.scrollX, y: window.scrollY };
      const viewportH = window.innerHeight;

      // #239: slide the column toward the text edge (inline style wins over
      // the CSS floor; recomputed here so panel toggles and resizes track).
      // window.innerWidth, NOT documentElement.clientWidth: absolute `right`
      // anchors to the initial containing block (the real viewport), while
      // clientWidth SHRINKS by the html reflow margin — feeding it here put
      // the column a full panel-width too far right, moving with panel state
      // (Blake's live repro, 2026-08-12).
      const open = typeof panelOpen === 'function' ? Boolean(panelOpen()) : false;
      let colOff = open ? PANEL_W : 0; // the CSS floor, used if measuring fails
      try {
        colOff = gutterRightOffset(window.innerWidth, contentRightEdge(), open);
        gutterEl.style.right = `${colOff}px`;
      } catch { /* stub DOMs without full geometry keep the CSS offsets */ }

      // Locate each comment's anchor and record its vertical position.
      const raw = [];
      const foldRaw = []; // #267: the ones a closed <details> is hiding
      for (const comment of comments) {
        const loc = locateAnchor(comment.anchor);
        if (loc === null) {
          // Orphaned: no position. Pinned to the top as a dashed flag.
          raw.push({ comment, y: -1, orphan: true, tier: gutterTier(comment.status) });
          continue;
        }
        const r = loc.rect();
        const concealed = typeof loc.hidden === 'function' && loc.hidden();
        if (concealed || (r.width <= 0 && r.height <= 0)) {
          // #267: concealed is no longer silent. If a CLOSED <details> is what
          // conceals it, the comment regroups onto that fold's summary — the
          // one row of the section still on screen — and marks are stacked
          // there with a count. Anything else concealing it (a hidden tab, a
          // display:none block) has no such row, so it keeps the behaviour
          // below: no mark, and the card carries the explanation.
          const fold = foldAncestorOf(loc, scroll);
          if (fold !== null) {
            foldRaw.push({
              comment,
              tier: gutterTier(comment.status),
              foldKey: fold.el,
              summaryY: fold.y,
            });
            continue;
          }
          // HIDDEN is not ORPHANED (Blake, collapsible-sections repro): the
          // anchor still resolves, its text is just folded away (a closed
          // details, a hidden tab). No mark at all — the comment fell off
          // the page with its section, and the orphan pill would offer
          // re-anchoring to a comment whose anchor is fine. The rect check
          // alone is NOT enough: Chrome keeps real geometry on a closed
          // details' children (content-visibility), so folded comments were
          // rendering marks at phantom rows (Blake's teal-5/grey-2 repro) —
          // hidden() sees through that via checkVisibility.
          continue;
        }
        // Centre the mark on the block's FIRST LINE — not its top edge, and
        // not the middle of its height. See firstLineRectOf and anchorMarkY.
        raw.push({
          comment,
          y: anchorMarkY(r, firstLineRectOf(loc), lineHeightOf(loc)) + scroll.y,
          blockId: comment.anchor && comment.anchor.blockId ? comment.anchor.blockId : null,
          orphan: false,
          tier: gutterTier(comment.status),
        });
      }

      // #224: orphans have NO row — they never reach the cluster pass, never
      // render as a dot at a fabricated position. They collapse into ONE
      // dashed flag with a count, pinned at the top of the column.
      const orphans = raw.filter((r) => r.orphan);
      const placed = raw.filter((r) => !r.orphan);
      placedRows = placed;

      // Sort and merge into clusters — the pure pass in overlay-model.js.
      const clusters = clusterGutterRows(placed);

      // Render. #225: capture keyboard focus first — replaceChildren
      // destroys the focused mark on every scroll-driven pass, which would
      // otherwise dump a keyboard user back to the page top mid-traversal.
      let focusedKey = null;
      try {
        const a = document.activeElement;
        if (a && typeof a.getAttribute === 'function') focusedKey = a.getAttribute('data-rv-gt-key');
      } catch { /* stub DOM */ }
      dotsContainer.replaceChildren();
      entries = [];
      if (orphans.length > 0) {
        const flagTitle = `${orphans.length} comment${orphans.length === 1 ? '' : 's'} lost `
          + 'their place in the document — click to re-anchor';
        const flag = el('div', 'rv-gt-orphan', String(orphans.length));
        flag.title = flagTitle;
        const openReanchor = () => onDotClick(orphans[0].comment, {
          orphan: true,
          orphans: orphans.map((o) => o.comment),
        });
        flag.addEventListener('click', (e) => {
          e.stopPropagation();
          openReanchor();
        });
        wireKey(flag, flagTitle, openReanchor);
        flag.setAttribute('data-rv-gt-key', 'orphans');
        dotsContainer.appendChild(flag);
      }
      for (const cluster of clusters) {
        if (cluster.length === 1) {
          renderDot(cluster[0], scroll, dotsContainer);
        } else {
          renderCluster(cluster, scroll, dotsContainer);
        }
      }
      // #267: one mark per fold, placed AFTER the dots so it can see what is
      // already drawn and clear it (DECISION 3). What it clears is the BOXES
      // as painted — a lone dot is 9px, a cluster chip at least 19 — not the
      // bare rows, which is what let a chip and a fold mark overlap.
      const folds = groupFoldRows(foldRaw);
      const occupied = [];
      for (const cluster of clusters) {
        if (cluster.length === 1) {
          occupied.push({ center: cluster[0].y, half: GUTTER_DOT_SIZE / 2 });
        } else {
          const box = gutterClusterBox(cluster.map((c) => c.y));
          occupied.push({ center: box.top + box.height / 2, half: box.height / 2 });
        }
      }
      for (const fold of folds) {
        fold.top = foldMarkTop(fold.y, occupied);
        occupied.push({ center: fold.top, half: FOLD_MARK_SIZE / 2 });
        renderFoldMark(fold, dotsContainer);
      }
      // #225: put keyboard focus back on the rebuilt mark, if it survived.
      if (focusedKey !== null) {
        for (const child of dotsContainer.children || []) {
          if (typeof child.getAttribute === 'function'
              && child.getAttribute('data-rv-gt-key') === focusedKey) {
            try { child.focus({ preventScroll: true }); } catch { /* stub DOM */ }
            break;
          }
        }
      }

      // #224: off-screen counters — comments beyond the fold, per direction.
      // Centred on the DOT lane (dot centre ≈ 37.5px from the column's right
      // edge), pinned to the viewport; 0 hides the counter, never shows "0".
      // DECISION 6 (Blake, 2026-08-13): the pills SUM comments, not marks —
      // that is already the established norm here, since two comments sharing
      // a row count as two. A fold therefore contributes all its members, at
      // the row its mark sits on.
      const edgeYs = placed.map((e) => e.y);
      for (const fold of folds) {
        for (let i = 0; i < fold.count; i += 1) edgeYs.push(fold.top);
      }
      const counts = gutterEdgeCounts(edgeYs, scroll.y, viewportH);
      const edgeRight = `${colOff + 37.5 - 11}px`;
      for (const [edge, count, arrow, where] of [
        [edgeTop, counts.above, '↑', 'above'],
        [edgeBot, counts.below, '↓', 'below'],
      ]) {
        if (!edge) continue;
        edge.classList.toggle('rv-hidden', count === 0);
        if (count === 0) continue;
        edge.textContent = `${arrow} ${count}`;
        const say = `${count} comment${count === 1 ? '' : 's'} ${where} — click to jump to the nearest`;
        edge.title = say;
        edge.setAttribute('aria-label', say); // #225: the glyph alone says nothing
        edge.style.right = edgeRight;
      }

      // Every dot placed — safe to come back on screen.
      gutterEl.classList.remove('rv-gt-reflowing');

      // #220: the tint rides THIS pass — re-measured with the dots, no
      // second rAF loop. If the rebuilt mark under the pointer is still the
      // hovered one, redraw at the fresh positions; if the page moved it out
      // from under a stationary pointer, clear rather than strand the tint.
      if (hover && hover.external) {
        drawHover(); // #222: stack-driven tint — redrawn, never pointer-checked
      } else if (hover && hover.focusSource) {
        // #225: a focus-driven tint follows the FOCUSED mark, not the
        // pointer — the focus restore above re-focused the rebuilt mark.
        let active = null;
        try { active = document.activeElement; } catch { /* stub DOM */ }
        if (active && typeof active.getAttribute === 'function'
            && active.getAttribute('data-rv-gt-key') === hover.key) {
          const top = parseFloat(active.style && active.style.top);
          if (Number.isFinite(top)) hover.top = top;
          drawHover();
        } else {
          clearHover();
        }
      } else if (hover) {
        let under = null;
        try { under = document.elementFromPoint(pointer.x, pointer.y); } catch { /* stub DOM */ }
        if (under && typeof under.getAttribute === 'function'
            && under.getAttribute('data-rv-gt-key') === hover.key) {
          const top = parseFloat(under.style.top);
          if (Number.isFinite(top)) hover.top = top;
          drawHover();
        } else {
          clearHover();
        }
      }

      // Start listening if not already.
      if (!listening) {
        window.addEventListener('scroll', scheduleReposition, true);
        window.addEventListener('resize', scheduleReposition);
        // The html margin reflow animates for 250ms; a measurement taken
        // mid-flight targets a text edge that is still moving. Re-measure
        // when the reflow lands so the column's final position is right.
        document.documentElement.addEventListener('transitionstart', onReflowStart);
        document.documentElement.addEventListener('transitionend', onReflowEnd);
        document.documentElement.addEventListener('transitioncancel', onReflowEnd);
        // Folding a <details> moves every anchor below it, and until now the
        // gutter waited for a scroll or the next poll to notice — "on a fold
        // event I'd like to see the comment gutter update more quickly"
        // (Blake, acceptance round 2). toggle does not bubble; capture sees it.
        document.addEventListener('toggle', (e) => {
          const t = e.target;
          if (t instanceof Element && t.tagName === 'DETAILS' && !t.closest('#rv-root')) {
            scheduleReposition();
          }
        }, true);
        listening = true;
      }
    }

    function renderDot(entry, scroll, parent) {
      const dot = el('div', `rv-gt-dot ${entry.tier}`);
      dot.style.top = `${gutterDotTop(entry.y)}px`;
      dot.title = entry.comment.body
        ? entry.comment.body.slice(0, 80)
        : 'comment';
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        // #222: the mark's viewport rect rides along so the floating stack
        // can open beside it (null on stub DOMs without geometry).
        onDotClick(entry.comment, {
          rect: typeof dot.getBoundingClientRect === 'function' ? dot.getBoundingClientRect() : null,
        });
      });
      dot.addEventListener('mouseenter', () => {
        dot.classList.add('rv-gt-hover');
      });
      dot.addEventListener('mouseleave', () => {
        dot.classList.remove('rv-gt-hover');
      });
      // #220: hovering the dot tints its anchor (and lights its card).
      wireHover(dot, [entry.comment], gutterDotTop(entry.y), String(entry.comment.id));
      // #225: keyboard — Enter/Space open the card exactly like a click.
      wireKey(dot,
        `Comment, ${TIER_WORD[entry.tier] || 'open'}: ${entry.comment.body
          ? String(entry.comment.body).slice(0, 60) : 'no text'}`,
        () => onDotClick(entry.comment, {}));
      parent.appendChild(dot);
      entries.push({ ...entry, dotEl: dot });
    }

    function renderCluster(cluster, scroll, parent) {
      const box = gutterClusterBox(cluster.map((c) => c.y));
      const tier = dominantTier(cluster.map((c) => c.tier));
      const chip = el('div', `rv-gt-chip ${tier}`);
      chip.style.top = `${box.top}px`;
      chip.style.height = `${box.height}px`;
      chip.textContent = String(cluster.length);
      chip.title = `${cluster.length} comments at this position`;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        // Open the panel filtered to this cluster, or the first comment.
        onDotClick(cluster[0].comment, {
          cluster: cluster.map((c) => c.comment),
          rect: typeof chip.getBoundingClientRect === 'function' ? chip.getBoundingClientRect() : null,
        });
      });
      // #220: hovering a cluster tints EVERY member, one box-set each.
      wireHover(chip, cluster.map((c) => c.comment), box.top,
        cluster.map((c) => String(c.comment.id)).join(','));
      // #225: keyboard — the accessible name carries count and dominant tier.
      wireKey(chip, `${cluster.length} comments, ${TIER_WORD[tier] || 'open'}`,
        () => onDotClick(cluster[0].comment, { cluster: cluster.map((c) => c.comment) }));
      parent.appendChild(chip);
    }

    // #267: the hidden stack. Reads as a cluster chip drawn hollow and dashed
    // with the fold's own triangle in front of the count — "these exist, and
    // you cannot see their text yet". Tier-coloured like every other mark, so
    // a fold holding a failed comment still shouts.
    function renderFoldMark(fold, parent) {
      const mark = el('div', `rv-gt-fold ${fold.tier}`);
      mark.style.top = `${gutterDotTop(fold.top, FOLD_MARK_SIZE)}px`;
      mark.textContent = `▸${fold.count}`;
      const name = foldNameOf(fold.foldKey);
      const say = `${fold.count} comment${fold.count === 1 ? '' : 's'} hidden in the folded `
        + `section${name ? ` “${name}”` : ''}`;
      mark.title = `${say} — click to see them`;
      const open = (extra) => onDotClick(fold.members[0], {
        cluster: fold.members,
        // The tray offers "Unfold this section" off the back of this; nothing
        // unfolds on its own (DECISION 4).
        fold: fold.foldKey,
        foldName: name,
        ...extra,
      });
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        open({
          rect: typeof mark.getBoundingClientRect === 'function'
            ? mark.getBoundingClientRect() : null,
        });
      });
      mark.addEventListener('mouseenter', () => { mark.classList.add('rv-gt-hover'); });
      mark.addEventListener('mouseleave', () => { mark.classList.remove('rv-gt-hover'); });
      // Hovering lights the members' CARDS. There is deliberately no anchor
      // tint: the text is folded away, so there is nothing on screen to tint,
      // and tintRectsFor already returns nothing for a concealed anchor.
      wireHover(mark, fold.members, gutterDotTop(fold.top, FOLD_MARK_SIZE),
        fold.members.map((c) => String(c.id)).join(','));
      wireKey(mark, `${say}, ${TIER_WORD[fold.tier] || 'open'}`, () => open({}));
      mark.setAttribute('data-rv-gt-key', `fold:${fold.members.map((c) => c.id).join(',')}`);
      parent.appendChild(mark);
    }

    // While the html margin animates, every measurement is of a moving page —
    // dots placed from them drift and re-target, which read as a slow smear.
    // Freeze instead: no gutter writes during the reflow, one snap at the end.
    // Decision (Blake, 2026-08-12): the gutter cannot share the page's easing
    // — different systems, visibly different motion — so it does not try.
    // It VANISHES the instant the reflow starts and fades back in, correctly
    // placed, a beat after everything else has stopped moving.
    let reflowing = false;
    function onReflowStart(e) {
      if (e && (e.propertyName === 'margin-right' || e.propertyName === 'margin')) {
        reflowing = true;
        if (gutterEl) gutterEl.classList.add('rv-gt-reflowing');
        clearHover(); // #220: the text is about to move under the tint
      }
    }
    function onReflowEnd(e) {
      if (e && (e.propertyName === 'margin-right' || e.propertyName === 'margin')) {
        // Linger one beat past the margin transition: other chrome (the panel
        // itself) can ease slightly longer, and reappearing early is exactly
        // the wrong-place look this replaces.
        setTimeout(() => { reflowing = false; scheduleReposition(); }, 120);
      }
    }

    function scheduleReposition() {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(reposition);
    }

    function show() {
      ensureGutter();
      gutterEl.classList.remove('rv-hidden');
      reposition();
    }

    function hide() {
      if (gutterEl) gutterEl.classList.add('rv-hidden');
    }

    // #223: where the column sits right now, so overlay.js can place the
    // comment/edit rail in the inner lane. Null when the gutter is not on
    // screen (the rail then falls back to the block's own edge).
    function columnRect() {
      if (!gutterEl || gutterEl.classList.contains('rv-hidden')) return null;
      try { return gutterEl.getBoundingClientRect(); } catch { return null; }
    }

    function destroy() {
      if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0; }
      if (listening) {
        window.removeEventListener('scroll', scheduleReposition, true);
        window.removeEventListener('resize', scheduleReposition);
        document.documentElement.removeEventListener('transitionstart', onReflowStart);
        document.documentElement.removeEventListener('transitionend', onReflowEnd);
        document.documentElement.removeEventListener('transitioncancel', onReflowEnd);
        listening = false;
      }
      clearHover();
      clearGutter();
      if (gutterEl) { gutterEl.remove(); gutterEl = null; dotsContainer = null; }
      edgeTop = null;
      edgeBot = null;
    }

    return { show, hide, reposition, scheduleReposition, destroy, clearGutter, tintExternal, columnRect };
  }

  window.__rv = window.__rv || {};
  window.__rv.createGutter = createGutter;
  // #239: pure, exposed for the DOM-stub tests via overlay.js's __rvTest.
  window.__rv.gutterRightOffset = gutterRightOffset;
})();
