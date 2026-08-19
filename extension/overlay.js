// overlay.js — the overlay UI: the panel shell, the runner API client, run
// polling, send → run → outcome, the run-status strip, the card list, and the
// selection → comment popover. It is the last and largest file in the overlay
// SET, and the only one that talks to the network.
//
// THE FILE SET (loaded in this order by manifest.json — the order is
// load-bearing and pinned by test/runner/extension-ui.test.mjs):
//   refraction.js       liquid-glass lensing, mounted on first paint
//   overlay-util.js     el/root/truncate/formatCost and friends
//   overlay-model.js    pure grouping + filtering logic (node-testable)
//   overlay-theme.js    Auto/Light/Dark footer control
//   overlay-anchor.js   locating a comment's target in the document
//   overlay-runlog.js   the trace-bundle viewer (factory)
//   overlay-scope.js    the scope-confirmation modal (factory)
//   overlay.js          this file — state, network, panel, cards, popover
//   content.js          runner detection; calls window.__redline
//
// They are plain content scripts, not ES modules: Chrome loads a content
// script as a classic script, so an import would resolve against the page
// being reviewed rather than the extension. They cooperate through the shared
// window.__rv namespace instead. No build step (CLAUDE.md), by design.
//
// Send All (contract amendment 2026-07-22 in design/07-api-contract.md):
// when 2+ OPEN comments pass the active filter, the panel header shows
// "Send all (N)", which POSTs exactly those ids as ONE batch run
// ({commentIds}) — one run record, one reload, one undo. The filter doubles
// as the batch selector; scope is decided here, client-side.
//
// THE CARD is four zones — head (who + controls + quote), ask (the comment),
// history (every reply and decision, oldest first), now (what you can do) —
// with one gap vocabulary: margin-top only, 4 / 8 / 14, and 14 exactly three
// times. See card() below and the matching block in overlay.css. Every card is
// BUILT in full (#265); collapsed, CSS shows zones 1-2 plus a one-line summary
// while zones 3-4 sit in the .rv-card-more well at 0fr. Clicking flips the
// class pair on the existing node — the 280ms expand transition survives
// because nothing rebuilds — and reveals the anchor. Exactly one card is
// expanded at a time. Filter chips (Active | Needs review | Resolved | All) sit in the
// panel header; Active is the default and survives post-run reloads via
// sessionStorage page state.
//
// Exposes window.__redline = { init(runner), hint() } for content.js (which
// runs after this file and owns detection). All DOM lives under #rv-root and
// every class is rv- namespaced so document styles never collide. The ONLY
// document-level styling is html.rv-panel-open (docked-panel reflow).

