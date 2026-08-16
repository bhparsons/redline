# Reviewing interactive documents with Redline

Redline is built for static HTML documents, but most real deliverables are not
static. They use tabs, accordions, carousels, toggle sections, and step-by-step
decks. These patterns hide content until the reader asks for it, which means an
anchor can exist in the DOM but not be visible on screen. The overlay handles this
with two small contracts so the host page and Redline stay out of each other's way.

## The two contracts

### 1. `rv:reveal` — ask the page to show a hidden anchor

When you click a comment whose anchor is inside a hidden container, the overlay
cannot simply scroll to it. It first dispatches a cancellable custom event on the
anchor element:

```js
document.querySelector('[data-rev="r-123"]').dispatchEvent(
  new CustomEvent('rv:reveal', {
    bubbles: true,
    cancelable: true,
    detail: { blockId: 'r-123', el: element }
  })
);
```

The host page can listen and reveal the right slide, tab, panel, or accordion
item. If the event is not cancelled, the overlay proceeds with its normal
scroll-and-flash behavior. If the page cancels it, the overlay assumes the page
will reveal the anchor itself and does nothing further.

Example listeners:

```js
// Tab system: reveal the pane containing the anchor.
document.addEventListener('rv:reveal', (e) => {
  const pane = e.detail.el.closest('.tab-pane');
  if (pane) showTab(pane.dataset.tab);
});

// Deck/carousel: advance to the slide containing the anchor.
document.addEventListener('rv:reveal', (e) => {
  const slide = e.detail.el.closest('.slide');
  if (slide) carousel.goTo(slide.dataset.slideIndex);
});

// Accordion: open the item containing the anchor.
document.addEventListener('rv:reveal', (e) => {
  const item = e.detail.el.closest('.accordion-item');
  if (item && item.classList.contains('collapsed')) item.classList.remove('collapsed');
});
```

The overlay detects the hidden case by checking whether the anchor has no
`offsetParent` or a zero-size bounding rect before it dispatches the event. No
events are fired for anchors that are already visible.

### 2. `window.redline` and `rv:modechange` — tell the page when you are active

The overlay swallows single-letter hotkeys while a comment card, inline editor,
or composer is focused, but it cannot know about hotkeys the host page has
registered globally. The overlay therefore exposes a stable public signal and
fires a mode-change event so the host page can disable its own shortcuts politely.

```js
window.redline = {
  active: true,        // overlay is injected and running
  mode: 'review',      // 'review' or 'view' — armed to capture comments or not
  panelOpen: false,    // side panel is currently open
  version: '0.3.1'     // extension build that injected the overlay
};

// The overlay also writes a data attribute on <html> for CSS-only consumers:
document.documentElement.setAttribute('data-rv-mode', 'review');

// And it dispatches a mode change event:
document.dispatchEvent(
  new CustomEvent('rv:modechange', {
    bubbles: true,
    detail: { mode: 'review', panelOpen: false }
  })
);
```

Host pages that use single-letter shortcuts (e.g. `j`/`k` navigation, `c` to
comment, `r` to reply) can guard them like this:

```js
function hostShortcutAllowed() {
  return !window.redline || !window.redline.active || window.redline.mode === 'view';
}

document.addEventListener('keydown', (e) => {
  if (!hostShortcutAllowed()) return;
  // your own shortcut logic here
});

// Or observe mode changes to update UI state:
document.addEventListener('rv:modechange', (e) => {
  document.body.classList.toggle('redline-active', e.detail.mode === 'review');
});
```

The overlay never reads from the host page. It only writes `window.redline` and
fires `rv:modechange`. The host page decides whether to react.

## What you do not need to do

- You do not need to expose internal state to Redline. The overlay locates
  anchors by `data-rev` block ids and only asks the page to reveal them.
- You do not need to change your keyboard handling if you have no global
  single-letter shortcuts. The overlay stops propagation inside its own inputs
  regardless.
- You do not need to handle `rv:reveal` if your document has no hidden
  containers. The overlay only dispatches the event when an anchor is hidden.

## What to add to your document

If your document has interactive hiding, add one or both listeners before the
overlay loads. If they are present, the review experience is seamless. If they
are absent, the overlay still works, but clicking a comment on a hidden anchor
may scroll to an invisible region.

```html
<script>
// Reveal contract
function revealForRedline(event) {
  const el = event.detail.el;
  const tab = el.closest('.tab-pane');
  if (tab) activateTab(tab.dataset.tab);
}
document.addEventListener('rv:reveal', revealForRedline);

// Hotkey contract
function redlineActive() {
  return window.redline && window.redline.active && window.redline.mode === 'review';
}
document.addEventListener('keydown', (e) => {
  if (redlineActive()) return;
  // your own shortcuts here
});
</script>
```

That's it. Redline stays a guest in your document; your document controls its own
behavior.

## The file on disk is the truth (#228)

Everything above is about *hiding and revealing* content that is **in the
file**. There is a harder case: a page whose script **writes content into
stamped blocks** at runtime — filling a table from JSON, injecting rendered
markup, updating text. That content exists only in the browser, and Redline
reviews **the file on disk**:

- **The agent never sees it.** Prompts carry the disk source; a block your
  script fills at runtime looks empty (or stale) to the agent.
- **Re-sync reverts it.** When a run or a direct edit lands anywhere in the
  document, every open tab pulls each changed block back in step with the
  disk source. Script-written content inside a stamped block is silently
  replaced by what the file says — which may be nothing.
- **Anchors may not match.** A comment anchored to script-written text has a
  quote the disk source does not contain; after a reload it can orphan.

This is deliberate (V1 decision 4): the disk file is the single source of
truth, and Redline documents the limitation rather than trying to merge two
writers into one DOM.

What the extension guarantees (#228): opening a page that has **no runs yet**
does not rewrite the DOM at all — the first re-sync pass is skipped, because
the tab just loaded the same bytes the runner serves. A page that renders
itself on load displays fine and stays rendered *until the first run or
direct edit lands*. From then on, re-sync enforces disk truth.

What to do instead:

- **Review inert documents when you can.** If the content matters for review,
  put it in the file — render once, save the output, review that.
- **Keep script writes out of stamped blocks.** Script-driven chrome (tab
  switching, class toggles, a clock) is fine; it is *content written into
  `data-rev` blocks* that gets reverted.
- **Instrument after rendering, not before.** `node runner/instrument.mjs`
  stamps what is in the file; if a generator produces the page, run it, save
  the result, then instrument.
- **Hidden-but-present beats generated.** All the patterns at the top of this
  page keep content in the file — they review correctly.
