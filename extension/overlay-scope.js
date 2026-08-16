// overlay-scope.js — the scope-confirmation modal (#107 / WP7).
//
// When a run reaches beyond the section the comment was anchored to, the
// runner pauses it and LOCKS the page. That makes the ask modal weight: a
// dialog over the document, not a strip in the panel. Dismissing it hides the
// dialog but not the lock — overlay.js keeps a "page locked" bar and can
// re-open this via show().
//
// A factory: overlay.js passes the host plus what to do on Allow/Decline
// (onResolve) and on "Not now" (onDismiss). This file owns no run state.
//
// Loads after overlay-util.js.

(() => {
  'use strict';

  const { el } = window.__rv.util;

  function createScopeDialog({ host, onResolve, onDismiss }) {
    let scopeScrim = null;

    function hideScopeDialog() {
      if (scopeScrim) { scopeScrim.remove(); scopeScrim = null; }
    }

    function showScopeDialog(scope) {
      hideScopeDialog();
      const s = scope || {};
      scopeScrim = el('div', 'rv-scope-scrim');
      const dlg = el('div', 'rv-scope-dialog');
      const kicker = el('div', 'rv-scope-kicker');
      kicker.appendChild(el('span', 'rv-scope-pulse'));
      kicker.appendChild(document.createTextNode('Confirm scope · page locked'));
      dlg.appendChild(kicker);
      dlg.appendChild(el('div', 'rv-scope-title', s.level === 'page'
        ? 'This change affects the whole page, not just the paragraph you commented on.'
        : 'This change reaches beyond the section you commented on.'));
      const body = el('div', 'rv-scope-body');
      body.appendChild(el('div', undefined, s.summary || 'The edit reaches beyond the commented section.'));
      if (s.touchedThemeZone) {
        body.appendChild(el('div', 'rv-scope-note', 'It edits the page-level theme, which every block inherits.'));
      }
      // The reach, in the document's own words. `data-rev` ids mean nothing to
      // a reviewer — they recognise the sentence (#106, mock part 9). The
      // runner sends `reach`; fall back to ids only for an older runner, or
      // for a block that no longer resolves.
      const reach = Array.isArray(s.reach) ? s.reach : null;
      const touched = Array.isArray(s.touchedBlocks) ? s.touchedBlocks : [];
      if (reach !== null && reach.length > 0) {
        const list = el('ul', 'rv-scope-blocks');
        for (const item of reach) {
          const li = el('li');
          if (item.kind === 'theme') {
            li.className = 'rv-scope-theme';
            const props = Array.isArray(item.props) ? item.props.filter(Boolean) : [];
            li.textContent = props.length > 0
              ? `page theme — ${props.join(', ')}`
              : 'page theme';
          } else if (item.kind === 'section' && item.text) {
            li.appendChild(document.createTextNode('the '));
            li.appendChild(el('b', undefined, item.text));
            li.appendChild(document.createTextNode(' section'));
          } else if (item.text) {
            li.className = 'rv-scope-quote';
            li.textContent = `“${item.text}”`;
          } else {
            // Unresolvable block: the id is the only honest thing left.
            li.className = 'rv-scope-unknown';
            li.textContent = item.blockId || 'a block that no longer exists';
          }
          list.appendChild(li);
        }
        body.appendChild(list);
      } else if (touched.length > 0) {
        const n = touched.length;
        body.appendChild(el('div', 'rv-scope-blocks',
          `Affects ${n} block${n === 1 ? '' : 's'}: ${touched.join(', ')}`));
      }
      dlg.appendChild(body);
      const acts = el('div', 'rv-scope-actions');
      const allow = el('button', 'rv-btn rv-btn-primary', 'Allow this change');
      allow.type = 'button';
      const decline = el('button', 'rv-btn', 'Decline');
      decline.type = 'button';
      const dismiss = el('button', 'rv-btn rv-scope-dismiss', 'Not now');
      dismiss.type = 'button';
      allow.addEventListener('click', () => onResolve(true, allow, decline));
      decline.addEventListener('click', () => onResolve(false, allow, decline));
      dismiss.addEventListener('click', () => { hideScopeDialog(); onDismiss(); });
      acts.appendChild(allow);
      acts.appendChild(decline);
      acts.appendChild(el('span', 'rv-scope-spacer'));
      acts.appendChild(dismiss);
      dlg.appendChild(acts);
      scopeScrim.appendChild(dlg);
      host.appendChild(scopeScrim);
    }

    return { show: showScopeDialog, hide: hideScopeDialog };
  }

  window.__rv = window.__rv || {};
  window.__rv.createScopeDialog = createScopeDialog;
})();
