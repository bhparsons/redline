// test/runner/extension-ui.test.mjs — Session 6: overlay UI guardrails.
//
// The overlay only runs in Chrome; what node CAN pin down:
//   - the scripts still parse,
//   - overlay.js talks ONLY to the frozen contract endpoints
//     (design/07-api-contract.md) and content.js only to /health,
//   - overlay.css never styles the user's document beyond the docked-panel
//     reflow pair (html transition + html.rv-panel-open margin) — every other
//     selector must be rv- namespaced,
//   - the storage key names stay stable across sessions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const EXT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

// Tiny CSS walker: strips comments, then yields {selector, body} for every
// style rule (recursing into @media and @supports). @keyframes blocks are
// yielded whole with keyframes: true so the caller can check the animation
// name instead of the inner from/to/percent selectors.
function cssRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const walk = (text) => {
    let i = 0;
    while (i < text.length) {
      const brace = text.indexOf('{', i);
      if (brace === -1) break;
      const selector = text.slice(i, brace).trim();
      let depth = 1;
      let j = brace + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      const body = text.slice(brace + 1, j - 1);
      if (selector.startsWith('@media') || selector.startsWith('@supports')) walk(body);
      else if (selector.startsWith('@keyframes')) rules.push({ selector, body, keyframes: true });
      else rules.push({ selector, body, keyframes: false });
      i = j;
    }
  };
  walk(src);
  return rules;
}

