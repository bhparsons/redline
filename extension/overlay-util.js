// overlay-util.js — the small, dependency-free helpers every other overlay
// file needs: element creation, the #rv-root host, text formatting, and the
// two pure geometry/threshold helpers.
//
// Part of the overlay file set. These files are plain content scripts loaded
// in manifest order (NOT ES modules — Chrome loads content scripts as classic
// scripts, so imports would resolve against the visited page). They cooperate
// through the shared window.__rv namespace: each file adds its own key, and
// later files read earlier ones. Load order is therefore load-bearing and is
// pinned by test/runner/extension-ui.test.mjs.

(() => {
  'use strict';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function root() {
    let node = document.getElementById('rv-root');
    if (!node) {
      node = el('div');
      node.id = 'rv-root';
      (document.body ?? document.documentElement).appendChild(node);
      // Liquid Glass refraction lives in refraction.js (loaded first, see
      // manifest.json) — a standalone, independently mergeable material unit.
      if (typeof window.__rvMountRefraction === 'function') window.__rvMountRefraction();
    }
    return node;
  }

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  // Format a USD cost compactly: cents at 2 dp, sub-cent at 4 dp (WP0).
  function formatCost(n) {
    if (!Number.isFinite(n)) return '';
    if (n === 0) return '$0.00';
    return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
  }

  // cmd+Enter (mac) / ctrl+Enter (win/linux) is the "submit this form" gesture
  // in Redline's own textareas — plain Enter stays a newline (WP3).
  function isSubmitShortcut(event) {
    return event.key === 'Enter' && (event.metaKey || event.ctrlKey)
      && !event.altKey && !event.shiftKey;
  }

  // A reference quote longer than this (chars) gets clamped to ~3 lines with
  // a Show more toggle in the expanded card (WP2). A pure threshold so the
  // decision is testable without layout.
  const QUOTE_CLAMP_CHARS = 180;
  function shouldClampQuote(quote) {
    return typeof quote === 'string' && quote.length > QUOTE_CLAMP_CHARS;
  }

  // Document-space box for a persistent-highlight tile over one client rect,
  // padded slightly so the tint reads as a highlight, not an outline (WP2).
  function anchorBoxRect(r, scroll) {
    return {
      top: r.top + scroll.y - 1,
      left: Math.max(0, r.left + scroll.x - 2),
      width: r.width + 4,
      height: r.height + 2,
    };
  }

  // (#223 removed pencilPosition/PENCIL_SIZE/PENCIL_INSET: the edit pencil
  // no longer floats at a block corner — it lives in the gutter rail beside
  // the comment button, positioned by overlay.js against the gutter column.)

  // ---- markdown in card prose (#246) ----
  // Agent replies, decision summaries and comment bodies arrive as markdown
  // and used to display as literal characters. renderMarkdown builds REAL
  // NODES for a small subset — innerHTML is never assigned, so model output
  // can never inject markup — and anything outside the subset stays literal.
  // Subset: **bold**, *italic*/_italic_, `code`, ``` fences, -/* bullets,
  // 1. numbered lists, #–### headings, > blockquotes, blank-line paragraphs,
  // hard line breaks. Pipe tables are NOT parsed — a card is too narrow — a
  // run of |-delimited lines becomes one monospace pre block instead.
  // Links become anchors ONLY for http:/https:; every other scheme
  // (javascript:, data:, …) renders as its literal characters.

  // One alternation, tried left to right: code, bold, *italic*, _italic_
  // (with a non-word boundary so snake_case survives), [text](url), bare URL.
  // Fresh regex per call — appendInline recurses into bold/italic content,
  // and a shared /g regex would clobber its own lastIndex.
  const MD_INLINE = () => new RegExp(
    '(`[^`\\n]+`)'
    + '|(\\*\\*[^*\\n]+\\*\\*)'
    + '|(\\*[^*\\s][^*\\n]*\\*)'
    + '|((?:^|[^\\w*])_[^_\\s][^_\\n]*_(?!\\w))'
    + '|(\\[[^\\]\\n]+\\]\\(([^)\\n]*)\\))'
    + '|(https?:\\/\\/[^\\s<>"\'\\)\\]]+)', 'g');

  function mdLink(label, url) {
    const a = el('a', 'rv-md-a', label);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  // Parse one line's inline markdown into `parent` as text nodes + elements.
  function appendInline(parent, text) {
    const re = MD_INLINE();
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      let start = m.index;
      let token = m[0];
      // The _italic_ alternative may consume the boundary char before the
      // opening underscore; give it back to the surrounding text.
      if (m[4] !== undefined && token[0] !== '_') { start += 1; token = token.slice(1); }
      if (start > last) parent.appendChild(document.createTextNode(text.slice(last, start)));
      if (m[1] !== undefined) {
        parent.appendChild(el('code', 'rv-md-code', token.slice(1, -1)));
      } else if (m[2] !== undefined) {
        const b = el('strong', 'rv-md-b');
        appendInline(b, token.slice(2, -2));
        parent.appendChild(b);
      } else if (m[3] !== undefined || m[4] !== undefined) {
        const i = el('em', 'rv-md-i');
        appendInline(i, token.slice(1, -1));
        parent.appendChild(i);
      } else if (m[5] !== undefined) {
        const url = m[6];
        if (/^https?:\/\//i.test(url)) {
          parent.appendChild(mdLink(token.slice(1, token.indexOf(']')), url));
        } else {
          // The security-relevant branch: never an anchor, only characters.
          parent.appendChild(document.createTextNode(token));
        }
      } else {
        parent.appendChild(mdLink(token, token));
      }
      last = start + token.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  const MD_FENCE = /^```/;
  const MD_PIPE = /^\s*\|/;
  const MD_HEADING = /^(#{1,3})\s+(.*)$/;
  const MD_QUOTE = /^>\s?/;
  const MD_BULLET = /^\s*[-*]\s+/;
  const MD_NUMBER = /^\s*\d+\.\s+/;
  // A line that OPENS a non-paragraph block — where a paragraph stops.
  const MD_BLOCK_START = /^(```|\s*\||#{1,3}\s|>|\s*[-*]\s+|\s*\d+\.\s+)/;

  // Pure: text -> DocumentFragment. Builds nodes only; never innerHTML.
  function renderMarkdown(text) {
    const frag = document.createDocumentFragment();
    const lines = String(text ?? '').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') { i += 1; continue; }
      if (MD_FENCE.test(line)) {
        const buf = [];
        i += 1;
        while (i < lines.length && !MD_FENCE.test(lines[i])) { buf.push(lines[i]); i += 1; }
        i += 1; // the closing fence (or EOF)
        const pre = el('pre', 'rv-md-pre');
        pre.appendChild(el('code', undefined, buf.join('\n')));
        frag.appendChild(pre);
        continue;
      }
      if (MD_PIPE.test(line)) {
        // A pipe-table wall: columns line up in monospace and the block
        // scrolls sideways. No <table> is built (#246 AC 2b).
        const buf = [];
        while (i < lines.length && MD_PIPE.test(lines[i])) { buf.push(lines[i]); i += 1; }
        const pre = el('pre', 'rv-md-pre rv-md-pipes');
        pre.appendChild(el('code', undefined, buf.join('\n')));
        frag.appendChild(pre);
        continue;
      }
      const h = line.match(MD_HEADING);
      if (h) {
        const head = el('div', `rv-md-h rv-md-h${h[1].length}`);
        appendInline(head, h[2]);
        frag.appendChild(head);
        i += 1;
        continue;
      }
      if (MD_QUOTE.test(line)) {
        const quote = el('blockquote', 'rv-md-bq');
        let first = true;
        while (i < lines.length && MD_QUOTE.test(lines[i])) {
          if (!first) quote.appendChild(el('br'));
          appendInline(quote, lines[i].replace(MD_QUOTE, ''));
          first = false;
          i += 1;
        }
        frag.appendChild(quote);
        continue;
      }
      if (MD_BULLET.test(line) || MD_NUMBER.test(line)) {
        const marker = MD_NUMBER.test(line) ? MD_NUMBER : MD_BULLET;
        const list = el(marker === MD_NUMBER ? 'ol' : 'ul', 'rv-md-list');
        while (i < lines.length && marker.test(lines[i])) {
          const item = el('li');
          appendInline(item, lines[i].replace(marker, ''));
          list.appendChild(item);
          i += 1;
        }
        frag.appendChild(list);
        continue;
      }
      // Paragraph: consecutive plain lines; a single newline is a HARD break
      // (chat prose, where the old textContent path collapsed it to a space).
      const para = el('p', 'rv-md-p');
      let first = true;
      while (i < lines.length && lines[i].trim() !== '' && !MD_BLOCK_START.test(lines[i])) {
        if (!first) para.appendChild(el('br'));
        appendInline(para, lines[i]);
        first = false;
        i += 1;
      }
      frag.appendChild(para);
    }
    return frag;
  }

  // The collapsed-surface counterpart: markdown syntax OUT, one flat line of
  // plain text back — no stray ** on a card face, no block elements (#246).
  function stripMarkdown(text) {
    const lines = String(text ?? '').split('\n');
    const out = [];
    let inFence = false;
    for (const raw of lines) {
      if (MD_FENCE.test(raw)) { inFence = !inFence; continue; }
      if (inFence) { out.push(raw); continue; }
      out.push(raw
        .replace(MD_HEADING, '$2')
        .replace(MD_QUOTE, '')
        .replace(MD_BULLET, '')
        .replace(MD_NUMBER, '')
        .replace(/\[([^\]\n]+)\]\(([^)\n]*)\)/g, '$1')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/\*([^*\s][^*\n]*)\*/g, '$1')
        .replace(/(^|[^\w*])_([^_\s][^_\n]*)_(?!\w)/g, '$1$2')
        .replace(/`([^`\n]+)`/g, '$1'));
    }
    return out.join(' ').replace(/\s+/g, ' ').trim();
  }

  // ---- history folding (#247) ----
  // Opening a card must not dump every reply at full length — one verbose
  // agent reply pushes everything else off-screen. An entry longer than
  // ~4 rendered lines starts FOLDED (header + one preview line); the newest
  // entry is always open, whatever its length. Pure, so the rule is testable
  // without a DOM: lines are estimated from the text, not measured.
  const FOLD_LINE_CHARS = 48; // ~one rendered line of card prose
  const FOLD_MAX_LINES = 4;   // longer than this starts folded
  function estimateLines(text) {
    return String(text ?? '').split('\n')
      .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / FOLD_LINE_CHARS)), 0);
  }
  // true = this entry starts folded inside an expanded card.
  function foldState(entry, { isNewest = false } = {}) {
    if (isNewest) return false;
    const text = entry && entry.kind === 'decision' ? entry.summary : entry && entry.body;
    return estimateLines(text) > FOLD_MAX_LINES;
  }

  // Which build of the extension is loaded — manifest.json's version_name
  // (a free-form label like "0.2.0 · overlay-split") falling back to version.
  // Shown in the panel footer so an unreloaded/wrong unpacked copy is visible
  // on the page itself, not just at chrome://extensions. Empty outside Chrome
  // (the node DOM-stub tests), where callers must render nothing.
  function extensionVersion() {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getManifest) return '';
      const m = chrome.runtime.getManifest();
      return m.version_name || m.version || '';
    } catch {
      return '';
    }
  }

  window.__rv = window.__rv || {};
  window.__rv.util = {
    el, root, truncate, formatCost, isSubmitShortcut, shouldClampQuote,
    anchorBoxRect, extensionVersion,
    renderMarkdown, stripMarkdown,
    foldState, estimateLines, FOLD_LINE_CHARS, FOLD_MAX_LINES,
    QUOTE_CLAMP_CHARS,
  };
})();
