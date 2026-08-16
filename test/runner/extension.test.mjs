// test/runner/extension.test.mjs — Session 2: extension package sanity.
//
// The extension itself only runs in Chrome (manual check: load unpacked at
// chrome://extensions). What node CAN guard: the manifest is valid MV3, every
// file it references exists, the scripts parse, and detection stays pinned to
// local origins only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const EXT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

test('extension package sanity', async (t) => {
  const manifest = JSON.parse(await fs.readFile(path.join(EXT_DIR, 'manifest.json'), 'utf8'));

  await t.test('manifest is MV3 with required fields', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.name && manifest.version && manifest.description);
  });

  await t.test('every referenced file exists', async () => {
    const referenced = [
      ...manifest.content_scripts.flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
      manifest.action.default_popup,
    ];
    for (const file of referenced) {
      await fs.access(path.join(EXT_DIR, file));
    }
  });

  await t.test('overlay.js loads before content.js (content.js calls into it)', () => {
    const js = manifest.content_scripts[0].js;
    assert.ok(js.indexOf('overlay.js') < js.indexOf('content.js'));
  });

  await t.test('host permissions and matches are local-only', () => {
    const locals = /^(http:\/\/(127\.0\.0\.1|localhost)\/\*|file:\/\/\/\*)$/;
    for (const pattern of manifest.host_permissions) assert.match(pattern, locals);
    for (const cs of manifest.content_scripts) {
      for (const pattern of cs.matches) assert.match(pattern, locals);
    }
  });

  await t.test('scripts parse (node --check)', async () => {
    for (const file of ['ports.js', 'content.js', 'overlay.js', 'popup.js']) {
      await execFileP(process.execPath, ['--check', path.join(EXT_DIR, file)]);
    }
  });

  await t.test('ports.js is the one scan range, and covers the runner default', async () => {
    const src = await fs.readFile(path.join(EXT_DIR, 'ports.js'), 'utf8');
    assert.ok(src.includes('5175'), 'default runner port present in scan range');
    // #126: the list was copy-pasted into content.js and popup.js and drifted —
    // neither copy had 5180, so a runner there was invisible to the popup.
    // Neither surface may carry its own literal any more.
    for (const file of ['content.js', 'popup.js']) {
      const s = await fs.readFile(path.join(EXT_DIR, file), 'utf8');
      assert.ok(s.includes('__rvPorts'), `${file} reads the shared port list`);
      assert.ok(!/\b517[5-9]\b/.test(s.replace(/^\s*\/\/.*$/gm, '')),
        `${file} carries no port literal of its own`);
    }
  });

  await t.test('ports.js loads before the scripts that read it', () => {
    const js = manifest.content_scripts[0].js;
    assert.equal(js[0], 'ports.js', 'ports.js is first in the content-script list');
    assert.ok(js.indexOf('ports.js') < js.indexOf('content.js'));
  });
});