test('extension overlay UI (Session 6)', async (t) => {
  const manifestJs = JSON.parse(await fs.readFile(path.join(EXT_DIR, 'manifest.json'), 'utf8'))
    .content_scripts[0].js;
  // The overlay is a SET of classic content scripts (#71), so every invariant
  // about "the overlay" has to scan all of them — reading overlay.js alone
  // would silently exempt whatever was moved out of it. overlayJs stays
  // separate only where the assertion is about that file specifically.
  const OVERLAY_FILES = manifestJs.filter((f) => /^overlay[-.]/.test(f));
  const overlaySrcs = new Map();
  for (const file of OVERLAY_FILES) {
    overlaySrcs.set(file, await fs.readFile(path.join(EXT_DIR, file), 'utf8'));
  }
  const overlayJs = overlaySrcs.get('overlay.js');
  const overlayAll = [...overlaySrcs.values()].join('\n');
  const contentJs = await fs.readFile(path.join(EXT_DIR, 'content.js'), 'utf8');
  const overlayCss = await fs.readFile(path.join(EXT_DIR, 'overlay.css'), 'utf8');
  // The liquid-glass material system lives in its own file (#98). Invariants
  // about the material — backdrop-filter placement, token definitions — must
  // scan both sheets, or extracting a rule silently exempts it from the test.
  const glassCss = await fs.readFile(path.join(EXT_DIR, 'glass.css'), 'utf8');
  const manifest = JSON.parse(await fs.readFile(path.join(EXT_DIR, 'manifest.json'), 'utf8'));

  await t.test('scripts parse (node --check)', async () => {
    for (const file of [...OVERLAY_FILES, 'content.js', 'refraction.js']) {
      await execFileP(process.execPath, ['--check', path.join(EXT_DIR, file)]);
    }
  });

  await t.test('the overlay references only frozen contract endpoints', () => {
    // Every /api/... string literal (quoted or template) must match the
    // contract allowlist, and each contract endpoint must actually be used.
    const literals = [...overlayAll.matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)].map((m) => m[1]);
    const allow = [
      /^\/api\/comment$/,
      /^\/api\/comments\?page=\$\{[^{}]+\}$/,
      /^\/api\/comment\/\$\{[^{}]+\}\/reply$/,
      /^\/api\/comment\/\$\{[^{}]+\}\/status$/,
      /^\/api\/comment\/\$\{[^{}]+\}\/ai-edits$/, // #96 AI-edits batch toggle
      /^\/api\/comment\/\$\{[^{}]+\}\/anchor$/, // #157 re-anchor an orphaned comment
      /^\/api\/run\/confirm$/, // WP7 scope-guardrail Allow/Decline (#212: /api/run itself is no longer called by the overlay — watcher-only V1)
      /^\/api\/edit$/,         // WP10 direct text edit
      /^\/api\/status\?page=\$\{[^{}]+\}$/,
      /^\/api\/undo$/,
      /^\/api\/instrument$/, // contract amendment 2026-07-22 (design/07-api-contract.md)
      /^\/api\/trace\?runId=\$\{[^{}]+\}&mode=list$/, // WP6 run-log probe
      /^\/api\/trace\?runId=\$\{[^{}]+\}$/,           // WP6 run-log bundle fetch
      /^\/api\/source\?page=\$\{[^{}]+\}$/, // #162 re-sync the document after a remote edit
      /^\/api\/events\?page=\$\{[^{}]+\}$/, // #162 SSE change stream
      /^\/api\/lease$/,       // #189 the human's block lease (composer / edit-in-progress)
      /^\/api\/lease\/renew$/, // #189 renewed while the composer is open, never a visible timer
      /^\/api\/lease\/\$\{[^{}]+\}\?sessionId=\$\{[^{}]+\}$/, // #189 release on save, cancel, tab-away
      /^\/api\/hold$/,        // #190/#191 hold mode, toggled from inside the agent banner
      /^\/api\/lease\/\$\{[^{}]+\}\?force=1$/, // #188/#191 break-glass force-release, recorded
    ];
    for (const literal of literals) {
      assert.ok(allow.some((re) => re.test(literal)), `off-contract api path in the overlay: ${literal}`);
    }
    for (const re of allow) {
      assert.ok(literals.some((l) => re.test(l)), `contract endpoint unused by the overlay: ${re}`);
    }
    // All network traffic funnels through the one runner-origin fetch site —
    // and the split must not have scattered it: the site stays in overlay.js,
    // and every other file takes apiRaw as an argument.
    assert.equal((overlayAll.match(/fetch\(/g) ?? []).length, 1,
      'the overlay must have exactly one fetch call site');
    assert.equal((overlayJs.match(/fetch\(/g) ?? []).length, 1,
      'the one fetch call site must be in overlay.js');
    assert.match(overlayJs, /fetch\(runner\.origin \+ path/);
  });

  await t.test('run-log viewer wiring (WP6, static)', () => {
    // The button probes before showing (hidden when no bundle exists) and
    // both the strip and decided cards can open the viewer.
    assert.match(overlayAll, /function runLogButton\(/);
    assert.match(overlayAll, /mode=list/, 'existence probe present');
    assert.match(overlayAll, /rv-runlog-btn rv-hidden/, 'button starts hidden until the probe confirms');
    assert.match(overlayJs, /runLogButton\(o\.runId\)/, 'strip outcomes carry the button');
    // #96: decided cards reach the run log via the run-id link in the outcome block.
    assert.match(overlayJs, /runLogButton\(runId, runId\)/, 'decided cards link the run id to the log');
    // Failed runs lead with the rejection reason.
    assert.match(overlayAll, /Run failed: \$\{typeof record\.error === 'string' \? record\.error : record\.status\}/);
    // Bundle content renders through el()/textContent — the overlay never
    // WRITES innerHTML (a read to prefill the WP10 direct-edit textarea is
    // safe; assigning untrusted markup is the injection risk we ban).
    assert.ok(!/\binnerHTML\s*=(?!=)/.test(overlayAll), 'overlay never assigns innerHTML');
    // The pane is styled and namespaced.
    assert.match(overlayCss, /#rv-root \.rv-runlog \{/);
    assert.match(overlayCss, /#rv-root \.rv-runlog-pre \{/);
  });

  await t.test('content.js fetches /health only', () => {
    const fetches = [...contentJs.matchAll(/fetch\(([^,)]*)/g)].map((m) => m[1]);
    assert.ok(fetches.length >= 1, 'content.js should ping the runner');
    for (const target of fetches) assert.match(target, /\/health/);
  });

  await t.test('overlay.css styles nothing document-level beyond the reflow pair', () => {
    const rules = cssRules(overlayCss);
    assert.ok(rules.length > 10, 'expected a parsed stylesheet');
    // The docked-panel reflow pair is the ONE sanctioned document-level rule:
    // the bare html selector may only carry the margin transition, and
    // html.rv-panel-open only the matching margin.
    const docLevel = { html: 'transition', 'html.rv-panel-open': 'margin-right' };
    for (const rule of rules) {
      if (rule.keyframes) {
        assert.match(rule.selector, /^@keyframes rv-/, `unnamespaced keyframes: ${rule.selector}`);
        continue;
      }
      for (const part of rule.selector.split(',').map((s) => s.trim())) {
        if (part in docLevel) {
          const props = [...rule.body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map((m) => m[1]);
          assert.deepEqual(props, [docLevel[part]],
            `document-level rule "${part}" may only set ${docLevel[part]}`);
          continue;
        }
        assert.ok(part.includes('#rv-root') || part.includes('.rv-'),
          `document-level selector in overlay.css: ${part}`);
      }
    }
    // The reflow margin must keep matching the docked panel width.
    const margin = overlayCss.match(/html\.rv-panel-open\s*\{\s*margin-right:\s*(\d+)px/);
    const width = overlayCss.match(/\.rv-panel\s*\{[^}]*width:\s*(\d+)px/);
    assert.ok(margin && width, 'reflow margin and panel width should both be present');
    assert.equal(margin[1], width[1], 'html.rv-panel-open margin must equal panel width');
  });

  await t.test('backdrop blur stays on chrome only (no glass-on-glass cards)', () => {
    // design/09-liquid-glass-notes.md: only the floating chrome layers carry
    // backdrop-filter; cards and anything inside the panel must stay flat
    // translucent fills. (#112's direct edit is now in-place contenteditable —
    // no floating editor panel.) The Phase 4 selection pill (#150) is a floating
    // glass capsule of the same class as the toolbar/popover, so it joins the set.
    // #214: .rv-capsule joins the set. It is drawn over the document from
    // #rv-root, not inside a card — the same floating-surface reasoning that
    // admitted the selection pill in #150. Nested, it would have been
    // glass-on-glass; escaped, it is the chrome layer.
    // #222: .rv-stack joins for the same reason — the floating cluster card
    // is a transient, user-invoked surface over the document, panel closed,
    // so it can never sit on other glass.
    const chrome = /\.rv-(toolbar|panel|popover|selpill|capsule|stack)(\.|:|\s|$)/;
    for (const [name, css] of [['overlay.css', overlayCss], ['glass.css', glassCss]]) {
      for (const rule of cssRules(css)) {
        if (!/backdrop-filter\s*:/.test(rule.body)) continue;
        for (const part of rule.selector.split(',').map((s) => s.trim())) {
          // The material sheet scopes its baselines to #rv-root itself (and to
          // theme variants of it); that IS the chrome layer, not a card.
          if (/^#rv-root(:not\([^)]*\))*$/.test(part)) continue;
          assert.match(part, chrome, `backdrop-filter outside the chrome layer (${name}): ${part}`);
        }
      }
    }
  });

  await t.test('glass tokens are defined in glass.css, consumed in overlay.css', () => {
    // The extraction's contract: overlay.css consumes --rv-glass-* but must
    // not redefine it, or the two sheets drift and the material forks.
    assert.ok(/--rv-glass-[\w-]+\s*:/.test(glassCss), 'glass.css must define the --rv-glass-* tokens');
    const redefined = [...overlayCss.matchAll(/^\s*(--rv-glass-[\w-]+)\s*:/gm)].map((m) => m[1]);
    assert.deepEqual(redefined, [], 'overlay.css must not redefine glass tokens');
  });

  await t.test('manifest loads the material system before its consumers', () => {
    // refraction.js sets window.__rvMountRefraction, which overlay.js calls on
    // mount; glass.css defines tokens overlay.css consumes. Order is load-bearing.
    const { js, css } = manifest.content_scripts[0];
    assert.ok(js.indexOf('refraction.js') < js.indexOf('overlay.js'),
      'refraction.js must load before overlay.js');
    assert.ok(css.indexOf('glass.css') < css.indexOf('overlay.css'),
      'glass.css must load before overlay.css');
  });

  await t.test('the loaded build identifies itself', () => {
    // Several unpacked copies of this extension exist at once (one per
    // worktree), and Chrome caches content scripts until a reload — so "which
    // build am I looking at?" has to be answerable from the page. The manifest
    // carries a semver `version` plus a free-form `version_name` label, and
    // both the panel footer and the popup render the label.
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof manifest.version_name, 'string');
    assert.ok(manifest.version_name.startsWith(manifest.version),
      'version_name must lead with the version so the two can never disagree');
    assert.match(overlayAll, /chrome\.runtime\.getManifest\(\)/);
    assert.match(overlayAll, /rv-build-tag/);
    assert.match(overlayCss, /#rv-root \.rv-build-tag \{/);
  });

  await t.test('overlay files load in dependency order (#71)', () => {
    // Classic content scripts, not modules: nothing declares its own
    // dependencies, so the manifest order IS the dependency graph. A file that
    // reads window.__rv.<key> must load after the file that sets it —
    // otherwise the overlay throws on injection, which no other test can see.
    const { js } = manifest.content_scripts[0];
    const sets = new Map(); // __rv key -> index of the file that defines it
    js.forEach((file, i) => {
      const src = overlaySrcs.get(file);
      if (!src) return;
      for (const m of src.matchAll(/window\.__rv\.(\w+)\s*=/g)) {
        if (!sets.has(m[1])) sets.set(m[1], i);
      }
    });
    assert.ok(sets.size >= 4, 'expected the overlay to be split across several files');
    js.forEach((file, i) => {
      const src = overlaySrcs.get(file);
      if (!src) return;
      for (const m of src.matchAll(/window\.__rv\.(\w+)\b(?!\s*=)/g)) {
        const key = m[1];
        if (!sets.has(key)) continue;
        assert.ok(sets.get(key) < i,
          `${file} reads window.__rv.${key} before the file that defines it`);
      }
      // Destructuring straight off the namespace object (const {a} = window.__rv)
      // is the other read shape — every key in it must already exist.
      for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*window\.__rv;/g)) {
        for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
          assert.ok(sets.has(name) && sets.get(name) < i,
            `${file} destructures window.__rv.${name} before it is defined`);
        }
      }
    });
    assert.equal(js[js.length - 1], 'content.js', 'content.js calls into the finished overlay');
    assert.ok(js.indexOf('overlay.js') === js.length - 2,
      'overlay.js is the last overlay file — it consumes all the others');
  });

  await t.test('storage key naming stays stable', () => {
    assert.match(overlayAll, /THEME_KEY = 'rv-theme'/, 'localStorage theme key must stay rv-theme');
    assert.match(overlayAll, /STATE_KEY_PREFIX = 'rv-state:'/, 'sessionStorage prefix must stay rv-state:');
    // Theme forcing is a class pair on #rv-root, chrome-only by construction.
    assert.match(overlayAll, /rv-theme-light/);
    assert.match(overlayAll, /rv-theme-dark/);
  });
});
