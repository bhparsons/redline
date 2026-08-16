// test/runner/overlay-runlog.test.mjs — WP12: run-log pane legibility.
//
// The run-log pane groups the trace-bundle files into pipeline stages (Prompt
// → Agent request → Agent response → Validation → Run record) so a run reads
// as a sequence, not a pile of filenames. groupRunLogFiles()/runLogFileMeta()
// are the pure categorization the pane renders; testing them locks the stage
// assignment and order without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadOverlay, EXT_DIR } from './_overlay-load.mjs';


test('runLogFileMeta assigns each bundle file to a pipeline stage', () => {
  const { runLogFileMeta } = loadOverlay();
  assert.equal(runLogFileMeta('prompt.md').group, 'prompt');
  assert.equal(runLogFileMeta('001-prompt.md').group, 'prompt');
  assert.equal(runLogFileMeta('agent-request.json').group, 'request');
  assert.equal(runLogFileMeta('agent-response.json').group, 'response');
  assert.equal(runLogFileMeta('validation.json').group, 'validation');
  assert.equal(runLogFileMeta('scope.json').group, 'validation');
  assert.equal(runLogFileMeta('run.json').group, 'record');
  assert.equal(runLogFileMeta('mystery.txt').group, 'other');
});

test('groupRunLogFiles orders stages and drops empty ones', () => {
  const { groupRunLogFiles } = loadOverlay();
  const files = [
    { name: 'run.json', content: '{}' },
    { name: 'agent-response.json', content: '{}' },
    { name: 'prompt.md', content: 'hi' },
    { name: 'agent-request.json', content: '{}' },
    { name: 'validation.json', content: '{}' },
  ];
  const groups = groupRunLogFiles(files);
  // Rendered in pipeline order regardless of input order; no empty groups.
  assert.deepEqual(Array.from(groups, (g) => g.group), ['prompt', 'request', 'response', 'validation', 'record']);
  assert.deepEqual(Array.from(groups, (g) => g.label),
    ['Prompt', 'Agent request', 'Agent response', 'Validation', 'Run record']);
  // Each file carries its meta (icon/label) for rendering.
  const prompt = groups[0].files[0];
  assert.equal(prompt.name, 'prompt.md');
  assert.equal(typeof prompt.meta.icon, 'string');
});

test('the pane wires an explainer and grouped rendering (static)', () => {
  // The viewer moved to its own file (#71); read that one, not overlay.js.
  const src = readFileSync(path.join(EXT_DIR, 'overlay-runlog.js'), 'utf8');
  assert.match(src, /rv-runlog-explain/);
  assert.match(src, /groupRunLogFiles\(r\.body\.files\)/);
  assert.match(src, /rv-runlog-group-title/);
  // It fetches nothing itself — the single call site stays in overlay.js.
  assert.ok(!/fetch\(/.test(src), 'the run-log viewer must go through the injected apiRaw');
});
