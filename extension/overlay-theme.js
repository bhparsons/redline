// overlay-theme.js — the Auto/Light/Dark control in the panel footer.
// Overlay chrome only: the choice is a class on #rv-root and never restyles
// the user's document.
//
// Loads after overlay-util.js (uses el).

(() => {
  'use strict';

  const { el, extensionVersion } = window.__rv.util;

  // Stable storage key — pinned by test/runner/extension-ui.test.mjs.
  const THEME_KEY = 'rv-theme'; // localStorage: 'light' | 'dark'; absent = auto

  // ---- theme: overlay chrome only, never the user's document ---------------
  // The choice lives as a class on #rv-root; overlay.css carries the two token
  // sets (light defaults, dark via prefers-color-scheme unless Light is
  // forced, dark always when Dark is forced).

  function storedTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === 'light' || v === 'dark' ? v : 'auto';
    } catch {
      return 'auto';
    }
  }

  function applyTheme(host, choice) {
    host.classList.toggle('rv-theme-light', choice === 'light');
    host.classList.toggle('rv-theme-dark', choice === 'dark');
  }

  function themeFooter(host) {
    const footer = el('div', 'rv-panel-footer');
    footer.appendChild(el('span', 'rv-footer-label', 'Theme'));
    const seg = el('div', 'rv-seg');
    const buttons = new Map();
    const current = storedTheme();
    for (const [choice, label] of [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]) {
      const btn = el('button', 'rv-seg-btn', label);
      btn.type = 'button';
      btn.classList.toggle('rv-seg-active', choice === current);
      btn.setAttribute('aria-pressed', String(choice === current));
      btn.addEventListener('click', () => {
        try {
          if (choice === 'auto') localStorage.removeItem(THEME_KEY);
          else localStorage.setItem(THEME_KEY, choice);
        } catch { /* private mode — the choice just won't persist */ }
        applyTheme(host, choice);
        for (const [c, b] of buttons) {
          b.classList.toggle('rv-seg-active', c === choice);
          b.setAttribute('aria-pressed', String(c === choice));
        }
      });
      buttons.set(choice, btn);
      seg.appendChild(btn);
    }
    footer.appendChild(seg);
    // Build tag — which unpacked copy is actually injected here. Omitted when
    // the manifest is unreadable (node stub), so the footer stays clean.
    const version = extensionVersion();
    if (version) {
      const tag = el('span', 'rv-build-tag', version);
      tag.title = `Redline extension ${version}`;
      footer.appendChild(tag);
    }
    return footer;
  }

  window.__rv.theme = { THEME_KEY, storedTheme, applyTheme, themeFooter };
})();
