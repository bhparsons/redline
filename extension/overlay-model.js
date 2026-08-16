// overlay-model.js — the overlay's pure logic: how comments are filtered and
// grouped into lifecycle sections, how run-log files map to pipeline stages,
// and the agent-author chip. No state, no event handlers — everything here is
// a function of its arguments, which is why these are the parts node can test
// directly (window.__rvTest re-exports them).
//
// Loads after overlay-util.js (uses el).

(() => {
  'use strict';

  const { el, stripMarkdown } = window.__rv.util;

  // A failed run needs the author's eyes as much as a decision does (#250).
  const DECIDED = new Set(['addressed', 'declined', 'deferred', 'failed']);

  // Panel filters. "Active" (the default) hides only what's been resolved;
  // "Needs review" is the addressed/declined/deferred/failed triage set.
  // "All" leads BOTH dropdowns and names its own axis (Blake, 2026-08-13):
  // the widest option sat last here and first in the audience list, and both
  // were called some flavour of "all" without saying all of WHAT. Order is
  // display only — every lookup is by key, and 'active' is still the default.
  const FILTERS = [
    ['all', 'All statuses', () => true],
    ['active', 'Active', (c) => c.status !== 'resolved'],
    ['needs', 'Needs review', (c) => DECIDED.has(c.status)],
    ['resolved', 'Resolved', (c) => c.status === 'resolved'],
  ];

  // Audience filter axis (#154): composes with the status filter. `inAiBatch`
  // is the audience predicate itself — absent or true keeps a comment in the
  // AI batch, only an explicit false opts it out.
  function inAiBatch(c) {
    return Boolean(c) && c.aiEdits !== false;
  }
  // "Everyone" read as PEOPLE (Blake, 2026-08-13) — and it sat directly under
  // the sentence "New comments go to the AI", which really is about who gets
  // something. This dropdown filters comments that already exist; the row
  // above decides what happens to the next one you write.
  const AUD_FILTERS = [
    ['all', 'All comments', () => true],
    ['ai', 'For the AI', (c) => inAiBatch(c)],
    ['note', 'Notes only', (c) => !inAiBatch(c)],
  ];

  // ---- The visibility rule (moved out of overlay.js's init() closure) ------
  //
  // Which comments a surface shows. It lived inside a 5,000-line closure, so
  // the only way the suite could check it was by matching the source as TEXT
  // (test/runner/gutter-position.test.mjs). Both halves are pure functions of
  // (comment, state) now, so node can run the rule instead of reading it.
  // `state` is {filter, audienceFilter, rowFilter} — the three axis variables
  // overlay.js owns; an unknown axis key falls back to its permissive default
  // rather than throwing, because a stale persisted value must never blank
  // the panel.
  const AXIS_DEFAULT = { filter: 'all', audienceFilter: 'all' };
  function axisDef(defs, key, fallback) {
    return defs.find(([k]) => k === key) || defs.find(([k]) => k === fallback);
  }
  function axisPredicate(defs, key, fallback) {
    return axisDef(defs, key, fallback)[2];
  }
  // Status × audience — the axes that bind BOTH surfaces (#219: the panel's
  // filter empties matching dots out of the gutter).
  function passesAxisFilters(c, state) {
    const s = state || AXIS_DEFAULT;
    return axisPredicate(FILTERS, s.filter, 'all')(c)
      && axisPredicate(AUD_FILTERS, s.audienceFilter, 'all')(c);
  }
  // ---- search: the fourth axis, and the only one that overrides (#268) ----
  //
  // A CLI session names a comment by its four-character handle ("look at
  // k7mq") and the browser had no way to get there but the eye. Blake's
  // redline of 2026-08-13 settled how it behaves:
  //
  //  · D8  — a HANDLE match reaches PAST the status/audience lens. Naming a
  //          comment by handle is asking for that comment; refusing to show it
  //          because of a dropdown set ten minutes ago is the feature failing
  //          at its only job. Every other axis composes; this one overrides.
  //  · D10 — it reads body, anchor quote, reply bodies, and author/agent names.
  //  · D11 — both sides are normalised first, so a straight apostrophe finds a
  //          curly one and `cafe` finds `café`.
  //  · D13 — markdown is stripped before matching, so a phrase spanning
  //          `**bold**` matches what the card DISPLAYS rather than what the
  //          sidecar stores.
  //  · D12 — panel only. The gutter consumes passesAxisFilters, which this
  //          leaves alone, so "search never erases the page's map" holds by
  //          construction rather than by a rule anyone has to remember.

  // Reviewed documents are entity-encoded, so a quote holds a curly
  // apostrophe while the keyboard produces a straight one. Accents fold
  // separately (NFD + combining-mark strip).
  const SEARCH_PUNCT = {
    '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
    '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
    '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-',
    '―': '-', '−': '-',
  };

  // Fold a string to its match form AND record where every folded character
  // came from. The map is what lets a hit be painted back onto the ORIGINAL
  // text: accent folding and whitespace collapsing both move offsets, so an
  // index into the folded string means nothing to the DOM without it. The
  // trailing entry is a sentinel (src.length), so a hit's END offset is always
  // just map[end] rather than a special case.
  function foldSearchText(text) {
    const src = String(text ?? '');
    let folded = '';
    const map = [];
    let lastWasSpace = true; // leading whitespace folds away
    for (let i = 0; i < src.length; i += 1) {
      const raw = src[i];
      if (/\s/.test(raw)) {
        if (lastWasSpace) continue;
        lastWasSpace = true;
        folded += ' ';
        map.push(i);
        continue;
      }
      lastWasSpace = false;
      const swapped = SEARCH_PUNCT[raw] || raw;
      const piece = swapped.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      for (const ch of piece) { folded += ch; map.push(i); }
    }
    while (folded.endsWith(' ')) { folded = folded.slice(0, -1); map.pop(); }
    map.push(src.length);
    return { folded, map };
  }

  // The handle alphabet leaves out 0 1 i l o u so a handle survives being read
  // aloud (REF_ALPHABET, overlay.js). A four-character query holding one of
  // them CANNOT name a comment — and that is not hypothetical: every handle
  // agent sessions had cited by 2026-08-13 (bwau, cubg, kt3p…) was minted from
  // a doc comment that listed the exclusions wrongly, and two of them contain
  // `u`. Searching for a handle that can never exist would fail silently, so
  // the box says so and falls through to a text search (D8a).
  const HANDLE_LEN = 4;
  const HANDLE_EXCLUDED = '01ilou';
  const HANDLE_SHAPE = new RegExp(`^[0-9a-z]{${HANDLE_LEN}}$`);
  function handleShape(query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!HANDLE_SHAPE.test(q)) return { handle: null, invalid: false, bad: '' };
    const bad = [...new Set([...q].filter((ch) => HANDLE_EXCLUDED.includes(ch)))];
    if (bad.length > 0) return { handle: null, invalid: true, bad: bad.join(' ') };
    return { handle: q, invalid: false, bad: '' };
  }

  // Everything a query needs said ONCE per render rather than once per card.
  // `ref` is injected for the same reason sortByDocumentOrder takes its
  // locator: shortRef lives in overlay.js, which loads after this file.
  function prepareSearch(query, ref) {
    const raw = String(query ?? '');
    const needle = foldSearchText(raw).folded;
    const shape = handleShape(raw);
    return {
      raw,
      needle,
      active: needle.length > 0,
      handle: shape.handle,
      invalidHandle: shape.invalid,
      badChars: shape.bad,
      ref: typeof ref === 'function' ? ref : null,
    };
  }

  function authorName(item) {
    if (!item) return '';
    return item.creator === 'agent' ? (item.agentName || 'agent') : 'user';
  }
  // What the search reads (D10), as one string per comment.
  function searchableText(c) {
    if (!c) return '';
    const parts = [stripMarkdown(c.body), authorName(c)];
    if (c.anchor && typeof c.anchor.quote === 'string') parts.push(c.anchor.quote);
    for (const r of Array.isArray(c.replies) ? c.replies : []) {
      parts.push(stripMarkdown(r.body), authorName(r));
    }
    return parts.filter(Boolean).join('\n');
  }

  // A buffered comment (#202) has no server id and therefore no handle, so it
  // can only ever be reached by its text — never by this branch.
  function isHandleMatch(c, search) {
    return Boolean(search && search.handle && search.ref
      && c && typeof c.id === 'string' && c.id
      && search.ref(c.id) === search.handle);
  }
  function matchesSearchText(c, search) {
    if (!search || !search.active) return true;
    return foldSearchText(searchableText(c)).folded.includes(search.needle);
  }
  // D9: a handle match and a text match are both matches — nothing is
  // suppressed, the handle is only pinned first (overlay.js does the pinning).
  function matchesSearch(c, search) {
    if (!search || !search.active) return true;
    return isHandleMatch(c, search) || matchesSearchText(c, search);
  }

  // Which lens a handle match had to reach past, as the label the notice
  // names — null when nothing was hiding it and there is nothing to announce.
  function searchReachedPast(c, state) {
    const search = state ? state.search : null;
    if (!isHandleMatch(c, search)) return null;
    const s = state || AXIS_DEFAULT;
    const status = axisDef(FILTERS, s.filter, 'all');
    if (!status[2](c)) return status[1];
    const aud = axisDef(AUD_FILTERS, s.audienceFilter, 'all');
    if (!aud[2](c)) return aud[1];
    if (s.rowFilter && !s.rowFilter.ids.includes(c.id)) return 'row';
    return null;
  }

  // Where a hit falls in ONE string, as offsets into that string — the
  // highlighter's half of the fold map. Non-overlapping, left to right.
  function searchHits(text, search) {
    if (!search || !search.active) return [];
    const { folded, map } = foldSearchText(text);
    const hits = [];
    let from = 0;
    for (;;) {
      const at = folded.indexOf(search.needle, from);
      if (at < 0) break;
      hits.push({ start: map[at], end: map[at + search.needle.length] });
      from = at + search.needle.length;
    }
    return hits;
  }

  // The sidecar's shown set adds the row filter. #260 amendment (Blake): the
  // row filter is SIDECAR-ONLY — the gutter keeps every dot, so entering a
  // row never erases the page's map of everything else. #222: it composes
  // with the other axes by intersection.
  function passesFilters(c, state) {
    const search = state ? state.search : null;
    if (search && search.active) {
      if (isHandleMatch(c, search)) return true; // D8: overrides every lens
      if (!matchesSearchText(c, search)) return false;
    }
    const rowFilter = state ? state.rowFilter : null;
    if (rowFilter && !rowFilter.ids.includes(c.id)) return false;
    return passesAxisFilters(c, state);
  }

  // Run-log file grouping (WP12): map a trace-bundle filename to a logical
  // group + a friendly label/icon, so the run-log pane reads as a pipeline
  // (prompt → request → response → validation → record) instead of raw files.
  const RUNLOG_GROUP_ORDER = ['prompt', 'request', 'response', 'validation', 'record', 'other'];
  const RUNLOG_GROUP_LABELS = {
    prompt: 'Prompt', request: 'Agent request', response: 'Agent response',
    validation: 'Validation', record: 'Run record', other: 'Other',
  };
  function runLogFileMeta(name) {
    const n = String(name || '');
    if (/(^|[-/])run\.json$/.test(n)) return { group: 'record', label: 'Run record', icon: '📄' };
    if (/scope/.test(n)) return { group: 'validation', label: 'Scope check', icon: '🔍' };
    if (/validation/.test(n)) return { group: 'validation', label: 'Validation', icon: '✓' };
    if (/response/.test(n)) return { group: 'response', label: 'Agent response', icon: '📥' };
    if (/request/.test(n)) return { group: 'request', label: 'Agent request', icon: '📤' };
    if (/prompt/.test(n)) return { group: 'prompt', label: 'Prompt', icon: '📝' };
    return { group: 'other', label: n, icon: '📎' };
  }
  // Order files into groups (stable within a group). Pure — exposed for tests.
  function groupRunLogFiles(files) {
    const out = RUNLOG_GROUP_ORDER.map((group) => ({ group, label: RUNLOG_GROUP_LABELS[group], files: [] }));
    const byGroup = new Map(out.map((g) => [g.group, g]));
    for (const f of Array.isArray(files) ? files : []) {
      const meta = runLogFileMeta(f && f.name);
      byGroup.get(meta.group).files.push({ ...f, meta });
    }
    return out.filter((g) => g.files.length > 0);
  }

  // Lifecycle sections (WP9). A comment lives in exactly ONE section, chosen
  // by its status — so a status change relocates its card, never duplicates
  // it. Recently-actioned sub-sections render in this order.
  const ACTIONED_ORDER = ['addressed', 'declined', 'deferred', 'failed'];
  function sectionKey(status) {
    if (status === 'resolved') return 'resolved';
    if (ACTIONED_ORDER.includes(status)) return 'actioned';
    return 'open'; // not yet actioned
  }
  // Group a comment list into ordered render sections. Pure — exposed for tests.
  function groupComments(list) {
    const groups = {
      open: [],
      actioned: { addressed: [], declined: [], deferred: [], failed: [] },
      resolved: [],
    };
    for (const c of Array.isArray(list) ? list : []) {
      const key = sectionKey(c && c.status);
      if (key === 'resolved') groups.resolved.push(c);
      else if (key === 'actioned') groups.actioned[c.status].push(c);
      else groups.open.push(c);
    }
    return groups;
  }

  // Order comments by where they sit on the PAGE, not by when they were
  // written (#105) — so the panel reads top-to-bottom like the document.
  //
  // `locate` is injected (overlay.js passes locateAnchor) for two reasons: it
  // keeps this file free of DOM lookups so node can test it against a stub,
  // and it lets the caller measure ONCE per render rather than once per
  // comparison — a sort calls its comparator O(n log n) times, and
  // getBoundingClientRect forces layout every time.
  //
  // Orphans (no locatable anchor) sort last, keeping their relative order:
  // they have no position to sort by, and burying them at the bottom is
  // better than scattering them through the list at position zero.
  function sortByDocumentOrder(list, locate) {
    const items = Array.isArray(list) ? list : [];
    const tops = new Map();
    for (const c of items) {
      let top = null;
      try {
        const loc = c && typeof locate === 'function' ? locate(c.anchor) : null;
        const rect = loc && typeof loc.rect === 'function' ? loc.rect() : null;
        // A zero-area rect means hidden, not top-of-page — treat it as
        // unlocatable rather than sorting it above everything (#60).
        if (rect && (rect.width > 0 || rect.height > 0)) top = rect.top;
      } catch { /* an unlocatable anchor is an orphan, never a throw */ }
      tops.set(c, top);
    }
    // Decorate with the index so ties and orphans keep creation order:
    // Array.prototype.sort is stable in modern engines, but the tie-break is
    // written out rather than relied upon.
    return items
      .map((c, i) => ({ c, i, top: tops.get(c) }))
      .sort((a, b) => {
        if (a.top === null && b.top === null) return a.i - b.i;
        if (a.top === null) return 1;
        if (b.top === null) return -1;
        return a.top - b.top || a.i - b.i;
      })
      .map((x) => x.c);
  }

  // ---- Comment gutter (#218/#219): the pure half of overlay-gutter.js ----
  // Status → tier. Four marks distinguished by weight rather than kind:
  //   filled amber (open) · amber ring (actioned) · faint grey (resolved) · red (failed)
  const GUTTER_TIER = {
    open: 'rv-gt-open',
    addressed: 'rv-gt-actioned',
    resolved: 'rv-gt-resolved',
    declined: 'rv-gt-resolved',
    deferred: 'rv-gt-resolved',
    failed: 'rv-gt-failed',
  };
  function gutterTier(status) {
    return GUTTER_TIER[status] || GUTTER_TIER.open;
  }

  // The tier most in need of the AUTHOR wins (Blake, acceptance 2026-08-12):
  // an open comment needs no revisit until something acts on it, but an
  // actioned or failed one is waiting on the author's review — so those
  // outrank open in a mixed cluster. One open among three resolved still
  // reads as open.
  const GUTTER_TIER_RANK = { 'rv-gt-failed': 0, 'rv-gt-actioned': 1, 'rv-gt-open': 2, 'rv-gt-resolved': 3 };
  function dominantTier(tiers) {
    return tiers.reduce((a, b) => (GUTTER_TIER_RANK[a] ?? 9) <= (GUTTER_TIER_RANK[b] ?? 9) ? a : b);
  }

  // Rows within this many pixels of their neighbour merge into one chip; the
  // dot itself is 9px (the CSS draws it, this file centers it).
  const GUTTER_CLUSTER_PX = 18;
  const GUTTER_DOT_SIZE = 9;

  // Group measured rows ({y, orphan}) into render clusters: orphans first
  // (each its own flag, never merged), the rest sorted by y and chained while
  // each row sits within clusterPx of the previous one. Pure — the input
  // array is not mutated.
  function clusterGutterRows(rows, clusterPx = GUTTER_CLUSTER_PX) {
    const sorted = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
      if (a.orphan && !b.orphan) return -1;
      if (!a.orphan && b.orphan) return 1;
      return a.y - b.y;
    });
    const clusters = [];
    let current = [];
    for (const row of sorted) {
      if (row.orphan) {
        if (current.length > 0) { clusters.push(current); current = []; }
        clusters.push([row]);
        continue;
      }
      if (current.length > 0 && Math.abs(row.y - current[current.length - 1].y) > clusterPx) {
        clusters.push(current);
        current = [];
      }
      current.push(row);
    }
    if (current.length > 0) clusters.push(current);
    return clusters;
  }

  // Dot-row geometry (#218 residue): a dot centers on its anchor's y; a
  // cluster chip spans first-to-last member with the dot size as its floor.
  function gutterDotTop(y, dotSize = GUTTER_DOT_SIZE) {
    return y - dotSize / 2;
  }
  // WHERE a mark's y comes from. Blake, 2026-08-15, live: "the comment bubbles
  // in the gutter seem to align with the very top of the div... aligning them
  // with the first line of the text is more intuitive."
  //
  // They did sit at the very top: the y was the block's bounding-box top, and
  // gutterDotTop centres the dot on it, so half the dot hung ABOVE the block
  // entirely. On a paragraph with any leading it read as pointing at the gap
  // rather than at the words.
  //
  // Blake asked whether a fixed nudge was the only option. It is not, and the
  // better answer costs nothing: a range over the block's contents reports one
  // rect per LINE, so the mark centres on the real first line at any font size.
  // Blake, same day, on a multi-line block: "centered on the first line of the
  // block, not centered on the overall block's height" — hence firstLineRect
  // rather than anything derived from blockRect.height. The line-height
  // fallback covers a block whose line boxes cannot be measured, and is capped
  // by the block's own height so a short block cannot push its mark past its
  // own bottom edge.
  function anchorMarkY(blockRect, firstLineRect, lineHeight) {
    if (firstLineRect && firstLineRect.height > 0) {
      return firstLineRect.top + firstLineRect.height / 2;
    }
    const h = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 0;
    const box = Number.isFinite(blockRect.height) && blockRect.height > 0 ? blockRect.height : h;
    const span = h > 0 ? Math.min(h, box) : 0;
    return blockRect.top + span / 2;
  }
  // The chip's floor is the height CSS actually renders it at, and the box is
  // CENTRED on the cluster (Blake, live pass 2026-08-13). It used to floor at
  // one dot (9px) and hang from `top`, while `min-height: 19px` in the sheet
  // stretched the drawn chip DOWNWARD — so a chip whose members share a row
  // sat 5px below the dots either side of it, and anything reasoning about
  // where the chip ends (the fold mark's clearance) was told 9px when 19 were
  // painted. For a cluster with real vertical span nothing moves: the mid
  // point of a span+dotSize box is the same top it always had.
  const GUTTER_CHIP_MIN_HEIGHT = 19; // must match .rv-gt-chip min-height
  function gutterClusterBox(ys, dotSize = GUTTER_DOT_SIZE, minHeight = GUTTER_CHIP_MIN_HEIGHT) {
    const first = ys[0];
    const last = ys[ys.length - 1];
    const height = Math.max(minHeight, last - first + dotSize);
    return { top: (first + last) / 2 - height / 2, height };
  }

  // ---- What the gutter-entry chip says (#269) ------------------------------
  //
  // It used to say "This row · N". "Row" is honest about the MECHANISM —
  // marks within 18px of each other, chained — and wrong about the idea
  // (Blake, 2026-08-13). It is a fact about where things land on screen, not
  // about the document: two comments on different short paragraphs group,
  // two on different lines of one long paragraph do not, and a fold mark's
  // group is a whole section wearing the same chip. Rather than pretend
  // those are one thing, the chip now names WHAT YOU CLICKED.
  //
  //   a single dot   → "This comment"
  //   a cluster chip → "These comments · 7"
  //   a fold mark    → "This section · 7"
  //
  // and when the status/audience lens is hiding some of them, the count
  // becomes a composition — "· 3 of 7" — because the gap between the two
  // numbers IS the explanation for why the list is shorter than the mark
  // implied. `canWiden` is true exactly when there is something to widen to,
  // so the affordance never appears with nothing behind it.
  const ROW_KIND_LABEL = {
    comment: 'This comment',
    cluster: 'These comments',
    section: 'This section',
  };
  function rowChipLabel(rowFilter, shownCount) {
    if (!rowFilter) return null;
    const total = Array.isArray(rowFilter.ids) ? rowFilter.ids.length : 0;
    const shown = Math.max(0, Math.min(Number(shownCount) || 0, total));
    const noun = ROW_KIND_LABEL[rowFilter.kind] || ROW_KIND_LABEL.cluster;
    const hiding = shown < total;
    // A lone comment nobody is hiding needs no arithmetic: "This comment · 1
    // of 1" is noise on a chip whose whole job is to be glanceable.
    const count = hiding ? `${shown} of ${total}` : (total > 1 ? String(total) : '');
    return {
      text: count ? `${noun} · ${count}` : noun,
      canWiden: hiding,
      // The section's own heading is too long for a 336px header, so it rides
      // the tooltip rather than the face.
      title: hiding
        ? `${total} comment${total === 1 ? '' : 's'} here, ${shown} shown under your filters`
          + `${rowFilter.name ? ` — ${rowFilter.name}` : ''}. Click the count to show all ${total}.`
        : `Showing ${total} comment${total === 1 ? '' : 's'}`
          + `${rowFilter.name ? ` in “${rowFilter.name}”` : ''}. Click × to leave.`,
    };
  }

  // ---- The hidden-comment stack at a fold (#267) --------------------------
  //
  // A comment inside a collapsed <details> used to leave the gutter without a
  // trace — no dot, no count, no flag (see the concealment branch in
  // overlay-gutter.js). It now regroups onto the one row of that section you
  // can still see: its <summary>. One mark per fold, carrying the count.
  //
  // The mark is 19px tall like a cluster chip, and STEPS by its own height
  // when it has to yield a row.
  const FOLD_MARK_SIZE = 19;
  // The breathing room between the fold mark and whatever it yields to. Two
  // pixels: they should read as adjacent rows, not as separated ones.
  const FOLD_MARK_GAP = 2;

  // Bucket concealed rows by the fold that conceals them. Each input row is
  // {comment, tier, foldKey, summaryY}; foldKey is whatever the caller uses to
  // identify a fold (the DOM half passes the <details> element itself). Output
  // is one entry per fold, in document order, with the count and the tier most
  // in need of the author. Pure — the input array is not mutated.
  //
  // NESTING: the DOM half resolves each comment to its OUTERMOST closed
  // ancestor, because that is the only one whose summary is still on screen —
  // so a fold inside a fold contributes to the outer mark's count, and the
  // count is transitive by construction rather than by a rule here.
  function groupFoldRows(rows) {
    const byKey = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || row.foldKey === null || row.foldKey === undefined) continue;
      let group = byKey.get(row.foldKey);
      if (!group) {
        group = { foldKey: row.foldKey, y: row.summaryY, members: [], tiers: [] };
        byKey.set(row.foldKey, group);
      }
      group.members.push(row.comment);
      group.tiers.push(row.tier);
    }
    return [...byKey.values()]
      .map((g) => ({
        foldKey: g.foldKey,
        y: g.y,
        members: g.members,
        count: g.members.length,
        tier: dominantTier(g.tiers),
      }))
      .sort((a, b) => a.y - b.y);
  }

  // DECISION 3 (Blake, 2026-08-13): a fold mark NEVER merges into a cluster
  // with a real dot. A comment anchored on the heading itself keeps the
  // summary row — its text is readable, and fusing "one you can read" with
  // "three you cannot" into a single count would lie about what you can
  // reach. The fold mark yields and steps down until it is clear of every
  // occupied row, its own earlier marks included.
  //
  // `occupied` is every mark already drawn, as {center, half} in document
  // coordinates — half being HALF ITS DRAWN HEIGHT, because that is what
  // decides whether two marks touch. A fixed step against a bare row y was
  // not enough (Blake, live pass 2026-08-13): a cluster chip is 19px tall
  // against a dot's 9, so clearing a chip by one dot-row still overlapped it
  // by 5px. The mark now drops to just below whatever it conflicts with, so
  // it sits 16px under a dot and 21px under a chip — as close as each can be
  // without touching, rather than one distance guessed for both.
  //
  // Returns the y the mark should CENTRE on. Pure.
  function foldMarkTop(y, occupied, opts) {
    const taken = Array.isArray(occupied) ? occupied : [];
    const markHalf = (opts && opts.markHalf) || FOLD_MARK_SIZE / 2;
    const gap = (opts && typeof opts.gap === 'number') ? opts.gap : FOLD_MARK_GAP;
    let top = y;
    // Settle: one pass can push the mark into something it had already
    // cleared, so repeat until nothing moves. Bounded against a pathological
    // page rather than trusted to converge.
    for (let guard = 0; guard < 12; guard += 1) {
      let moved = false;
      for (const o of taken) {
        if (!o || typeof o.center !== 'number') continue;
        const need = markHalf + (typeof o.half === 'number' ? o.half : 0) + gap;
        if (Math.abs(top - o.center) < need) { top = o.center + need; moved = true; }
      }
      if (!moved) break;
    }
    return top;
  }

  // Off-screen counters (#224): how many rows sit above the viewport's top
  // edge, and how many start beyond its bottom edge. Pure — the counters are
  // the one thing a document-coordinate gutter cannot say by itself.
  function gutterEdgeCounts(ys, scrollY, viewportH) {
    let above = 0;
    let below = 0;
    for (const y of Array.isArray(ys) ? ys : []) {
      if (y < scrollY) above += 1;
      else if (y > scrollY + viewportH) below += 1;
    }
    return { above, below };
  }

  // A small chip naming an AGENT author. Returns null for human or
  // unattributed authors (they wear no chip — WP1). `item` is any object
  // carrying flat {creator, agentName} (a comment or a reply); a run's nested
  // `run.actor` has the same shape, so pass it directly.
  function authorChip(item) {
    if (!item || item.creator !== 'agent') return null;
    const name = typeof item.agentName === 'string' && item.agentName.length > 0
      ? item.agentName : 'agent';
    const chip = el('span', 'rv-chip rv-chip-agent rv-author-chip', name);
    chip.title = `Authored by ${name}`;
    return chip;
  }

  // A small chip naming the scope gate's outcome on a run (#236). Without it
  // a run the gate stopped and a human then allowed reads identically to one
  // that never touched the gate at all — the run record now carries
  // `scopeGate` (runner/lib/scope.mjs's gateRecord, always present once a
  // dry-run happened) plus `status`/`lane` for the declined case, and this is
  // the one place that turns those into what the panel shows. Returns null
  // for the common case — a run the gate never paused — which is the correct
  // rendering (no badge), not a missing one.
  function scopeGateChip(run) {
    if (!run || typeof run !== 'object') return null;
    if (run.status === 'declined' || run.lane === 'declined') {
      const chip = el('span', 'rv-chip rv-chip-gate-declined', 'scope gate: declined');
      chip.title = 'The author was asked to allow a wider-than-expected edit and declined it.';
      return chip;
    }
    if (run.scopeGate && run.scopeGate.fired === true) {
      const chip = el('span', 'rv-chip rv-chip-gate-allowed', 'scope gate: allowed by you');
      chip.title = 'This edit reached beyond the commented section (or the page theme) and the author allowed it.';
      return chip;
    }
    return null;
  }

  window.__rv.model = {
    DECIDED, FILTERS, AUD_FILTERS, ACTIONED_ORDER,
    inAiBatch, passesAxisFilters, passesFilters,
    HANDLE_LEN, HANDLE_EXCLUDED,
    foldSearchText, handleShape, prepareSearch, searchableText,
    isHandleMatch, matchesSearchText, matchesSearch, searchReachedPast, searchHits,
    runLogFileMeta, groupRunLogFiles, sectionKey, groupComments, authorChip, scopeGateChip,
    sortByDocumentOrder,
    GUTTER_CLUSTER_PX, GUTTER_DOT_SIZE,
    gutterTier, dominantTier, clusterGutterRows, gutterDotTop, anchorMarkY, gutterClusterBox,
    gutterEdgeCounts,
    FOLD_MARK_SIZE, FOLD_MARK_GAP, GUTTER_CHIP_MIN_HEIGHT,
    groupFoldRows, foldMarkTop, rowChipLabel,
  };
})();