(() => {
  'use strict';

  const CONTEXT_CHARS = 30;
  const MAX_QUOTE_CHARS = 2000;
  // #194: the FIXED machine-readable token a rejection reply leads with.
  // Watchers key on this exact string — never on free-text parsing. The rest
  // of the reply body is the author's own words on what is wrong.
  const REJECT_MARKER = '[[redline:reject]]';
  const POPOVER_WIDTH = 312;
  const AUDIENCE_KEY = 'rv-audience'; // localStorage: sticky new-comment audience
  const POLL_MS = 1000;
  // Idle cross-tab watch (#106): slow on purpose — it only has to make a page
  // locked by ANOTHER tab visible within a few seconds.
  const WATCH_MS = 4000;
  // Backstop cadence once the SSE stream is confirmed live (#162).
  const WATCH_IDLE_MS = 30000;
  const FLASH_MS = 1200; // hold ~300ms, fade ~900ms (see .rv-flash transition)
  // Stable storage key — pinned by test/runner/extension-ui.test.mjs.
  const STATE_KEY_PREFIX = 'rv-state:'; // sessionStorage: per-page reload state
  // #268: the panel search is review state, like the section folds — a poll
  // re-render, a run reload or a tab revisit must not silently drop what you
  // narrowed the list to.
  const SEARCH_KEY_PREFIX = 'rv-search:'; // sessionStorage: per-page search query
  // Offline comment buffer (#202). localStorage, not sessionStorage: losing
  // writing because a tab closed is exactly the failure this exists to stop.
  const BUFFER_KEY_PREFIX = 'rv-buffer:'; // localStorage: unsaved comments per page
  const BUFFER_MAX = 50; // refuse past this rather than silently dropping the oldest
  const DOWN_TICK_MS = 1000; // how often the "retrying Ns" readout advances

  // ---- the page-level Undo is HIDDEN (#311) ---------------------------------
  // The control works; what it cannot do is say WHICH run it will revert. It is
  // last-run-wins, and under a live watcher the last run changes underneath you:
  // read the page, decide "undo that", and by the click the watcher has landed
  // another run on a different comment. You would revert that one instead, with
  // nothing on screen naming it.
  //
  // The runner already has the honest verbs — POST /api/undo takes `runId` for a
  // targeted revert of a NAMED run (#232, refuses with reason:'conflicted' when
  // later edits touched those blocks) and `expectRunId` to refuse when the top
  // of the stack is not the run you meant (#164). The overlay button sends
  // NEITHER. So this is a UI gap, not an engine one, and the fix is a per-comment
  // affordance on the card that actioned it — not a better page-level button.
  //
  // Flip to true to bring the old control back verbatim; nothing else changes.
  const UNDO_UI_ENABLED = false;

  // ---- the human's block lease (#189) ---------------------------------------
  //
  // Until this existed the human side of the lease ledger was empty: opening
  // the composer or the in-place editor claimed NOTHING, so an agent could
  // rewrite the paragraph you were mid-sentence in and the ledger would call it
  // legal. Observed live on 2026-07-31 in the other direction too — Send now
  // was pressed on a comment a watching session was already researching, both
  // did the work, the paid run won at 5.6¢ and declined, and the session's
  // validated zero-cost edit was thrown away. Neither party could see the other.
  //
  // THE TTL PROBLEM. The runner clamps a lease to five minutes
  // (LEASE_MAX_TTL_MS in runner/lib/leases.mjs) and a person can spend ten
  // minutes writing a comment. Raising the ceiling is the wrong fix twice over:
  // it is runner code the overlay does not own, and a very long TTL is exactly
  // how a closed laptop lid holds a paragraph hostage for an hour. So the lease
  // is SHORT and RENEWED while the composer is genuinely open, and dies with
  // the tab. That keeps decision 7 — no countdown the human can see — while
  // making abandonment self-healing.
  const LEASE_TTL_MS = 120000;   // the crash backstop; never rendered, never a timer
  const LEASE_RENEW_MS = 45000;  // comfortably inside it, so one lost renewal is survivable

  // Pulled out of the shared namespace once, here, so everything below reads
  // exactly as it did when this was a single file.
  const {
    el, root, truncate, formatCost, isSubmitShortcut, shouldClampQuote,
    anchorBoxRect, QUOTE_CLAMP_CHARS,
    renderMarkdown, stripMarkdown, foldState,
  } = window.__rv.util;

  // Expanded-card prose renders its markdown (#246); one helper so every
  // surface builds the same way. Never innerHTML — see renderMarkdown.
  function mdBlock(className, text) {
    const node = el('div', className);
    node.appendChild(renderMarkdown(text));
    return node;
  }
  const {
    FILTERS, AUD_FILTERS, ACTIONED_ORDER, RUNLOG_GROUP_ORDER,
    runLogFileMeta, groupRunLogFiles, sectionKey, groupComments, authorChip, scopeGateChip,
    sortByDocumentOrder, inAiBatch, rowChipLabel,
    passesAxisFilters: modelPassesAxisFilters,
    passesFilters: modelPassesFilters,
    prepareSearch, searchReachedPast, searchHits, isHandleMatch,
  } = window.__rv.model;
  const { storedTheme, applyTheme, themeFooter } = window.__rv.theme;
  const { locateAnchor } = window.__rv.anchor;
  const { createRunLog, createScopeDialog, createGutter } = window.__rv;

  // Selection-pill icons (#150). Built with createElementNS, never innerHTML
  // (the overlay bans writing markup into the DOM). Paths mirror the mock.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_PATHS = {
    copy: [{ rect: { x: 9, y: 9, width: 11, height: 11, rx: 2 } },
      'M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1'],
    comment: ['M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.6-.8L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z'],
    edit: ['M4 20h4L20 8a2.83 2.83 0 0 0-4-4L4 16v4z', 'M14.5 5.5l4 4'],
  };
  function svgNode(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }
  function svgIcon(name) {
    const svg = svgNode('svg', {
      viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
      'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
    for (const part of ICON_PATHS[name]) {
      if (typeof part === 'string') svg.appendChild(svgNode('path', { d: part }));
      else svg.appendChild(svgNode('rect', part.rect));
    }
    return svg;
  }

  // A coarse "N min/h/d ago" for reply timestamps (#153). '' when unparseable.
  function relativeTime(iso) {
    if (typeof iso !== 'string' || !iso) return '';
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 45) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} h ago`;
    return `${Math.round(hrs / 24)} d ago`;
  }

  // A local HH:MM for a history stamp (#199). The card's ordering rule is
  // "read the who · when stamps down the card and check they ascend", and a
  // relative time ("2 h ago") cannot be read that way. '' when unparseable.
  function clockTime(iso, now = new Date()) {
    if (typeof iso !== 'string' || !iso) return '';
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return '';
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    // A bare clock time only means something today. Older stamps carry their
    // date (Blake, acceptance 2026-08-12); the hover title still has the
    // full ISO + relative form either way.
    const sameDay = t.getFullYear() === now.getFullYear()
      && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
    if (sameDay) return hm;
    const day = t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${day} ${hm}`;
  }

  // ---- a citable comment reference (#203) ---------------------------------
  //
  // `c-5999e7a0980f` is unusable in conversation: nobody can hold it in their
  // head, match it to a card, or say it out loud, so any discussion ABOUT a
  // review has no way to point at a comment. This derives a four-character
  // handle from the id, over an alphabet with no 0/1/i/l/o/u, so it survives
  // being read aloud and typed back.
  //
  // THAT EXCLUSION LIST IS LOAD-BEARING, and this note used to get it wrong:
  // it said "no 0/O/1/l/i", omitting `o` and `u`. `examples/watch-collaborate.mjs`
  // and `docs/AGENT-CONTRACT.md` carry the correct list, but an agent
  // reimplementing the handle from THIS note mints a different alphabet and
  // therefore a different handle — which is exactly what happened: every
  // handle agent sessions cited up to 2026-08-13 (bwau, cubg, kt3p, 6ggn,
  // 9aqs, m5hr, cch4, a6ab) matched no comment on the page it was written
  // about, and two of them contain a `u` this alphabet cannot emit. The three
  // copies are pinned against each other by
  // test/runner/panel-search.test.mjs (#268 DECISION 8a).
  //
  // DERIVED, never stored, and that is the whole design. It needs no schema
  // change; it cannot go stale mid-conversation, because it depends on nothing
  // but the id; it survives a document rewrite and a re-anchor, because the id
  // does; and any other client can compute the same handle from the same
  // comment list without being told the mapping. FNV-1a because the
  // requirement is spread, not secrecy.
  const REF_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
  const REF_LEN = 4; // 30^4 = 810k — a collision needs ~1000 comments on one page
  function shortRef(id) {
    if (typeof id !== 'string' || !id) return '';
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i += 1) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    let out = '';
    for (let i = 0; i < REF_LEN; i += 1) {
      out += REF_ALPHABET[h % REF_ALPHABET.length];
      h = Math.floor(h / REF_ALPHABET.length);
    }
    return out;
  }

  // ---- the card's history, as a time series (#199) ------------------------
  //
  // The sort key for an entry whose timestamp is unknown. A decision recovered
  // from `comment.resolution` has no time of its own — the field carries none —
  // and it is by construction the LATEST decision, so it sinks to the bottom
  // rather than floating to the top the way an empty string would.
  const NO_TIME = '\uffff';

  /**
   * One comment's history — every reply, every decision, and the re-open flips,
   * oldest first.
   *
   * This is the overlay's copy of the ordering `commentThread()` in
   * runner/lib/api.mjs has built for the AGENT prompt since #108. The agent has
   * been shown ask → replies → decisions interleaved by timestamp; the human
   * was shown "all replies, then the one decision", which puts a decline below
   * the reply that conceded to it and hides every decision but the last.
   *
   * Decisions come from `runs`, not from `comment.resolution`: resolution is a
   * single slot the next run overwrites, so a card that was declined, argued
   * with and then addressed shows only the addressing while runs[] keeps both.
   * When no run record covers the current resolution — the runner does not yet
   * put runs[] on /api/comments — the resolution stands in, so the card never
   * shows LESS than it does today.
   *
   * Pure; `runs` may be empty. Exposed on window.__rvTest.
   */
  function commentHistory(comment, runs = []) {
    const out = [];
    const id = comment ? comment.id : undefined;

    for (const reply of Array.isArray(comment && comment.replies) ? comment.replies : []) {
      const at = typeof reply.createdAt === 'string' ? reply.createdAt : '';
      const agent = reply.creator === 'agent';
      out.push({
        kind: 'reply',
        at,
        sort: at || NO_TIME,
        agent,
        who: agent ? (reply.agentName || 'agent') : 'user',
        body: reply.body,
      });
    }

    const covered = new Set();
    for (const run of Array.isArray(runs) ? runs : []) {
      const covers = Array.isArray(run.commentIds)
        ? run.commentIds.includes(id)
        : run.commentId === id;
      if (!covers) continue;
      for (const d of Array.isArray(run.decisions) ? run.decisions : []) {
        if (d.id !== id) continue;
        covered.add(run.runId);
        const at = typeof run.createdAt === 'string' ? run.createdAt : '';
        out.push({
          kind: 'decision',
          at,
          sort: at || NO_TIME,
          decision: d.decision || '',
          summary: typeof d.summary === 'string' ? d.summary : '',
          note: typeof d.note === 'string' ? d.note : '',
          runId: typeof run.runId === 'string' ? run.runId : '',
          model: run.model || run.archetype || '',
          undone: run.status === 'undone',
          // #236: carried straight through so the rendered row can tell a run
          // the gate stopped and a human allowed apart from one that never
          // touched it — same field runner/lib/scope.mjs's gateRecord writes.
          scopeGate: run.scopeGate ?? null,
        });
      }
    }

    // #236: a declined scope confirmation resolves nothing — recordDeclinedRun
    // leaves decisions empty by construction (#128) — so it produces no entry
    // above, yet the agent call it discarded was real, billed spend and the
    // author's own "no" is part of this thread's history. commentId (never
    // commentIds: the gate only ever pauses a single-comment run) ties it
    // back to the comment that asked.
    for (const run of Array.isArray(runs) ? runs : []) {
      if (run.status !== 'declined' || run.commentId !== id) continue;
      const at = typeof run.createdAt === 'string' ? run.createdAt : '';
      out.push({
        kind: 'gate-declined',
        at,
        sort: at || NO_TIME,
        runId: typeof run.runId === 'string' ? run.runId : '',
      });
    }

    const res = comment ? comment.resolution : null;
    if (res && typeof res.summary === 'string' && !covered.has(res.runId)) {
      out.push({
        kind: 'decision',
        at: '',
        sort: NO_TIME,
        decision: res.decision || (comment.status === 'failed' ? 'failed' : ''),
        summary: res.summary,
        note: typeof res.note === 'string' ? res.note : '',
        runId: typeof res.runId === 'string' ? res.runId : '',
        model: '',
        undone: false,
      });
    }

    // Stable — V8's sort is, so same-stamp entries keep insertion order and
    // unknown-time entries stay together at the bottom.
    out.sort((a, b) => (a.sort < b.sort ? -1 : (a.sort > b.sort ? 1 : 0)));

    // #198: a human reply re-opens a settled comment, from any state. Record
    // the flip WHERE IT HAPPENED — right after the first human reply following
    // the last decision — so an open comment sitting under an addressed
    // decision explains itself instead of looking like a random retraction.
    if (comment && comment.status === 'open') {
      let lastDecision = -1;
      for (let i = 0; i < out.length; i += 1) if (out[i].kind === 'decision') lastDecision = i;
      if (lastDecision >= 0) {
        const at = out.findIndex((e, i) => i > lastDecision && e.kind === 'reply' && !e.agent);
        if (at >= 0) {
          out.splice(at + 1, 0, {
            kind: 'event',
            event: 'reopened',
            at: out[at].at,
            sort: out[at].sort,
            text: 'Re-opened by a user reply',
          });
        }
      }
    }
    return out;
  }

  // "Has anything happened here?" — the thread count on the card face (#201).
  // Counts turns somebody TOOK; a re-open is something that merely happened.
  function threadCount(history) {
    return (history || []).filter((e) => e.kind === 'reply' || e.kind === 'decision').length;
  }

  // The status word the card face carries, or null when there is nothing to
  // say (#201). 'open' is the quiet default — unless a decision came first, in
  // which case the comment came BACK, and that is worth a word.
  function faceStatus(comment, history) {
    const status = (comment && comment.status) || 'open';
    if (status !== 'open') return status;
    return (history || []).some((e) => e.kind === 'decision') ? 're-opened' : null;
  }

  // The one clamped line a COLLAPSED card shows under the ask (#201): the last
  // thing anybody said. A bare count only tells you to go and look.
  function lastSaid(history) {
    for (let i = (history || []).length - 1; i >= 0; i -= 1) {
      const e = history[i];
      if (e.kind === 'reply') return { agent: e.agent, who: `${e.who} replied`, text: e.body };
      if (e.kind === 'decision') {
        return { agent: true, who: `${e.model || 'the agent'} ${e.decision || 'ran'}`, text: e.summary };
      }
    }
    return null;
  }

  function init(runner) {
    const host = root();
    const page = window.location.pathname;
    applyTheme(host, storedTheme());

    let comments = [];
    // The page's run records, for the card history (#199). /api/comments
    // carries them when the runner is new enough; see pageRuns() for what
    // stands in until then.
    let runRecords = [];
    let statusInfo = null; // last GET /api/status body
    let runUi = null; // null | {phase: running|done|undone|error, ...}
    let pollTimer = null;
    let watchTimer = null;
    let lastDocSig = null;  // last seen run signature — the document-changed marker
    let evtSource = null;   // live SSE stream (#162)
    let streamLive = false; // stream confirmed up — the poll backs off when true
    // Runner liveness (#196 slice 1) and the offline comment buffer (#202).
    // runnerDown is set by refresh() failing, cleared by it succeeding; the
    // clearing edge is what triggers the replay.
    let runnerDown = false;
    let downSince = 0;      // ms at the START of this outage — drives "retrying Ns"
    let downTimer = null;   // 1 s tick, alive only while down
    let bufferedComments = []; // unsaved comments for THIS page, from localStorage
    let replay = null;      // {total, done} while flushing, else null
    let replayReport = null; // {total, failed} once a flush finishes with failures
    let replayDismissed = false;
    let filter = 'active'; // status FILTERS key; persisted across doc reloads
    let audienceFilter = 'all'; // #154: audience axis (all/ai/note), composes with status
    // #222: the third filter axis — "just this row of the gutter". A fixed id
    // set captured when a tall cluster (>4) opens the panel; survives poll
    // re-renders because it lives here, not in the DOM. Entering it resets
    // the other two axes to All (the promise is "exactly that row's
    // comments"); afterwards the axes compose by INTERSECTION. The header
    // chip is the visible, reversible way out.
    let rowFilter = null; // { ids: [commentId, …] } or null
    // #268: the fourth axis. The raw query lives here rather than being read
    // off the input, because everything that reads it (render, the card
    // highlighter, the section folds) must agree with what was last TYPED even
    // mid-poll — and because it is review state, so it is persisted below.
    let searchQuery = '';
    let searchPrepared = prepareSearch('', shortRef); // rebuilt whenever the query changes
    let expandedId = null; // comment id of the ONE expanded card, or null
    // #265: the expanded card's live DOM node, so the click toggle can flip
    // classes on the EXISTING cards instead of rebuilding — a rebuild kills
    // the in-flight expand/collapse transition. render() re-sets it each pass.
    let expandedCardEl = null;
    // Keyboard surface (#149): the cheat sheet, and the ↑/↓ cursor. cycledId is
    // the comment the arrows have landed on — a NAVIGATION cursor only, never a
    // resolve target (A resolves the card you OPENED, expandedId). cycleOrder is
    // the flat visible order render() rebuilds each pass.
    let cheatEl = null;
    let cycleOrder = [];
    let cycledId = null;
    // Reply drafts, keyed by comment id — an OPEN reply composer and whatever
    // has been typed into it, held outside the card so it survives a redraw.
    // render() rebuilds the card list wholesale, so the textarea being typed
    // into is a different element on the other side of every poll; without
    // this, the words in it went with the old one. Losing typed text is the
    // same class of silent loss the offline buffer exists to prevent, so it is
    // held the same way: outside the thing that gets thrown away.
    // Present-but-empty means "open"; absent means "closed".
    let replyDrafts = new Map();
    // Scope confirmation (#107): a page-locking modal over the document, not a
    // panel strip. scopeScrim is the mounted modal (or null); scopeDismissed
    // means the author hid it but the lock still holds (the panel shows a bar).
    let scopeScrim = null;
    let scopeDismissed = false;
    // Direct edit (#112): a pencil appears over any instrumented block on hover
    // in review mode; clicking it makes the block editable IN PLACE
    // (contenteditable) — no floating panel, no raw-markup textarea. The runner
    // stays the only writer (save POSTs /api/edit). Declared here so
    // syncChrome's init-time call to hideEditPencil doesn't hit a TDZ.
    let editPencil = null;    // the shared hover pencil (created lazily)
    let railEl = null;        // #223: the gutter rail carrying comment + pencil
    let pencilHeldTitle = null; // the "…is writing here" line inside its capsule
    let pencilTakeBack = null;  // the break-glass force-release inside it
    let pencilBlockId = null; // data-rev id the pencil currently targets
    let pencilHideTimer = null; // #131: grace period before the pencil goes away
    let editing = null;       // { el, blockId, originalHTML, originalNodes } while editing
    let savingInline = false; // guards blur/Enter double-commit
    // Phase 4 (#155): mode and sidecar are INDEPENDENT axes, unfused.
    //   redline     — View only ↔ Redline active. Arming: only while redline is
    //                 on is the selection listener armed and the hover pencil
    //                 live; off, the page selects/copies/clicks natively (WP3).
    //   sidecarOpen — the comments panel is shown. It DOCKS (reflows the page
    //                 into a narrower viewport) only when open AND redline is on;
    //                 a closed or view-only sidecar reflows nothing.
    // Panel visibility is the derived `redline && sidecarOpen`; selection and
    // hover are armed by `redline` alone, so you can comment with the sidecar
    // closed. syncChrome() applies both from the two flags.
    let redline = false;
    let sidecarOpen = true;
    // #161: the comment gutter. Declared here so syncChrome() can check it
    // without hitting a TDZ — it is assigned later, after createGutter is
    // available and the host element is ready.
    let gutter = null;
    // Comment-popover state (declared here so syncChrome → hidePopover at
    // init time doesn't reference them in their temporal dead zone).
    let popover = null;
    let pendingAnchor = null;
    let pendingHl = [];
    // Selection pill (#150): the icons-only capsule raised on a selection (or a
    // pinnable non-text element), and its hover tooltip. pillCtx carries the
    // anchor + rect + single-block flag the actions need.
    let selPill = null;
    let selTip = null;
    let pillCtx = null;
    // #214: the one refusal capsule, drawn into #rv-root rather than nested in
    // the control it explains. One at a time, like selTip.
    let capsuleEl = null;
    // Re-anchor an orphaned comment (#157): reanchorId is the comment awaiting a
    // manual pick — while set, the next document selection re-attaches it instead
    // of raising the pill. reanchorBar is the "select the text…" prompt.
    let reanchorId = null;
    let reanchorBar = null;
    // Sticky new-comment audience (#151): 'ai' → the comment goes to the agent
    // (default), 'note' → a note for people. Persists across reloads; the
    // composer switch and the sidecar audience row (#154) both flip it.
    let audience = 'ai';
    try { if (localStorage.getItem(AUDIENCE_KEY) === 'note') audience = 'note'; } catch { /* private mode */ }

    // ---- co-editing state (#189, #191, #196 slices 2-3) --------------------
    // tabSession is this TAB's identity in the lease ledger. The runner asks
    // every lease for a `sessionId` and validates nothing about it (see
    // docs/AGENT-CONTRACT.md, "Nothing checks that the sessionId on a lease is
    // a live claim"), so the browser mints its own rather than claiming a
    // watcher slot it is not entitled to — a human in a tab is not a session
    // under #187, and taking a claim would evict the agent it means to
    // cooperate with.
    const tabSession = `human-${Math.random().toString(36).slice(2, 10)}`;
    let heldLease = null;    // {leaseId, blockId, expiresAt} — the block THIS tab holds
    let leaseTimer = null;   // the renew interval, alive only while a lease is held
    let leaseRefused = null; // {blockId} — an acquire the ledger refused, for the pencil
    let leaseLost = null;    // {blockId} — a renewal that could not be recovered
    let leaseHoverId = null; // the held block the pointer is on (veil + tag on approach)
    let composerLeasePaint = null; // redraws the open composer's lease line
    // The positioned boxes drawn over held blocks, and the scroll/resize
    // listeners that keep them on their text. Declared with the rest of the
    // state because syncChrome() runs at init time, long before the rendering
    // section below, and a `let` down there would be in its temporal dead zone.
    let leaseBoxes = [];
    let leaseListening = false;
    let leaseRaf = 0;
    // #210: a temporary refusal capsule shown over a block when an edit was
    // refused because someone else holds the lease. Distinct from the hover
    // veil — the veil is ambient, this is a response to an action.
    let leaseRefusalBox = null;
    let leaseRefusalTimer = null;
    // Presence (#187 read side). sessionSeen remembers the watcher we last saw
    // so a DEPARTURE can name it; a claim that merely lapses is still in
    // statusInfo.session, and a released one is not, and both must read the
    // same to the author.
    let sessionSeen = null;      // {agentName} — the last watcher this tab observed
    let sessionGoneDismissed = false;
    let presenceTimer = null;    // fires at expiresAt, so a lapse needs no poll
    let holdBusy = false;        // a /api/hold write in flight

    // ---- reload state (saved before location.reload after doc changes) ----
    let saved = null;
    try {
      const raw = sessionStorage.getItem(STATE_KEY_PREFIX + page);
      if (raw) {
        sessionStorage.removeItem(STATE_KEY_PREFIX + page);
        saved = JSON.parse(raw);
      }
    } catch { /* state restore is best-effort */ }

    if (saved && FILTERS.some(([key]) => key === saved.filter)) filter = saved.filter;
    if (saved && AUD_FILTERS.some(([key]) => key === saved.audienceFilter)) {
      audienceFilter = saved.audienceFilter;
    }
    // A row filter is a fixed id set; ids that no longer exist simply match
    // nothing, so a stale one narrows to an empty list rather than throwing.
    // Shape-checked because the blob is user-writable storage.
    if (saved && saved.rowFilter && Array.isArray(saved.rowFilter.ids)) {
      rowFilter = {
        ids: saved.rowFilter.ids.filter((id) => typeof id === 'string'),
        kind: saved.rowFilter.kind,
        name: typeof saved.rowFilter.name === 'string' ? saved.rowFilter.name : '',
      };
    }

    // ---- panel shell ----
    const panel = el('div', 'rv-panel rv-hidden');
    const header = el('div', 'rv-panel-header');
    const headerTop = el('div', 'rv-header-top');
    const headerTitle = el('span', 'rv-panel-title', 'Review');
    // Undo, wrapped the same way Send all is. It is a write like any other and
    // was the last control on the panel that refused without saying why —
    // worse, it did not refuse at all: it fired, failed, and reported "undo
    // failed — is the runner still running?" after the round trip.
    const undoWrap = el('span', 'rv-explain rv-hidden');
    const undoBtn = el('button', 'rv-btn rv-undo', 'Undo');
    undoBtn.type = 'button';
    undoBtn.title = 'Undo the last run';
    undoBtn.addEventListener('click', () => undoLastRun(undoBtn));
    if (!UNDO_UI_ENABLED) undoWrap.classList.add('rv-undo-off');
    undoWrap.appendChild(undoBtn);
    // #214: the reason rides on the wrap as data, and the capsule itself is
    // built on approach into #rv-root. The sub is dropped: "only the runner
    // can undo" is what the title already says.
    setCapsuleWhy(undoWrap, 'Needs the runner');
    armCapsule(undoWrap, undoBtn);
    // Send all (#154): ALWAYS visible, disabled at zero, live from one — the
    // open AI-directed comments under the current filter, sent as one batch.
    // Send all, wrapped so it can explain itself. A greyed control that will
    // not say why is a dead end (#196): the capsule appears BELOW it on
    // approach, one sentence for the cause and one for the reassurance, and
    // only while the control is actually refused.
    const sendAllWrap = el('span', 'rv-explain');
    const sendAllBtn = el('button', 'rv-btn rv-btn-primary rv-send-all', 'Send all');
    sendAllBtn.type = 'button';
    sendAllWrap.appendChild(sendAllBtn);
    setCapsuleWhy(sendAllWrap, 'Needs the runner');
    armCapsule(sendAllWrap, sendAllBtn);
    sendAllBtn.addEventListener('click', () => {
      const ids = sendableComments().map((c) => c.id);
      if (ids.length >= 1 && !isRunning()) startRun(ids);
    });
    const closeBtn = el('button', 'rv-icon-btn', '×');
    closeBtn.type = 'button';
    closeBtn.title = 'Close the sidecar ( ] )';
    closeBtn.setAttribute('aria-label', 'Close the sidecar');
    closeBtn.addEventListener('click', () => setSidecar(false));
    const headerBtns = el('div', 'rv-header-btns');
    headerBtns.append(sendAllWrap, undoWrap, closeBtn);
    // #269 (Blake, 2026-08-13): the gutter-entry chip rides the TITLE line and
    // takes the count's slot while it is up — the placement that costs the
    // header no extra height. It is the only visible sign a gutter entry is
    // narrowing the list, and the only control that leaves one, so it is not
    // optional chrome. Two targets: the label widens (clearing the lens that
    // is hiding members), the × leaves.
    const rowChip = el('span', 'rv-rowchip rv-hidden');
    const rowChipLbl = el('button', 'rv-rowchip-label');
    rowChipLbl.type = 'button';
    const rowChipX = el('button', 'rv-rowchip-x', '×');
    rowChipX.type = 'button';
    rowChipX.title = 'Leave this selection';
    rowChipX.addEventListener('click', (e) => {
      e.stopPropagation();
      rowFilter = null;
      render();
    });
    rowChipLbl.addEventListener('click', (e) => {
      e.stopPropagation();
      // Widen: drop the axes hiding members, keep the selection and any
      // search. Inert when nothing is hidden — render() disables it there.
      if (rowChipLbl.disabled) return;
      filter = 'all';
      audienceFilter = 'all';
      render();
    });
    rowChip.append(rowChipLbl, rowChipX);
    headerTop.appendChild(headerTitle);
    headerTop.appendChild(rowChip);
    headerTop.appendChild(headerBtns);
    header.appendChild(headerTop);

    // Audience state row (#154): what new comments will be, with a Switch that
    // flips the sticky audience (the same state as the composer switch).
    const audState = el('div', 'rv-audience-state');
    header.appendChild(audState);

    // Filters (#154): two dropdowns on one line — status × audience. Separate
    // axes that COMPOSE rather than replacing each other. Options + counts are
    // filled by render().
    const filterRow = el('div', 'rv-filters');
    const statusSel = el('select', 'rv-filter-sel');
    statusSel.setAttribute('aria-label', 'Filter by status');
    statusSel.addEventListener('change', () => { filter = statusSel.value; render(); });
    const audSel = el('select', 'rv-filter-sel');
    audSel.setAttribute('aria-label', 'Filter by audience');
    audSel.addEventListener('change', () => { audienceFilter = audSel.value; render(); });
    filterRow.append(statusSel, audSel);
    header.appendChild(filterRow);

    // Search (#268), on its own row under the dropdowns — the mock draws it
    // there, and a fifth control on the filter row is what already squeezed
    // the row chip out of sight (see .rv-rowchip in the sheet).
    //
    // The header is built ONCE here and render() never rebuilds it, so this
    // input keeps its focus and caret through every poll re-render for free.
    // That is the whole reason it lives up here rather than in the card list.
    const searchRow = el('div', 'rv-filters rv-searchrow');
    const searchBox = el('label', 'rv-searchbox');
    searchBox.appendChild(el('span', 'rv-search-mag', '⌕'));
    const searchInput = el('input', 'rv-search-input');
    searchInput.type = 'text';
    searchInput.setAttribute('placeholder', 'Search comments or type a handle');
    searchInput.setAttribute('aria-label', 'Search comments or type a four-character handle');
    const searchClear = el('button', 'rv-search-clear rv-hidden', '✕');
    searchClear.type = 'button';
    searchClear.title = 'Clear the search';
    searchClear.setAttribute('aria-label', 'Clear the search');
    searchBox.append(searchInput, searchClear);
    searchRow.appendChild(searchBox);
    header.appendChild(searchRow);
    // The two things the search says about itself, in one slot below the box:
    // "that is not a valid handle" (D8a) and "showing it past your Active
    // filter" (D8). Only ever one at a time — a handle that reached past the
    // lens was a valid handle by definition.
    const searchNote = el('div', 'rv-search-note rv-hidden');
    header.appendChild(searchNote);

    function saveSearch() {
      try {
        if (searchQuery) sessionStorage.setItem(SEARCH_KEY_PREFIX + page, JSON.stringify(searchQuery));
        else sessionStorage.removeItem(SEARCH_KEY_PREFIX + page);
      } catch { /* narrowing the list is worth losing on a reload, not worth throwing over */ }
    }
    function setSearch(value, { fromInput = false } = {}) {
      searchQuery = String(value ?? '');
      searchPrepared = prepareSearch(searchQuery, shortRef);
      if (!fromInput) searchInput.value = searchQuery;
      saveSearch();
      render();
    }
    searchInput.addEventListener('input', () => setSearch(searchInput.value, { fromInput: true }));
    searchClear.addEventListener('click', () => { setSearch(''); searchInput.focus(); });
    // D17: Escape clears the SEARCH only while focus is in the box. It never
    // reaches the global Escape cascade anyway — #rv-root swallows keys typed
    // in a field — so this is the box's own key, not a competitor for it.
    searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (searchQuery !== '') setSearch('');
    });
    try {
      const rawSearch = sessionStorage.getItem(SEARCH_KEY_PREFIX + page);
      const parsed = rawSearch ? JSON.parse(rawSearch) : null;
      if (typeof parsed === 'string' && parsed) {
        searchQuery = parsed;
        searchPrepared = prepareSearch(searchQuery, shortRef);
        searchInput.value = searchQuery;
      }
    } catch { /* fresh state */ }
    if (saved && typeof saved.search === 'string' && saved.search) {
      searchQuery = saved.search;
      searchPrepared = prepareSearch(searchQuery, shortRef);
      searchInput.value = searchQuery;
    }
    // ---- the liveness indicator (#196 slice 1) -----------------------------
    //
    // ONE indicator in ONE slot: in the panel, below the filters and above the
    // first section. Not an enumeration of error types and never a stack of
    // pills. ABSENCE IS THE DEFAULT — a healthy runner shows nothing here at
    // all, because "the tool is working" is not news, and a badge that is
    // always up is a badge nobody reads.
    //
    // Three things may claim the slot, and each one names what the author does
    // about it: the runner is unreachable (restart it — and meanwhile keep
    // commenting), the buffer is flushing (nothing, watch it land), a replay
    // failed (re-anchor it, or take the words out). Today it learns of the
    // first only when a save fails, and the poll backstop fails quietly.
    //
    // Slices 2 and 3 — a watcher whose heartbeat went stale, and a hold set
    // with nobody watching — are NOT here: they need session presence (#187),
    // which this branch does not own.
    const banner = el('div', 'rv-abn rv-hidden');

    // ---- presence, in the SAME slot (#191, #196 slices 2-3) ----------------
    //
    // Decision 20: NO ATTACHED SESSION IS THE DEFAULT AND SHOWS NO WARNING.
    // Absence of an agent is not a problem state — an earlier draft treated it
    // as one and was rejected. An attached agent is a small green banner here;
    // a disconnect is a dismissible warning here; once dismissed, back to the
    // default. ONE indicator, never a stack of pills, which is why all of this
    // lands in the component that already exists rather than beside it.
    //
    // Decision 21: HOLD LIVES INSIDE THIS BANNER so it cannot be stranded, and
    // it PERSISTS across a disconnect and a reconnect. Silently clearing
    // somebody's setting is the kind of helpfulness that gets discovered three
    // days later; a persisted hold is safe provided it is obvious, so while
    // hold is on this slot is never empty.

    /** Learn who is watching, so a DEPARTURE can be named. A released claim is
     *  simply absent from /api/status, so without this the warning could only
     *  say "somebody left". */
    function syncPresence() {
      const s = statusInfo && statusInfo.session ? statusInfo.session : null;
      if (s === null) return;
      const claim = {
        agentName: typeof s.agentName === 'string' && s.agentName ? s.agentName : 'a session',
        handle: typeof s.handle === 'string' && s.handle ? s.handle : null,
        seenRev: typeof s.seenRev === 'number' ? s.seenRev : null,
        claimedAt: s.claimedAt ?? null,
        expiresAt: typeof s.expiresAt === 'number' ? s.expiresAt : null,
        ttlMs: typeof s.ttlMs === 'number' ? s.ttlMs : null,
      };
      if (!claimLapsed(claim)) {
        // A NEW watcher is not the old one coming back, so a dismissal must not
        // carry over: it covered the departure that already happened, not the
        // next one.
        if (sessionSeen === null || sessionSeen.claimedAt !== claim.claimedAt) sessionGoneDismissed = false;
        sessionSeen = claim;
        return;
      }
      // A claim that is present but LAPSED is a dead watcher, and it must read
      // the same whether this tab watched it die or opened onto the corpse.
      // That ambiguity — a watcher with nothing to do versus one that silently
      // stopped — is what cost an hour on a live document.
      sessionSeen = sessionSeen === null ? claim : { ...sessionSeen, ...claim };
    }

    /** Everything about a status body that the co-editing chrome renders and
     *  `rev` cannot see. The watch tick compares it to decide whether to redraw. */
    function presenceSig(s) {
      const sess = s && s.session ? s.session : null;
      const hold = s && s.hold ? s.hold : null;
      const leases = s && s.leases ? s.leases : null;
      return [
        sess ? `${sess.agentName}:${sess.handle ?? ''}:${sess.claimedAt}:${sess.expiresAt}:${sess.seenRev ?? ''}` : '-',
        hold ? `${hold.on ? 1 : 0}:${hold.heldCount ?? 0}` : '-',
        leases ? Object.keys(leases).sort().join(',') : '-',
        // #208: re-render when contention changes.
        s && s.contended ? Object.keys(s.contended).sort().join(',') : '-',
      ].join('|');
    }

    function claimLapsed(claim) {
      return claim !== null && typeof claim.expiresAt === 'number' && Date.now() >= claim.expiresAt;
    }

    /** 'live' | 'gone' | null — and null is the ordinary, unremarkable case. */
    function presenceState() {
      const s = statusInfo && statusInfo.session ? statusInfo.session : null;
      if (s !== null && !claimLapsed({ expiresAt: s.expiresAt })) return 'live';
      if (sessionSeen === null) return null; // no agent has ever been here: the DEFAULT
      return sessionGoneDismissed ? null : 'gone';
    }

    /** Seconds since the last heartbeat. A name alone cannot tell watching from
     *  wedged, which is the whole reason this readout exists. */
    function beatAge(claim) {
      if (claim === null || typeof claim.expiresAt !== 'number' || typeof claim.ttlMs !== 'number') return null;
      return Math.max(0, Math.round((Date.now() - (claim.expiresAt - claim.ttlMs)) / 1000));
    }

    // A lapse happens at a known instant, so it needs no poll to notice: wake
    // exactly when the claim runs out. Without this the disconnect would appear
    // only on the next status fetch — up to thirty seconds after the watcher
    // was already provably dead, which is the failure this ticket is about.
    function schedulePresenceCheck() {
      if (presenceTimer !== null) { clearTimeout(presenceTimer); presenceTimer = null; }
      const s = statusInfo && statusInfo.session ? statusInfo.session : null;
      if (s === null || typeof s.expiresAt !== 'number') return;
      const due = s.expiresAt - Date.now();
      if (due <= 0) return;
      presenceTimer = setTimeout(() => { presenceTimer = null; render(); }, due + 250);
    }

    function holdState() {
      const h = statusInfo && statusInfo.hold ? statusInfo.hold : null;
      return h && typeof h === 'object' ? h : null;
    }

    async function setHold(on) {
      if (holdBusy || runnerDown) return;
      holdBusy = true;
      render();
      try {
        const body = await api('/api/hold', { page, hold: Boolean(on) });
        if (statusInfo !== null) statusInfo = { ...statusInfo, hold: body };
      } catch { /* the banner's own state is refetched on the next tick */ }
      holdBusy = false;
      await refresh();
    }

    // The hold row, per decision 21 — INSIDE the banner, in every state that
    // has one, and the whole safety argument for letting hold persist. If it
    // were dropped, persistence would have to go with it.
    function holdRow(state) {
      const hold = holdState();
      if (hold === null) return null;
      if (!hold.on && state !== 'live') return null; // nothing to offer and nobody to offer it to
      const row = el('div', 'rv-abn-hold');
      const lab = el('span', 'rv-abn-hold-lab');
      const sw = el('button', `rv-abn-sw${hold.on ? ' rv-abn-sw-on' : ''}`);
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(Boolean(hold.on)));
      sw.setAttribute('aria-label', 'Hold new comments');
      sw.disabled = holdBusy || runnerDown;
      sw.addEventListener('click', () => setHold(!hold.on));
      // Hold is runner-side state, so it cannot move while the runner is gone.
      // It was the one refused control on the whole surface that said nothing —
      // greyed with no capsule and no title, which is the dead end #196 exists
      // to remove. holdBusy is transient and stays a plain disable.
      lab.appendChild(refuseWhenDown(sw, 'Needs the runner'));
      const n = Number.isFinite(hold.heldCount) ? hold.heldCount : 0;
      if (!hold.on) {
        lab.appendChild(el('span', undefined, 'Hold new comments'));
        row.appendChild(lab);
        return row;
      }
      lab.appendChild(el('span', undefined,
        state === 'live' ? 'Hold' : (state === null ? 'Hold is on' : 'Hold is still on')));
      // "held back since hold went on", NEVER "not yet done" (decision 15).
      // Hold gates intake only: anything already released is in the agent's
      // hands and keeps moving.
      lab.appendChild(el('span', 'rv-abn-hold-cnt',
        state === null
          ? `${n} held back · no agent attached`
          : `${n} held back${hold.since ? ` since ${clockTime(hold.since)}` : ''}`));
      row.appendChild(lab);
      const off = el('button', `rv-abn-hold-btn${state === 'live' ? ' rv-btn-primary' : ''}`,
        state === 'live' && n > 0 ? `Release ${n}` : 'Turn hold off');
      off.type = 'button';
      off.disabled = holdBusy || runnerDown;
      off.addEventListener('click', () => setHold(false));
      row.appendChild(refuseWhenDown(off, 'Needs the runner'));
      return row;
    }

    function renderBanner() {
      banner.replaceChildren();
      syncPresence();
      schedulePresenceCheck();
      const presence = presenceState();
      const hold = holdState();
      // ONE slot, so the states are ORDERED rather than stacked. The runner
      // being unreachable outranks everything: with it gone, what a watcher is
      // doing is unknowable and unactionable. A hold with nobody watching still
      // claims the slot when nothing else does — that is #196's third signal,
      // and specimen 5 in the mocks is exactly this row on its own.
      const state = runnerDown ? 'down'
        : (replay !== null ? 'flush'
          : ((replayReport && !replayDismissed) ? 'warn'
            : (presence !== null ? presence
              : ((hold !== null && hold.on) ? 'plain' : null))));
      banner.className = state ? `rv-abn rv-abn-${state}` : 'rv-abn rv-hidden';
      if (!state) return;

      if (state === 'live' || state === 'gone' || state === 'plain') {
        const claim = sessionSeen;
        if (state !== 'plain') {
          const top = el('div', 'rv-abn-top');
          top.appendChild(el('span', 'rv-abn-dot'));
          // #211: include the derived handle so two sessions of the same type
          // are distinguishable — "claude-code · ab3f" not just "claude-code".
          const whoLabel = claim && claim.handle
            ? `${claim.agentName} · ${claim.handle}`
            : (claim ? claim.agentName : 'a session');
          top.appendChild(el('span', 'rv-abn-who', whoLabel));
          top.appendChild(document.createTextNode(state === 'live' ? ' is watching' : ' stopped watching'));
          const age = beatAge(claim);
          if (state === 'live') {
            // The age is the part that makes the green honest: a name alone
            // cannot distinguish watching from wedged.
            if (age !== null) top.appendChild(el('span', 'rv-abn-age', `${age}s`));
            // #235: read receipt — has the watcher seen the latest changes?
            const currentRev = statusInfo && typeof statusInfo.rev === 'number' ? statusInfo.rev : 0;
            const seenRev = claim && typeof claim.seenRev === 'number' ? claim.seenRev : null;
            if (seenRev !== null) {
              if (seenRev >= currentRev) {
                top.appendChild(el('span', 'rv-abn-caught', 'caught up'));
              } else {
                const behind = currentRev - seenRev;
                top.appendChild(el('span', 'rv-abn-behind',
                  `${behind} revision${behind === 1 ? '' : 's'} behind`));
              }
            }
          } else {
            const x = el('button', 'rv-abn-x', '×');
            x.type = 'button';
            x.setAttribute('aria-label', 'Dismiss');
            x.addEventListener('click', () => { sessionGoneDismissed = true; render(); });
            top.appendChild(x);
          }
          banner.appendChild(top);
          if (state === 'gone') {
            // Amber, not red: nothing is failing, something merely stopped —
            // and saying what did NOT happen is most of the reassurance.
            banner.appendChild(el('div', 'rv-abn-sub',
              `${age === null ? 'No heartbeat' : `No heartbeat for ${age}s`}. Nothing was lost, and nothing was undone. Ask the session to start watching again.`));
          }
        }
        const row = holdRow(state === 'plain' ? null : state);
        if (row !== null) banner.appendChild(row);
        // #208: if the watcher was blocked on a held block, say so.
        if (state === 'live') {
          const contended = statusInfo && statusInfo.contended && typeof statusInfo.contended === 'object'
            ? statusInfo.contended : null;
          if (contended && Object.keys(contended).length > 0) {
            const count = Object.keys(contended).length;
            banner.appendChild(el('div', 'rv-abn-sub rv-abn-blocked',
              `Watcher was blocked on ${count} block${count === 1 ? '' : 's'} you are editing.`));
          }
        }
        return;
      }

      const top = el('div', 'rv-abn-top');
      top.appendChild(el('span', 'rv-abn-dot'));
      const sub = el('div', 'rv-abn-sub');

      if (state === 'down') {
        // #207, Blake's wording 2026-08-15 (design/mock-chunk1-repairs.html,
        // version D — picked after five side-by-side drafts at real panel
        // width). The only IRREVERSIBLE thing here is reloading: the runner is
        // also the web server, so a reload does not just lose the connection,
        // it loses the page. That goes in the bold headline, where a skimming
        // reader spends their one line of attention. The reassurance — that
        // comments are safe and will sync — can afford to be missed, so it is
        // demoted to the quieter sub line.
        //
        // The COUNT is Blake's amendment, same day: "add back the # of
        // comments". It is the difference between a reassurance you have to
        // take on trust and one you can check — "3 comments are saved" names
        // the work it is promising to keep. At zero there is nothing to count,
        // and "0 comments are saved" reads as a failure report, so that case
        // keeps the unnumbered sentence.
        top.appendChild(el('span', 'rv-abn-who', 'Runner offline — do not reload page.'));
        const waiting = bufferedComments.filter((b) => !b.failed).length;
        // Blake, 2026-08-15, looking at it live: the retry counter used to sit
        // on the top row beside the headline, and at 312px the headline fills
        // that row, so the counter wrapped to a line of its own BETWEEN the
        // headline and the sub line — a stripe of nothing splitting the two
        // sentences that belong together. It now rides on the sub line,
        // right-aligned, where the second wrapped line leaves room for it.
        sub.classList.add('rv-abn-sub-split');
        sub.appendChild(el('span', 'rv-abn-subtext', waiting === 0
          ? 'Comments are saved and will sync when the runner is back online.'
          : `${waiting} comment${waiting === 1 ? ' is' : 's are'} saved and will sync when the runner is back online.`));
        const secs = Math.max(0, Math.round((Date.now() - downSince) / 1000));
        sub.appendChild(el('span', 'rv-abn-age', `retrying ${secs}s`));
        banner.append(top, sub);
        return;
      }

      if (state === 'flush') {
        top.appendChild(document.createTextNode('Runner back —'));
        top.appendChild(el('span', 'rv-abn-who',
          `saving ${replay.total} comment${replay.total === 1 ? '' : 's'}`));
        top.appendChild(el('span', 'rv-abn-age', `${Math.min(replay.done + 1, replay.total)} of ${replay.total}`));
        const prog = el('div', 'rv-abn-prog');
        const fill = el('i');
        fill.style.width = `${Math.round((replay.done / replay.total) * 100)}%`;
        prog.appendChild(fill);
        banner.append(top, prog);
        return;
      }

      top.appendChild(el('span', 'rv-abn-who',
        `${replayReport.failed} of ${replayReport.total} comments could not be saved`));
      const x = el('button', 'rv-abn-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', 'Dismiss');
      x.addEventListener('click', () => { replayDismissed = true; renderBanner(); });
      top.appendChild(x);
      sub.textContent = 'The text it was written about is no longer in the document. It is still here and nothing was thrown away.';
      banner.append(top, sub);
    }

    // While the runner is down the age readout has to advance on its own — the
    // poll that would otherwise redraw it is the thing that is failing.
    //
    // BOTH EDGES LIVE HERE. Everything that changes when liveness changes —
    // the banner, the refused controls, the replay — is a consequence of the
    // TRANSITION, not of the tick that happened to notice it, so it belongs in
    // the one function that owns the transition. The reconnect used to be
    // handled in refresh() instead, and refresh() is only reached when the
    // sidecar's `rev` moved: nothing moves while the runner is down, so a
    // solo author's tab never recovered at all (#196).
    function setRunnerDown(down) {
      if (down === runnerDown) return;
      runnerDown = down;
      if (down) {
        downSince = Date.now();
        if (downTimer === null) downTimer = setInterval(renderBanner, DOWN_TICK_MS);
      } else {
        if (downTimer !== null) { clearInterval(downTimer); downTimer = null; }
      }
      syncChrome();
      // Every card is built against runnerDown — which controls refuse, which
      // capsule they carry — so the card list is stale the instant it flips.
      // Redrawing HERE is also what lets the offline poll stop redrawing: an
      // edge is the only time anything on screen actually changes.
      render();
      // The reconnect EDGE is the replay trigger (#202). Fired from the
      // liveness change rather than from the stream reopening, because a live
      // stream is not the same claim as a runner that answers writes, and it
      // is the writes that were lost.
      if (!down) flushBuffer();
    }

    const strip = el('div', 'rv-run-strip rv-hidden');
    const cards = el('div', 'rv-cards');
    cards.tabIndex = 0; // so ↑/↓ only bite when the card list holds focus (#149)
    panel.appendChild(header);
    panel.appendChild(banner);
    panel.appendChild(strip);
    panel.appendChild(cards);
    panel.appendChild(themeFooter(host));

    const toolbar = el('div', 'rv-toolbar');
    // Status chip (#149): Ready (View only) · Redline active (amber) · Running ·
    // Confirm needed · Run failed. renderToolbar() derives it from redline +
    // runUi. The runner-origin title stays for debugging.
    const baseLabel = runner.servedByRunner ? 'Ready' : 'Runner found';
    const chip = el('span', 'rv-chipstate');
    const chipPip = el('span', 'rv-pip');
    const chipText = document.createTextNode(baseLabel);
    chip.appendChild(chipPip);
    chip.appendChild(chipText);
    chip.title = `runner: ${runner.origin}`;
    // The mode switch: View only ↔ Redline active. Its knob draws a pencil in
    // both positions (CSS). role=button + Space/Enter for keyboard, and `R`
    // toggles it globally.
    const modeSw = el('span', 'rv-sw-mode');
    modeSw.setAttribute('role', 'button');
    modeSw.setAttribute('aria-label', 'Redline mode');
    modeSw.setAttribute('aria-pressed', 'false');
    modeSw.tabIndex = 0;
    modeSw.title = 'Turn redline on or off (R)';
    const swTrack = el('span', 'rv-sw-track');
    swTrack.appendChild(el('span', 'rv-sw-knob'));
    modeSw.appendChild(swTrack);
    modeSw.addEventListener('click', () => setRedline(!redline));
    modeSw.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); setRedline(!redline); }
    });
    // The ? button opens the shortcut sheet (also on the `?` key).
    const helpBtn = el('button', 'rv-help-btn', '?');
    helpBtn.type = 'button';
    helpBtn.title = 'Keyboard shortcuts (?)';
    helpBtn.setAttribute('aria-label', 'Keyboard shortcuts');
    helpBtn.addEventListener('click', () => toggleCheat());

    // Apply the derived chrome state from the two independent axes (#155). The
    // panel shows only when redline is on AND the sidecar is open; it docks
    // (reflows the page) in exactly that case, and the pill shifts left of the
    // panel edge (rv-shifted) so it never sits over the footer. Turning redline
    // off dismisses any open popover, exits an in-place edit, and hides the
    // hover pencil so nothing lingers over a now-native page.
    function syncChrome() {
      const panelShown = redline && sidecarOpen;
      panel.classList.toggle('rv-hidden', !panelShown);
      document.documentElement.classList.toggle('rv-panel-open', panelShown);
      toolbar.classList.toggle('rv-shifted', panelShown);
      if (!redline) {
        if (typeof hidePopover === 'function') hidePopover();
        hideSelPill();
        if (typeof cancelManualReanchor === 'function') cancelManualReanchor();
        if (editing) exitEditing(true);
        hideEditPencil();
      }
      // Held-block marks are chrome over the document, so they arm and disarm
      // with the mode exactly as the pill and the pencil do.
      positionLeaseOverlays();
      // #161: the gutter shows in review mode, with the reflow class on <html>.
      if (redline && gutter) {
        gutter.show();
        document.documentElement.classList.add('rv-gutter-open');
      } else {
        if (gutter) gutter.hide();
        document.documentElement.classList.remove('rv-gutter-open');
      }
      renderToolbar();
    }
    // Public signal for interactive host pages. window.redline is always
    // present once the overlay is initialized; data-rv-mode mirrors the mode;
    // rv:modechange fires whenever the mode flips (review ↔ view).
    const buildTag = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
      ? (chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version || '')
      : '';
    let lastSignalMode = null;
    function updateSignal() {
      const mode = redline ? 'review' : 'view';
      const panelOpen = redline && sidecarOpen;
      window.redline = {
        active: true,
        mode,
        panelOpen,
        version: buildTag,
      };
      document.documentElement.setAttribute('data-rv-mode', mode);
      if (lastSignalMode !== mode) {
        lastSignalMode = mode;
        document.dispatchEvent(new CustomEvent('rv:modechange', {
          bubbles: true,
          detail: { mode, panelOpen, version: buildTag },
        }));
      }
    }

    // Reflect the chip + switch from the current mode and run state. Amber
    // "Redline active" and red "Run failed" are deliberately different colours.
    function renderToolbar() {
      let cls = '';
      let text;
      if (runUi && runUi.phase === 'running') { cls = 'rv-cs-busy'; text = 'Running…'; }
      else if (runUi && runUi.phase === 'confirm') { cls = 'rv-cs-lock'; text = 'Confirm needed'; }
      else if (runUi && runUi.phase === 'error') { cls = 'rv-cs-fail'; text = 'Run failed'; }
      else if (redline) { cls = 'rv-cs-mode'; text = 'Redline active'; }
      else { text = baseLabel; }
      chip.className = 'rv-chipstate' + (cls ? ' ' + cls : '');
      chipText.nodeValue = text;
      modeSw.setAttribute('aria-pressed', String(redline));
    }
    // Mode: View only ↔ Redline active. Opening redline reveals the sidecar it
    // was left with; the two axes stay separate.
    function setRedline(on) { redline = on; syncChrome(); updateSignal(); }
    // Sidecar: open ↔ closed, independent of mode (the `]` key drives it).
    function setSidecar(open) { sidecarOpen = open; syncChrome(); updateSignal(); }
    // Sticky new-comment audience (#151). Persists across reloads; #154's
    // sidecar audience row will re-render off it.
    function setAudience(next) {
      audience = next;
      try { localStorage.setItem(AUDIENCE_KEY, next); } catch { /* private mode */ }
      renderAudienceState();
    }
    // Every comment on this page, saved or not. Blake, 2026-08-15, live: "the
    // offline comments are updating and being added, but they do not get
    // reflected in the gutter counts or filters." They did not, because three
    // surfaces each built their own list and only the card list remembered the
    // buffer — so the header said "3 comments" while the filter said "(2)" and
    // the gutter drew two dots. A comment you can see in the list and cannot
    // find in the gutter reads as data loss, which is the exact fear the
    // offline buffer exists to prevent.
    const everyComment = () => comments.concat(bufferedComments.map(asLocalComment));
    // Fill a status/audience <select> with `label (count)` options, count being
    // how many comments match that option on its own axis.
    function fillSelect(sel, defs, cur) {
      sel.replaceChildren();
      const pool = everyComment();
      for (const [key, label, pred] of defs) {
        const option = el('option', undefined, `${label} (${pool.filter(pred).length})`);
        option.value = key;
        if (key === cur) option.selected = true;
        sel.appendChild(option);
      }
    }
    // The audience-state row: what NEW comments will be + a Switch to flip it.
    function renderAudienceState() {
      audState.className = 'rv-audience-state' + (audience === 'note' ? ' rv-aud-note' : '');
      audState.replaceChildren(
        el('span', 'rv-aud-dot'),
        el('span', 'rv-aud-text', audience === 'ai' ? 'New comments go to the AI' : 'New comments are notes'),
      );
      const swap = el('button', 'rv-btn rv-aud-switch', 'Switch');
      swap.type = 'button';
      swap.addEventListener('click', () => setAudience(audience === 'ai' ? 'note' : 'ai'));
      audState.appendChild(swap);
    }
    // The visibility rule itself lives in overlay-model.js, where node can run
    // it. These two read this closure's axis state and hand it over; the rule
    // is the model's, the state is ours.
    function filterState() {
      return { filter, audienceFilter, rowFilter, search: searchPrepared };
    }
    function passesAxisFilters(c) { return modelPassesAxisFilters(c, filterState()); }
    function passesFilters(c) { return modelPassesFilters(c, filterState()); }
    // The blocks the filtered row is anchored to — clicks inside them keep
    // the filter; clicks anywhere else on the page clear it.
    function rowFilterBlockIds() {
      const ids = new Set();
      if (rowFilter === null) return ids;
      for (const c of comments) {
        if (rowFilter.ids.includes(c.id) && c.anchor && c.anchor.blockId) {
          ids.add(c.anchor.blockId);
        }
      }
      return ids;
    }
    toolbar.appendChild(chip);
    toolbar.appendChild(modeSw);
    toolbar.appendChild(helpBtn);

    host.appendChild(panel);
    host.appendChild(toolbar);

    // Swallow keyboard events that originate inside overlay inputs so host-page
    // single-letter shortcuts do not fire while the user is typing a comment.
    host.addEventListener('keydown', (event) => {
      const t = event.target;
      if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) {
        event.stopPropagation();
      }
    });

    // Fresh loads default to Redline active with the sidecar open (a doc opened
    // for review is armed — commenting works immediately). Post-run/undo reloads
    // restore whichever state the author left, per axis; an older saved blob
    // that only carried panelOpen seeds both axes from it.
    if (saved) {
      redline = saved.redline !== undefined ? Boolean(saved.redline) : Boolean(saved.panelOpen);
      sidecarOpen = saved.sidecarOpen !== undefined ? Boolean(saved.sidecarOpen) : Boolean(saved.panelOpen);
    } else {
      redline = true;
      sidecarOpen = true;
    }
    syncChrome();
    updateSignal();
    if (saved && typeof saved.scrollY === 'number') {
      requestAnimationFrame(() => window.scrollTo(0, saved.scrollY));
    }
    if (saved && saved.outcome) {
      runUi = saved.outcome.kind === 'undo'
        ? { phase: 'undone' }
        : { phase: 'done', outcome: saved.outcome };
    }

    if (!runner.servedByRunner) {
      renderEmpty('This page is not served by the runner — open it through the runner to review it.');
      return;
    }

    // ---- uninstrumented page: offer to stamp data-rev block ids ----
    // Comments anchor to [data-rev] blocks; a page with none makes every
    // send fall back to fragile quote-only anchors. Preparing the page adds
    // the ids on disk (idempotent, attributes only) and reloads.
    if (!document.querySelector('[data-rev]')) {
      const notice = el('div', 'rv-notice');
      const text = el('div', 'rv-notice-text');
      text.appendChild(el('div', 'rv-notice-title', "This page isn't prepared for review yet"));
      text.appendChild(el('div', 'rv-notice-sub',
        'Comments need stable block ids to anchor to. Preparing the page adds them — the visible content does not change.'));
      const noticeNote = el('div', 'rv-notice-sub rv-notice-error');
      text.appendChild(noticeNote);
      notice.appendChild(text);
      const prepare = el('button', 'rv-btn rv-btn-primary', 'Prepare page');
      prepare.type = 'button';
      prepare.addEventListener('click', async () => {
        prepare.disabled = true;
        noticeNote.textContent = '';
        try {
          await api('/api/instrument', { page });
          window.location.reload();
        } catch {
          prepare.disabled = false;
          noticeNote.textContent = 'Could not prepare the page — is the runner still running?';
        }
      });
      notice.appendChild(prepare);
      panel.insertBefore(notice, strip);
    }

    // ---- runner API ----
    // ---- the offline comment buffer (#202) ---------------------------------
    //
    // The runner is the ONLY writer — the browser never touches the sidecar —
    // so when it is down nothing saves, comments included. Leaving the controls
    // enabled would just lose the writing, so comments are held here and
    // replayed on reconnect. COMMENTS ONLY: they are append-only, so replaying
    // one later is safe, where an edit would replay against a document that may
    // have moved underneath it.
    //
    // DECISIONS THIS TICKET OWED, made here:
    //   Scope — PER PAGE. An anchor only means anything on its own page, so a
    //     per-origin buffer would be a per-page buffer with extra bookkeeping.
    //   Lifetime — localStorage, so it SURVIVES A CLOSED TAB. Losing writing
    //     because a tab closed is the failure the ticket exists to prevent.
    //   Eviction — on successful replay, and never otherwise. No TTL: a
    //     buffered comment that expired on a timer is exactly the silent drop
    //     the design forbids. A failed replay stays, with Copy text as the
    //     floor. BUFFER_MAX is a storage bound, and it refuses rather than
    //     dropping.
    function bufferKey() { return `${BUFFER_KEY_PREFIX}${page}`; }
    function loadBuffer() {
      try {
        const raw = window.localStorage.getItem(bufferKey());
        const parsed = raw ? JSON.parse(raw) : [];
        bufferedComments = Array.isArray(parsed) ? parsed : [];
      } catch { bufferedComments = []; }
    }
    function saveBuffer() {
      try {
        if (bufferedComments.length === 0) window.localStorage.removeItem(bufferKey());
        else window.localStorage.setItem(bufferKey(), JSON.stringify(bufferedComments));
      } catch { /* quota or a blocked store — the in-memory copy still renders */ }
    }
    // A buffered entry, shaped as a COMMENT so the card, the filters, the
    // sections and the document-order sort all work on it unchanged. `local`
    // is what every "this is not real yet" branch keys on.
    function asLocalComment(entry) {
      return {
        id: entry.localId,
        body: entry.body,
        anchor: entry.anchor,
        status: 'open',
        createdAt: entry.createdAt,
        creator: 'human',
        replies: [],
        aiEdits: entry.asNote !== true,
        local: true,
        replyTo: entry.replyTo || null,
        failed: entry.failed || null,
      };
    }
    function bufferComment(body, anchor, asNote) {
      if (bufferedComments.length >= BUFFER_MAX) return false;
      bufferedComments.push({
        localId: `local-${Math.random().toString(36).slice(2, 10)}`,
        body,
        anchor,
        asNote,
        createdAt: new Date().toISOString(),
        failed: null,
      });
      saveBuffer();
      return true;
    }
    // #241: a reply buffers too. It targets a STABLE comment id, so it avoids
    // the anchor problem that keeps edits out of the buffer entirely; the
    // parent's anchor rides along only so the buffered card can show a quote.
    function bufferReply(commentId, body, parentAnchor) {
      if (bufferedComments.length >= BUFFER_MAX) return false;
      bufferedComments.push({
        localId: `local-${Math.random().toString(36).slice(2, 10)}`,
        kind: 'reply',
        replyTo: commentId,
        body,
        anchor: parentAnchor || null,
        createdAt: new Date().toISOString(),
        failed: null,
      });
      saveBuffer();
      return true;
    }

    // Replay, on the edge where the runner comes back. In order, one at a time,
    // so the count in the banner means something and a failure stops only its
    // own comment.
    async function flushBuffer() {
      // #241: comments first, then replies, each side in composition order —
      // a reply must never race the still-buffered comment it sits under.
      const live = bufferedComments.filter((b) => !b.failed);
      const pending = [
        ...live.filter((b) => b.kind !== 'reply'),
        ...live.filter((b) => b.kind === 'reply'),
      ];
      if (pending.length === 0 || replay !== null) return;
      replay = { total: pending.length, done: 0 };
      replayReport = null;
      render();
      let failed = 0;
      for (const item of pending) {
        if (item.kind === 'reply') {
          // A reply's replay check is the PARENT's existence, which only the
          // runner can answer — a 404 is "the comment is gone", not an outage.
          try {
            const r = await apiRaw(`/api/comment/${encodeURIComponent(item.replyTo)}/reply`, {
              page, body: item.body,
            });
            if (r.ok) {
              bufferedComments = bufferedComments.filter((b) => b.localId !== item.localId);
            } else {
              item.failed = r.status === 404
                ? 'The comment this replied to is no longer on the server.'
                : 'The runner refused it. It is still here and nothing was thrown away.';
              failed += 1;
            }
          } catch {
            item.failed = 'The runner refused it. It is still here and nothing was thrown away.';
            failed += 1;
          }
        } else if (!locateAnchor(item.anchor)) {
          // The failure the design names — "the text it was written about is no
          // longer in the document" — is checkable HERE and nowhere else. The
          // runner stores an anchor verbatim without resolving it, so a comment
          // whose quote has gone would post happily and land as an orphan. Ask
          // the document first.
          item.failed = 'The quoted text is gone from the document — it changed while the runner was down.';
          failed += 1;
        } else {
          try {
            // ONE write, carrying the note flag (#185). This path is where the
            // two-write window hurt most: a replay flushes the whole buffer at
            // once, so every buffered note went through the gap back to back,
            // each one briefly indistinguishable from an edit request to any
            // session watching the stream.
            await api('/api/comment', {
              page, body: item.body, anchor: item.anchor, aiEdits: !item.asNote,
            });
            bufferedComments = bufferedComments.filter((b) => b.localId !== item.localId);
          } catch {
            item.failed = 'The runner refused it. It is still here and nothing was thrown away.';
            failed += 1;
          }
        }
        replay.done += 1;
        saveBuffer();
        render();
      }
      const total = replay.total;
      replay = null;
      // Green self-dismisses on success; a failure keeps the slot until the
      // author dismisses it, because a failed replay is never a silent drop.
      replayReport = failed > 0 ? { total, failed } : null;
      replayDismissed = false;
      await refresh();
    }

    // `opts.method` and `opts.keepalive` exist for the lease release (#189):
    // handing a block back is a DELETE, and the tab-close path needs the
    // request to outlive the document. They ride through the SAME call site on
    // purpose — one fetch in the whole extension is what makes "apiRaw owns
    // liveness" a fact rather than a convention.
    async function apiRaw(path, payload, opts) {
      const method = (opts && opts.method) || (payload === undefined ? 'GET' : 'POST');
      const init = (method === 'GET' && payload === undefined) ? undefined : {
        method,
        ...(payload === undefined ? {} : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        ...(opts && opts.keepalive ? { keepalive: true } : {}),
      };
      let res;
      try {
        res = await fetch(runner.origin + path, init);
      } catch (err) {
        // The ONE place a dead runner is detectable, so it is the one place
        // that decides (#196). Every other path had its own opinion and they
        // were all wrong: the watch tick swallowed the failure without
        // refreshing, the SSE error handler only downgraded `streamLive`, and a
        // failed write just re-enabled its button. So the runner could die
        // mid-session and the banner whose entire job is to say so would never
        // appear — you learned about it when a save silently did nothing, which
        // is the exact hole this ticket exists to close.
        //
        // A REJECTED FETCH is the signal, and only that. A 404 or a 409 comes
        // back with ok:false and is a live runner answering — marking those
        // "offline" would put a red banner over a working system.
        setRunnerDown(true);
        throw err;
      }
      // …and the SAME rule read forwards. A rejected fetch is the only proof
      // the runner is gone; a RESOLVED one — 200, 404, 409, 500, any of them —
      // is proof it is there, because something answered. Owning only the down
      // edge here is what left the tab offline forever: recovery was gated
      // behind refresh(), which the watch tick reaches only when the sidecar's
      // `rev` moved, and nothing moves while the runner is down. The failure
      // was inverted — the quieter the page, the longer it stayed broken, so a
      // solo author (exactly who the offline buffer exists for) never
      // recovered while a page with a second writer recovered by accident.
      setRunnerDown(false);
      let body = null;
      try {
        body = await res.json();
      } catch { /* non-JSON body — callers see null */ }
      return { status: res.status, ok: res.ok, body };
    }

    async function api(path, payload) {
      const r = await apiRaw(path, payload);
      if (!r.ok) throw new Error(`api ${path} -> ${r.status}`);
      return r.body;
    }

    // #266: /api/status counts session-hold LEASES in `running` — but a held
    // block is presence, not a run. Treating it as one gave every open
    // composer (yours included) a phantom "Running…" strip, and settling that
    // phantom against an unrelated lastRun record reloaded the whole page the
    // moment the lease released — Blake's "sidecar closes and reopens" on
    // every comment save and every watcher edit. Leases render as rails
    // (#189/#191); only real runs reach the run UI.
    function realRunActive(s) {
      if (!s || !s.running) return false;
      const active = Array.isArray(s.runs) ? s.runs : [];
      return active.some((r) => r && r.lane !== 'session-hold');
    }
    function isRunning() {
      // 'confirm' counts as busy: the page is locked server-side awaiting the
      // author's Allow/Decline, so no new send may start (WP7).
      return (runUi !== null && (runUi.phase === 'running' || runUi.phase === 'confirm'))
        || realRunActive(statusInfo);
    }
    // The lastRun on record when this tab adopted a foreign run — settling
    // must only reload for a record NEWER than this, or a run that ends
    // without writing one (declined, instrument) replays the previous run's
    // reload for nothing (#266).
    let adoptBaseRunId = null;

    // ---- the human's block lease (#189) ------------------------------------
    //
    // Decision 6: the lock is taken on COMPOSER-OPEN or EDIT-IN-PROGRESS, never
    // on selection. Selection is ambient and has no natural end — a reader who
    // highlights a sentence and wanders off would stall the agent for as long
    // as the tab stays open, on a document nobody is actually editing.
    //
    // Decision 5: first holder wins and NOTHING is preempted. A refusal here is
    // not an error to retry; it is the agent already holding the block, and the
    // only correct response is to name the holder and let the human decide.

    function stopLeaseRenew() {
      if (leaseTimer !== null) { clearInterval(leaseTimer); leaseTimer = null; }
    }

    /** Take the block. Returns the lease, or null — and null is NEVER fatal:
     *  reading, commenting and replying stay permissible on a held block, so
     *  only the direct-edit write consults the result. */
    async function acquireLease(blockId) {
      if (typeof blockId !== 'string' || blockId.length === 0) return null;
      if (runnerDown) return null;
      if (heldLease !== null && heldLease.blockId === blockId) return heldLease;
      if (heldLease !== null) await releaseLease();
      let res;
      try {
        res = await apiRaw('/api/lease', {
          page, blocks: [blockId], sessionId: tabSession, ttlMs: LEASE_TTL_MS,
        });
      } catch {
        return null; // the runner went away; apiRaw already painted the banner
      }
      if (res.status === 409) {
        // Held by the agent. Say who, and let the human wait — under
        // first-holder-wins there is no door here, and force-release is a
        // separate, recorded, deliberate act.
        leaseRefused = { blockId, reason: (res.body && res.body.reason) || 'blocks-leased' };
        render();
        return null;
      }
      if (!res.ok || !res.body || typeof res.body.leaseId !== 'string') return null;
      leaseRefused = null;
      leaseLost = null;
      heldLease = {
        leaseId: res.body.leaseId,
        blockId,
        expiresAt: typeof res.body.expiresAt === 'number' ? res.body.expiresAt : 0,
      };
      stopLeaseRenew();
      leaseTimer = setInterval(renewLease, LEASE_RENEW_MS);
      render();
      return heldLease;
    }

    /** Give the block back. `keepalive` is for the tab going away, where a
     *  normal fetch is cancelled with the document. */
    async function releaseLease({ keepalive = false } = {}) {
      const lease = heldLease;
      heldLease = null;
      stopLeaseRenew();
      if (lease === null) return;
      render();
      try {
        await apiRaw(
          `/api/lease/${encodeURIComponent(lease.leaseId)}?sessionId=${encodeURIComponent(tabSession)}`,
          undefined, { method: 'DELETE', keepalive });
      } catch { /* the TTL is the backstop, which is exactly what it is for */ }
    }

    // Renewal is what makes decision 7 affordable. A composer may stay open for
    // ten minutes; the runner's ceiling is five. Rather than asking for a
    // longer lease — runner code the overlay does not own, and a dead tab
    // holding a paragraph for an hour — the claim is short and re-taken while
    // the composer is genuinely open, so it dies with the tab on its own.
    async function renewLease() {
      const lease = heldLease;
      if (lease === null) { stopLeaseRenew(); return; }
      let res;
      try {
        res = await apiRaw('/api/lease/renew', { leaseId: lease.leaseId, ttlMs: LEASE_TTL_MS });
      } catch {
        return; // offline; the banner says so and the lease lapses server-side
      }
      if (heldLease !== lease) return; // released while the renewal was in flight
      if (res.ok && res.body && typeof res.body.expiresAt === 'number') {
        lease.expiresAt = res.body.expiresAt;
        return;
      }
      // 404 unknown-lease (it expired, or was force-released from another tab)
      // or 409. A renewal CANNOT resurrect a lease — the blocks may already be
      // someone else's — so take it again from scratch, and if that is refused,
      // say the claim ended rather than leaving a violet rail lying about.
      heldLease = null;
      stopLeaseRenew();
      const again = await acquireLease(lease.blockId);
      if (again === null) {
        leaseLost = { blockId: lease.blockId };
        render();
      }
    }

    async function refresh() {
      try {
        const [c, s] = await Promise.all([
          api(`/api/comments?page=${encodeURIComponent(page)}`),
          api(`/api/status?page=${encodeURIComponent(page)}`),
        ]);
        comments = Array.isArray(c.comments) ? c.comments : [];
        runRecords = Array.isArray(c.runs) ? c.runs : [];
        statusInfo = s;
        // Liveness is NOT decided here any more. apiRaw owns both edges, so by
        // the time these two calls have resolved the banner is already down and
        // the replay is already running — and, crucially, recovery no longer
        // depends on this function being reached at all (#196).
      } catch {
        // Keep the last-known comments rather than silently wiping the list.
        // Deliberately does NOT flip the banner: apiRaw owns that, and it only
        // fires on a rejected fetch. Landing here with the runner still up
        // means it answered and refused — a different problem from offline, and
        // painting the offline banner over it would send you to restart a
        // process that is running fine.
      }
      // A run may be in flight that this tab didn't start — watch it.
      // realRunActive, not statusInfo.running: a session-hold lease (an open
      // composer here or anywhere) must never be adopted as a run (#266).
      if (realRunActive(statusInfo) && (runUi === null || runUi.phase !== 'running')) {
        adoptBaseRunId = statusInfo.lastRun ? statusInfo.lastRun.runId ?? null : null;
        runUi = { phase: 'running', note: 'A run is in progress for this page…' };
        renderStrip();
        startPolling();
      }
      // …and a run may be AWAITING CONFIRMATION that this tab didn't start.
      // The pending confirmation locks the page for every tab, so every tab
      // has to show the ask — otherwise sends here 409 with no visible cause,
      // which is the bug in #106. A local 'confirm' already showing wins: it
      // holds the same runId and may have been dismissed to the lock bar.
      const pendingInfo = statusInfo ? statusInfo.pendingConfirmation : null;
      if (pendingInfo && (runUi === null || runUi.phase !== 'confirm')) {
        stopPolling();
        runUi = { phase: 'confirm', runId: pendingInfo.runId, scope: pendingInfo.scope || {} };
        renderStrip();
      } else if (!pendingInfo && runUi !== null && runUi.phase === 'confirm') {
        // Resolved elsewhere (another tab allowed or declined it). Drop the
        // ask rather than leaving a dialog that can no longer be answered.
        hideScopeDialog();
        runUi = null;
        renderStrip();
      }
      // Pull the DOCUMENT back in step when a run record says it moved — a
      // direct edit or an applied run in another tab. Before render(), so the
      // anchor highlight is re-placed over the patched geometry rather than
      // the old.
      const sig = docSignature(statusInfo);
      if (sig !== lastDocSig) {
        // #228 (V1 decision 4): the FIRST observation of a page with no runs
        // has nothing to catch up on — this tab loaded the same disk truth
        // moments ago, and a page script may have written into stamped blocks
        // since (a mock filling itself in). Rewriting here is pure cost: it
        // reverts those writes and repairs no drift. Record the signature and
        // skip the sync; any later run record moves the signature and syncs.
        const firstSightNoRuns = lastDocSig === null && sig === '';
        lastDocSig = sig;
        if (!firstSightNoRuns) await syncDocument();
      }
      render();
    }

    // ---- run status polling (~1 s, per the contract) ----
    function startPolling() {
      if (pollTimer !== null) return;
      const tick = async () => {
        let s = null;
        try {
          s = await api(`/api/status?page=${encodeURIComponent(page)}`);
        } catch { /* transient — keep polling */ }
        if (pollTimer === null) return;
        if (s) {
          statusInfo = s;
          // A gated run leaves activeRuns the moment it pauses, so `running`
          // goes false while the run is very much not finished. A watching tab
          // must show the ask, not settle on the PREVIOUS run's record (#106).
          if (s.pendingConfirmation) {
            stopPolling();
            runUi = {
              phase: 'confirm',
              runId: s.pendingConfirmation.runId,
              scope: s.pendingConfirmation.scope || {},
            };
            renderStrip();
            render();
            return;
          }
          if (!realRunActive(s)) {
            stopPolling();
            // #209: a page with no runs has no lastRun. Absence of history
            // is not a lost run — quietly clear the strip instead of
            // rendering "the run finished but no run record was found".
            // #266: settle ONLY against a record newer than the one already
            // on the page when the run was adopted — a run that ends without
            // writing one must not replay the previous record's reload.
            if (runUi !== null && runUi.phase === 'running') {
              const fresh = s.lastRun && s.lastRun.runId !== adoptBaseRunId ? s.lastRun : null;
              if (fresh) {
                await settleRun(fresh);
              } else {
                runUi = null;
                renderStrip();
                await refresh();
              }
            } else {
              render();
            }
            return;
          }
        }
        pollTimer = setTimeout(tick, POLL_MS);
      };
      pollTimer = setTimeout(tick, POLL_MS);
    }

    function stopPolling() {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    }

    // ---- document re-sync (#162 follow-on) ----
    // refresh() re-fetches comments and status — the OVERLAY. It never touched
    // the document, so a direct edit or an applied run in another tab changed
    // the file on disk while this tab kept rendering the HTML it loaded at
    // page load. The sync signal was firing correctly; there was simply nothing
    // listening for the document half.
    //
    // ---- fold state: the reviewer's <details> toggles are review STATE ----
    // The document's own details elements reset to their source defaults on
    // every full reload (own runs, undo, instrument) — which read as sections
    // "reopening themselves" whenever the watcher applied an edit (Blake,
    // round 2, twice). Folds persist per page in sessionStorage, keyed by
    // each details' first stamped descendant, and are reasserted after loads
    // and re-syncs. Only the `open` attribute is ever touched — never content.
    const FOLD_KEY_PREFIX = 'rv-folds:';
    function foldKeyOf(det) {
      const stamped = det.querySelector('[data-rev]');
      return stamped ? stamped.getAttribute('data-rev') : null;
    }
    function pageDetails() {
      try {
        return [...document.querySelectorAll('details')].filter((d) => !d.closest('#rv-root'));
      } catch { return []; }
    }
    function saveFolds() {
      try {
        const map = {};
        for (const det of pageDetails()) {
          const key = foldKeyOf(det);
          if (key) map[key] = Boolean(det.open);
        }
        sessionStorage.setItem(FOLD_KEY_PREFIX + page, JSON.stringify(map));
      } catch { /* losing fold state is cosmetic */ }
    }
    function applyFolds() {
      let map = null;
      try { map = JSON.parse(sessionStorage.getItem(FOLD_KEY_PREFIX + page) || 'null'); } catch { /* ignore */ }
      if (!map || typeof map !== 'object') return;
      for (const det of pageDetails()) {
        const key = foldKeyOf(det);
        if (key && typeof map[key] === 'boolean' && det.open !== map[key]) det.open = map[key];
      }
    }
    // toggle does not bubble; a capture listener on document still sees it.
    document.addEventListener('toggle', (event) => {
      const t = event.target;
      if (t instanceof Element && t.tagName === 'DETAILS' && !t.closest('#rv-root')) saveFolds();
    }, true);
    applyFolds(); // a reload just happened if there is anything stored

    // Re-sync from /api/source rather than tracking which blocks a run touched:
    // comparing the served source against the live DOM is self-correcting, so
    // it repairs drift from any cause — direct edit, agent run, undo, or a
    // change this tab never heard about at all.
    async function syncDocument() {
      let source;
      try {
        source = (await api(`/api/source?page=${encodeURIComponent(page)}`)).source;
      } catch { return; }
      if (typeof source !== 'string' || source.length === 0) return;

      let incoming;
      try {
        incoming = new DOMParser().parseFromString(source, 'text/html');
      } catch { return; }

      let patched = 0;
      for (const fresh of incoming.querySelectorAll('[data-rev]')) {
        const id = fresh.getAttribute('data-rev');
        // Never overwrite a block this tab is mid-edit in — the author's
        // uncommitted keystrokes outrank a remote update of the same block.
        if (editing !== null && editing.blockId === id) continue;
        const live = document.querySelector(`[data-rev="${CSS.escape(id)}"]`);
        // Comparing innerHTML is a READ, which the injection guard allows.
        if (live === null || live.innerHTML === fresh.innerHTML) continue;
        // ADOPT the already-parsed nodes rather than assigning a markup string.
        // Same result, and it keeps the overlay's no-innerHTML-writes rule
        // intact — DOMParser has done the parsing, so round-tripping back
        // through a string would only re-introduce the sink we ban.
        live.replaceChildren(...document.importNode(fresh, true).childNodes);
        patched += 1;
      }
      // A patch can arrive with restructured markup; the reviewer's folds
      // outrank whatever defaults rode in with it.
      if (patched > 0) applyFolds();
      // Callers run this BEFORE render(), whose reconcileHighlight() re-places
      // the anchor tint over the new client rects — a patched block reflows,
      // and a highlight positioned over the old geometry would be left
      // pointing at the wrong text.
      return patched;
    }

    // A run record is the marker that the DOCUMENT may have moved: agent runs,
    // direct edits (lane 'direct-edit') and undo all write one. Comments and
    // replies bump `rev` without touching the document, so keying off rev alone
    // would refetch the source on every keystroke someone else types.
    function docSignature(s) {
      const r = s && s.lastRun;
      return r ? `${r.runId}:${r.status}` : '';
    }

    // ---- live stream (#162) ----
    // The 4 s watch below is a floor, not a target, and every version skew it
    // met presented as SILENCE. GET /api/events pushes the sidecar rev the
    // moment a save lands, so a change in another tab shows up in milliseconds
    // rather than on the next tick.
    //
    // The poll STAYS as a backstop. EventSource reconnects on its own, but a
    // stream can be dropped by a proxy or a sleeping laptop, and a runner too
    // old to serve /api/events must still sync. Belt and braces, cheap.
    function startStream() {
      if (typeof EventSource !== 'function' || evtSource !== null) return;
      let src;
      try {
        // Path written as its own literal so the contract-allowlist test can
        // see it — a template starting with ${runner.origin} slips past that guard.
        //
        // `runner` is {origin, servedByRunner}, NOT a string: `runner + path`
        // stringified to "[object Object]/api/events?…", which resolved against
        // the document base, 404'd, and fired onerror — so streamLive was never
        // true and #162's live push has never once worked outside the tests.
        // Every tab has been running on the 4 s poll backstop since bc66281.
        src = new EventSource(runner.origin + `/api/events?page=${encodeURIComponent(page)}`);
      } catch { return; } // no stream — the poll covers it
      evtSource = src;

      // `hello` proves the stream is live; `rev` is every save after that.
      // Both are just "something moved" — the client refetches through the
      // normal endpoints rather than trusting a payload, which is why the
      // stream never has to carry content or care who is allowed to see it.
      const onRev = async (ev) => {
        let rev = null;
        try { rev = JSON.parse(ev.data).rev; } catch { /* malformed — refetch anyway */ }
        if (typeof rev === 'number' && statusInfo && statusInfo.rev === rev) return;
        await refresh();
      };
      src.addEventListener('rev', onRev);
      src.addEventListener('hello', () => { streamLive = true; });
      src.onerror = () => {
        // EventSource retries by itself; mark it dead so the poll takes over in
        // the meantime and stop trusting the stream for freshness.
        streamLive = false;
      };
    }

    function stopStream() {
      if (evtSource !== null) {
        try { evtSource.close(); } catch { /* already closed */ }
        evtSource = null;
      }
      streamLive = false;
    }

    // ---- idle watch (#106) ----
    // The run poll above only exists while THIS tab has a run in flight. A tab
    // sitting idle therefore never learned that another tab had hit the scope
    // gate — it kept rendering "no comments" while the page was locked, and its
    // sends failed with no visible cause. That is the bug #106 describes, and
    // rendering the card was only half of it: something has to go and look.
    //
    // Deliberately slower than POLL_MS. Nothing here is time-critical — it
    // exists so a page locked elsewhere becomes visible within a few seconds,
    // not so a progress bar moves smoothly.
    function startWatching() {
      if (watchTimer !== null) return;
      const tick = async () => {
        watchTimer = null;
        // While a run of ours is live, the 1 s poll owns the status; and a
        // dialog already up must not be yanked out from under a click.
        if (pollTimer === null && !(runUi && runUi.phase === 'confirm')) {
          try {
            const s = await api(`/api/status?page=${encodeURIComponent(page)}`);
            // `rev` is the sidecar's revision, so this catches everything a
            // flag comparison misses — a comment or reply added in another
            // tab, a status flipped, a run recorded. Watching only the
            // pending/running flags meant a comment written next door stayed
            // invisible here until something else forced a refresh.
            const prev = statusInfo;
            // A runner too old to send `rev` would make every comparison below
            // read "unchanged" — undefined !== undefined is false — so the tab
            // would silently sync run starts and nothing else. Degrade to
            // refreshing every tick instead: slower, but never silently wrong.
            const noRev = typeof s.rev !== 'number';
            const changed = !prev
              || noRev
              || s.rev !== prev.rev
              || Boolean(s.pendingConfirmation) !== Boolean(prev.pendingConfirmation)
              || Boolean(s.running) !== Boolean(prev.running)
              // Presence and held leases DO NOT BUMP rev, and cannot: a claim,
              // a heartbeat and a lease all live in the runner's memory, not in
              // the sidecar. Comparing rev alone would make an agent arriving,
              // leaving or taking a block invisible here — which is the exact
              // shape of the bug this phase exists to close (#191, #196).
              || presenceSig(s) !== presenceSig(prev);
            statusInfo = s;
            // refresh() owns adopting a pending ask or a run someone else
            // started; only pay for it when something actually moved.
            if (changed) await refresh();
          } catch {
            // Deliberately draws NOTHING. apiRaw already flipped the banner and
            // setRunnerDown already redrew the cards — on the EDGE, once. A
            // redraw on every failing tick rebuilds the whole card list every
            // four seconds for a screen where nothing has changed, and it takes
            // any composer the author is typing into with it. The one thing
            // that does keep moving while down, the "retrying Ns" age, has its
            // own 1 s timer redrawing the banner ALONE, precisely because the
            // poll that would otherwise redraw it is the thing that is failing.
            //
            // Keep watching — this loop is what notices the runner coming back,
            // and now the noticing is all it has to do.
          }
        }
        // A healthy stream makes the poll a safety net, not the mechanism:
        // check rarely, purely to catch a stream that died without saying so.
        //
        // EXCEPT while there is co-editing to see. The stream carries `rev` and
        // nothing else, and presence and leases never touch rev, so with an
        // agent attached or hold on the poll IS the mechanism again and backing
        // it off to thirty seconds would leave a departed watcher green for
        // half a minute.
        const coediting = Boolean(statusInfo
          && (statusInfo.session || (statusInfo.hold && statusInfo.hold.on)
            || (statusInfo.leases && Object.keys(statusInfo.leases).length > 0)));
        watchTimer = setTimeout(tick, (streamLive && !coediting) ? WATCH_IDLE_MS : WATCH_MS);
      };
      watchTimer = setTimeout(tick, WATCH_MS);
    }

    // ---- send → run → outcome ----
    // commentIds: one id = the classic single send; two or more = a Send All
    // batch — one run, one record, one undo (design/07-api-contract.md,
    // amendment 2026-07-22).
    // Resolve a scope-guardrail pause (WP7): Allow applies the previewed run,
    // Decline discards it. Both go through POST /api/run/confirm; the runner
    // holds the stashed edits, so Allow lands exactly what was previewed.
    async function resolveConfirmation(allow, allowBtn, declineBtn) {
      if (runUi === null || runUi.phase !== 'confirm') return;
      const runId = runUi.runId;
      allowBtn.disabled = true;
      declineBtn.disabled = true;
      let res = null;
      try {
        res = await apiRaw('/api/run/confirm', { page, runId, allow });
      } catch {
        allowBtn.disabled = false;
        declineBtn.disabled = false;
        return;
      }
      hideScopeDialog(); // resolved either way — the modal comes down now
      if (!allow) {
        runUi = res.status === 200 ? { phase: 'declined' }
          : { phase: 'error', message: (res.body && res.body.error) || 'could not decline the run' };
        renderStrip();
        await refresh();
        return;
      }
      if (res.status === 200 && res.body) {
        runUi = { phase: 'running', note: null }; // let settleRun take over
        return settleRun(res.body);
      }
      runUi = { phase: 'error', message: (res.body && res.body.error) || 'could not apply the run' };
      renderStrip();
      await refresh();
    }

    // #212: with a watcher attached, Send routes to the free session, not the
    // paid OpenRouter lane. The watcher already subscribes to the SSE stream
    // and sees every comment — Send is the signal to act, not a dispatch.
    // If hold is on, releasing it is the handover. If hold is off, the watcher
    // is already working and Send is a no-op with a reassurance message.
    // Without a watcher, Send is disabled — no paid path in V1.
    function watcherAttached() {
      return presenceState() === 'live';
    }

    async function startRun(commentIds) {
      if (isRunning()) return;
      // #212: no watcher → no Send. The paid path is hidden in V1.
      if (!watcherAttached()) {
        runUi = { phase: 'error', message: 'Attach a watcher to act on comments — no agent session is connected.' };
        renderStrip();
        render();
        return;
      }
      // #212: with a watcher, Send does not call /api/run — the paid path
      // does not exist in V1. #254 amended (Blake, same day, after the
      // silence read as "run keeps failing"): Send is now a REAL nudge with
      // a receipt. Each sent comment gets a status touch — open → open is a
      // 200 that bumps the COMMENT's rev, which is exactly the new-work
      // signal conforming watchers key on (docs/AGENT-CONTRACT.md) — and
      // the subdued handover strip says what happened.
      const hold = holdState();
      const heldRelease = Boolean(hold && hold.on);
      if (heldRelease) await setHold(false); // releases the batch too
      // R-004: Send was reported as "produced no run", and it is SUPPOSED to
      // produce no run — it is a nudge, not a paid lane. What it produced
      // instead was invisible, so a deaf watcher and a broken button looked
      // identical from the outside. Log what actually happened, per comment,
      // so the next such report arrives with its own evidence.
      const touched = [];
      const missed = [];
      for (const id of commentIds) {
        try {
          await api(`/api/comment/${encodeURIComponent(id)}/status`, { page, status: 'open' });
          touched.push(id);
        } catch (err) {
          // A failed touch leaves the comment exactly as it was.
          missed.push({ id, error: String(err && err.message ? err.message : err) });
        }
      }
      console.log('[redline] Send: nudged %d comment(s) — no run is created by design (#212/#254). '
        + 'If nothing happens next, the watcher is not reading, not the button.',
      touched.length, { touched, missed, heldRelease, watcher: presenceState() });
      runUi = { phase: 'done', outcome: { kind: 'handover', count: commentIds.length, heldRelease } };
      renderStrip();
      await refresh();
    }

    async function settleRun(run) {
      stopPolling();
      if (runUi === null || runUi.phase !== 'running') return;
      if (!run) {
        runUi = { phase: 'error', message: 'the run finished but no run record was found' };
        renderStrip();
        await refresh();
        return;
      }
      // A Send All batch record carries commentIds (and null archetype/
      // model); its outcome line is decision counts, not one decision chip.
      const batchIds = Array.isArray(run.commentIds) ? run.commentIds : null;
      let decision = null;
      let summary = null;
      let failed = 0;
      if (batchIds) {
        const counts = new Map();
        for (const d of Array.isArray(run.decisions) ? run.decisions : []) {
          if (d && typeof d.decision === 'string') counts.set(d.decision, (counts.get(d.decision) ?? 0) + 1);
        }
        // Failed comments carry no decision — count them from perComment (WP8).
        failed = Array.isArray(run.perComment) ? run.perComment.filter((p) => p && p.status === 'failed').length : 0;
        const parts = [...counts].map(([kind, n]) => `${n} ${kind}`);
        if (failed > 0) parts.push(`${failed} failed`);
        summary = `${batchIds.length} comments sent${parts.length > 0 ? ' — ' + parts.join(', ') : ''}`;
      } else {
        const d = Array.isArray(run.decisions)
          ? run.decisions.find((x) => x && x.id === run.commentId)
          : null;
        decision = d ? d.decision : null;
        summary = d && typeof d.summary === 'string' ? d.summary : null;
      }
      const outcome = {
        kind: 'run',
        runId: run.runId,
        status: run.status,
        archetype: run.archetype ?? null,
        model: run.model ?? null,
        decision,
        summary,
        edits: Array.isArray(run.edits) ? run.edits.length : 0,
        failed,
        partial: run.status === 'partial',
        costUsd: run.usage && Number.isFinite(run.usage.costUsd) ? run.usage.costUsd : null,
        actor: run.actor ?? null,
        // #227: the strip's "View card" needs the ONE comment a run decided.
        // A batch (Send All) touched several — nothing here names one of them
        // over the others, so it carries no card to jump to.
        commentId: batchIds ? null : (run.commentId ?? null),
      };
      // 'ok' and 'partial' (WP8) both applied edits. #266: every settle is an
      // ADOPTED run now (V1's Send is a nudge, not a run), so the document is
      // another session's work — patch it in place through syncDocument, the
      // way every other foreign write lands, instead of reloading the page.
      // The reload here was the second half of Blake's jitter: the tab blinked
      // whenever a watcher or CLI edit finished. reloadPreserving still serves
      // the surfaces that changed the doc FROM this tab (direct edit, undo).
      const applied = run.status === 'ok' || run.status === 'partial';
      if (applied && outcome.edits > 0) {
        await syncDocument();
        runUi = { phase: 'done', outcome };
        renderStrip();
        await refresh();
        return;
      }
      runUi = applied
        ? { phase: 'done', outcome }
        : { phase: 'error', message: typeof run.error === 'string' ? run.error : 'run failed', outcome };
      renderStrip();
      await refresh();
    }

    // ---- undo last run ----
    async function undoLastRun(button) {
      if (isRunning()) return;
      button.disabled = true;
      let res = null;
      try {
        res = await apiRaw('/api/undo', { page, creator: 'human' });
      } catch { /* handled below */ }
      if (res && res.status === 200) {
        reloadPreserving({ kind: 'undo' });
        return;
      }
      button.disabled = false;
      runUi = {
        phase: 'error',
        message: (res && res.body && res.body.error) || 'undo failed — is the runner still running?',
      };
      renderStrip();
      await refresh();
    }

    // ---- reload, preserving panel state + scroll (sessionStorage, per page) ----
    function reloadPreserving(outcome) {
      try {
        sessionStorage.setItem(STATE_KEY_PREFIX + page, JSON.stringify({
          redline,
          sidecarOpen,
          // panelOpen kept for back-compat with any blob written before #155
          // (the derived state a pre-#155 build would have restored).
          panelOpen: redline && sidecarOpen,
          scrollY: window.scrollY,
          // #269 (Blake, 2026-08-13): a run must not change what you are
          // looking at. His case is the watcher running while the panel is
          // set to what needs his eye — revisions should LAND in that view.
          // Collapsed panel sections and document folds are NOT here on
          // purpose: they already ride their own sessionStorage keys
          // (rv-sections:, rv-folds:) and so already survive. Only the
          // audience and row axes were actually being dropped.
          filter,
          audienceFilter,
          rowFilter,
          search: searchQuery,
          outcome: outcome ?? null,
        }));
      } catch { /* reload anyway — losing panel state is cosmetic */ }
      window.location.reload();
    }

    // ---- run-status strip ----
    // The toolbar chip is driven by renderToolbar() (#149), which reads runUi +
    // redline directly, so renderStrip just calls it after mutating runUi.

    // #227: "View card" on a finished strip — open the panel if closed, expand
    // the card the run decided, and land on it. Mirrors the gutter dot click
    // (onDotClick above): same expandedId + uncollapseSectionOf + scrollIntoView
    // steps, minus the row-filter and in-document scroll, which are about
    // finding a spot on the PAGE — this is about finding a card in the PANEL.
    // A comment the filters are hiding, or that no longer exists, is a silent
    // no-op — the same tolerance the dot click already has.
    function goToCard(commentId) {
      if (!commentId) return;
      closeStack();
      if (!sidecarOpen) setSidecar(true);
      expandedId = commentId;
      render();
      requestAnimationFrame(() => {
        const card = cards.querySelector(`[data-rv-comment="${CSS.escape(commentId)}"]`);
        if (!card) return;
        uncollapseSectionOf(card);
        card.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
        card.classList.add('rv-card-flash');
        setTimeout(() => card.classList.remove('rv-card-flash'), 2500);
      });
    }

    // ---- scope confirmation modal (#107) ----
    // The dialog itself lives in overlay-scope.js; this file owns the run
    // state, so it supplies what Allow/Decline do (resolveConfirmation) and
    // what "Not now" does — hiding the dialog without releasing the lock, so
    // renderStrip keeps showing the lock bar.
    const scopeDialog = createScopeDialog({
      host,
      onResolve: (allow, allowBtn, declineBtn) => resolveConfirmation(allow, allowBtn, declineBtn),
      onDismiss: () => { scopeDismissed = true; renderStrip(); },
    });
    const showScopeDialog = (scope) => scopeDialog.show(scope);
    const hideScopeDialog = () => scopeDialog.hide();

    function renderStrip() {
      strip.replaceChildren();
      strip.className = 'rv-run-strip';
      // The modal only belongs to the confirm phase; any other state tears it
      // down and clears the dismissed flag so the next confirmation starts fresh.
      if (!runUi || runUi.phase !== 'confirm') { hideScopeDialog(); scopeDismissed = false; }
      if (runUi === null) {
        strip.classList.add('rv-hidden');
        renderToolbar();
        return;
      }
      if (runUi.phase === 'running') {
        renderToolbar();
        strip.classList.add('rv-running');
        strip.appendChild(el('span', 'rv-spinner'));
        const box = el('div', 'rv-strip-text');
        box.appendChild(el('div', undefined, 'Running…'));
        if (runUi.note) box.appendChild(el('div', 'rv-strip-sub', runUi.note));
        strip.appendChild(box);
        return;
      }
      if (runUi.phase === 'confirm') {
        // Scope guardrail (WP7 / #107): the run reaches beyond the commented
        // section (or touches the theme). The page is LOCKED, so the ask is a
        // modal over the document (showScopeDialog), and the panel keeps a
        // persistent lock bar. Dismissing the modal leaves the bar; Review
        // re-opens it. The lock is server-enforced, so hiding the modal changes
        // nothing about what can proceed — it only lets the author read the doc.
        renderToolbar();
        strip.classList.add('rv-confirm');
        const bar = el('div', 'rv-lock-bar');
        bar.appendChild(el('span', 'rv-lock-dot'));
        bar.appendChild(el('span', 'rv-lock-text', 'Page locked — scope confirmation pending'));
        const review = el('button', 'rv-btn rv-lock-review', 'Review');
        review.type = 'button';
        review.addEventListener('click', () => { scopeDismissed = false; showScopeDialog(runUi.scope); });
        bar.appendChild(review);
        strip.appendChild(bar);
        if (!scopeDismissed) showScopeDialog(runUi.scope);
        return;
      }
      renderToolbar();
      if (runUi.phase === 'declined') {
        const box = el('div', 'rv-strip-text');
        box.appendChild(el('div', undefined, 'Change declined — the document was left unchanged.'));
        strip.appendChild(box);
        const dismiss = el('button', 'rv-strip-dismiss', '×');
        dismiss.type = 'button';
        dismiss.setAttribute('aria-label', 'Dismiss');
        dismiss.addEventListener('click', () => { runUi = null; renderStrip(); });
        strip.appendChild(dismiss);
        return;
      }
      const box = el('div', 'rv-strip-text');
      if (runUi.phase === 'done') {
        const o = runUi.outcome;
        // #212: watcher-routed outcomes — not run records.
        if (o && o.kind === 'handover') {
          box.appendChild(el('div', undefined,
            `${o.count} comment${o.count === 1 ? '' : 's'} nudged to the watcher`
            + `${o.heldRelease ? ' — hold released' : ''}.`));
          strip.appendChild(box);
          const dismiss = el('button', 'rv-strip-dismiss', '×');
          dismiss.type = 'button';
          dismiss.setAttribute('aria-label', 'Dismiss');
          dismiss.addEventListener('click', () => { runUi = null; renderStrip(); });
          strip.appendChild(dismiss);
          return;
        }
        // #254: there is no 'watching' outcome any more — the hover capsule
        // carries the reassurance before the click, and the click is a true
        // no-op with no strip (it pushed content down and implied activity).
        const head = el('div', 'rv-strip-head');
        if (o.decision) head.appendChild(el('span', `rv-chip rv-chip-${o.decision}`, o.decision));
        const runBy = authorChip(o.actor);
        if (runBy) head.appendChild(runBy);
        const provenance = [o.archetype, o.model].filter(Boolean).join(' · ');
        if (provenance) head.appendChild(el('span', 'rv-strip-sub', provenance));
        box.appendChild(head);
        if (o.summary) box.appendChild(mdBlock(undefined, o.summary));
        if (o.edits > 0) {
          box.appendChild(el('div', 'rv-strip-sub',
            `${o.edits} edit${o.edits === 1 ? '' : 's'} applied — document updated.`));
        }
        if (Number.isFinite(o.costUsd)) {
          box.appendChild(el('div', 'rv-strip-sub', `Cost: ${formatCost(o.costUsd)}`));
        }
        // Run-log button lives on the resolved card (WP11 de-dup); a successful
        // run's strip no longer repeats it. Failed runs (below) keep it — a
        // failed run resolves no comment, so the card has no button to open.
        // #227: the strip names a decision but used to give no way back to the
        // card it was about. A batch run's outcome carries no commentId (many
        // cards, none of them "the" one) — mock states 1 and 2 in
        // design/mock-chunk1-repairs.html.
        if (o.commentId) {
          const viewCard = el('button', 'rv-strip-viewcard', 'View card');
          viewCard.type = 'button';
          viewCard.addEventListener('click', (event) => {
            event.stopPropagation();
            goToCard(o.commentId);
          });
          // Blake, 2026-08-15: "show the view card button in the same line as
          // the addressed or declined, just on the right-hand side of that top
          // line." It rides on the HEAD row, hard right, rather than taking a
          // row of its own. That row holds only fixed-width things — the
          // decision chip, the author chip, the provenance — so the link's
          // position is stable; the one part that varies in length, the summary
          // sentence, already has its own row beneath, where wrapping is
          // harmless. Comparison at real panel width: the last row of the #227
          // section in design/mock-chunk1-repairs.html.
          head.appendChild(viewCard);
        }
      } else if (runUi.phase === 'undone') {
        box.appendChild(el('div', undefined, 'Last run undone — the document was restored.'));
      } else { // error
        strip.classList.add('rv-failed');
        // #212: the no-watcher message is not a "run failed" — no run was attempted.
        const isNoWatcher = runUi.message && runUi.message.startsWith('Attach a watcher');
        box.appendChild(el('div', undefined, isNoWatcher ? runUi.message : `Run failed: ${runUi.message}`));
        const o = runUi.outcome;
        if (o && (o.archetype || o.model)) {
          box.appendChild(el('div', 'rv-strip-sub', [o.archetype, o.model].filter(Boolean).join(' · ')));
        }
        if (o && o.runId) box.appendChild(runLogButton(o.runId));
      }
      strip.appendChild(box);
      const dismiss = el('button', 'rv-strip-dismiss', '×');
      dismiss.type = 'button';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.addEventListener('click', () => {
        runUi = null;
        renderStrip();
      });
      strip.appendChild(dismiss);
    }

    // ---- run-log viewer (WP6) ----
    // Owned by overlay-runlog.js. It takes apiRaw rather than fetching itself,
    // which is what keeps the single-fetch-call-site invariant true.
    const { runLogButton } = createRunLog({ host, apiRaw });

    // ---- #222: the floating stack card (panel closed) ---------------------
    // A dot click with the panel closed must not cost a 336px reflow. Up to
    // STACK_MAX comments open in a floating card beside the gutter, EVERY
    // member visible with its own actions — "a count that opens one comment
    // and hides two is worse than no count at all" (Blake). Past STACK_MAX
    // the panel is the better surface and opens filtered to exactly that row
    // (decision 2026-08-03, recorded in design/comment-gutter.md).
    const STACK_MAX = 4;
    let stackEl = null;
    // Tray state (Blake's approved redesign, 2026-08-12): the member list,
    // which member is expanded IN PLACE (null = rest, every card visible),
    // which member's reply box is open, and the mark rect the tray clamps to.
    let stackGroup = null;
    let stackExpanded = null;
    let stackReplying = null;
    let stackAt = null;
    // #267: set when the tray was opened from a FOLD mark — the <details>
    // those comments are hidden inside, and its name. The tray then offers
    // to unfold, which is the only thing that ever unfolds without you
    // asking for it by name (DECISION 4: nothing unfolds on a mark click).
    let stackFold = null;

    // #225: one place decides whether navigation scrolls animate.
    function scrollBehavior() {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      } catch { return 'smooth'; }
    }

    function closeStack() {
      if (!stackEl) return;
      stackEl.remove();
      stackEl = null;
      stackGroup = null;
      stackExpanded = null;
      stackReplying = null;
      stackAt = null;
      stackFold = null;
      window.removeEventListener('scroll', stackDismiss, true);
      document.removeEventListener('mousedown', stackDismiss, true);
      document.removeEventListener('keydown', stackEscape, true);
      if (gutter) gutter.tintExternal(null);
    }

    // #225 gave the tray Escape; the redesign made it a LADDER — one
    // consistent step-back key: reply → card → tray.
    function stackEscape(event) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (stackReplying !== null) { stackReplying = null; renderStackItems(); return; }
      if (stackExpanded !== null) { stackExpanded = null; renderStackItems(); return; }
      closeStack();
    }

    // The tint the tray asserts when no item is hovered: the expanded member
    // alone during an expansion, the whole set at rest.
    function stackTintBaseline() {
      if (!stackGroup) return null;
      if (stackExpanded !== null) {
        const one = stackGroup.filter((c) => c.id === stackExpanded);
        if (one.length > 0) return one;
      }
      return stackGroup;
    }

    // Scrolling the DOCUMENT dismisses the stack (its position over the text
    // is stale the moment the page moves); scrolling inside the stack's own
    // overflow, or clicking within it, keeps it.
    function stackDismiss(event) {
      if (stackEl && event.target instanceof Node && stackEl.contains(event.target)) return;
      closeStack();
    }

    function stackCard(comment) {
      const expanded = comment.id === stackExpanded;
      const item = el('div', `rv-stack-item${expanded ? ' rv-stack-open' : ''}`);
      // #220 narrowed: hovering an item shrinks the tint to this one comment;
      // leaving restores the tray's current baseline.
      item.addEventListener('mouseenter', () => { if (gutter) gutter.tintExternal([comment]); });
      item.addEventListener('mouseleave', () => {
        const base = stackTintBaseline();
        if (gutter && base) gutter.tintExternal(base);
      });

      const head = el('div', 'rv-stack-byline');
      head.appendChild(byline(comment));
      item.appendChild(head);
      const quote = comment.anchor && typeof comment.anchor.quote === 'string' ? comment.anchor.quote : '';
      if (quote) {
        const qEl = el('div', 'rv-stack-quote rv-stack-q', `“${truncate(quote, expanded ? 160 : 90)}”`);
        if (stackFold !== null) {
          // #267 (Blake, live pass 2026-08-13): the unfold rides EACH card,
          // beside the quote it would take you to — you decide to open a
          // section while reading one comment, not after scrolling past all
          // of them to a button at the bottom. It jumps to THIS comment,
          // which the single bottom button could not do.
          const row = el('div', 'rv-stack-q-row');
          row.appendChild(qEl);
          row.appendChild(stackUnfoldButton(comment));
          item.appendChild(row);
        } else {
          item.appendChild(qEl);
        }
      } else if (stackFold !== null) {
        const row = el('div', 'rv-stack-q-row');
        row.appendChild(el('span', 'rv-stack-q'));
        row.appendChild(stackUnfoldButton(comment));
        item.appendChild(row);
      }
      item.appendChild(el('div', 'rv-stack-body', stripMarkdown(comment.body)));

      // Expansion reveals the thread — the tray is a reading surface now,
      // not just an index (approved redesign).
      const replies = Array.isArray(comment.replies) ? comment.replies : [];
      if (expanded && replies.length > 0) {
        const th = el('div', 'rv-stack-thread');
        for (const r of replies) {
          const row = el('div', 'rv-stack-turn');
          row.appendChild(el('b', undefined,
            r.creator === 'agent' ? (r.agentName || 'agent') : 'user'));
          row.appendChild(document.createTextNode(` — ${stripMarkdown(r.body)}`));
          th.appendChild(row);
        }
        item.appendChild(th);
      }

      if (expanded && stackReplying === comment.id) {
        // The ONE editable box, in place of the action row.
        const followup = el('div', 'rv-followup');
        const ta = el('textarea', 'rv-followup-input');
        ta.placeholder = 'Add a reply';
        const fuSend = el('button', 'rv-btn rv-btn-primary', comment.status !== 'open' ? 'Reply & re-open' : 'Reply');
        fuSend.type = 'button';
        const fuCancel = el('button', 'rv-btn', 'Cancel');
        fuCancel.type = 'button';
        const postStackReply = async () => {
          const text = ta.value.trim();
          if (!text) return;
          fuSend.disabled = true;
          try {
            await api(`/api/comment/${encodeURIComponent(comment.id)}/reply`, { page, body: text });
            stackReplying = null;
            await refresh();
            renderStackItems();
          } catch { fuSend.disabled = false; }
        };
        fuSend.addEventListener('click', postStackReply);
        ta.addEventListener('keydown', (event) => {
          if (isSubmitShortcut(event)) { event.preventDefault(); postStackReply(); }
        });
        fuCancel.addEventListener('click', () => { stackReplying = null; renderStackItems(); });
        const fuActions = el('div', 'rv-followup-actions');
        fuActions.append(fuCancel, el('span', 'rv-actions-spacer'), fuSend);
        followup.append(ta, fuActions);
        item.appendChild(followup);
        requestAnimationFrame(() => ta.focus());
      } else {
        const actions = el('div', 'rv-actions');
        // Send to AI — the card's "Send now" semantics: reopen if settled,
        // then hand to the watcher (#212: nothing paid dispatches from here).
        const send = el('button', 'rv-btn', comment.status === 'failed' ? 'Retry' : 'Send to AI');
        send.type = 'button';
        if (runnerDown || isRunning() || !watcherAttached()) {
          send.disabled = true;
          send.title = runnerDown ? 'Needs the runner'
            : (isRunning() ? 'A run is already in progress'
              : 'Attach a watcher to act on comments');
        }
        send.addEventListener('click', async () => {
          send.disabled = true;
          try {
            if (comment.status !== 'open') {
              await api(`/api/comment/${encodeURIComponent(comment.id)}/status`, { page, status: 'open' });
            }
            startRun([comment.id]);
            closeStack();
          } catch { send.disabled = false; }
        });
        const replyBtn = el('button', 'rv-btn', 'Reply');
        replyBtn.type = 'button';
        replyBtn.addEventListener('click', () => {
          // Reply implies the expansion; the box opens inside it.
          stackExpanded = comment.id;
          stackReplying = comment.id;
          renderStackItems();
        });
        const resolveBtn = el('button', 'rv-btn', comment.status === 'resolved' ? 'Reopen' : 'Resolve');
        resolveBtn.type = 'button';
        if (runnerDown) { resolveBtn.disabled = true; resolveBtn.title = 'Needs the runner'; }
        resolveBtn.addEventListener('click', async () => {
          resolveBtn.disabled = true;
          try {
            await api(`/api/comment/${encodeURIComponent(comment.id)}/status`,
              { page, status: comment.status === 'resolved' ? 'open' : 'resolved' });
            await refresh();
            closeStack();
          } catch { resolveBtn.disabled = false; }
        });
        actions.append(send, replyBtn, el('span', 'rv-actions-spacer'), resolveBtn);
        item.appendChild(actions);
      }

      if (!expanded) {
        item.addEventListener('click', (event) => {
          if (event.target instanceof Element
            && event.target.closest('button, textarea')) return;
          stackExpanded = comment.id;
          stackReplying = null;
          renderStackItems();
        });
      }
      return item;
    }

    // A collapsed sibling while another card is expanded: avatar + quote,
    // one line. Clicking it MOVES the expansion — never stacks two.
    function stackSlim(comment) {
      const slim = el('div', 'rv-stack-slim');
      slim.appendChild(el('span', `rv-av${comment.creator === 'agent' ? '' : ' rv-av-anon'}`));
      const quote = comment.anchor && typeof comment.anchor.quote === 'string'
        ? comment.anchor.quote : stripMarkdown(comment.body);
      slim.appendChild(el('span', 'rv-stack-slim-q', `“${truncate(quote, 60)}”`));
      slim.addEventListener('mouseenter', () => { if (gutter) gutter.tintExternal([comment]); });
      slim.addEventListener('mouseleave', () => {
        const base = stackTintBaseline();
        if (gutter && base) gutter.tintExternal(base);
      });
      slim.addEventListener('click', () => {
        stackExpanded = comment.id; // the expansion MOVES, never stacks
        stackReplying = null;
        renderStackItems();
      });
      return slim;
    }

    // #267: the tray's one deliberate escalation — you have read a hidden
    // comment in place, and now you want its text. One per card, jumping to
    // THAT comment. Nothing unfolds without this click.
    function stackUnfoldButton(comment) {
      const btn = el('button', 'rv-stack-unfold-inline', 'Unfold');
      btn.type = 'button';
      btn.title = stackFold && stackFold.name
        ? `Unfold “${stackFold.name}” and jump to this text`
        : 'Unfold the section and jump to this text';
      btn.addEventListener('click', (event) => {
        event.stopPropagation(); // never also expands the card underneath
        const det = stackFold ? stackFold.el : null;
        closeStack(); // clears stackFold — read it out first
        if (det) det.open = true; // fires toggle: saveFolds + the gutter repositions
        const loc = locateAnchor(comment.anchor);
        if (loc) revealAnchor(loc, comment.anchor, comment.id);
      });
      return btn;
    }

    // Rebuild the tray's contents for the current state without moving the
    // tray itself, then re-clamp (expansion changes its height) and assert
    // the tint baseline.
    function renderStackItems() {
      if (!stackEl || !stackGroup) return;
      stackEl.replaceChildren();
      if (stackExpanded === null) {
        if (stackFold !== null) {
          // #267: name the fold rather than the position — "here" is exactly
          // what these comments do NOT have, which is why they are stacked.
          const n = stackGroup.length;
          stackEl.appendChild(el('div', 'rv-stack-head rv-stack-head-fold',
            `\u25B8 ${n} comment${n === 1 ? '' : 's'} in `
            + `${stackFold.name ? `\u201c${stackFold.name}\u201d` : 'this folded section'}`));
        } else if (stackGroup.length > 1) {
          stackEl.appendChild(el('div', 'rv-stack-head', `${stackGroup.length} comments here`));
        }
        for (const c of stackGroup) stackEl.appendChild(stackCard(c));
      } else {
        if (stackGroup.length > 1) {
          const back = el('button', 'rv-stack-back', `← All ${stackGroup.length} comments`);
          back.type = 'button';
          back.addEventListener('click', () => {
            stackExpanded = null;
            stackReplying = null;
            renderStackItems();
          });
          stackEl.appendChild(back);
        }
        for (const c of stackGroup) {
          stackEl.appendChild(c.id === stackExpanded ? stackCard(c) : stackSlim(c));
        }
      }
      const base = stackTintBaseline();
      if (gutter && base) gutter.tintExternal(base);
      clampStack();
    }

    // Clamp fully inside the viewport. Side rule (Blake, acceptance
    // 2026-08-12): prefer the empty space RIGHT of the mark — between the
    // gutter and the viewport edge — and only sit left, over the text, when
    // the window leaves no room there.
    function clampStack() {
      if (!stackEl) return;
      const width = 300; // matches .rv-stack in overlay.css
      const cardH = stackEl.offsetHeight || 0;
      const at = stackAt;
      const anchorTop = at && Number.isFinite(at.top) ? at.top : 80;
      const anchorLeft = at && Number.isFinite(at.left) ? at.left : window.innerWidth - 60;
      const anchorRight = at && Number.isFinite(at.right) ? at.right : anchorLeft + 12;
      const spaceRight = window.innerWidth - anchorRight;
      const left = spaceRight >= width + 20
        ? anchorRight + 12
        : Math.max(8, anchorLeft - width - 12);
      stackEl.style.left = `${left}px`;
      stackEl.style.top = `${Math.min(Math.max(8, anchorTop - 8),
        Math.max(8, window.innerHeight - cardH - 8))}px`;
    }

    function openStack(group, at, fold) {
      closeStack();
      stackGroup = group;
      stackExpanded = null;
      stackReplying = null;
      stackAt = at;
      stackFold = fold || null; // #267: set only for a fold mark
      stackEl = el('div', 'rv-stack');
      host.appendChild(stackEl);
      renderStackItems();
      window.addEventListener('scroll', stackDismiss, true);
      document.addEventListener('mousedown', stackDismiss, true);
      document.addEventListener('keydown', stackEscape, true);
    }

    // ---- comment gutter (#161) ----
    // A narrow column of dots beside the document, one per comment. The
    // gutter shows where comments are without marking the text. Assigned to
    // the pre-declared `gutter` variable so syncChrome() can reference it.
    gutter = createGutter({
      host,
      getComments: () => {
        // The status × audience axes bind both surfaces (#219); the ROW
        // filter deliberately does not (#260 amendment) — the gutter keeps
        // every dot while the sidecar narrows.
        // Buffered comments get a dot too (Blake, 2026-08-15). They are
        // anchored to real text and they are the ones their author is most
        // anxious about; leaving them out of the gutter is what made the
        // buffer feel unreliable.
        return everyComment().filter(passesAxisFilters);
      },
      onDotClick: (comment, opts) => {
        // Dot click: the dot IS the comment, so clicking it must land you ON
        // that comment — panel open, card EXPANDED, scrolled into view. The
        // old version opened the panel with everything collapsed, which read
        // as "which one was that about?" (Blake, acceptance 2026-08-12).
        // #224: the orphan flag leads straight into the re-anchor flow (#157)
        // — the one action an anchorless comment needs. The generic path
        // below would scroll to a card and stop there.
        if (opts && opts.orphan) {
          closeStack();
          if (!sidecarOpen) setSidecar(true);
          startManualReanchor(comment.id); // sets reanchorId + expandedId + the bar
          render();
          requestAnimationFrame(() => {
            const card = cards.querySelector(`[data-rv-comment="${CSS.escape(comment.id)}"]`);
            if (card) {
              uncollapseSectionOf(card); // its own section only
              card.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
            }
          });
          return;
        }
        const clickGroup = Array.isArray(opts && opts.cluster) && opts.cluster.length > 0
          ? opts.cluster : [comment];
        // #222: panel closed, a cluster opens as ALL of its comments in a
        // floating stack — no forced reflow. Past STACK_MAX the panel is the
        // better surface: open it filtered to exactly this row. Orphans keep
        // the panel (their card carries the re-anchor tools).
        if (!sidecarOpen && clickGroup.length <= STACK_MAX) {
          // #267 DECISION 4: a fold mark follows this rule EXACTLY. Four or
          // fewer hidden comments open in the tray, readable in full without
          // disturbing the document — which is worth more here than anywhere
          // else, because unfolding is the alternative. The tray then offers
          // the unfold as a deliberate second click.
          openStack(clickGroup, opts && opts.rect ? opts.rect : null,
            opts && opts.fold ? { el: opts.fold, name: opts.foldName || '' } : null);
          return;
        }
        closeStack();
        if (!sidecarOpen) { setSidecar(true); }
        // #260 (Blake, acceptance 2026-08-12): entering the panel from the
        // gutter FILTERS it to the mark's members — every case, single dots
        // included. Esc and clicking off are the way out.
        //
        // #269 (Blake, live pass 2026-08-13): entering a row NO LONGER resets
        // the status and audience axes. #222 reset them so the row's promise
        // was "exactly these comments", but that threw away a lens the author
        // had deliberately set — click a dot while reading only Active
        // comments and you were silently back to All. The axes now compose by
        // intersection, so the promise is "this row, through your lens".
        // Nothing to restore on exit, because nothing was clobbered.
        // #269: record WHAT was clicked, not just which ids — the chip names
        // a section, a group of comments, or a single comment, because "row"
        // described the 18px clustering rather than anything in the document.
        rowFilter = {
          ids: clickGroup.map((c) => c.id),
          kind: (opts && opts.fold) ? 'section' : (clickGroup.length > 1 ? 'cluster' : 'comment'),
          name: (opts && opts.foldName) ? opts.foldName : '',
        };
        expandedId = comment.id;
        render();
        // #221: the dot sits level with its anchor, so the anchor is
        // normally already on screen — scroll the DOCUMENT only when it is
        // not. A dot you can see must not move the page under your click.
        const anchorLoc = locateAnchor(comment.anchor);
        if (anchorLoc && !(typeof anchorLoc.hidden === 'function' && anchorLoc.hidden())) {
          const r = anchorLoc.rect();
          const onScreen = r.bottom > 0 && r.top < window.innerHeight;
          if (!onScreen && (r.width > 0 || r.height > 0)) {
            window.scrollTo({
              top: Math.max(0, r.top + window.scrollY - (window.innerHeight - r.height) / 2),
              behavior: scrollBehavior(), // #225: honours prefers-reduced-motion
            });
          }
        }
        // Defer to the next frame so the panel (and the expanded card's
        // height) have rendered before we scroll to it.
        requestAnimationFrame(() => {
          // A cluster chip says "2" — so TWO cards light up, not one
          // (Blake, acceptance 2026-08-12). The first is also expanded and
          // scrolled to; the rest flash where they sit.
          const group = Array.isArray(opts && opts.cluster) && opts.cluster.length > 0
            ? opts.cluster : [comment];
          group.forEach((c, i) => {
            const card = cards.querySelector(`[data-rv-comment="${CSS.escape(c.id)}"]`);
            if (!card) return;
            // #260: the first card goes to the TOP of the panel, not merely
            // into view — the list now holds only this row's comments, so
            // "where did it go" always has the same answer. (Supersedes
            // #221's visibility gate for gutter clicks; poll re-renders
            // still preserve scroll untouched.)
            if (i === 0) {
              uncollapseSectionOf(card); // its own section only
              card.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
            }
            // #260: light and fade SLOWLY — time to scan for what lit up.
            card.classList.add('rv-card-flash');
            setTimeout(() => card.classList.remove('rv-card-flash'), 2500);
          });
        });
      },
      onDotHover: (group) => {
        // #220: panel open, the hovered mark's cards light in the panel —
        // every cluster member, not just the first. group is null on leave.
        // (Panel closed, the gutter draws its own one-line label instead.)
        cards.querySelectorAll('.rv-card-lit').forEach((c) => c.classList.remove('rv-card-lit'));
        if (!group || !sidecarOpen) return;
        for (const c of group) {
          const card = cards.querySelector(`[data-rv-comment="${CSS.escape(c.id)}"]`);
          if (card) card.classList.add('rv-card-lit');
        }
      },
      panelOpen: () => sidecarOpen,
    });
    // The FIRST syncChrome() ran at init, before this factory existed — so a
    // fresh load in review mode drew no gutter until something else toggled
    // the chrome ("sometimes it is not present at all", Blake's live repro,
    // 2026-08-12). Now that the gutter exists, apply the chrome state again.
    syncChrome();

    // ---- scroll-and-flash on card click ----
    // Exactly one flash exists at a time: a new reveal clears the previous
    // one (rapid card clicks never stack), and each flash fades out via the
    // .rv-flash-out transition, then removes itself after FLASH_MS.
    let flashEl = null;
    let flashTimer = null;

    function clearFlash() {
      if (flashTimer !== null) {
        clearTimeout(flashTimer);
        flashTimer = null;
      }
      if (flashEl !== null) {
        flashEl.remove();
        flashEl = null;
      }
    }

    // Say plainly that we could not get there (#60). The message belongs ON
    // THE CARD you just clicked, not in a corner of the page: the click
    // happened in the sidecar, the eye is in the sidecar, and a bottom-centre
    // toast is both far away and easy to miss (Blake, verifying 2026-07-29).
    // One id at a time — the note describes the last reveal that failed.
    let hiddenAnchorId = null;
    function markAnchorHidden(commentId) {
      if (hiddenAnchorId === commentId) return;
      hiddenAnchorId = commentId ?? null;
      render();
    }
    function clearAnchorHidden() {
      if (hiddenAnchorId === null) return;
      hiddenAnchorId = null;
      render();
    }

    // #60: an anchor inside a display:none ancestor (a deck slide, a tab panel,
    // a closed accordion) is found by querySelector but measures 0x0 at the
    // origin — so scrolling to its rect sends you to the TOP OF THE DOCUMENT
    // with no flash and no error. Live on docs/handbook.html, which hides three
    // of its four pages.
    //
    // Ask the host page to reveal it first. rv:reveal is cancellable: a page
    // that handles it (switching to the right tab) should preventDefault to say
    // "I've got this", but we re-measure either way rather than trust the flag.
    // If it is still hidden, say so on the card instead of scrolling somewhere
    // wrong and pretending.
    function requestReveal(loc, anchor) {
      const el = typeof loc.element === 'function' ? loc.element() : null;
      if (!el) return;
      el.dispatchEvent(new CustomEvent('rv:reveal', {
        bubbles: true,
        cancelable: true,
        detail: {
          blockId: anchor && anchor.blockId ? anchor.blockId : null,
          quote: anchor && anchor.quote ? anchor.quote : null,
        },
      }));
    }

    function revealAnchor(loc, anchor, commentId) {
      clearFlash();
      if (typeof loc.hidden === 'function' && loc.hidden()) {
        requestReveal(loc, anchor);
        // Re-measure next frame: a host that switched tabs has laid out by then.
        requestAnimationFrame(() => {
          if (loc.hidden()) { markAnchorHidden(commentId); return; }
          revealAnchor(loc, anchor, commentId);
        });
        return;
      }
      // We got there — any previous "hidden" note is stale.
      clearAnchorHidden();
      const rect = loc.rect();
      const top = rect.top + window.scrollY;
      const left = rect.left + window.scrollX;
      window.scrollTo({
        top: Math.max(0, top - window.innerHeight / 3),
        behavior: scrollBehavior(), // #225: honours prefers-reduced-motion
      });
      const flash = el('div', 'rv-flash');
      flash.style.top = `${top - 3}px`;
      flash.style.left = `${Math.max(0, left - 4)}px`;
      flash.style.width = `${Math.max(0, rect.width + 8)}px`;
      flash.style.height = `${rect.height + 6}px`;
      host.appendChild(flash);
      flashEl = flash;
      // Two rAFs so the initial opacity paints before the fade starts.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (flashEl === flash) flash.classList.add('rv-flash-out');
      }));
      flashTimer = setTimeout(clearFlash, FLASH_MS);
    }

    // ---- persistent anchor highlight (while a card is expanded) ----
    // A subtle tint over the anchor's client rects that survives re-renders
    // and repositions on scroll/resize (WP2). Same positioned-div technique
    // as the flash/pending highlight — the document DOM is never mutated.
    // Exactly one highlight exists, tied to the expanded card.
    let hlBoxes = [];
    let hlLoc = null;
    let hlId = null;
    let hlListening = false;
    let hlRaf = 0;
    function positionHl() {
      if (hlLoc === null) return;
      // #257, layered: the block rect stays as soft ambient context, and the
      // EXACT quoted text (when the quote still exists in the block) gets a
      // deeper tint on its own line boxes. Both are positioned divs — the
      // document DOM is never touched. quoteRects() returns [] when the quote
      // is gone or absent, which degrades to exactly the old block-only tint.
      const ambient = hlLoc.rects();
      const exact = typeof hlLoc.quoteRects === 'function' ? hlLoc.quoteRects() : [];
      const want = [
        ...ambient.map((r) => ({ r, cls: 'rv-anchor-hl' })),
        ...exact.map((r) => ({ r, cls: 'rv-anchor-hl rv-anchor-exact' })),
      ];
      while (hlBoxes.length > want.length) hlBoxes.pop().remove();
      while (hlBoxes.length < want.length) {
        const box = el('div', 'rv-anchor-hl');
        host.appendChild(box);
        hlBoxes.push(box);
      }
      const scroll = { x: window.scrollX, y: window.scrollY };
      want.forEach(({ r, cls }, i) => {
        const box = hlBoxes[i];
        box.className = cls;
        if (r.width <= 0 || r.height <= 0) { box.style.display = 'none'; return; }
        const b = anchorBoxRect(r, scroll);
        box.style.display = '';
        box.style.top = `${b.top}px`;
        box.style.left = `${b.left}px`;
        box.style.width = `${b.width}px`;
        box.style.height = `${b.height}px`;
      });
    }

    function schedulePositionHl() {
      if (hlRaf !== 0) return;
      hlRaf = requestAnimationFrame(() => { hlRaf = 0; positionHl(); });
    }

    // Live fix (acceptance 2026-08-12): the docked-panel reflow animates the
    // html margin for 250ms, and boxes measured before it settles sit over
    // text that has since moved ("the highlights don't move with the text",
    // Blake). Re-measure when the margin lands, a beat after, the same way
    // the gutter snaps at transitionend.
    function onHlReflowEnd(e) {
      if (e && (e.propertyName === 'margin-right' || e.propertyName === 'margin')) {
        setTimeout(schedulePositionHl, 120);
      }
    }
    // …and VANISH while it animates, exactly like the gutter: boxes cannot
    // share the page's easing, so mid-flight they sit over moving text.
    // positionHl un-hides them when the re-measure lands (Blake, round 2).
    function onHlReflowStart(e) {
      if (e && (e.propertyName === 'margin-right' || e.propertyName === 'margin')) {
        for (const box of hlBoxes) box.style.display = 'none';
      }
    }

    function clearPersistentHighlight() {
      hlId = null;
      hlLoc = null;
      for (const box of hlBoxes) box.remove();
      hlBoxes = [];
      if (hlListening) {
        window.removeEventListener('scroll', schedulePositionHl, true);
        window.removeEventListener('resize', schedulePositionHl);
        document.documentElement.removeEventListener('transitionstart', onHlReflowStart);
        document.documentElement.removeEventListener('transitionend', onHlReflowEnd);
        hlListening = false;
      }
    }

    // #237: is this anchor's geometry trustworthy? An anchor inside a hidden
    // ancestor (display:none tab, closed accordion) — or one whose rects are
    // all zero-area — measures 0x0 at the origin, so drawing it would tint
    // the wrong line at the top of the document.
    function anchorConcealed(loc) {
      if (typeof loc.hidden === 'function' && loc.hidden()) return true;
      const rects = typeof loc.rects === 'function' ? loc.rects() : [];
      return !rects.some((r) => r.width > 0 && r.height > 0);
    }

    // Reconcile the persistent highlight with the currently expanded card.
    // Called at the end of every render() (cards rebuild on each poll, the
    // highlight lives in #rv-root and outlives them).
    function reconcileHighlight(visible) {
      const comment = expandedId === null ? null : visible.find((c) => c.id === expandedId);
      if (!comment) { clearPersistentHighlight(); return; }
      if (hlId === expandedId && hlLoc !== null) { positionHl(); return; }
      const loc = locateAnchor(comment.anchor);
      if (loc === null) { clearPersistentHighlight(); return; }
      // #237: hidden or degenerate geometry draws NOTHING; the card carries
      // the hidden note instead (markAnchorHidden no-ops on a repeat id, so
      // the render it triggers terminates). hlLoc stays null, so every render
      // re-evaluates — the tint appears as soon as the content is revealed.
      if (anchorConcealed(loc)) {
        clearPersistentHighlight();
        markAnchorHidden(comment.id);
        return;
      }
      clearPersistentHighlight();
      hlId = expandedId;
      hlLoc = loc;
      positionHl();
      window.addEventListener('scroll', schedulePositionHl, true);
      window.addEventListener('resize', schedulePositionHl);
      document.documentElement.addEventListener('transitionstart', onHlReflowStart);
      document.documentElement.addEventListener('transitionend', onHlReflowEnd);
      hlListening = true;
      // The anchor is visibly tinted now, so a stale hidden note comes off.
      // (The render this triggers takes the hlId shortcut above.)
      if (comment.id === hiddenAnchorId) clearAnchorHidden();
    }

    // ---- who holds which block, and how it is drawn (#189 · #191) ----------
    //
    // Invisible locking is locking nobody trusts, and a paragraph that
    // mysteriously will not accept an edit is the worst version of it. So every
    // held block carries a mark.
    //
    // Decision 22: TEAL is an agent-held block, VIOLET a human-held one — and
    // because two hues now carry distinct meaning, neither may rely on hue.
    // Teal and violet are a common confusion pair and are worst exactly where
    // this lives, at the low saturation quiet chrome uses. So the rail PATTERN
    // carries the actor (solid = agent, segmented = human), the tag's border
    // repeats it (solid = agent, dashed = human, per `.lease-tag.human` in the
    // mocks), and both always name the holder in words. Three channels; the
    // mock proves the greyscale case.

    function agentLabel() {
      const s = statusInfo && statusInfo.session ? statusInfo.session : null;
      // #211: include the derived handle so two sessions of the same type
      // are distinguishable in lease tags too, not just the banner.
      const withHandle = (name, handle) =>
        handle ? `${name} · ${handle}` : name;
      if (s && typeof s.agentName === 'string' && s.agentName.length > 0)
        return withHandle(s.agentName, s.handle);
      if (sessionSeen !== null && sessionSeen.agentName)
        return withHandle(sessionSeen.agentName, sessionSeen.handle);
      return 'another session';
    }

    /** blockId → {kind:'human'|'agent', label} for every leased block. */
    function leaseHolders() {
      const out = new Map();
      const s = statusInfo;
      const byId = new Map();
      if (s && Array.isArray(s.runs)) for (const r of s.runs) byId.set(r.runId, r);
      const map = (s && s.leases && typeof s.leases === 'object') ? s.leases : {};
      for (const blockId of Object.keys(map)) {
        // '*' is a page-wide writer (undo, instrument, a batch run). There is no
        // single contended block to rail, and the run strip already says a run
        // is in flight — drawing every paragraph teal would be a warning about
        // something the panel has already explained.
        if (blockId === '*') continue;
        const rec = byId.get(map[blockId]) || null;
        const holder = rec && typeof rec.holder === 'string' ? rec.holder : null;
        out.set(blockId, holder === tabSession
          ? { kind: 'human', label: 'you are editing', leaseId: map[blockId], forceable: false }
          : {
            kind: 'agent',
            label: `${agentLabel()} is writing here`,
            leaseId: map[blockId],
            // Only a HELD lease may be broken. A run's lease is mid-write
            // against a document it already dry-ran, and yanking it would
            // leave it writing outside its lease — the one thing the ledger
            // exists to prevent. The runner refuses it anyway; not offering
            // the door is how the author finds that out without trying.
            forceable: rec !== null && rec.lane === 'session-hold',
          });
      }
      // Our own claim, the instant the ledger grants it. /api/status lags by a
      // poll, and the violet rail has to appear when the composer does rather
      // than four seconds later — the mark IS the feedback that the claim
      // landed.
      if (heldLease !== null) {
        out.set(heldLease.blockId,
          { kind: 'human', label: 'you are editing', leaseId: heldLease.leaseId, forceable: false });
      }
      return out;
    }

    // The break-glass door (#188, #191). First holder wins and there is no
    // eviction verb for the agent — but "restart the runner" is not an answer a
    // document editor may give its author, so when the machine is simply wrong
    // the human needs a way through. It is RECORDED: the runner writes a
    // `lane: 'lease-force-release'` run so the session whose lease was yanked
    // can learn why its next write failed, instead of guessing.
    async function forceRelease(blockId) {
      const who = leaseHolders().get(blockId) || null;
      if (who === null || !who.forceable) return;
      try {
        await apiRaw(`/api/lease/${encodeURIComponent(who.leaseId)}?force=1`,
          undefined, { method: 'DELETE' });
      } catch { return; }
      leaseRefused = null;
      await refresh();
    }

    function clearLeaseOverlays() {
      for (const box of leaseBoxes) box.remove();
      leaseBoxes = [];
    }
    function scheduleLeaseOverlays() {
      if (leaseRaf !== 0) return;
      leaseRaf = requestAnimationFrame(() => { leaseRaf = 0; positionLeaseOverlays(); });
    }
    function stopLeaseWatch() {
      if (!leaseListening) return;
      window.removeEventListener('scroll', scheduleLeaseOverlays, true);
      window.removeEventListener('resize', scheduleLeaseOverlays);
      leaseListening = false;
    }

    // Positioned boxes in #rv-root over the block's client rects, exactly like
    // the anchor highlight — the document DOM is never mutated inside a block,
    // which is the standing invariant and also the only way this can coexist
    // with an in-place contenteditable edit.
    function positionLeaseOverlays() {
      clearLeaseOverlays();
      // View only means the page is NATIVE: no pill, no pencil, no marks over
      // the text. The leases are still real and the panel is hidden anyway, so
      // there is nothing here for a reader who has put the tool away.
      if (!redline) { stopLeaseWatch(); return; }
      const holders = leaseHolders();
      if (holders.size === 0) { stopLeaseWatch(); return; }
      const scroll = { x: window.scrollX, y: window.scrollY };
      for (const [blockId, who] of holders) {
        let bEl = null;
        try { bEl = document.querySelector(`[data-rev="${CSS.escape(blockId)}"]`); } catch { /* bad id */ }
        if (!bEl || bEl.closest('#rv-root')) continue;
        const r = bEl.getBoundingClientRect();
        if (r.width <= 0 && r.height <= 0) continue;
        // THE RAIL IS THE WHOLE AT-REST STATE. No pill and no tint: a label
        // hung above a held paragraph overlaps the block above it, and it would
        // charge every held block for a fact you only need at the moment you
        // try to type.
        const rail = el('div', `rv-lease-rail rv-lease-${who.kind}`);
        rail.setAttribute('data-rv-lease', blockId);
        rail.setAttribute('data-rv-lease-kind', who.kind);
        rail.style.top = `${r.top + scroll.y - 3}px`;
        rail.style.left = `${Math.max(0, r.left + scroll.x - 11)}px`;
        rail.style.height = `${Math.max(0, r.height + 6)}px`;
        host.appendChild(rail);
        leaseBoxes.push(rail);
        if (leaseHoverId !== blockId) continue;
        // ON APPROACH: the veil and the holder's name. The information arrives
        // exactly when the intent does — approaching the paragraph is the
        // moment you might act on it. No padlock: a lock glyph would say "you
        // may not touch this", and that is false. Reading, commenting and
        // replying all still work; only the write is gated.
        const veil = el('div', `rv-lease-veil rv-lease-${who.kind}`);
        veil.style.top = `${r.top + scroll.y - 3}px`;
        veil.style.left = `${Math.max(0, r.left + scroll.x - 8)}px`;
        veil.style.width = `${r.width + 16}px`;
        veil.style.height = `${Math.max(0, r.height + 6)}px`;
        host.appendChild(veil);
        leaseBoxes.push(veil);
        const tag = el('div', `rv-lease-tag rv-lease-${who.kind}`, who.label);
        tag.setAttribute('data-rv-lease-tag', blockId);
        tag.style.top = `${Math.max(0, r.top + scroll.y - 24)}px`;
        tag.style.left = `${Math.max(0, r.left + scroll.x)}px`;
        host.appendChild(tag);
        leaseBoxes.push(tag);
      }
      if (!leaseListening) {
        window.addEventListener('scroll', scheduleLeaseOverlays, true);
        window.addEventListener('resize', scheduleLeaseOverlays);
        leaseListening = true;
      }
    }

    function setLeaseHover(blockId) {
      const next = (blockId !== null && leaseHolders().has(blockId)) ? blockId : null;
      if (next === leaseHoverId) return;
      leaseHoverId = next;
      positionLeaseOverlays();
    }
    // Used when a refusal has to explain itself without being hovered for: the
    // author reached for Edit text and was told no, so the name appears anyway.
    function showLeaseHover(blockId) {
      leaseHoverId = blockId;
      positionLeaseOverlays();
    }

    // #210: a refusal capsule that is visually distinct from the hover veil.
    // The hover veil is ambient — you see it by approaching the block. This is
    // a RESPONSE to an action: you pressed Edit and were told no. It appears
    // over the block, names the holder, and auto-dismisses after 4 seconds.
    function showLeaseRefusal(blockId) {
      // Still show the hover veil so the holder's name is visible, but ALSO
      // show a capsule that reads as a response, not as an ambient state.
      showLeaseHover(blockId);
      // Clear any previous refusal capsule.
      if (leaseRefusalBox) { leaseRefusalBox.remove(); leaseRefusalBox = null; }
      if (leaseRefusalTimer) { clearTimeout(leaseRefusalTimer); leaseRefusalTimer = null; }
      const who = leaseHolders().get(blockId);
      const holderLabel = who ? who.label : 'someone is writing here';
      let bEl = null;
      try { bEl = document.querySelector(`[data-rev="${CSS.escape(blockId)}"]`); } catch { /* bad id */ }
      if (!bEl || bEl.closest('#rv-root')) return;
      const r = bEl.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return;
      const scroll = { x: window.scrollX, y: window.scrollY };
      const cap = el('div', 'rv-lease-refusal');
      const body = el('div', 'rv-lease-refusal-body');
      body.appendChild(el('div', 'rv-lease-refusal-title', "Can't edit"));
      body.appendChild(el('div', 'rv-lease-refusal-sub', holderLabel));
      cap.appendChild(body);
      cap.style.top = `${Math.max(0, r.top + scroll.y - 28)}px`;
      cap.style.left = `${Math.max(0, r.left + scroll.x)}px`;
      host.appendChild(cap);
      leaseRefusalBox = cap;
      leaseRefusalTimer = setTimeout(() => {
        if (leaseRefusalBox) { leaseRefusalBox.remove(); leaseRefusalBox = null; }
        leaseRefusalTimer = null;
      }, 4000);
    }

    // ---- panel rendering ----
    // Keeping the caret through a redraw. The draft map above preserves the
    // WORDS; this preserves the place you were typing them, which is the half
    // an author actually notices — a composer that keeps its text but loses
    // focus and caret mid-word still reads as "it closed on me".
    function captureCardFocus() {
      const active = document.activeElement;
      if (!active || typeof active.closest !== 'function') return null;
      const box = active.closest('.rv-followup-input');
      if (!box || !cards.contains(box)) return null;
      const owner = box.closest('[data-rv-comment]');
      if (!owner) return null;
      return {
        id: owner.getAttribute('data-rv-comment'),
        start: box.selectionStart ?? null,
        end: box.selectionEnd ?? null,
      };
    }
    function restoreCardFocus(saved) {
      if (!saved) return;
      let owner = null;
      try {
        owner = cards.querySelector(`[data-rv-comment="${CSS.escape(saved.id)}"]`);
      } catch { /* an id CSS.escape cannot express — nothing to restore into */ }
      const box = owner ? owner.querySelector('.rv-followup-input') : null;
      if (!box) return;
      box.focus();
      if (saved.start !== null && typeof box.setSelectionRange === 'function') {
        try { box.setSelectionRange(saved.start, saved.end); } catch { /* not selectable */ }
      }
    }

    function renderEmpty(message, { clearSearch = false } = {}) {
      const box = el('div', 'rv-empty');
      box.appendChild(el('div', undefined, message));
      if (clearSearch) {
        // The way out is on the dead end itself — the box is a header row
        // above, and "nothing matches" is exactly when it stops being obvious
        // that a search is what emptied the list.
        const btn = el('button', 'rv-btn rv-empty-clear', 'Clear search');
        btn.type = 'button';
        btn.addEventListener('click', () => { setSearch(''); searchInput.focus(); });
        box.appendChild(btn);
      }
      cards.replaceChildren(box);
    }

    // ---- the search's own chrome (#268) -------------------------------------
    //
    // Two things it can say, never both: the query is four characters the
    // handle alphabet cannot emit (D8a), or a handle match was shown past a
    // lens that was hiding it (D8). A handle that reached past was a valid
    // handle by definition, so the cases cannot overlap.
    function renderSearchChrome(pinned) {
      searchClear.classList.toggle('rv-hidden', !searchPrepared.active);
      searchBox.classList.toggle('rv-searchbox-on', searchPrepared.active);
      let note = '';
      if (searchPrepared.invalidHandle) {
        note = `“${searchPrepared.raw}” is not a valid handle — searching as text instead.`
          + ' Handles never contain 0 1 i l o u.';
      } else if (pinned) {
        const lens = searchReachedPast(pinned, filterState());
        if (lens) note = `Handle ${searchPrepared.handle} — showing it past your ${lens} filter.`;
      }
      searchNote.textContent = note;
      searchNote.classList.toggle('rv-hidden', note === '');
    }

    // ---- marking the hits inside a card (#268 D13) --------------------------
    //
    // The offsets come from the model's fold map, so a match found through
    // accent folding or a curly apostrophe still lands on the right characters
    // of the ORIGINAL text.
    //
    // Per TEXT NODE, deliberately: a phrase spanning a **bold** run is two
    // nodes in the rendered markdown and goes unmarked. The card still MATCHES
    // and still shows — which is the part the feature is for — and the
    // alternative is re-flowing prose the renderer has already built.
    function hitNodes(text) {
      const hits = searchHits(text, searchPrepared);
      if (hits.length === 0) return null;
      const out = [];
      let at = 0;
      for (const h of hits) {
        if (h.start > at) out.push(document.createTextNode(text.slice(at, h.start)));
        out.push(el('mark', 'rv-hit', text.slice(h.start, h.end)));
        at = h.end;
      }
      if (at < text.length) out.push(document.createTextNode(text.slice(at)));
      return out;
    }
    // A plain-text card line, with its hits marked.
    function hitText(className, text) {
      const node = el('div', className);
      const raw = String(text ?? '');
      const nodes = searchPrepared.active ? hitNodes(raw) : null;
      if (nodes) node.append(...nodes);
      else node.textContent = raw;
      return node;
    }
    // The same, over an already-built subtree — the markdown surfaces.
    function paintHits(node) {
      if (!searchPrepared.active || !node) return node;
      const walk = (parent) => {
        for (const child of [...(parent.childNodes || [])]) {
          if (child.nodeType === 3) {
            const nodes = hitNodes(String(child.nodeValue ?? ''));
            if (!nodes) continue;
            for (const n of nodes) parent.insertBefore(n, child);
            parent.removeChild(child);
            continue;
          }
          if (child.nodeType === 1 && child.tagName !== 'MARK') walk(child);
        }
      };
      walk(node);
      return node;
    }

    // The Send All set: OPEN comments passing the active filter, minus any the
    // author has switched OUT of AI edits (#96). aiEdits === false is the only
    // opt-out; absent/true stays in the batch. A one-off Send still works on an
    // opted-out comment — this only governs the batch.
    // The Send All set: OPEN, AI-directed comments passing BOTH filter axes.
    // A buffered comment is excluded — it does not exist server-side yet, so
    // there is no id to send.
    function sendableComments() {
      return comments.filter((c) => c.status === 'open' && inAiBatch(c) && passesFilters(c));
    }

    function render() {
      renderBanner();
      // #265: a rebuild replaces every card node; card() re-sets this while
      // building the expanded one, and the empty paths leave it cleared.
      expandedCardEl = null;
      // Held blocks are drawn on every pass: a lease can appear or vanish
      // without anything else on the panel moving (#191).
      positionLeaseOverlays();
      if (composerLeasePaint !== null) composerLeasePaint();
      // Buffered comments (#202) render in the list beside saved ones, at the
      // same place in the document, because that is where their author expects
      // to find their own writing. What tells them apart is the card, not a
      // separate holding pen.
      const all = everyComment();
      // #105: read the panel top-to-bottom like the document. Measured ONCE
      // here, not once per comparison — locateAnchor forces layout.
      const inLens = sortByDocumentOrder(all.filter(passesFilters), locateAnchor);
      // D9: the handle match leads, text matches follow — nothing suppressed.
      // At most one comment can carry a given handle, so this is a find, not a
      // partition.
      const pinned = searchPrepared.active
        ? inLens.find((c) => isHandleMatch(c, searchPrepared)) ?? null
        : null;
      const shown = pinned
        ? [pinned, ...inLens.filter((c) => c !== pinned)]
        : inLens;
      renderSearchChrome(pinned);
      headerTitle.textContent = all.length === 0
        ? 'Review'
        : shown.length === all.length
          ? `${all.length} comment${all.length === 1 ? '' : 's'}`
          : `${shown.length} of ${all.length} comments`;
      // two dropdowns (status × audience), each option carrying its own count
      fillSelect(statusSel, FILTERS, filter);
      fillSelect(audSel, AUD_FILTERS, audienceFilter);
      // #222: the row chip states the axis and carries its own exit.
      // #269: the chip names what was clicked, and states the composition
      // when the lens is hiding members. It shares the title line, so the
      // title yields while it is up rather than the two competing.
      const chip = rowChipLabel(rowFilter, rowFilter
        ? shown.filter((c) => rowFilter.ids.includes(c.id)).length : 0);
      rowChip.classList.toggle('rv-hidden', !chip);
      headerTitle.classList.toggle('rv-hidden', Boolean(chip));
      if (chip) {
        rowChipLbl.textContent = chip.text;
        rowChipLbl.disabled = !chip.canWiden;
        rowChipLbl.title = chip.title;
        rowChip.title = chip.title;
      }
      renderAudienceState();
      const canUndo = UNDO_UI_ENABLED
        && Boolean(statusInfo && statusInfo.lastRun
          && (statusInfo.lastRun.status === 'ok' || statusInfo.lastRun.status === 'partial'))
        && !isRunning();
      undoWrap.classList.toggle('rv-hidden', !canUndo);
      undoWrap.classList.toggle('rv-explaining', runnerDown);
      undoBtn.disabled = runnerDown;
      undoBtn.title = runnerDown ? '' : 'Undo the last run';
      // Send all is ALWAYS visible now: disabled at zero, live from one.
      // #212: disabled when no watcher is attached — no paid path in V1.
      const sendable = sendableComments();
      const hasWatcher = watcherAttached();
      sendAllBtn.textContent = `Send all (${sendable.length})`;
      sendAllBtn.disabled = runnerDown || sendable.length === 0 || isRunning() || !hasWatcher;
      // The hover capsule takes over from the tooltip when the reason is the
      // runner or the absence of a watcher.
      const needsWatcher = !hasWatcher && sendable.length > 0 && !runnerDown;
      // #254: with a watcher live and hold OFF, Send dispatches nothing — the
      // watcher already sees every comment. Say so on HOVER, before the
      // click, through the same capsule the refusals use (the control stays
      // live; clicking is still the subdued reassurance strip).
      const holdNow = holdState();
      const watching = hasWatcher && !runnerDown && sendable.length > 0
        && !(holdNow && holdNow.on) && !isRunning();
      sendAllWrap.classList.toggle('rv-explaining', runnerDown || needsWatcher || watching);
      sendAllBtn.title = (runnerDown || watching) ? ''
        : (needsWatcher
          ? 'Attach a watcher to act on comments'
          : (sendable.length === 0
            ? 'Nothing to send — no open comments for the AI under this filter'
            : `Hand ${sendable.length} open comment${sendable.length === 1 ? '' : 's'} to the watcher`));
      // Update the capsule text for the no-watcher case. #214: the reason is
      // data on the wrap now — the capsule is built from it on approach.
      if (needsWatcher) {
        // The only sub that survives the cut on this control: it is a next
        // step, not a restatement of the title.
        setCapsuleWhy(sendAllWrap, 'No watcher attached', 'Attach a Claude Code or Codex session');
      } else if (runnerDown) {
        setCapsuleWhy(sendAllWrap, 'Needs the runner');
      } else if (watching) {
        setCapsuleWhy(sendAllWrap, 'The watcher already sees these comments',
          'Send nudges it to take another pass at them');
      }
      renderStrip();
      if (all.length === 0) {
        cycleOrder = [];
        renderEmpty('No comments yet. Select text in the document to add one.');
        reconcileHighlight(shown);
        applyCycleHighlight();
        return;
      }
      if (shown.length === 0) {
        cycleOrder = [];
        if (searchPrepared.active) {
          renderEmpty(`No comments match “${searchPrepared.raw}”.`, { clearSearch: true });
        } else {
          renderEmpty('No comments match this filter.');
        }
        reconcileHighlight(shown);
        applyCycleHighlight();
        return;
      }
      // #221: replaceChildren empties the list, which zeroes the scroll box —
      // without putting it back, every poll re-render and every dot click
      // snapped the panel to the top ("Every click seems to jump the sidebar
      // back to the top", Blake, prototype).
      const scrolled = cards.scrollTop;
      const focused = captureCardFocus();
      cards.replaceChildren(...buildSections(shown, pinned ? pinned.id : null));
      reconcileHighlight(shown);
      applyCycleHighlight();
      // #161: reposition the gutter dots after a render.
      if (gutter) gutter.scheduleReposition();
      restoreCardFocus(focused);
      cards.scrollTop = scrolled;
    }

    // Panel-section folds are review state too (Blake, round 2, on 0.4.56):
    // the card list rebuilds on EVERY render — which any card click triggers
    // — so DOM-only collapse state meant collapsing Open and then touching
    // any Addressed card sprang Open back. Keyed by section title, persisted
    // like the document folds so run-reloads keep it as well.
    const SECTIONS_KEY_PREFIX = 'rv-sections:';
    let collapsedSections = new Set();
    try {
      const rawSections = sessionStorage.getItem(SECTIONS_KEY_PREFIX + page);
      if (rawSections) collapsedSections = new Set(JSON.parse(rawSections));
    } catch { /* fresh state */ }
    function saveCollapsedSections() {
      try {
        sessionStorage.setItem(SECTIONS_KEY_PREFIX + page, JSON.stringify([...collapsedSections]));
      } catch { /* cosmetic */ }
    }
    // Deliberate navigation to a card unfolds ITS section — never any other:
    // a dot click must land you on the comment even when its section is
    // collapsed, and unfolding only the target's home is what keeps that
    // from undoing the folds you made to focus.
    function uncollapseSectionOf(cardEl) {
      const sec = cardEl.closest('.rv-section');
      if (!sec || !sec.classList.contains('rv-collapsed')) return;
      sec.classList.remove('rv-collapsed');
      const secBody = sec.querySelector(':scope > .rv-section-body');
      if (secBody) secBody.classList.remove('rv-hidden');
      const titleEl = sec.querySelector('.rv-section-title');
      if (titleEl) {
        collapsedSections.delete(titleEl.textContent);
        saveCollapsedSections();
      }
    }

    // A collapsible section: a clickable header (title + count) over a body of
    // cards (or sub-sections). Clicking the header collapses/expands it (WP9).
    function sectionContainer(title, items, { sub = false, cls = '' } = {}) {
      const wrap = el('div', `${sub ? 'rv-subsection' : 'rv-section'}${cls ? ` ${cls}` : ''}`);
      const head = el('div', 'rv-section-head');
      head.appendChild(el('span', 'rv-section-title', title));
      head.appendChild(el('span', 'rv-section-count', String(items.length)));
      const body = el('div', 'rv-section-body');
      for (const c of items) body.appendChild(card(c));
      // #268 D13: while a search is active every card in this section is a
      // match, so a fold you made earlier would hide the very thing you just
      // asked for. Clearing the search restores the fold — `collapsedSections`
      // is untouched, only ignored.
      if (collapsedSections.has(title) && !searchPrepared.active) {
        wrap.classList.add('rv-collapsed');
        body.classList.add('rv-hidden');
      }
      head.addEventListener('click', () => {
        const collapsed = wrap.classList.toggle('rv-collapsed');
        body.classList.toggle('rv-hidden', collapsed);
        if (collapsed) collapsedSections.add(title);
        else collapsedSections.delete(title);
        saveCollapsedSections();
      });
      wrap.appendChild(head);
      wrap.appendChild(body);
      return wrap;
    }

    // Ordered lifecycle sections (#96: flattened). Open, then each actioned
    // status as its OWN top-level heading — Addressed/Declined/Deferred/Failed
    // no longer nest under a "Recently actioned" wrapper, since the card rail
    // already distinguishes them — then Resolved. Empty sections are omitted.
    function buildSections(shown, pinnedId = null) {
      // A buffered comment whose replay failed is not "open" — nothing will
      // happen to it until the author acts. It gets the top of the panel and
      // its own heading, because the alternative is a card that looks like
      // ordinary work while holding the only copy of some writing (#202).
      const stuck = shown.filter((c) => c.local && c.failed);
      const groups = groupComments(shown.filter((c) => !(c.local && c.failed)));
      const built = [];
      const add = (title, items, cls) => {
        built.push({ node: sectionContainer(title, items, { cls }), ids: items.map((c) => c.id) });
      };
      if (stuck.length > 0) add('Needs attention', stuck, 'rv-section-attention');
      if (groups.open.length > 0) add('Open', groups.open, 'rv-section-open');
      for (const k of ACTIONED_ORDER) {
        if (groups.actioned[k].length === 0) continue;
        add(k.charAt(0).toUpperCase() + k.slice(1), groups.actioned[k], `rv-section-${k}`);
      }
      if (groups.resolved.length > 0) add('Resolved', groups.resolved, 'rv-section-resolved');
      // #268 D9: a handle match leads the panel. Its lifecycle SECTION is
      // hoisted whole rather than the card being lifted out of it — the card
      // keeps the heading that says what state it is in, which is most of why
      // you asked for it by name (the mock draws it under "Resolved").
      // `shown` already puts the pinned comment first inside its group, so it
      // leads the section too.
      if (pinnedId) {
        const at = built.findIndex((s) => s.ids.includes(pinnedId));
        if (at > 0) built.unshift(built.splice(at, 1)[0]);
      }
      // Record the flat display order for the ↑/↓ cursor (#149) — after the
      // hoist, so the arrows walk what the panel actually shows.
      cycleOrder = built.flatMap((s) => s.ids);
      return built.map((s) => s.node);
    }

    // The page's run records for commentHistory (#199). When /api/comments
    // does not carry `runs` — a runner predating the field — the ONE run
    // /api/status reports is everything the overlay can see, and
    // commentHistory falls back to comment.resolution for anything older.
    function pageRuns() {
      if (runRecords.length > 0) return runRecords;
      const last = statusInfo && statusInfo.lastRun;
      return last ? [last] : [];
    }

    // Who wrote this — the identity slot (#201). Two values, because two is
    // what the system knows: `user` for anything a human wrote, the session's
    // own name for anything an agent wrote. No display name, no initials and no
    // picture, because there is no identity service to supply them. The 18px
    // disc is drawn anyway so a real name and avatar later are a DATA change
    // rather than a re-layout; the mark inside it is angular for a session and
    // a round dot for a person, so the greyscale test still passes.
    function byline(item) {
      const agent = item.creator === 'agent';
      const wrap = el('span', `rv-by${agent ? ' rv-by-agent' : ''}`);
      wrap.appendChild(el('span', `rv-av${agent ? '' : ' rv-av-anon'}`));
      const name = agent ? (item.agentName || 'agent') : 'user';
      const label = el('span', 'rv-byname', name);
      // The citable handle (#203) rides in the slot the design already drew for
      // "name · short mono token" — so the card gains a name you can say out
      // loud without gaining a row. A buffered comment has no server id yet, so
      // it has no handle either; giving it one would promise a stable reference
      // that changes the moment it saves.
      const ref = item.local ? '' : shortRef(item.id);
      if (ref) label.appendChild(el('span', 'rv-byref', ref));
      wrap.appendChild(label);
      wrap.title = agent ? `Written by ${name}` : 'Written by a person';
      if (ref) wrap.title += ` — call this comment ${ref} (${item.id})`;
      return wrap;
    }

    // Wrap a control so it explains itself while the runner is down (#196).
    // Everything a card can do EXCEPT reading is a write, and no write except a
    // new comment buffers — so when the runner is unreachable these must refuse
    // VISIBLY. Blake hit the alternative: Reopen re-enabled its own button and
    // changed nothing, which is indistinguishable from the app ignoring you.
    // ---- the refusal capsule (#214) ---------------------------------------
    // The capsule renders into #rv-root, NOT inside the refused control's
    // wrapper. Nested, it was clipped by `.rv-card { overflow: hidden }` on a
    // collapsed card, and worse: on controls near the panel's bottom edge —
    // Reply is the reported one — it landed outside `.rv-cards`' scroll box
    // entirely, so the control refused and explained nothing at all. #196's
    // mechanism reported success while the author saw silence.
    //
    // (0.4.10 tried `overflow: visible` on the capsule. A descendant cannot
    // escape an ancestor's clip, so it was always a no-op.)
    //
    // Escaping to the root also settles the material question. The blur
    // guardrail admits backdrop-filter on the floating chrome layer only, and
    // banned the capsule as glass-on-glass while it sat inside a card. Drawn
    // over the document from the root it IS that layer — the same reasoning
    // that admitted the selection pill in #150.
    //
    // The reason travels as data on the wrap so it stays assertable without a
    // hover, and so callers can update it in place (Send all's no-watcher
    // variant does).
    function setCapsuleWhy(wrap, title, sub) {
      wrap.setAttribute('data-cap-title', title || '');
      if (sub) wrap.setAttribute('data-cap-sub', sub);
      else wrap.removeAttribute('data-cap-sub');
    }
    function hideCapsule() { if (capsuleEl) { capsuleEl.remove(); capsuleEl = null; } }
    function showCapsule(anchor, title, sub) {
      hideCapsule();
      if (!title || !anchor) return null;
      // -float carries the positioning. The pencil's own capsules stay nested
      // inside its hover target (it already lives in #rv-root, so it never
      // clipped) and one of them holds a button, which a transient hover-built
      // capsule could not.
      capsuleEl = el('div', 'rv-capsule rv-capsule-float rv-sev-down');
      const body = el('span', 'rv-cap-body');
      body.appendChild(el('span', 'rv-cap-title', title));
      // A sub only when it earns its place — a differentiator or a next step.
      // Five of the seven refusals were restating the title in two sentences.
      if (sub) body.appendChild(el('span', 'rv-cap-sub', sub));
      capsuleEl.appendChild(body);
      host.appendChild(capsuleEl);
      const r = anchor.getBoundingClientRect();
      const h = capsuleEl.offsetHeight || 0;
      const w = capsuleEl.offsetWidth || 0;
      // Below by default, flipped above when the viewport has no room. Without
      // the flip the Reply capsule is drawn off-screen and says nothing.
      const room = (window.innerHeight || 0) - r.bottom - 8;
      const above = h > 0 && room < h;
      const top = above ? Math.max(8, r.top - 8 - h) : r.bottom + 8;
      const left = Math.max(8, Math.min(r.right - w, (window.innerWidth || 0) - w - 8));
      capsuleEl.style.top = `${top + (window.scrollY || 0)}px`;
      capsuleEl.style.left = `${left + (window.scrollX || 0)}px`;
      return capsuleEl;
    }
    // Arm a wrap so the capsule appears on approach and leaves with it.
    // focusin/focusout carry the keyboard: a disabled button is not focusable,
    // so the wrap is what receives it.
    function armCapsule(wrap, anchor) {
      const show = () => {
        if (!wrap.classList.contains('rv-explaining')) return;
        showCapsule(anchor, wrap.getAttribute('data-cap-title'), wrap.getAttribute('data-cap-sub'));
      };
      wrap.addEventListener('mouseenter', show);
      wrap.addEventListener('focusin', show);
      wrap.addEventListener('mouseleave', hideCapsule);
      wrap.addEventListener('focusout', hideCapsule);
    }
    // #254: the informational twin of refuseWhenDown — the same capsule on
    // approach, but the control stays LIVE. Used where knowing before the
    // click changes what the click means (Send with a watcher attached is a
    // nudge, not a dispatch).
    function explainWhileLive(control, title, sub) {
      const wrap = el('span', 'rv-explain rv-explaining');
      wrap.appendChild(control);
      setCapsuleWhy(wrap, title, sub);
      armCapsule(wrap, control);
      return wrap;
    }
    function refuseWhenDown(control, title, sub) {
      if (!runnerDown) return control;
      control.disabled = true;
      // The capsule is the explanation now, so the native tooltip is dropped
      // rather than left to compete with it: a title on a disabled button is
      // slow, easy to miss, and cannot hold two sentences. Same rule Send all
      // already followed.
      control.title = '';
      const wrap = el('span', 'rv-explain rv-explaining');
      wrap.appendChild(control);
      setCapsuleWhy(wrap, title, sub);
      armCapsule(wrap, control);
      return wrap;
    }

    // A "who · when" line for a history entry. The stamp is a clock time, not
    // "2 h ago": the card's ordering rule is read by scanning the stamps down
    // the card, and relative times cannot be scanned that way (#199).
    function whoWhen(who, at, { agent = false, suffix = '' } = {}) {
      const row = el('div', 'rv-who');
      row.appendChild(el('span', agent ? 'rv-who-agent' : 'rv-who-user', who));
      if (suffix) row.appendChild(document.createTextNode(` ${suffix}`));
      const stamp = clockTime(at);
      if (stamp) {
        const when = el('span', 'rv-when', stamp);
        const rel = relativeTime(at);
        when.title = rel ? `${at} (${rel})` : at;
        row.appendChild(when);
      }
      return row;
    }

    // A BUFFERED comment (#202) — written while the runner was down, living in
    // this browser and nowhere else. It gets the same four zones, but zones 3
    // and 4 have nothing to hold: there is no history because nothing has
    // happened to it, and the only thing you can do is the thing that is
    // already happening. Unsaved work must never look saved, so it carries
    // THREE signals — a dashed border, a segmented rail, and a chip naming
    // where it lives — because this is the one card whose misreading loses
    // writing.
    function localCard(comment) {
      const entry = bufferedComments.find((b) => b.localId === comment.id);
      const failedText = comment.failed;
      // #216: the same anchor lookup a saved card does. A buffered REPLY
      // carries its parent's anchor only to show a quote (see bufferReply) —
      // `orphan` is scoped to a comment that HAD text to find and lost it, not
      // to a reply that never had its own anchor.
      const loc = locateAnchor(comment.anchor);
      const orphan = Boolean(comment.anchor) && !loc;
      // Always rendered EXPANDED — quote and body wrap rather than clipping to
      // one line. A saved comment truncated on the card face is still readable
      // from the sidecar; this card holds the only copy, so clipping it would
      // hide writing that exists nowhere else.
      const node = el('div',
        `rv-card rv-card-open rv-expanded rv-buffered${failedText ? ' rv-failed-replay' : ''}${orphan ? ' rv-orphaned' : ''}`);
      node.setAttribute('data-rv-comment', comment.id);
      // #216: click-to-reveal, same as a saved card (card(), below) — scroll
      // to and flash the anchored text. Only wired when there is somewhere to
      // reveal; an orphaned or anchor-less (reply) card gets no dead listener,
      // and there is no expand/collapse here to also guard against.
      if (loc) {
        node.addEventListener('click', (event) => {
          if (event.target instanceof Element
            && event.target.closest('button, input, textarea, form')) return;
          revealAnchor(loc, comment.anchor, comment.id);
        });
      }

      const controls = el('div', 'rv-card-controls');
      controls.appendChild(byline(comment));
      controls.appendChild(el('span', 'rv-actions-spacer'));
      // The audience is shown, not offered: flipping it would be a write, and
      // writes are the thing that is unavailable. It replays as chosen.
      // A buffered REPLY (#241) is neither audience — its chip names what it
      // is instead.
      if (comment.replyTo) {
        const chip = el('span', 'rv-mini', 'reply');
        chip.title = 'A reply to an existing comment, held on this device';
        controls.appendChild(chip);
      } else {
        const aud = inAiBatch(comment) ? 'ai' : 'note';
        const chip = el('span', `rv-mini rv-mini-${aud}`, aud === 'ai' ? 'AI' : 'note');
        chip.title = `Will be saved as ${aud === 'ai' ? 'an AI comment' : 'a note'}`;
        controls.appendChild(chip);
      }
      // #216: the same orphan treatment a saved card gets (rv-orphaned dims
      // the quote below via the shared rule) plus a chip naming it here, since
      // this card has no zone 4 to carry the longer explanation saved cards use.
      if (orphan) {
        const chip = el('span', 'rv-mini rv-mini-orphan', 'orphan');
        chip.title = 'The commented text is no longer in the document.';
        controls.appendChild(chip);
      }
      node.appendChild(controls);

      const quote = comment.anchor && typeof comment.anchor.quote === 'string' ? comment.anchor.quote : '';
      node.appendChild(el('div', 'rv-card-quote', quote ? `“${truncate(quote, 160)}”` : '(no anchor text)'));
      // Always expanded, so the body renders its markdown (#246).
      node.appendChild(mdBlock('rv-card-body', comment.body));

      if (!failedText) {
        const chipRow = el('div', 'rv-local-row');
        chipRow.appendChild(el('span', 'rv-local',
          replay !== null ? 'saving…' : 'on this device, not saved'));
        node.appendChild(chipRow);
        return node;
      }

      // A failed replay is never a silent drop. The comment keeps its text and
      // gets the two exits that matter: point it at something that still
      // exists, or take the words out so nothing is lost even if it is
      // abandoned. COPY TEXT IS THE FLOOR — whatever else fails, the writing
      // survives. Both are always visible; a stuck card must not hide its own
      // escape behind a click to expand.
      const box = el('div', 'rv-failed');
      box.appendChild(el('b', undefined, 'Could not be saved.'));
      box.appendChild(document.createTextNode(` ${failedText}`));
      node.appendChild(box);

      const acts = el('div', 'rv-actions rv-local-acts');
      const again = el('button', 'rv-btn', 'Re-anchor…');
      again.type = 'button';
      again.addEventListener('click', (event) => {
        event.stopPropagation();
        startManualReanchor(comment.id);
      });
      const copy = el('button', 'rv-btn', 'Copy text');
      copy.type = 'button';
      copy.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(comment.body);
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy text'; }, 1500);
        } catch { copy.textContent = 'Press ⌘C'; }
      });
      const drop = el('button', 'rv-btn rv-btn-quiet', 'Discard');
      drop.type = 'button';
      drop.title = 'Remove this unsaved comment from this device';
      drop.addEventListener('click', (event) => {
        event.stopPropagation();
        if (drop.textContent !== 'Discard?') { drop.textContent = 'Discard?'; return; }
        bufferedComments = bufferedComments.filter((b) => b.localId !== comment.id);
        saveBuffer();
        render();
      });
      // A failed REPLY has no anchor to fix — its parent is gone, and Copy
      // text / Discard are its two exits (#241).
      if (comment.replyTo) acts.append(copy, el('span', 'rv-actions-spacer'), drop);
      else acts.append(again, copy, el('span', 'rv-actions-spacer'), drop);
      node.appendChild(acts);
      if (entry) node.title = `Written ${relativeTime(entry.createdAt)}, held on this device`;
      return node;
    }

    // The card, in FOUR ZONES with one gap vocabulary (#200, and the four-zone
    // plate in design/phase10-mocks.html):
    //
    //   1 head     the control row — who, on the left; state and controls on
    //              the right — then the anchor quote. Fixed; never reorders.
    //   2 ask      the comment body. Exactly one, always second.
    //   3 history  every reply, decision and flip, oldest first (#199).
    //   4 now      what is true and what you can do about it. No timestamps
    //              here, because none of it has happened yet.
    //
    // Spacing rule: every child sets margin-top and NEVER margin-bottom, so a
    // gap is one number owned by the lower element rather than the sum of two
    // elements' opinions. Three legal values — 4 inside a unit, 8 between units
    // in a zone, 14 between zones — and 14 appears exactly three times. The
    // third one carries the card's only hairline. That lives in overlay.css;
    // this function's job is to keep every child inside one of the four zones.
    //
    // The AI/note control cannot drift out of line any more (#197): it sits in
    // a fixed 22px control row of its own rather than being centred against a
    // quote whose height changes when the card expands.
    // render() keeps at most one card expanded.
    // #265: the class pair is flipped in place by the card-click path (no
    // rebuild, so the .rv-card-more transition survives). add/remove, not
    // toggle(cls, force) — the boot-test DOM stub has no two-arg toggle.
    function setCardExpanded(cardEl, open) {
      if (open) {
        cardEl.classList.add('rv-expanded');
        cardEl.classList.remove('rv-collapsed');
      } else {
        cardEl.classList.remove('rv-expanded');
        cardEl.classList.add('rv-collapsed');
      }
    }
    function card(comment) {
      if (comment.local) return localCard(comment);
      const expanded = comment.id === expandedId;
      const on = inAiBatch(comment);
      const history = commentHistory(comment, pageRuns());
      const node = el('div', `rv-card rv-card-${comment.status} ${expanded ? 'rv-expanded' : 'rv-collapsed'}`);
      node.setAttribute('data-rv-comment', comment.id); // ↑/↓ cursor lookup (#149)
      if (comment.status === 'resolved') node.classList.add('rv-resolved');
      // A dashed leading edge repeats agent authorship down the card's full
      // height, for anyone who has scrolled past the control row (#201).
      if (comment.creator === 'agent') node.classList.add('rv-card-byagent');

      const loc = locateAnchor(comment.anchor);
      if (!loc) node.classList.add('rv-orphaned');
      if (expanded) expandedCardEl = node;
      node.addEventListener('click', (event) => {
        if (event.target instanceof Element
          && event.target.closest('button, input, textarea, form')) return;
        // #265: toggle classes on the EXISTING cards — no render(). The card
        // is always built in full; rv-expanded/rv-collapsed drive the
        // .rv-card-more well's 0fr→1fr transition and the collapsed-face
        // differences. A rebuild here killed the transition mid-flight.
        // `expanded` (build-time) goes stale across toggles, so read live.
        if (comment.id === expandedId) {
          expandedId = null;
          expandedCardEl = null;
          setCardExpanded(node, false);
          reconcileHighlight([]);
          return;
        }
        if (expandedCardEl) setCardExpanded(expandedCardEl, false);
        expandedId = comment.id;
        expandedCardEl = node;
        setCardExpanded(node, true);
        reconcileHighlight([comment]);
        if (loc) revealAnchor(loc, comment.anchor, comment.id);
      });

      const setStatus = async (button, value) => {
        button.disabled = true;
        try {
          await api(`/api/comment/${encodeURIComponent(comment.id)}/status`, { page, status: value });
          await refresh();
        } catch { button.disabled = false; }
      };

      const quote = comment.anchor && typeof comment.anchor.quote === 'string' ? comment.anchor.quote : '';

      // The AI-edits batch toggle. The head chip is now its ONLY affordance —
      // the named "Include in AI edits" setting row is gone, and with it the
      // divider it carried, which zone 4 now owns.
      const flipAiEdits = async () => {
        try {
          await api(`/api/comment/${encodeURIComponent(comment.id)}/ai-edits`, { page, value: !on });
          await refresh();
        } catch { /* leave state as-is; next poll reconciles */ }
      };

      // ---- ZONE 1: head ----
      // One control row with a reading order that does not vary: who on the
      // left, state and controls on the right, nothing in between. Filling both
      // halves is the point — the old row was a 22px band with a chip stranded
      // at one end, and naming the author is what fills it (#201).
      const controls = el('div', 'rv-card-controls');
      controls.appendChild(byline(comment));
      controls.appendChild(el('span', 'rv-actions-spacer'));

      const face = faceStatus(comment, history);
      if (face) {
        const chip = el('span', `rv-mini rv-mini-st rv-mini-st-${face.replace('-', '')}`, face);
        chip.title = face === 're-opened'
          ? 'Settled once and open again — see the history'
          : `This comment is ${face}`;
        controls.appendChild(chip);
      }
      const turns = threadCount(history);
      if (turns > 0) {
        const count = el('span', 'rv-thread', String(turns));
        count.title = `${turns} repl${turns === 1 ? 'y' : 'ies'} and decisions on this comment`;
        controls.appendChild(count);
      }
      // Resolved is filed away: no audience control and no tick (the tick only
      // ever settles, and there is nothing left to settle).
      if (comment.status !== 'resolved') {
        const audienceChip = el('button', `rv-mini rv-mini-${on ? 'ai' : 'note'}`, on ? 'AI' : 'note');
        audienceChip.type = 'button';
        audienceChip.title = on
          ? 'In the AI-edits batch — click to make it a note'
          : 'A note — click to send it to the AI';
        audienceChip.addEventListener('click', (event) => { event.stopPropagation(); flipAiEdits(); });
        // Through refuseWhenDown like every other refused write, NOT a native
        // title on a disabled button (#196). Two treatments for one situation
        // is confusing enough; the odd one out had the bad one — a tooltip is
        // slow to appear, easy to miss and cannot hold the second sentence, so
        // Blake read it as "clicking does nothing, but no indication as to
        // why", which is the exact symptom the capsule exists to remove.
        controls.appendChild(refuseWhenDown(audienceChip, 'Needs the runner'));

        const approve = el('button', 'rv-approve');
        approve.type = 'button';
        approve.title = 'Approve — resolve this comment';
        approve.setAttribute('aria-label', 'Approve');
        approve.addEventListener('click', () => setStatus(approve, 'resolved'));
        controls.appendChild(refuseWhenDown(approve, 'Needs the runner'));
      }
      node.appendChild(controls);

      const q1 = hitText('rv-card-quote',
        quote ? `“${truncate(quote, 160)}”` : (loc ? '(no anchor text)' : 'anchor not found'));
      if (!loc) q1.title = 'The commented text was not found in the current document.';
      node.appendChild(q1);

      // ---- ZONE 2: ask ----
      // Both faces are built and CSS shows one (#265): expanded, the body's
      // markdown renders; collapsed, syntax is STRIPPED to keep the one-line
      // ellipsis clamp — no stray **, no block elements changing the card's
      // height (#246). Class-driven so the in-place toggle needs no rebuild.
      node.appendChild(paintHits(mdBlock('rv-card-body rv-body-full', comment.body)));
      node.appendChild(hitText('rv-card-body rv-body-line', stripMarkdown(comment.body)));

      // A count says there is a conversation; the last thing said is what
      // makes that worth knowing (#201). One clamped line, shown collapsed
      // only (CSS) — an open card renders the history in full instead.
      const last = lastSaid(history);
      if (last) {
        const line = el('div', 'rv-card-last');
        line.appendChild(el('span', `rv-lastwho${last.agent ? '' : ' rv-lastwho-user'}`, last.who));
        line.appendChild(document.createTextNode(` ${stripMarkdown(last.text)}`));
        node.appendChild(paintHits(line));
      }

      // #265: everything below is expanded-only and lives in the .rv-card-more
      // grid well, whose row transitions 0fr→1fr (280ms; spec
      // design/mock-card-transitions.html). The card is ALWAYS built in full;
      // the class pair decides what shows, so expand/collapse is a class flip
      // on this existing node, never a rebuild.
      const more = el('div', 'rv-card-more');
      const moreInner = el('div', 'rv-card-more-inner');
      more.appendChild(moreInner);

      // ---- ZONE 3: history ----
      // Every reply, every decision and every flip, oldest first, interleaved
      // by timestamp (#199). A decline is an event in the thread at the moment
      // it happened, not a footer on the card.
      if (history.length > 0) {
        const hist = el('div', 'rv-hist');
        // The newest turn is always open, whatever its length (#247); events
        // are things that merely happened, not turns, so they don't count.
        let newestIdx = -1;
        for (let idx = 0; idx < history.length; idx += 1) {
          if (history[idx].kind !== 'event') newestIdx = idx;
        }
        history.forEach((entry, idx) => {
          if (entry.kind === 'event') {
            // Bare hairline rows hold things that merely happened; boxes hold
            // words somebody wrote.
            const ev = el('div', `rv-entry rv-entry-ev rv-ev-${entry.event}`);
            ev.appendChild(document.createTextNode(entry.text));
            const stamp = clockTime(entry.at);
            if (stamp) ev.appendChild(el('span', 'rv-when', stamp));
            hist.appendChild(ev);
            return;
          }
          // #236: a declined scope confirmation is its own kind, not a
          // comment decision — nothing about the COMMENT was decided, so it
          // gets no rv-d-declined edge (that colour already means "the agent
          // declined this ask", a different fact). The billed-but-discarded
          // agent call still deserves a way in to its trace.
          if (entry.kind === 'gate-declined') {
            const box = el('div', 'rv-entry rv-entry-msg rv-entry-gate');
            const row = el('div', 'rv-entry-gate-row');
            row.appendChild(document.createTextNode('Scope confirmation declined — no edit was applied.'));
            const stamp = clockTime(entry.at);
            if (stamp) row.appendChild(el('span', 'rv-when', stamp));
            box.appendChild(row);
            const chip = scopeGateChip({ status: 'declined' });
            if (chip) box.appendChild(chip);
            if (entry.runId) {
              const run = el('div', 'rv-run');
              run.appendChild(runLogButton(entry.runId, entry.runId));
              box.appendChild(run);
            }
            hist.appendChild(box);
            return;
          }
          const isDecision = entry.kind !== 'reply';
          const box = el('div', `rv-entry rv-entry-msg${isDecision ? ' rv-entry-decision' : ''}`);
          const head = isDecision
            ? whoWhen(entry.model || 'the agent', entry.at, {
              agent: true,
              suffix: entry.undone ? `${entry.decision} (undone)` : entry.decision,
            })
            : whoWhen(entry.who, entry.at, { agent: entry.agent });
          box.appendChild(head);
          const text = isDecision ? entry.summary : entry.body;
          // The body and the run row live in one container so folding hides
          // both at once — a folded entry is header + preview and nothing else.
          const full = el('div', 'rv-entry-full');
          full.appendChild(paintHits(mdBlock('rv-text', text)));
          if (isDecision) {
            if (entry.decision) box.classList.add(`rv-d-${entry.decision}`);
            if (entry.undone) box.classList.add('rv-entry-undone');
            if (entry.note) box.title = entry.note;
            // The run id IS the link into the trace — there is no separate
            // "Run log" button, and the strip does not repeat it on success.
            const runId = entry.runId;
            if (runId) {
              const run = el('div', 'rv-run');
              run.appendChild(runLogButton(runId, runId));
              // #236: a run the scope gate paused and the author then allowed
              // reads exactly like an ungated one otherwise — same decision,
              // same edits, same "addressed" edge. This is the one thing on
              // the card that says a human was stopped and asked first.
              const gateChip = scopeGateChip({ scopeGate: entry.scopeGate });
              if (gateChip) run.appendChild(gateChip);
              full.appendChild(run);
            }
          }
          // A long entry starts folded (#247): the whole who·when row becomes
          // the toggle. Short entries render in full and get no toggle at all.
          // No persistence — the next REBUILD returns every entry to this
          // default. Since #265 a close/reopen of the card is a class flip on
          // the existing node, so fold state survives that (review state
          // surviving a toggle is the sitting's own rule); any render() —
          // poll change, filter change, run reload — still resets it.
          if (foldState(entry, { isNewest: idx === newestIdx })) {
            box.classList.add('rv-entry-fold', 'rv-folded');
            head.classList.add('rv-fold-toggle');
            head.setAttribute('role', 'button');
            head.setAttribute('tabindex', '0');
            head.setAttribute('aria-expanded', 'false');
            // After the author name, per Blake (2026-08-12) — the name leads.
            head.insertBefore(el('span', 'rv-fold-chevron'), head.children[1] ?? null);
            box.appendChild(hitText('rv-fold-preview', stripMarkdown(text)));
            // #268 D13: a hit inside a folded entry is a hit you cannot see,
            // which defeats the search. Start it OPEN — the toggle stays, so
            // it can still be folded back by hand.
            if (searchPrepared.active && searchHits(stripMarkdown(text), searchPrepared).length > 0) {
              box.classList.remove('rv-folded');
              head.setAttribute('aria-expanded', 'true');
            }
            const toggle = (event) => {
              // The card's own click handler collapses the card; this one
              // must not reach it.
              event.stopPropagation();
              const folded = box.classList.toggle('rv-folded');
              head.setAttribute('aria-expanded', folded ? 'false' : 'true');
            };
            head.addEventListener('click', toggle);
            head.addEventListener('keydown', (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle(event);
              }
            });
            // Folded, the WHOLE box is the target — a one-line preview is all
            // margin. Open, only the head folds it back, so selecting or
            // clicking text in the body never collapses it (Blake, 2026-08-12).
            box.addEventListener('click', (event) => {
              if (!box.classList.contains('rv-folded')) return;
              if (event.target instanceof Element && event.target.closest('button, a')) return;
              toggle(event);
            });
          }
          box.appendChild(full);
          hist.appendChild(box);
        });
        moreInner.appendChild(hist);
      }

      // ---- ZONE 4: now ----
      // The present state and what you can do about it. Nothing here carries a
      // timestamp. This zone opens with the card's ONE hairline.
      const now = el('div', 'rv-now');

      // #267 DECISION 5: the tag rides EVERY concealed comment's card, not
      // just the one whose reveal last failed. The gutter now says a fold is
      // hiding N comments, so the panel has to agree without being provoked
      // first; hiddenAnchorId still forces it for the non-fold case a failed
      // reveal discovered. anchorConcealed is the same check the gutter runs.
      if (loc && (comment.id === hiddenAnchorId || anchorConcealed(loc))) {
        // Blake (hidden-section test): "no scroll to the section or
        // indication of where the comment is hidden". When the concealer is
        // a closed <details>, NAME it by its own heading and offer the jump
        // — an explicit click may unfold what implicit reveals may not (the
        // auto-unfold script died for reopening sections nobody asked open).
        // Browsers themselves open <details> for find-in-page and fragment
        // jumps, so an asked-for unfold is native behaviour, not a document
        // write. Anything else hidden (a tab, a display:none ancestor) keeps
        // the generic note — only the host page knows how to reveal those.
        const folded = (() => {
          try {
            let n = typeof loc.element === 'function' ? loc.element() : null;
            const closed = [];
            let name = null;
            for (; n; n = n.parentElement) {
              if (n.tagName === 'DETAILS' && !n.open) {
                closed.push(n);
                if (name === null) {
                  const s = n.querySelector(':scope > summary');
                  if (s) name = s.textContent.trim().replace(/\s+/g, ' ').slice(0, 60);
                }
              }
            }
            return closed.length > 0 ? { closed, name } : null;
          } catch { return null; /* stub DOM */ }
        })();
        const tag = el('div', 'rv-hidden-tag');
        if (folded) {
          // ONE LINE including the button (Blake, 2026-08-13). The section's
          // name is deliberately out of the string — it is the part that can
          // run to 60 characters, and wrapping is what the amendment was
          // about. It rides the button's tooltip instead. The LABEL shortened;
          // the ACTION is unchanged: unfold every closed ancestor, then jump.
          tag.appendChild(el('span', 'rv-hidden-tag-text', 'Content in folded section'));
          const openBtn = el('button', 'rv-btn', 'Unfold');
          openBtn.type = 'button';
          openBtn.title = folded.name
            ? `Unfold “${folded.name}” and jump to this text`
            : 'Unfold the section and jump to this text';
          openBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            for (const det of folded.closed) det.open = true;
            revealAnchor(loc, comment.anchor, comment.id);
          });
          tag.appendChild(openBtn);
        } else {
          tag.appendChild(el('span', undefined,
            'This text is hidden on the page right now — open the tab or section holding it to jump there.'));
        }
        now.appendChild(tag);
      }
      if (!loc) {
        now.appendChild(el('div', 'rv-orphan-tag', 'The commented text is no longer in the document.'));
        // R3 (#157): offer the closest surviving text when the matcher has a
        // candidate above threshold; fall back to a manual pick otherwise.
        const cand = suggestReanchor(comment.anchor);
        const wrap = el('div', 'rv-reanchor');
        // Re-anchoring a SAVED comment is a sidecar write (POST …/anchor), so
        // it is refused like the rest while the runner is down. Found in the
        // #196 audit: these three failed into `catch { btn.disabled = false; }`
        // — the same silent re-enable that started this ticket. (The buffered
        // card's own Re-anchor is a different button, on a local entry, and
        // stays live: it rewrites this device's copy and needs nothing.)
        const REANCHOR_WHY = ['Needs the runner'];
        if (cand) {
          wrap.appendChild(el('div', 'rv-reanchor-label', 'Closest text still in the document'));
          wrap.appendChild(el('div', 'rv-reanchor-snippet', `“…${cand.snippet}…”`));
          const acts = el('div', 'rv-actions');
          const another = el('button', 'rv-btn', 'Pick another');
          another.type = 'button';
          another.addEventListener('click', () => startManualReanchor(comment.id));
          const here = el('button', 'rv-btn rv-btn-primary', 'Re-anchor here');
          here.type = 'button';
          here.addEventListener('click', () => reanchorTo(comment.id, cand.anchor, here));
          acts.append(refuseWhenDown(another, ...REANCHOR_WHY),
            el('span', 'rv-actions-spacer'), refuseWhenDown(here, ...REANCHOR_WHY));
          wrap.appendChild(acts);
        } else {
          const acts = el('div', 'rv-actions');
          const pick = el('button', 'rv-btn', 'Re-anchor…');
          pick.type = 'button';
          pick.addEventListener('click', () => startManualReanchor(comment.id));
          acts.appendChild(refuseWhenDown(pick, ...REANCHOR_WHY));
          wrap.appendChild(acts);
        }
        now.appendChild(wrap);
      }

      // The composer. It lives in zone 4 next to the action row that opens it,
      // not full-bleed at the bottom of the card detached from the thread it
      // appends to.
      const settled = comment.status !== 'open';
      // An open composer and its text are restored from the draft map, so a
      // redraw mid-sentence is invisible instead of destructive.
      const draft = replyDrafts.get(comment.id);
      const followup = el('div', `rv-followup${draft === undefined ? ' rv-hidden' : ''}`);
      const fuHead = el('div', 'rv-followup-head', 'Reply');
      followup.appendChild(fuHead);
      // #194: Reject mode — the same composer, armed to carry the fixed
      // machine-readable marker so a watcher can act on the rejection.
      let rejectArm = false;
      const ta = el('textarea', 'rv-followup-input');
      ta.placeholder = 'Add a reply';
      if (draft !== undefined) ta.value = draft;
      // Every keystroke, not just a blur: the redraw this survives is on a
      // timer, so it can land between any two characters.
      ta.addEventListener('input', () => { replyDrafts.set(comment.id, ta.value); });
      // #198: ANY reply re-opens the ticket, from any state — so disagreeing
      // with a decline costs nothing, where before the only way back was Send
      // now, which spends a model call. The tick is how you settle it again, so
      // the tick IS the opt-out and no separate control is needed. Only a
      // HUMAN reply re-opens: an agent answering a question should not reverse
      // a decision the author made.
      const postReply = async (btn) => {
        const text = ta.value.trim();
        // A REJECTION with no typed reason is still a rejection — the marker
        // alone is the machine-readable act, and the author may well have
        // already said why in an earlier reply. The empty-text early-return
        // made Reject & back out a SILENT no-op (Blake hit it live,
        // 2026-08-12). Plain replies still require words.
        if (!text && !rejectArm) return;
        // The one chokepoint the click and cmd/ctrl+Enter both pass through.
        // #241: with the runner down the reply BUFFERS like a new comment —
        // it targets a stable comment id, so replaying it later is safe where
        // replaying an edit would not be. The draft is dropped only once the
        // words are in the buffer, which is somewhere else. (Reject mode
        // never reaches here — the Reject button refuses while down, because
        // its revert is a document write.)
        if (runnerDown) {
          if (bufferReply(comment.id, text, comment.anchor)) {
            replyDrafts.delete(comment.id);
            render();
          }
          return;
        }
        btn.disabled = true;
        try {
          // The runner re-opens a settled comment on a human reply in the
          // same write (#250) — no second status call, so a failure can't
          // leave a reply without its re-open. The label still says
          // "Reply & re-open"; the rule just lives in the trust layer now.
          const body = rejectArm ? (text ? `${REJECT_MARKER} ${text}` : REJECT_MARKER) : text;
          await api(`/api/comment/${encodeURIComponent(comment.id)}/reply`, { page, body });
          // Dropped only once the words are somewhere else — the draft is the
          // only copy until the runner has it.
          replyDrafts.delete(comment.id);
          // #194: a rejection then tries the clean back-out itself — tier 1
          // of the two-tier undo (#232). A 409 is not an error here: reason
          // 'conflicted' (or an unsupported shape) means the marker reply
          // stands and the watcher re-derives the block instead.
          if (rejectArm && rejectRunId) {
            await apiRaw('/api/undo', { page, runId: rejectRunId, creator: 'human' }).catch(() => {});
          }
          await refresh();
        } catch { btn.disabled = false; }
      };
      const fuActions = el('div', 'rv-followup-actions');
      // The label states the consequence, so nothing is hidden.
      const fuSend = el('button', 'rv-btn rv-btn-primary', settled ? 'Reply & re-open' : 'Reply');
      fuSend.type = 'button';
      const fuCancel = el('button', 'rv-btn', 'Cancel');
      fuCancel.type = 'button';
      ta.addEventListener('keydown', (event) => {
        if (isSubmitShortcut(event)) { event.preventDefault(); postReply(fuSend); }
      });
      fuSend.addEventListener('click', () => postReply(fuSend));
      const disarmReject = () => {
        rejectArm = false;
        fuHead.textContent = 'Reply';
        fuSend.textContent = settled ? 'Reply & re-open' : 'Reply';
      };
      fuCancel.addEventListener('click', () => {
        followup.classList.add('rv-hidden');
        ta.value = '';
        replyDrafts.delete(comment.id);
        disarmReject();
      });
      // #241: a reply is append-only AND targets a stable server id, so it
      // buffers offline exactly like a new comment — no refusal here.
      fuActions.append(fuCancel, el('span', 'rv-actions-spacer'), fuSend);
      followup.appendChild(ta);
      followup.appendChild(fuActions);

      const actions = el('div', 'rv-actions');
      const reply = el('button', 'rv-btn', 'Reply');
      reply.type = 'button';
      if (settled) reply.title = 'A reply re-opens this comment';
      reply.addEventListener('click', () => {
        disarmReject();
        const shown = !followup.classList.toggle('rv-hidden');
        if (shown) { replyDrafts.set(comment.id, ta.value); ta.focus(); }
        else replyDrafts.delete(comment.id);
      });
      // #241 revisited: the composer OPENS offline now, because a reply
      // buffers — it targets a stable comment id, so it avoids the anchor
      // problem that keeps edits refused. The old rule (refuse the opener,
      // 2026-08-05) applied while replies had nowhere to go.
      actions.appendChild(reply);

      // #194: Reject on an ADDRESSED comment backs the edit out. The reply it
      // posts leads with the fixed marker (machine-readable, never free-text
      // parsed); the clean case then reverts via the targeted undo, and a
      // conflicted one leaves the marker for the watcher to re-derive from
      // the comments that still stand. Only addressed comments carry an edit
      // to back out, and only when a decision names its run.
      const rejectRunId = comment.status === 'addressed'
        ? ([...history].reverse().find((e) => e.kind === 'decision' && e.runId)?.runId ?? null)
        : null;
      if (rejectRunId) {
        const rejectBtn = el('button', 'rv-btn', 'Reject…');
        rejectBtn.type = 'button';
        rejectBtn.title = 'Back this edit out — say why, and the change is reverted or rebuilt';
        rejectBtn.addEventListener('click', () => {
          if (runnerDown) return; // belt to the capsule's braces, like pillEdit()
          rejectArm = true;
          fuHead.textContent = 'Reject — say what is wrong';
          fuSend.textContent = 'Reject & back out';
          followup.classList.remove('rv-hidden');
          replyDrafts.set(comment.id, ta.value);
          ta.focus();
        });
        // A rejection ends in a document write, so it refuses while down —
        // unlike a plain reply, which buffers (#241).
        actions.appendChild(refuseWhenDown(rejectBtn, 'Needs the runner',
          'Backing out an edit is a document write'));
      }
      actions.appendChild(el('span', 'rv-actions-spacer'));

      if (comment.status === 'resolved') {
        // Resolved is your own filing, so undoing it owes nobody an
        // explanation — and the tick that did it is no longer rendered, which
        // would otherwise leave resolved as the one state with no free way
        // back at all. Every other state gets back through a reply.
        const reopen = el('button', 'rv-btn', 'Reopen');
        reopen.type = 'button';
        reopen.addEventListener('click', () => setStatus(reopen, 'open'));
        actions.appendChild(refuseWhenDown(reopen, 'Needs the runner'));
      } else {
        // Send now = one-off run (independent of the batch toggle). A decided or
        // failed comment reopens first; the label reads "Retry" when it failed.
        // #212: disabled when no watcher is attached — no paid path in V1.
        const send = el('button', 'rv-btn rv-btn-primary', comment.status === 'failed' ? 'Retry' : 'Send now');
        send.type = 'button';
        if (isRunning() || !loc) {
          send.disabled = true;
          if (!loc) send.title = 'Cannot run — the commented text is no longer in the document';
        } else if (!watcherAttached()) {
          send.disabled = true;
          send.title = 'Attach a watcher to act on comments';
        }
        send.addEventListener('click', async () => {
          send.disabled = true;
          try {
            if (comment.status !== 'open') {
              await api(`/api/comment/${encodeURIComponent(comment.id)}/status`, { page, status: 'open' });
            }
            startRun([comment.id]); // reopened → sendable; startRun refreshes + polls
          } catch { send.disabled = false; }
        });
        // #254: the same hover hint as Send all — with a live watcher and
        // hold off, this button nudges rather than dispatches.
        const holdNow = holdState();
        const watchingHere = !runnerDown && !send.disabled
          && watcherAttached() && !(holdNow && holdNow.on);
        actions.appendChild(runnerDown
          ? refuseWhenDown(send, 'Needs the runner')
          : (watchingHere
            ? explainWhileLive(send, 'The watcher already sees this comment',
              'Send nudges it to take another pass')
            : send));
      }

      now.appendChild(actions);
      now.appendChild(followup);
      moreInner.appendChild(now);
      node.appendChild(more);
      return node;
    }

    // ---- direct edit (#112): hover pencil + in-place contenteditable ----
    // A pencil floats over the block on hover in review mode. Clicking it turns
    // the block itself editable in place — you edit the rendered text where it
    // lives, not raw markup in a side panel. The runner is still the only writer
    // (save POSTs /api/edit, which entity-encodes + validates via surgery).
    function ensurePencil() {
      if (editPencil) return editPencil;
      editPencil = el('button', 'rv-edit-pencil');
      editPencil.type = 'button';
      editPencil.title = 'Edit this text';
      editPencil.setAttribute('aria-label', 'Edit this text');
      editPencil.addEventListener('click', (e) => {
        e.stopPropagation();
        // Offline: the affordance STAYS and changes state (#196). Removing the
        // pencil would teach nothing; a refused one teaches the rule and
        // carries the reason — including the alternative that still works,
        // which is the difference between a refusal and a dead end.
        if (runnerDown) return;
        if (pencilBlockId) openInlineEditor(pencilBlockId);
      });
      // The capsule lives inside the pencil's own hover target so it appears on
      // approach and never sits over the document permanently.
      const why = el('span', 'rv-why');
      const cap = el('span', 'rv-capsule rv-sev-down');
      const capBody = el('span', 'rv-cap-body');
      capBody.appendChild(el('span', 'rv-cap-title', 'Editing needs the runner'));
      // #214: cut to the next step. Why the runner owns writes is what the
      // title says; the alternative is the only thing the reader needs.
      capBody.appendChild(el('span', 'rv-cap-sub',
        'Comment instead — that still works.'));
      cap.appendChild(capBody);
      // The held case gets its own capsule in the same slot: who has the block,
      // and what still works. Never a padlock — reading, commenting and
      // replying are all still permitted here and only the write is gated.
      const heldCap = el('span', 'rv-capsule rv-sev-held');
      const heldBody = el('span', 'rv-cap-body');
      pencilHeldTitle = el('span', 'rv-cap-title', '');
      heldBody.appendChild(pencilHeldTitle);
      heldBody.appendChild(el('span', 'rv-cap-sub',
        'Commenting and replying still work.'));
      // …and a door, because when the machine is wrong "restart the runner" is
      // not an answer a document editor may give. Deliberately at the bottom of
      // an explanation you had to reach for, and deliberately not the first
      // thing offered.
      pencilTakeBack = el('button', 'rv-cap-action', 'Take the block back');
      pencilTakeBack.type = 'button';
      pencilTakeBack.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pencilBlockId) forceRelease(pencilBlockId);
      });
      heldBody.appendChild(pencilTakeBack);
      heldCap.appendChild(heldBody);
      why.appendChild(cap);
      why.appendChild(heldCap);
      editPencil.appendChild(why);
      // Arriving on the pencil cancels a pending hide (#131). The mouseover
      // handler returns early for anything inside #rv-root, so without this the
      // grace timer would fire and hide the pencil the cursor just reached.
      editPencil.addEventListener('mouseenter', cancelPencilHide);
      return editPencil;
    }
    // #223: the gutter rail — comment over edit, in the gutter's inner lane
    // (centred 12px from the column's right edge; the dots keep the outer
    // lane at 33px), raised at the hovered block's row. One hover zone in
    // one predictable place: hovering anywhere in a tall block puts the
    // controls in the same spot every time instead of chasing a corner that
    // may be off screen. Replaces the corner pencil OUTRIGHT (decision
    // 2026-08-03) — no transition period, no flag.
    const RAIL_BTN = 22; // button size; the lane centre arithmetic below uses it
    function ensureRail() {
      if (railEl) return railEl;
      railEl = el('div', 'rv-gt-rail');
      const add = el('button', 'rv-gt-add');
      add.type = 'button';
      add.textContent = '⊕'; // ⊕, matching the mock's pair
      add.title = 'Comment on this block';
      add.setAttribute('aria-label', 'Comment on this block');
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pencilBlockId) openBlockComposer(pencilBlockId);
      });
      railEl.appendChild(add);
      railEl.appendChild(ensurePencil());
      // Arriving on the rail cancels a pending hide — the #131 bridge,
      // carried over to the pair.
      railEl.addEventListener('mouseenter', cancelPencilHide);
      host.appendChild(railEl);
      return railEl;
    }
    // #223: the rail's comment button — the composer anchored to the WHOLE
    // block. The selection pill stays for word-range comments.
    function openBlockComposer(blockId) {
      let bEl = null;
      try { bEl = document.querySelector(`[data-rev="${CSS.escape(blockId)}"]`); } catch { /* bad id */ }
      if (!bEl || bEl.closest('#rv-root')) return;
      // The runner REQUIRES a quote on every anchor (contract: {blockId?,
      // quote}), so a bare {blockId} was refused with "missing or invalid
      // anchor" — Blake hit it live via hover-M. A whole-block comment
      // quotes the whole block: the save passes validation, and the
      // exact-tint layer covers the block, which is what "anchored to the
      // whole block" should look like anyway.
      const text = (bEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      showPopover({ blockId, quote: text.slice(0, MAX_QUOTE_CHARS) },
        bEl.getBoundingClientRect(), null);
    }
    // #258 hover scope: the pill's COPY, without needing a selection first —
    // takes the hovered block's whole text.
    function copyHoverBlock() {
      let bEl = null;
      try { bEl = document.querySelector(`[data-rev="${CSS.escape(pencilBlockId)}"]`); } catch { /* bad id */ }
      if (!bEl || bEl.closest('#rv-root')) return;
      const text = bEl.textContent || '';
      if (!text) return;
      try { navigator.clipboard.writeText(text); } catch { /* clipboard unavailable */ }
    }
    function hideEditPencil() {
      cancelPencilHide();
      pencilBlockId = null;
      if (railEl) railEl.style.display = 'none';
    }
    // #131 carried as a rule, #223 widened it: any affordance living outside
    // the element it acts on needs a deferred teardown, or it is unreachable
    // by construction. The rail sits in the gutter, so the path from
    // mid-paragraph crosses real dead space — margins, the document's own
    // padding — and 150ms was tuned for a corner inside the block. The hide
    // is cancelled by the rail itself, a re-entered block, or another block
    // (which retargets rather than hides).
    const PENCIL_HIDE_MS = 280;
    function cancelPencilHide() {
      if (pencilHideTimer !== null) { clearTimeout(pencilHideTimer); pencilHideTimer = null; }
    }
    function scheduleHideEditPencil() {
      if (pencilHideTimer !== null) return;
      pencilHideTimer = setTimeout(() => { pencilHideTimer = null; hideEditPencil(); }, PENCIL_HIDE_MS);
    }
    function showEditPencilFor(blockEl) {
      const id = blockEl.getAttribute('data-rev');
      if (!id) { hideEditPencil(); return; }
      cancelPencilHide();
      ensureRail();
      const p = ensurePencil();
      pencilBlockId = id;
      // The GATED THING SHOULD BE THE THING THAT LOOKS GATED. The pencil stays
      // and changes state rather than disappearing — a missing affordance
      // teaches nothing, a refused one teaches the rule (#191, and the same
      // argument the offline state already makes).
      const who = leaseHolders().get(id) || null;
      const agentHeld = who !== null && who.kind === 'agent';
      p.classList.toggle('rv-pencil-off', runnerDown);
      p.classList.toggle('rv-pencil-held', !runnerDown && agentHeld);
      pencilHeldTitle.textContent = who === null ? '' : who.label;
      pencilTakeBack.classList.toggle('rv-hidden', !(agentHeld && who.forceable));
      p.title = (runnerDown || agentHeld) ? '' : 'Edit this text';
      // #223: level with the block's top, in the gutter's inner lane. When
      // the gutter is not on screen (stub DOMs, gutter hidden), fall back to
      // the block's own right edge so the pair still appears somewhere sane.
      const r = blockEl.getBoundingClientRect();
      const scroll = { x: window.scrollX, y: window.scrollY };
      const col = gutter && typeof gutter.columnRect === 'function' ? gutter.columnRect() : null;
      const left = col !== null
        ? col.right + scroll.x - 12 - RAIL_BTN / 2
        : r.right + scroll.x - RAIL_BTN - 4;
      railEl.style.display = '';
      railEl.style.top = `${r.top + scroll.y}px`;
      railEl.style.left = `${left}px`;
    }

    function exitEditing(restore) {
      if (!editing) return;
      const { el: bEl, originalNodes } = editing;
      // Revert via replaceChildren with pre-edit node clones — never an
      // innerHTML assignment (the overlay bans writing markup into the DOM).
      if (restore) bEl.replaceChildren(...originalNodes.map((n) => n.cloneNode(true)));
      bEl.removeAttribute('contenteditable');
      bEl.classList.remove('rv-editing');
      bEl.removeEventListener('keydown', onEditKey);
      bEl.removeEventListener('blur', onEditBlur);
      bEl.removeEventListener('paste', onEditPaste);
      editing = null;
      // Escape, blur-with-no-change and a rejected save all come through here.
      // saveInline releases AFTER its write returns (#231), so on that path
      // this is a no-op; on every abandon path it is the release.
      releaseLease();
    }
    function onEditPaste(e) {
      // Paste as PLAIN TEXT — this edits words, not formatting, so no styled
      // markup rides in from the clipboard.
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    }
    function onEditKey(e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); exitEditing(true); }
      // Plain Enter commits (and never splits the block into <div>s); Shift is
      // free for a soft line break.
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveInline(); }
    }
    function onEditBlur() {
      // Blur = commit, like an inline cell editor. Unchanged → silent exit.
      if (!savingInline) saveInline();
    }
    async function saveInline() {
      if (!editing || savingInline) return;
      const { el: bEl, blockId, originalHTML } = editing;
      const newInner = bEl.innerHTML.trim();
      if (newInner === originalHTML.trim()) { exitEditing(false); return; }
      savingInline = true;
      bEl.setAttribute('contenteditable', 'false');
      let res = null;
      // #231: the write NAMES the lease we hold, so the order is lease →
      // write → release. The old order handed the lease back BEFORE writing
      // (a held lease used to refuse its own holder's write), which opened a
      // millisecond window where anyone could take the block between our
      // release and our write. The runner now exempts exactly the named
      // lease; release happens after the write returns, either way.
      const held = heldLease !== null && heldLease.blockId === blockId ? heldLease : null;
      try {
        res = await apiRaw('/api/edit', {
          page, blockId, newInner,
          // R-005: say who did this. The runner treats a missing actor as
          // human — which is what every M1 sidecar carries, so it keeps
          // working — but that made a human edit identifiable only by the
          // ABSENCE of a field, next to agent runs that name themselves. A
          // review history you can only read by noticing what is not there is
          // not a review history.
          creator: 'human',
          ...(held !== null ? { leaseId: held.leaseId } : {}),
        });
      } catch {
        savingInline = false;
        bEl.setAttribute('contenteditable', 'true');
        bEl.focus();
        return;
      }
      await releaseLease();
      if (res.status === 200 && res.body) {
        reloadPreserving({
          kind: 'run', runId: res.body.runId, status: 'ok', decision: null,
          summary: 'Direct edit applied.', edits: Array.isArray(res.body.edits) ? res.body.edits.length : 1,
          costUsd: null, actor: res.body.actor ?? null,
        });
        return; // page reloads; editing state goes with it
      }
      // Rejected: revert to the pre-edit text and leave a console breadcrumb
      // (in-place editing has no panel to surface an error note in).
      savingInline = false;
      exitEditing(true);
      // eslint-disable-next-line no-console
      console.warn('[redline] direct edit rejected:', (res.body && res.body.error) || `HTTP ${res.status}`);
    }
    async function openInlineEditor(blockId) {
      if (editing) exitEditing(false);
      if (isRunning()) return;
      let bEl = null;
      try { bEl = document.querySelector(`[data-rev="${CSS.escape(blockId)}"]`); } catch { /* bad id */ }
      if (!bEl || bEl.closest('#rv-root')) return;
      // Edit-in-progress is the other lock trigger (decision 6), and it is the
      // one that is genuinely GATED: this is a write. First holder wins, so a
      // refusal stops the edit and names the holder rather than preempting it
      // — and the block stays readable, commentable and repliable throughout.
      const lease = await acquireLease(blockId);
      if (lease === null && leaseRefused !== null && leaseRefused.blockId === blockId) {
        // #210: show a distinct refusal capsule, not the ambient hover veil.
        showLeaseRefusal(blockId);
        return;
      }
      hideEditPencil();
      editing = {
        el: bEl, blockId,
        originalHTML: bEl.innerHTML,
        originalNodes: Array.from(bEl.childNodes).map((n) => n.cloneNode(true)),
      };
      bEl.setAttribute('contenteditable', 'true');
      bEl.classList.add('rv-editing');
      bEl.addEventListener('keydown', onEditKey);
      bEl.addEventListener('blur', onEditBlur);
      bEl.addEventListener('paste', onEditPaste);
      bEl.focus();
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(bEl);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }

    // ---- selection → comment popover ----
    // (popover/pendingAnchor/pendingHl are declared up in the state block so
    // syncChrome's init-time call to hidePopover doesn't hit a TDZ.)

    // While the popover is open the native selection collapses as soon as
    // the textarea takes focus, so the commented text keeps a highlight of
    // its own: absolutely positioned boxes in #rv-root over the range's
    // client rects (same technique as .rv-flash — the document DOM is never
    // mutated). Cleared whenever the popover closes.
    function clearPendingHighlight() {
      for (const box of pendingHl) box.remove();
      pendingHl = [];
    }

    function showPendingHighlight(range) {
      clearPendingHighlight();
      let rects = Array.from(range.getClientRects());
      if (rects.length === 0) rects = [range.getBoundingClientRect()];
      for (const r of rects) {
        if (r.width <= 0 || r.height <= 0) continue;
        const box = el('div', 'rv-pending-hl');
        box.style.top = `${r.top + window.scrollY - 1}px`;
        box.style.left = `${Math.max(0, r.left + window.scrollX - 2)}px`;
        box.style.width = `${r.width + 4}px`;
        box.style.height = `${r.height + 2}px`;
        host.appendChild(box);
        pendingHl.push(box);
      }
    }

    function hidePopover() {
      if (popover) popover.remove();
      popover = null;
      pendingAnchor = null;
      clearPendingHighlight();
      // Cancel, submit and every other way out of the composer land here, so
      // this is the one place the claim has to be given back (#189).
      composerLeasePaint = null;
      leaseLost = null;
      releaseLease();
    }

    // Anchor = nearest [data-rev] ancestor id (if any), the exact selected
    // text, and ~30 chars of surrounding context. Stored verbatim by the
    // runner; locateAnchor above resolves it back on render/click.
    function computeAnchor(range) {
      const quote = range.toString().slice(0, MAX_QUOTE_CHARS);
      if (!quote.trim()) return null;
      // Anchor to the block containing the selection START, not the range's
      // commonAncestor: a triple-click's common ancestor is the <ul>, and
      // closest('[data-rev]') from there walks up past every stamped block and
      // finds none (#150). The common ancestor still scopes prefix/suffix.
      let startNode = range.startContainer;
      if (startNode.nodeType !== Node.ELEMENT_NODE) startNode = startNode.parentElement;
      if (!startNode || startNode.closest('#rv-root')) return null;
      const blockEl = startNode.closest('[data-rev]');
      let common = range.commonAncestorContainer;
      if (common.nodeType !== Node.ELEMENT_NODE) common = common.parentElement;
      const scope = blockEl ?? common ?? startNode;
      const anchor = { quote };
      if (blockEl) anchor.blockId = blockEl.getAttribute('data-rev');
      try {
        const pre = document.createRange();
        pre.setStart(scope, 0);
        pre.setEnd(range.startContainer, range.startOffset);
        const prefix = pre.toString().slice(-CONTEXT_CHARS);
        if (prefix) anchor.prefix = prefix;
        const post = document.createRange();
        post.setStart(range.endContainer, range.endOffset);
        post.setEnd(scope, scope.childNodes.length);
        const suffix = post.toString().slice(0, CONTEXT_CHARS);
        if (suffix) anchor.suffix = suffix;
      } catch {
        // context is best-effort; the quote alone still anchors
      }
      return anchor;
    }

    // showPopover(anchor, rect, range): the comment composer (#151). The pill
    // (#150) feeds it — rect positions it below the selection/element, range
    // (when present) keeps a pending highlight over the commented text; a pin
    // passes null. Quote · field · audience switch (AI/Note) · Cancel/Comment,
    // with a left rail carrying the audience. The audience is sticky (persists
    // across reloads); a Note is created then flipped out of the AI batch.
    function showPopover(anchor, rect, range) {
      hidePopover();
      pendingAnchor = anchor;
      if (range) showPendingHighlight(range);

      popover = el('div', `rv-popover${audience === 'ai' ? ' rv-for-ai' : ''}`);
      const quote = anchor && typeof anchor.quote === 'string' ? anchor.quote : '';
      if (quote) popover.appendChild(el('div', 'rv-composer-quote', quote));
      const ta = el('textarea');
      ta.placeholder = audience === 'ai' ? 'Ask for a change…' : 'Leave a note…';
      const note = el('div', 'rv-popover-note');

      const foot = el('div', 'rv-composer-foot');
      // audience switch: bare AI / Note, blue when it goes to the agent
      const sw = el('span', 'rv-aud-sw');
      sw.setAttribute('role', 'button');
      sw.setAttribute('aria-label', 'Comment audience');
      sw.setAttribute('aria-pressed', String(audience === 'ai'));
      sw.tabIndex = 0;
      const swTrack = el('span', 'rv-sw-track');
      swTrack.appendChild(el('span', 'rv-sw-knob'));
      const swLbl = el('span', 'rv-aud-lbl', audience === 'ai' ? 'AI' : 'Note');
      sw.appendChild(swTrack);
      sw.appendChild(swLbl);
      const flipAudience = () => {
        setAudience(audience === 'ai' ? 'note' : 'ai');
        const on = audience === 'ai';
        sw.setAttribute('aria-pressed', String(on));
        swLbl.textContent = on ? 'AI' : 'Note';
        popover.classList.toggle('rv-for-ai', on);
        ta.placeholder = on ? 'Ask for a change…' : 'Leave a note…';
      };
      sw.addEventListener('click', flipAudience);
      sw.addEventListener('keydown', (event) => {
        if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); flipAudience(); }
      });
      foot.appendChild(sw);
      foot.appendChild(el('span', 'rv-actions-spacer'));
      const cancel = el('button', 'rv-btn', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', hidePopover);
      const save = el('button', 'rv-btn rv-btn-primary', 'Comment');
      save.type = 'button';
      const commit = async () => {
        const body = ta.value.trim();
        if (!body || !pendingAnchor) { hidePopover(); return; }
        const asNote = audience === 'note';
        save.disabled = true;
        // Runner down: hold it here instead of throwing the writing away
        // (#202). Deliberately checked BEFORE the request rather than as a
        // catch — an author who already knows the runner is offline should not
        // watch a request time out to be told what the banner says.
        if (runnerDown) {
          if (!bufferComment(body, pendingAnchor, asNote)) {
            save.disabled = false;
            note.textContent = `This device is holding ${BUFFER_MAX} unsaved comments — start the runner to save them.`;
            return;
          }
          hidePopover();
          render();
          return;
        }
        try {
          // ONE write, carrying the audience (#185). It used to be two — create,
          // then flag — and the first bumps `rev` and wakes every watcher, so a
          // note was indistinguishable from an edit request until the second
          // landed. A session watching the stream could and did act inside that
          // window. The runner now takes `aiEdits` at creation, so the window
          // is gone rather than narrowed.
          await api('/api/comment', { page, body, anchor: pendingAnchor, aiEdits: !asNote });
          hidePopover();
          await refresh();
        } catch {
          // apiRaw flips runnerDown on a REJECTED fetch, so if it is set the
          // runner went away between the banner's last check and this
          // keystroke: buffer rather than lose the writing. If it is NOT set,
          // the runner answered and refused — replaying a payload it already
          // rejected would only fail again, so say so instead of queueing it.
          if (runnerDown && bufferComment(body, pendingAnchor, asNote)) {
            hidePopover();
            render();
            return;
          }
          save.disabled = false;
          note.textContent = runnerDown
            ? `This device is holding ${BUFFER_MAX} unsaved comments — start the runner to save them.`
            : 'The runner refused this comment. Nothing was saved.';
        }
      };
      save.addEventListener('click', commit);
      // Esc closes, ⌘↵ submits. stopPropagation so the global cascade doesn't
      // also fire Esc after the composer already handled it.
      ta.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); hidePopover(); return; }
        if (isSubmitShortcut(event)) { event.preventDefault(); commit(); }
      });
      foot.appendChild(cancel);
      foot.appendChild(save);
      popover.appendChild(ta);
      popover.appendChild(note);
      // The lease line (#189). It states the RELEASE CONDITION, which is a fact
      // about the control, and deliberately not a countdown: decision 7 puts no
      // timer on a human-held block, ever. Filled in only once the ledger has
      // actually granted the block — a promise of protection nobody took would
      // be worse than none.
      const leaseLine = el('div', 'rv-composer-lease rv-hidden');
      popover.appendChild(leaseLine);
      popover.appendChild(foot);
      const paintLeaseLine = () => {
        if (!popover) return;
        const blockId = pendingAnchor && pendingAnchor.blockId;
        let text = '';
        if (leaseLost && blockId && leaseLost.blockId === blockId) {
          text = `Your claim on this block ended — ${agentLabel()} may be writing here now.`;
        } else if (heldLease !== null && blockId && heldLease.blockId === blockId) {
          text = 'Held by you · released when you save or cancel';
        }
        leaseLine.textContent = text;
        leaseLine.classList.toggle('rv-hidden', text === '');
        popover.classList.toggle('rv-composer-held', heldLease !== null && blockId === (heldLease && heldLease.blockId));
      };
      composerLeasePaint = paintLeaseLine;

      // Below the selection, never on top of the text being read.
      const left = Math.max(8, Math.min(
        rect.left + window.scrollX,
        window.scrollX + document.documentElement.clientWidth - POPOVER_WIDTH - 8));
      popover.style.left = `${left}px`;
      popover.style.top = `${rect.bottom + window.scrollY + 8}px`;
      host.appendChild(popover);
      ta.focus();
      // Composer-open is the trigger (decision 6). Fired and NOT awaited: a
      // refusal must never stand between the author and the textarea, because
      // commenting on a held block is explicitly still allowed — only writes
      // are gated. paintLeaseLine catches up when the ledger answers.
      if (anchor && typeof anchor.blockId === 'string') {
        acquireLease(anchor.blockId).then(paintLeaseLine, () => {});
      }
    }

    // ---- selection pill (#150) ----
    // Raised BELOW a selection (or a pinnable non-text element). Icons only;
    // hovering one drops a tooltip naming the action + key. The keys c/m/e are
    // live only while the pill is up (handled in the keydown listener).
    function blockOfNode(node) {
      const elm = node && node.nodeType === Node.ELEMENT_NODE ? node : (node && node.parentElement);
      return elm ? elm.closest('[data-rev]') : null;
    }
    function hideSelTip() { if (selTip) { selTip.remove(); selTip = null; } }
    function hideSelPill() { hideSelTip(); if (selPill) { selPill.remove(); selPill = null; } pillCtx = null; }
    function showSelTip(btn, label, key) {
      hideSelTip();
      selTip = el('div', 'rv-selpill-tip');
      selTip.appendChild(el('span', undefined, label));
      selTip.appendChild(el('kbd', undefined, key.toUpperCase()));
      host.appendChild(selTip);
      const r = btn.getBoundingClientRect();
      selTip.style.top = `${r.bottom + window.scrollY + 7}px`;
      selTip.style.left = `${Math.max(8, r.left + window.scrollX + r.width / 2 - selTip.offsetWidth / 2)}px`;
    }
    function pillCopy() {
      const text = String(window.getSelection());
      if (text && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
      hideSelPill();
    }
    function pillComment() {
      const ctx = pillCtx;
      hideSelPill();
      if (ctx) showPopover(ctx.anchor, ctx.rect, ctx.range);
    }
    function pillEdit() {
      const ctx = pillCtx;
      // #215: a text edit is a write and no edit buffers (#202), so refuse to
      // OPEN it while the runner is down rather than inviting text that cannot
      // be saved. The pill's own capsule already says why; leave it up. This is
      // the one chokepoint the click and the `e` shortcut both pass through.
      if (ctx && ctx.block && runnerDown) return;
      hideSelPill();
      if (ctx && ctx.block) openInlineEditor(ctx.block.getAttribute('data-rev'));
    }
    function showSelPill(ctx) {
      hideSelPill();
      pillCtx = ctx;
      selPill = el('div', 'rv-selpill');
      const row = el('div', 'rv-selpill-row');
      const addBtn = (name, label, key, fn, enabled, refuse = null) => {
        if (!enabled) return;
        const b = el('button', 'rv-selpill-btn');
        b.type = 'button';
        b.appendChild(svgIcon(name));
        b.setAttribute('aria-label', `${label} (${key.toUpperCase()})`);
        // #215: a write control on the pill refuses through the SAME capsule the
        // cards use when the runner is down, so you never compose an edit you
        // cannot save. Drawn over the document, the pill was the one write
        // surface the refusal enumeration in eb2b78c never reached.
        if (refuse && runnerDown) {
          row.appendChild(refuseWhenDown(b, refuse.title, refuse.sub));
          return;
        }
        b.addEventListener('click', (event) => { event.stopPropagation(); fn(); });
        b.addEventListener('mouseenter', () => showSelTip(b, label, key));
        b.addEventListener('mouseleave', hideSelTip);
        row.appendChild(b);
      };
      addBtn('copy', 'Copy', 'c', pillCopy, ctx.hasText);
      addBtn('comment', 'Comment', 'm', pillComment, true);
      addBtn('edit', 'Edit text', 'e', pillEdit, Boolean(ctx.block), {
        title: 'Runner offline',
        sub: 'Edits can’t be held offline',
      });
      selPill.appendChild(row);
      // #226: a selection spanning several stamped blocks anchors to its FIRST
      // block (computeAnchor), while the agent still receives the whole
      // selection as the quote. Say so on the pill instead of letting the
      // card's one-block tint imply the rest was dropped.
      if (ctx.multiBlock) {
        selPill.classList.add('rv-selpill-multi');
        selPill.appendChild(el('div', 'rv-selpill-note',
          'Anchors to the first paragraph — the agent gets the whole selection'));
      }
      host.appendChild(selPill);
      // BELOW the selection, centred on it, clamped to the viewport left edge.
      const r = ctx.rect;
      selPill.style.top = `${r.bottom + window.scrollY + 8}px`;
      selPill.style.left = `${Math.max(8, r.left + window.scrollX + r.width / 2 - selPill.offsetWidth / 2)}px`;
    }

    // ---- re-anchor an orphaned comment (#157, R3) ----
    // Suggest the closest surviving text (client-side quote-word overlap), and
    // fall back to a manual pick. The WRITE always goes through the runner
    // (POST /api/comment/:id/anchor) — the overlay only proposes an anchor.
    // 4+ chars skips the commonest stopwords (the/for/and) that would otherwise
    // inflate the overlap score and pick a blander block (#157).
    function reWords(s) { return (String(s).toLowerCase().match(/[a-z0-9]{4,}/g) || []); }
    function suggestReanchor(anchor) {
      const quote = anchor && typeof anchor.quote === 'string' ? anchor.quote.trim() : '';
      if (quote.length < 4) return null;
      const qSet = new Set(reWords(quote));
      if (qSet.size === 0) return null;
      let best = null;
      for (const block of document.querySelectorAll('[data-rev]')) {
        if (block.closest('#rv-root')) continue;
        const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const bSet = new Set(reWords(text));
        if (bSet.size === 0) continue;
        let hit = 0;
        for (const w of qSet) if (bSet.has(w)) hit += 1;
        const score = hit / qSet.size;
        if (best === null || score > best.score) best = { block, score, text };
      }
      if (best === null || best.score < 0.5) return null; // nothing close enough
      // A snippet around the first matched quote word — a REAL slice of the
      // block so it exists as a quote; blockId is the primary anchor anyway.
      const words = best.text.split(' ');
      let idx = words.findIndex((w) => qSet.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')));
      if (idx < 0) idx = 0;
      const slice = words.slice(Math.max(0, idx - 3), Math.max(0, idx - 3) + 12).join(' ');
      return {
        snippet: slice.length > 80 ? `${slice.slice(0, 80)}…` : slice,
        anchor: { blockId: best.block.getAttribute('data-rev') || undefined, quote: slice.slice(0, 200) },
      };
    }
    async function reanchorTo(id, anchor, btn) {
      if (btn) btn.disabled = true;
      // A buffered comment (#202) has no server id to PATCH, so re-anchoring it
      // rewrites the local entry and clears the failure. Handled HERE so the
      // whole select-to-re-anchor flow above works on a stuck replay unchanged.
      const local = bufferedComments.find((b) => b.localId === id);
      if (local) {
        local.anchor = anchor;
        local.failed = null;
        saveBuffer();
        cancelManualReanchor();
        flushBuffer();
        render();
        return;
      }
      try {
        await api(`/api/comment/${encodeURIComponent(id)}/anchor`, { page, anchor });
        cancelManualReanchor();
        await refresh();
      } catch { if (btn) btn.disabled = false; }
    }
    function showReanchorBar() {
      hideReanchorBar();
      reanchorBar = el('div', 'rv-reanchor-bar');
      reanchorBar.appendChild(el('span', 'rv-lock-dot'));
      reanchorBar.appendChild(el('span', 'rv-lock-text', 'Select the text this comment belongs to'));
      const cancel = el('button', 'rv-btn', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', cancelManualReanchor);
      reanchorBar.appendChild(cancel);
      host.appendChild(reanchorBar);
    }
    function hideReanchorBar() { if (reanchorBar) { reanchorBar.remove(); reanchorBar = null; } }
    function startManualReanchor(id) {
      hideSelPill();
      reanchorId = id;
      expandedId = id;
      showReanchorBar();
    }
    function cancelManualReanchor() { reanchorId = null; hideReanchorBar(); }

    document.addEventListener('mouseup', (event) => {
      // View only: the selection listener is disarmed entirely, so the page
      // selects/copies/clicks like any other (WP3). Armed by redline mode alone
      // — the sidecar being closed does not disarm commenting (#155).
      if (!redline) return;
      if (event.target instanceof Element && event.target.closest('#rv-root')) return;
      const target = event.target instanceof Element ? event.target : null;
      // Let the browser settle the selection first.
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel ? String(sel).trim() : '';
        // Manual re-anchor (#157): a selection while armed re-attaches the
        // orphaned comment instead of raising the pill. Empty selection waits.
        if (reanchorId !== null) {
          if (sel && !sel.isCollapsed && text) {
            const anchor = computeAnchor(sel.getRangeAt(0));
            if (anchor) reanchorTo(reanchorId, anchor);
          }
          return;
        }
        if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !text) {
          // No text to select — the pin path: an image, SVG or figure has
          // nothing to select, so clicking it raises a pill with Comment alone.
          const block = target ? target.closest('[data-rev]') : null;
          if (block && !block.closest('#rv-root')
            && (block.tagName === 'FIGURE' || block.querySelector('svg, img, canvas'))) {
            const cap = block.querySelector('figcaption');
            const label = (cap ? cap.textContent : (block.getAttribute('aria-label') || '')).trim().slice(0, 120);
            showSelPill({
              rect: block.getBoundingClientRect(), range: null, block: null, hasText: false,
              anchor: { blockId: block.getAttribute('data-rev') || undefined, quote: label || '[image]' },
            });
          } else {
            hideSelPill();
          }
          return;
        }
        const range = sel.getRangeAt(0);
        const anchor = computeAnchor(range);
        if (!anchor) { hideSelPill(); return; }
        // Edit is offered only when the selection sits inside ONE stamped block:
        // editing is block-level, so a two-block selection has no single target.
        // The same-block test is by CONTENT because a triple-click ends at
        // offset 0 of the NEXT element, reporting two blocks for one (#150).
        const startBlock = blockOfNode(range.startContainer);
        const endBlock = blockOfNode(range.endContainer);
        // Containment compares WHITESPACE-NORMALIZED text: a triple-click's
        // toString() carries a trailing newline (and hard-wrapped source puts
        // newlines where textContent has spaces), so a raw includes() failed
        // and the multi-paragraph note fired on a one-paragraph selection
        // (#226 acceptance, Blake 2026-08-12).
        const squash = (s) => s.replace(/\s+/gu, ' ').trim();
        const oneBlock = Boolean(startBlock)
          && (endBlock === startBlock || squash(startBlock.textContent).includes(squash(text)));
        showSelPill({
          rect: range.getBoundingClientRect(), range, hasText: true,
          block: oneBlock ? startBlock : null, anchor,
          // #226: genuinely 2+ stamped blocks — the content test above already
          // absolves the triple-click that merely ENDS at the next block.
          multiBlock: Boolean(startBlock) && Boolean(endBlock) && !oneBlock,
        });
      }, 0);
    });

    // ---- keyboard surface (#149) ----
    // The shortcut sheet (also opened by the toolbar ? button).
    function toggleCheat() {
      if (cheatEl) { cheatEl.remove(); cheatEl = null; return; }
      cheatEl = el('div', 'rv-cheat');
      cheatEl.appendChild(el('h3', undefined, 'Keyboard'));
      const dl = document.createElement('dl');
      for (const [k, d] of [
        ['R', 'Redline on / off'], [']', 'Open / close the sidecar'],
        ['↑ ↓', 'Previous / next comment (sidecar focused)'],
        ['A', 'Resolve the comment you have open'],
        ['⌘Z', 'Undo the last edit or run'], ['⌘↵', 'Save a comment'],
        ['?', 'This sheet'], ['Esc', 'Close chrome → sidecar → View only'],
      ]) {
        const dt = el('dt');
        dt.appendChild(el('kbd', undefined, k));
        dl.appendChild(dt);
        dl.appendChild(el('dd', undefined, d));
      }
      cheatEl.appendChild(dl);
      cheatEl.appendChild(el('div', 'rv-cheat-note',
        'C copy · M comment · E edit — on the selected text, or the block under the pointer.'));
      host.appendChild(cheatEl);
    }

    // The ↑/↓ cursor: ring the visible comment the arrows have landed on and
    // scroll to its anchor. A navigation cursor only — never a resolve target.
    function applyCycleHighlight() {
      if (cycledId !== null && !cycleOrder.includes(cycledId)) cycledId = null;
      const prev = cards.querySelector('.rv-card-cycled');
      if (prev) prev.classList.remove('rv-card-cycled');
      if (cycledId === null) return;
      const node = cards.querySelector(`[data-rv-comment="${CSS.escape(cycledId)}"]`);
      if (node) node.classList.add('rv-card-cycled');
    }
    function cycleComment(dir) {
      if (cycleOrder.length === 0) return;
      let i = cycleOrder.indexOf(cycledId);
      if (i < 0) i = dir > 0 ? -1 : 0; // fresh cursor: down → first, up → last
      i = (i + dir + cycleOrder.length) % cycleOrder.length;
      cycledId = cycleOrder[i];
      applyCycleHighlight();
      const comment = comments.find((c) => c.id === cycledId);
      const loc = comment ? locateAnchor(comment.anchor) : null;
      if (loc) revealAnchor(loc, comment.anchor, comment.id);
      cards.focus();
    }

    // Resolve the OPENED comment (A) — never the ↑/↓ cursor. No-op if nothing is
    // open or it is already resolved (A was gated after rev 1 resolved a run of
    // comments by a leaned-on key).
    async function resolveOpened() {
      if (expandedId === null) return;
      const comment = comments.find((c) => c.id === expandedId);
      if (!comment || comment.status === 'resolved') return;
      try {
        await api(`/api/comment/${encodeURIComponent(comment.id)}/status`, { page, status: 'resolved' });
        expandedId = null;
        await refresh();
      } catch { /* leave as-is; next poll reconciles */ }
    }

    // Global keys: single letters, no modifiers, inert inside any field. Escape
    // is handled first so it can still cascade from a focused field.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        // Cascade: cheat → pill → re-anchor → composer → open card →
        // row filter → sidecar → View only.
        if (cheatEl) { toggleCheat(); return; }
        if (selPill) { hideSelPill(); return; }
        if (reanchorId !== null) { cancelManualReanchor(); return; }
        if (popover) { hidePopover(); return; }
        // The scope modal is a server-side lock — Escape does not dismiss it.
        if (expandedId !== null) { expandedId = null; render(); return; }
        // #260: stepping out of a gutter-entered row filter, before the
        // panel itself closes.
        if (rowFilter !== null) { rowFilter = null; render(); return; }
        if (redline && sidecarOpen) { setSidecar(false); return; }
        if (redline) { setRedline(false); return; }
        return;
      }
      const t = event.target;
      if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) return;
      // Pill keys c/m/e — live ONLY while the pill is up (#150); single letters
      // are safe here because the pill is transient.
      if (selPill && pillCtx && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const k = event.key.toLowerCase();
        if (k === 'c' && pillCtx.hasText) { event.preventDefault(); pillCopy(); return; }
        if (k === 'm') { event.preventDefault(); pillComment(); return; }
        if (k === 'e' && pillCtx.block) { event.preventDefault(); pillEdit(); return; }
      }
      if (event.altKey) return;
      if (event.metaKey || event.ctrlKey) {
        // ⌘Z / ctrl+Z undoes the last run, when there is one to undo.
        if (event.key.toLowerCase() === 'z'
          && !undoWrap.classList.contains('rv-hidden') && !undoBtn.disabled) {
          event.preventDefault();
          undoLastRun(undoBtn);
        }
        return;
      }
      if (event.key === '?') { event.preventDefault(); toggleCheat(); return; }
      if (event.key.toLowerCase() === 'r') { event.preventDefault(); setRedline(!redline); return; }
      if (!redline) return; // View only claims nothing else
      // #258, hover scope (Blake, 2026-08-12): the pill's three acts aimed at
      // the block under the pointer when nothing is selected. The rail
      // already tracks the target (pencilBlockId); typing contexts and
      // modifiers were excluded above, and a live pill's own c/m/e handled
      // earlier — selection wins over hover.
      if (pencilBlockId !== null && !selPill) {
        const k = event.key.toLowerCase();
        if (k === 'c') { event.preventDefault(); copyHoverBlock(); return; }
        if (k === 'm') { event.preventDefault(); openBlockComposer(pencilBlockId); return; }
        if (k === 'e') {
          event.preventDefault();
          if (!runnerDown) openInlineEditor(pencilBlockId);
          return;
        }
      }
      if (event.key === ']') { event.preventDefault(); setSidecar(!sidecarOpen); return; }
      // ↑/↓ cycle comments ONLY while the card list holds focus, so they never
      // fight the page's own scrolling.
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && cards.contains(document.activeElement)) {
        event.preventDefault();
        cycleComment(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key.toLowerCase() === 'a') { event.preventDefault(); resolveOpened(); return; }
    });

    // #260 amendment (Blake): clicking anywhere that is not the overlay's
    // own chrome and not one of the filtered row's blocks clears the row
    // filter — click off to unfilter. Clicks inside the row's own block keep
    // it (selecting its text to comment again must not tear the view down);
    // Esc and the header chip remain the deliberate exits. Bubble phase, so
    // overlay controls that stopPropagation never reach here.
    document.addEventListener('click', (event) => {
      if (rowFilter === null) return;
      const t = event.target;
      if (!(t instanceof Element)) return;
      // A target DETACHED mid-dispatch means an overlay interaction: a card
      // click re-renders the panel before the event bubbles here, and the
      // detached card has lost its ancestors — closest() can no longer prove
      // it was chrome, so without this guard clicking a card INSIDE the
      // filtered list read as clicking off (Blake's five-comment repro).
      if (!t.isConnected) return;
      if (t.closest('#rv-root')) return; // panel, gutter, tray, chip
      const block = t.closest('[data-rev]');
      if (block && rowFilterBlockIds().has(block.getAttribute('data-rev'))) return;
      rowFilter = null;
      render();
    });

    // #112: hover over any instrumented block in review mode surfaces the edit
    // pencil. Hovering the pencil itself (inside #rv-root) leaves it up; moving
    // off both hides it. Disarmed while a run is active or a block is being edited.
    document.addEventListener('mouseover', (event) => {
      if (!redline) return;
      const t = event.target;
      if (!(t instanceof Element)) return;
      if (t.closest('#rv-root')) return; // over our own chrome (incl. the pencil)
      const block = t.closest('[data-rev]');
      // The veil and the holder's name are an ON-APPROACH state (#191), so the
      // pointer landing on a held block is their trigger. Ahead of the pencil's
      // own guards on purpose: a block held by a RUN is exactly the case the
      // author most needs named, and `isRunning()` would swallow it.
      setLeaseHover(block && !block.closest('#rv-root') ? block.getAttribute('data-rev') : null);
      if (isRunning() || editing) return;
      // #131: defer, don't hide. Margins and grid gaps between blocks resolve
      // to no [data-rev], and hiding on them strands the cursor mid-journey.
      if (!block || block.closest('#rv-root')) { scheduleHideEditPencil(); return; }
      showEditPencilFor(block);
    });
    // The pencil is placed in page coords for a specific rect; a scroll would
    // strand it. Hide on scroll — it reappears on the next hover.
    window.addEventListener('scroll', hideEditPencil, true);

    renderStrip();
    // Before the first refresh: comments buffered in a previous session must be
    // on screen from the first paint, not appear once the network settles (#202).
    loadBuffer();
    // BOOT IS AN EDGE TOO, and it is the one edge no transition can carry:
    // runnerDown starts false, so a tab that opens with a healthy runner never
    // transitions and never replays. Blake's buffer survived a hard reload —
    // exactly as designed — and then had no path to save at all; three comments
    // came back by hand out of localStorage. A reload made the reconnect edge
    // permanently unreachable in that tab, so a buffer that only fills is a slow
    // silent drop, which is the outcome #202 forbids.
    refresh().then(() => { if (!runnerDown) flushBuffer(); });
    // Watch from boot, not just while this tab has a run: the whole point is
    // noticing what ANOTHER tab did (#106). The stream (#162) makes that
    // near-instant; the watch stays as its backstop.
    startStream();
    startWatching();
    // Close the stream on navigate/unload rather than leaving the runner
    // holding a socket until its heartbeat notices.
    window.addEventListener('pagehide', stopStream);
    // The tab going away has to hand the block back (#189). `keepalive` because
    // an ordinary fetch is cancelled with the document. Neither of these fires
    // reliably on a closed lid or a killed tab, which is precisely why the
    // renewed short TTL exists behind them — a backstop that is never rendered
    // and never counts down, sized so that reaching it means the tab is gone
    // rather than that you were thinking.
    window.addEventListener('pagehide', () => { releaseLease({ keepalive: true }); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        releaseLease({ keepalive: true });
        return;
      }
      // Coming back to a composer or an editor that is still open re-takes the
      // block. If the agent claimed it while the tab was in the background it
      // simply stays claimed — first holder wins, and the composer's own line
      // says the claim ended rather than promising protection nobody holds.
      const open = editing !== null ? editing.blockId
        : (popover !== null && pendingAnchor ? pendingAnchor.blockId : null);
      if (typeof open === 'string' && heldLease === null) acquireLease(open);
    });
  }

  function hint() {
    const host = root();
    applyTheme(host, storedTheme());
    const pill = el('div', 'rv-toolbar rv-hint');
    const status = el('span', 'rv-status');
    status.appendChild(el('span', 'rv-dot rv-dot-off'));
    status.appendChild(document.createTextNode('Runner not connected'));
    status.title = 'Start it with: node runner/index.mjs <dir> — see the extension popup for setup.';
    const dismiss = el('button', undefined, '×');
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.addEventListener('click', () => pill.remove());
    pill.appendChild(status);
    pill.appendChild(dismiss);
    host.appendChild(pill);
  }

  window.__redline = { init, hint };
  // Pure module-level helpers exposed for node DOM-stub tests (never used by
  // production code, which goes through init()).
  window.__rvTest = {
    authorChip, scopeGateChip, formatCost, truncate, shouldClampQuote, anchorBoxRect,
    isSubmitShortcut, groupComments, sectionKey, ACTIONED_ORDER, QUOTE_CLAMP_CHARS,
    runLogFileMeta, groupRunLogFiles, RUNLOG_GROUP_ORDER,
    // Phase 4 repairs: document-order sorting (#105), hidden-anchor
    // detection (#60). Pure on purpose — see the test file. (#223 retired
    // the pencil-geometry trio with the corner pencil itself.)
    sortByDocumentOrder,
    isHidden: window.__rv.anchor.isHidden,
    // Phase 10 card shape: the history ordering (#199) and the three things
    // the card face says about a comment (#201). All pure.
    commentHistory, threadCount, faceStatus, lastSaid, clockTime,
    // #203: the citable handle, derived so any client can compute it.
    shortRef, REF_ALPHABET, REF_LEN,
    // #246: markdown in card prose — expanded cards render it, collapsed
    // surfaces strip it. Pure node-builders, exposed for the DOM-stub tests.
    renderMarkdown, stripMarkdown,
    // #247: long history entries start folded; the rule is pure.
    foldState,
    // #250: the "Needs review" filter now includes failed comments.
    FILTERS,
    // The visibility rule, now runnable rather than source-matchable.
    AUD_FILTERS, inAiBatch,
    passesAxisFilters: modelPassesAxisFilters,
    passesFilters: modelPassesFilters,
    // #268: the search axis — normalisation, the handle guard, what a card
    // exposes to a query, and where the hits fall. All pure.
    foldSearchText: window.__rv.model.foldSearchText,
    handleShape: window.__rv.model.handleShape,
    prepareSearch: window.__rv.model.prepareSearch,
    searchableText: window.__rv.model.searchableText,
    isHandleMatch: window.__rv.model.isHandleMatch,
    matchesSearchText: window.__rv.model.matchesSearchText,
    matchesSearch: window.__rv.model.matchesSearch,
    searchReachedPast: window.__rv.model.searchReachedPast,
    searchHits: window.__rv.model.searchHits,
    HANDLE_LEN: window.__rv.model.HANDLE_LEN,
    HANDLE_EXCLUDED: window.__rv.model.HANDLE_EXCLUDED,
    // #194: the fixed rejection token — watchers and tests key on the string.
    REJECT_MARKER,
    // #239 follow-up: the column hugs the text edge; the arithmetic is pure.
    gutterRightOffset: window.__rv.gutterRightOffset,
    // #219: the gutter's pure half — tiers, the cluster pass, dot geometry.
    gutterTier: window.__rv.model.gutterTier,
    dominantTier: window.__rv.model.dominantTier,
    clusterGutterRows: window.__rv.model.clusterGutterRows,
    gutterDotTop: window.__rv.model.gutterDotTop,
    anchorMarkY: window.__rv.model.anchorMarkY,
    gutterClusterBox: window.__rv.model.gutterClusterBox,
    GUTTER_CLUSTER_PX: window.__rv.model.GUTTER_CLUSTER_PX,
    GUTTER_DOT_SIZE: window.__rv.model.GUTTER_DOT_SIZE,
    // #224: the off-screen counters' arithmetic.
    gutterEdgeCounts: window.__rv.model.gutterEdgeCounts,
    // #267: the hidden-comment stack — grouping by fold, and the rule that
    // keeps a fold mark from ever merging with a real dot.
    // #269: what the gutter-entry chip says, and whether it can widen.
    rowChipLabel: window.__rv.model.rowChipLabel,
    groupFoldRows: window.__rv.model.groupFoldRows,
    foldMarkTop: window.__rv.model.foldMarkTop,
    FOLD_MARK_SIZE: window.__rv.model.FOLD_MARK_SIZE,
    FOLD_MARK_GAP: window.__rv.model.FOLD_MARK_GAP,
    GUTTER_CHIP_MIN_HEIGHT: window.__rv.model.GUTTER_CHIP_MIN_HEIGHT,
  };
})();