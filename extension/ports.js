// ports.js — the one list of ports a local runner may be listening on.
//
// Loaded by BOTH surfaces that have to guess at a runner: the popup
// (popup.html) and the content script (content.js, via manifest.json). The
// list used to be copy-pasted into each and they drifted — neither copy
// contained 5180, so a runner there was invisible to the popup (#126). node's
// side of this needs no list at all: runner/lib/discovery.mjs finds a runner
// by walking up to its lock file.
//
// Guessing is the FALLBACK path, not the main one. Both surfaces prefer the
// origin that actually served the page; the scan only answers "is there a
// runner anywhere" when there is no such origin to ask (a file:// page, or the
// popup opened over a tab that isn't a document).
//
// Content scripts of one extension share a single isolated world per frame, so
// window.__rvPorts set here is visible to content.js — the same way overlay.js
// publishes window.__rv. The popup is an ordinary page and sees it the same way.

(() => {
  'use strict';

  // The runner's default is 5175; it walks upward when that port is taken, and
  // a worktree started by hand often picks its own. Ten covers every
  // simultaneous session anyone has run here (five were up during #126).
  const RUNNER_PORTS = [5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182, 5183, 5184];

  window.__rvPorts = Object.freeze(RUNNER_PORTS);
})();
