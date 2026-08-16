// overlay-runlog.js — the run-log viewer (WP6/WP12). The trace bundle
// (tmp/review-runs/<runId>/) is served read-only by GET /api/trace; this file
// owns the probe, the button, and the pane that renders the bundle as a
// pipeline (prompt → request → response → validation → record).
//
// A factory rather than a singleton: it takes the host element and the raw API
// caller from overlay.js, so the ONE fetch call site stays in overlay.js and
// this file has no network code of its own.
//
// Loads after overlay-util.js and overlay-model.js.

(() => {
  'use strict';

  const { el } = window.__rv.util;
  const { groupRunLogFiles, scopeGateChip } = window.__rv.model;

  function createRunLog({ host, apiRaw }) {
    const traceProbes = new Map(); // runId -> Promise<boolean>
    function hasTrace(runId) {
      if (!traceProbes.has(runId)) {
        traceProbes.set(runId, apiRaw(`/api/trace?runId=${encodeURIComponent(runId)}&mode=list`)
          .then((r) => r.status === 200)
          .catch(() => false));
      }
      return traceProbes.get(runId);
    }

    function runLogButton(runId, label = 'View run log') {
      const logBtn = el('button', 'rv-btn rv-runlog-btn rv-hidden', label);
      logBtn.type = 'button';
      logBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        openRunLog(runId);
      });
      hasTrace(runId).then((ok) => {
        if (ok) logBtn.classList.remove('rv-hidden');
      });
      return logBtn;
    }

    let runlogEl = null;
    function closeRunLog() {
      if (runlogEl !== null) {
        runlogEl.remove();
        runlogEl = null;
      }
    }

    async function openRunLog(runId) {
      closeRunLog();
      const pane = el('div', 'rv-runlog');
      const head = el('div', 'rv-runlog-head');
      head.appendChild(el('span', 'rv-runlog-title', `Run log · ${runId}`));
      const close = el('button', 'rv-strip-dismiss', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close run log');
      close.addEventListener('click', closeRunLog);
      head.appendChild(close);
      pane.appendChild(head);
      const body = el('div', 'rv-runlog-body');
      body.appendChild(el('div', 'rv-runlog-loading', 'Loading trace bundle…'));
      pane.appendChild(body);
      host.appendChild(pane);
      runlogEl = pane;

      const r = await apiRaw(`/api/trace?runId=${encodeURIComponent(runId)}`);
      if (runlogEl !== pane) return; // closed or replaced while loading
      body.replaceChildren();
      if (r.status !== 200 || !r.body || !Array.isArray(r.body.files)) {
        body.appendChild(el('div', 'rv-runlog-error', 'No trace bundle found for this run.'));
        return;
      }
      // A failed run leads with its rejection reason, prominently.
      const runFile = r.body.files.find((f) => f && f.name === 'run.json');
      let record = null;
      try {
        record = runFile ? JSON.parse(runFile.content) : null;
      } catch { /* unparseable run.json — the raw file below still shows it */ }
      if (record && record.status && record.status !== 'ok') {
        body.appendChild(el('div', 'rv-runlog-error',
          `Run failed: ${typeof record.error === 'string' ? record.error : record.status}`));
      }
      // #236: the scope-gate outcome, on the pane's title bar. A declined
      // confirmation resolves no comment — its card-thread row (overlay.js)
      // never gets built — so this trace pane is the one place its (billed,
      // discarded) run is reachable at all.
      const gateChip = scopeGateChip(record);
      if (gateChip) head.appendChild(gateChip);

      // Explainer (WP12): what the pipeline files mean. Dismissible.
      const explain = el('div', 'rv-runlog-explain');
      explain.appendChild(el('span', 'rv-runlog-explain-icon', 'ℹ'));
      explain.appendChild(el('span', 'rv-runlog-explain-text',
        'A run in order: the Prompt sent to the agent, the raw Agent request/response, '
        + 'the Validation verdict, and the final Run record with decisions.'));
      const explainX = el('button', 'rv-strip-dismiss', '×');
      explainX.type = 'button';
      explainX.setAttribute('aria-label', 'Dismiss');
      explainX.addEventListener('click', () => explain.remove());
      explain.appendChild(explainX);
      body.appendChild(explain);

      // Files grouped into the pipeline stages (WP12).
      for (const group of groupRunLogFiles(r.body.files)) {
        const section = el('div', 'rv-runlog-group');
        section.appendChild(el('div', 'rv-runlog-group-title', group.label));
        for (const file of group.files) {
          const box = el('details', 'rv-runlog-file');
          if (file.meta.group === 'prompt' || file.meta.group === 'validation') box.open = true;
          const summary = el('summary');
          summary.appendChild(el('span', 'rv-runlog-file-icon', file.meta.icon));
          summary.appendChild(el('span', 'rv-runlog-file-name', file.name));
          box.appendChild(summary);
          // textContent only (via el) — bundle content is data, never markup.
          box.appendChild(el('pre', 'rv-runlog-pre', file.content));
          section.appendChild(box);
        }
        body.appendChild(section);
      }
    }

    return { runLogButton, openRunLog, closeRunLog };
  }

  window.__rv = window.__rv || {};
  window.__rv.createRunLog = createRunLog;
})();
