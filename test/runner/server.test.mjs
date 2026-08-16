// test/runner/server.test.mjs — Session 1: runner skeleton.
//
// Self-contained: builds its own fixture dir under a tmpdir and starts the
// server on an OS-assigned port. No git sandbox needed yet — the skeleton
// never writes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startServer,
  resolvePath,
  injectPlaceholder,
  INJECTION_PLACEHOLDER,
} from '../../runner/lib/server.mjs';

async function makeFixtureDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-runner-'));
  await fs.writeFile(path.join(dir, 'doc.html'),
    '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n<p data-rev="r-0001">hello</p>\n</body></html>\n');
  await fs.writeFile(path.join(dir, 'fragment.html'), '<p>no body tag here</p>\n');
  await fs.writeFile(path.join(dir, 'style.css'), 'p { color: red; }\n');
  await fs.writeFile(path.join(dir, '.secret'), 'dotfile\n');
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'index.html'), '<body><p>sub index</p></body>\n');
  await fs.writeFile(path.join(path.dirname(dir), 'outside-' + path.basename(dir) + '.txt'), 'outside\n');
  return dir;
}

test('runner server skeleton', async (t) => {
  const root = await makeFixtureDir();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  await t.test('GET /health returns ok', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  await t.test('serves HTML with the injection placeholder before </body>', async () => {
    const res = await fetch(`${base}/doc.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes(INJECTION_PLACEHOLDER));
    assert.ok(html.indexOf(INJECTION_PLACEHOLDER) < html.toLowerCase().lastIndexOf('</body>'));
    assert.ok(html.includes('data-rev="r-0001"'), 'document content survives injection');
  });

  await t.test('HTML without </body> gets the placeholder appended', async () => {
    const html = await (await fetch(`${base}/fragment.html`)).text();
    assert.ok(html.trimEnd().endsWith(INJECTION_PLACEHOLDER));
  });

  await t.test('files on disk stay clean (injection is serve-time only)', async () => {
    await fetch(`${base}/doc.html`);
    const onDisk = await fs.readFile(path.join(root, 'doc.html'), 'utf8');
    assert.ok(!onDisk.includes(INJECTION_PLACEHOLDER));
  });

  await t.test('non-HTML files served verbatim, no injection', async () => {
    const res = await fetch(`${base}/style.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/css/);
    assert.equal(await res.text(), 'p { color: red; }\n');
  });

  await t.test('directory serves its index.html', async () => {
    const html = await (await fetch(`${base}/sub/`)).text();
    assert.ok(html.includes('sub index'));
  });

  await t.test('missing file → 404', async () => {
    assert.equal((await fetch(`${base}/nope.html`)).status, 404);
  });

  await t.test('dotfiles → 404', async () => {
    assert.equal((await fetch(`${base}/.secret`)).status, 404);
  });

  await t.test('path traversal → 404, plain and percent-encoded', async () => {
    for (const p of ['/../etc/passwd', '/%2e%2e/etc/passwd', '/sub/%2e%2e/%2e%2e/outside.txt']) {
      assert.equal((await fetch(`${base}${p}`)).status, 404, p);
    }
  });

  await t.test('non-GET methods → 405', async () => {
    assert.equal((await fetch(`${base}/doc.html`, { method: 'POST' })).status, 405);
  });
});

test('resolvePath unit checks', async (t) => {
  const root = path.resolve('/srv/docs');

  await t.test('normal paths resolve under root', () => {
    assert.equal(resolvePath(root, '/a/b.html'), path.join(root, 'a', 'b.html'));
    assert.equal(resolvePath(root, '/'), root);
  });

  await t.test('dot segments are clamped at root by URL normalization', () => {
    // WHATWG URL collapses ".." (and "%2e%2e") before the path can escape "/",
    // so these resolve safely under root rather than above it.
    assert.equal(resolvePath(root, '/../x'), path.join(root, 'x'));
    assert.equal(resolvePath(root, '/a/../../x'), path.join(root, 'x'));
    assert.equal(resolvePath(root, '/%2e%2e/x'), path.join(root, 'x'));
  });

  await t.test('encoded-slash traversal and dotfiles are rejected', () => {
    // "%2F" survives URL normalization and only becomes "/" after decoding —
    // the segment check must catch the ".." it reveals.
    assert.equal(resolvePath(root, '/a%2F..%2F..%2Fx'), null);
    assert.equal(resolvePath(root, '/..%2f..%2fetc/passwd'), null);
    assert.equal(resolvePath(root, '/.git/config'), null);
    assert.equal(resolvePath(root, '/a/.hidden'), null);
    assert.equal(resolvePath(root, '/%00'), null);
  });
});

test('injectPlaceholder unit checks', async (t) => {
  await t.test('inserts before the LAST </body>, case-insensitive', () => {
    const html = '<body><code>&lt;/body&gt; literal</code></BODY>';
    const out = injectPlaceholder(html);
    assert.ok(out.endsWith(INJECTION_PLACEHOLDER + '\n</BODY>'));
  });

  await t.test('appends when no </body> exists', () => {
    assert.ok(injectPlaceholder('<p>x</p>').endsWith(INJECTION_PLACEHOLDER + '\n'));
  });
});
