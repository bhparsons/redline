// overlay-anchor.js — finding where a comment points in the document.
// blockId ([data-rev]) is primary; the fallback is the first text occurrence
// of the quote. No match → the caller marks the card orphaned; nothing here
// hard-fails.
//
// Standalone: reads the document, depends on no other overlay file.

(() => {
  'use strict';

  // ---- anchor location ------------------------------------------------------
  // blockId ([data-rev]) is primary; fallback is the first text occurrence of
  // the quote across the document's text nodes (never inside #rv-root).
  // Sophisticated re-anchoring is future work: no match → the card is marked
  // orphaned, nothing hard-fails.

  // `root` (#257): scope the search to one element — the block an anchor
  // already resolved — so the quote pinpoints text WITHIN it.
  function findQuoteRange(quote, root = null) {
    const scope = root ?? document.body ?? document.documentElement;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest('#rv-root')) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let text = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: text.length });
      text += n.nodeValue;
    }
    const at = text.indexOf(quote);
    if (at === -1) return null;
    const end = at + quote.length;
    const pos = (offset, preferNodeEnd) => {
      for (const { node, start } of nodes) {
        const len = node.nodeValue.length;
        if (offset < start + len || (preferNodeEnd && offset === start + len)) {
          return { node, offset: offset - start };
        }
      }
      return null;
    };
    const s = pos(at, false);
    const e = pos(end, true);
    if (!s || !e) return null;
    try {
      const range = document.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      return range;
    } catch {
      return null;
    }
  }

  // Is this element hidden by a display:none ancestor (#60)? offsetParent is
  // null for exactly that case — and also for position:fixed elements, which
  // are very much visible, so those are excluded. Cheap: no getComputedStyle
  // walk up the tree.
  function isHidden(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    // checkVisibility() sees through every hiding mechanism, including the
    // one the offsetParent test is blind to: Chrome hides closed-<details>
    // content with content-visibility, which keeps offsetParent non-null AND
    // real geometry — so the old check called it visible and the highlight
    // landed where the text would be (#237 acceptance, Blake 2026-08-12).
    try {
      if (typeof el.checkVisibility === 'function') {
        return !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
      }
    } catch { /* fall through to the offsetParent heuristic */ }
    if (el.offsetParent !== null) return false;
    try {
      if (getComputedStyle(el).position === 'fixed') return false;
    } catch { /* no computed style available — fall through to hidden */ }
    return true;
  }

  // → { rect(), rects(), element(), hidden() } or null (orphaned). rect() is
  // the union box (used to scroll into view); rects() is the per-line client-
  // rect list (used by the persistent highlight so wrapped quotes tint every
  // line, not one tall box).
  //
  // element() and hidden() exist for #60: querySelector finds a block inside a
  // display:none ancestor perfectly well, but its rect is 0x0 at the origin —
  // so a caller that just scrolls to rect().top silently sends you to the top
  // of the document. Callers must ask hidden() before trusting the geometry.
  function locateAnchor(anchor) {
    if (!anchor || typeof anchor !== 'object') return null;
    if (typeof anchor.blockId === 'string' && anchor.blockId) {
      let block = null;
      try {
        block = document.querySelector(`[data-rev="${CSS.escape(anchor.blockId)}"]`);
      } catch { /* fall through to the quote */ }
      if (block && !block.closest('#rv-root')) {
        return {
          rect: () => block.getBoundingClientRect(),
          rects: () => [block.getBoundingClientRect()],
          // #257: the exact quoted text's line boxes WITHIN the block, or []
          // when the quote is absent or no longer findable (edits move text).
          // The block rect above stays the ambient layer either way.
          quoteRects: () => {
            const quote = typeof anchor.quote === 'string' ? anchor.quote : '';
            if (!quote) return [];
            const range = findQuoteRange(quote, block);
            if (!range) return [];
            return Array.from(range.getClientRects());
          },
          element: () => block,
          hidden: () => isHidden(block),
        };
      }
    }
    if (typeof anchor.quote === 'string' && anchor.quote.length > 0) {
      const range = findQuoteRange(anchor.quote);
      if (range) {
        // For a quote, the nearest ELEMENT is what a host page can act on —
        // rv:reveal has to be dispatched on a node, not a range.
        const nearest = () => {
          const n = range.startContainer;
          return n && n.nodeType === 1 ? n : (n && n.parentElement) || null;
        };
        return {
          rect: () => range.getBoundingClientRect(),
          rects: () => {
            const rs = Array.from(range.getClientRects());
            return rs.length > 0 ? rs : [range.getBoundingClientRect()];
          },
          // A quote-only anchor is already exact — the layers coincide.
          quoteRects: () => Array.from(range.getClientRects()),
          element: nearest,
          hidden: () => isHidden(nearest()),
        };
      }
    }
    return null;
  }

  window.__rv.anchor = { findQuoteRange, locateAnchor, isHidden };
})();
