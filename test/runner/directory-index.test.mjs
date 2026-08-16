// test/runner/directory-index.test.mjs — issue #129: the served-directory root
// is browsable instead of returning {"error":"not found"}.
//
// Covers the listing contract (GET /api/dir), the rendered index page, and the
// guards the issue names: traversal, dotfiles, and redline.config.json — which
// can carry the OpenRouter API key and must appear in neither surface.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { listDirectory, renderIndex, escapeHtml } from '../../runner/lib/directory.mjs';

const INSTRUMENTED = '<!doctype html>\n<html><body>\n'
  + '<p data-rev="r-0001">reviewed paragraph</p>\n</body></html>\n';
const PLAIN = '<!doctype html>\n<html><body>\n<p>never stamped</p>\n</body></html>\n';

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-dirindex-'));
  await fs.mkdir(path.join(root, 'docs', 'deep'), { recursive: true });
  await fs.mkdir(path.join(root, 'zeta'));
  await fs.mkdir(path.join(root, 'withindex'));
  await fs.writeFile(path.join(root, 'top.html'), INSTRUMENTED);
  await fs.writeFile(path.join(root, 'Beta.md'), '# Beta\n');
  await fs.writeFile(path.join(root, 'alpha.txt'), 'alpha\n');
  await fs.writeFile(path.join(root, '.secret'), 'hidden\n');
  await fs.writeFile(path.join(root, 'redline.config.json'),
    JSON.stringify({ agent: { apiKey: 'sk-or-v1-NEVER-LEAK-THIS' } }));
  await fs.writeFile(path.join(root, 'docs', 'inner.html'), PLAIN);
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n');
  await fs.writeFile(path.join(root, 'docs', 'deep', 'leaf.txt'), 'leaf\n');
  await fs.writeFile(path.join(root, 'withindex', 'index.html'),
    '<body><p>author index wins</p></body>\n');
  // Sidecar for top.html: two comments, one already addressed.
  await fs.writeFile(path.join(root, 'top.html.review.json'), JSON.stringify({
    rev: 2,
    comments: [
      { id: 'c-1', body: 'stays open', status: 'open' },
      { id: 'c-2', body: 'handled', status: 'addressed' },
    ],
  }));
  return root;
}

test('directory listing contract', async (t) => {
  const root = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const listing = await listDirectory(root, '');
  assert.equal(listing.path, '');
  assert.deepEqual(listing.entries.map((e) => e.name),
    ['docs', 'withindex', 'zeta', 'alpha.txt', 'Beta.md', 'top.html', 'top.html.review.json'],
    'dirs first, then case-insensitive alpha');

  assert.ok(!listing.entries.some((e) => e.name === '.secret'), 'dotfiles are hidden');
  assert.ok(!listing.entries.some((e) => e.name === 'redline.config.json'),
    'the runner config is never listed — it can carry the API key');

  const dir = listing.entries.find((e) => e.name === 'docs');
  assert.deepEqual(
    { type: dir.type, size: dir.size, ext: dir.ext, mtime: typeof dir.mtime },
    { type: 'dir', size: null, ext: null, mtime: 'string' });

  const md = listing.entries.find((e) => e.name === 'Beta.md');
  assert.equal(md.type, 'file');
  assert.equal(md.ext, 'md');
  assert.ok(md.size > 0);
  assert.ok(!('page' in md), 'non-HTML entries carry no review state');

  const top = listing.entries.find((e) => e.name === 'top.html');
  assert.deepEqual(top.page,
    { instrumented: true, sidecar: true, comments: 2, openComments: 1 });

  const docs = await listDirectory(root, 'docs');
  assert.equal(docs.path, 'docs');
  assert.deepEqual(docs.entries.map((e) => e.name), ['deep', 'guide.md', 'inner.html']);
  assert.deepEqual(docs.entries.find((e) => e.name === 'inner.html').page,
    { instrumented: false, sidecar: false, comments: 0, openComments: 0 },
    'un-instrumented, never-reviewed HTML still enriches');

  const deep = await listDirectory(root, 'docs/deep');
  assert.deepEqual(deep.entries.map((e) => e.name), ['leaf.txt']);
});

test('directory listing guards', async (t) => {
  const root = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const rejects = async (rel, code) => {
    await assert.rejects(() => listDirectory(root, rel), (err) => err.code === code,
      `${JSON.stringify(rel)} should throw ${code}`);
  };
  await rejects('..', 'EBADDIRPATH');
  await rejects('docs/../../etc', 'EBADDIRPATH');
  await rejects('.history', 'EBADDIRPATH');
  await rejects('docs/.git', 'EBADDIRPATH');
  await rejects('nope', 'ENOTDIRECTORY');
  await rejects('top.html', 'ENOTDIRECTORY');
});

test('rendered index page', async (t) => {
  const root = await makeFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const html = renderIndex({ rootName: 'fixture', listing: await listDirectory(root, '') });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('href="/top.html"'), 'HTML documents link to themselves');
  assert.ok(html.includes('href="/docs/"'), 'subdirectories link with a trailing slash');
  assert.ok(html.includes('1 open'), 'open-comment count shows on a reviewed page');
  assert.ok(!html.includes('<script'), 'the index page ships no JavaScript');
  assert.ok(!/src=|href="http/.test(html), 'the index page fetches nothing external');
  assert.ok(!html.includes('sk-or-v1-'), 'no path renders the API key');

  const nested = renderIndex({ rootName: 'fixture', listing: await listDirectory(root, 'docs/deep') });
  assert.ok(nested.includes('href="/"') && nested.includes('href="/docs/"'),
    'breadcrumbs walk back up to the root');

  assert.equal(escapeHtml('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('a name with HTML metacharacters is escaped, not injected', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-dirxss-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nasty = '<img src=x onerror=alert(1)>.txt';
  await fs.writeFile(path.join(root, nasty), 'x\n');

  const html = renderIndex({ rootName: 'x', listing: await listDirectory(root, '') });
  assert.ok(!html.includes('<img src=x'), 'the raw tag never reaches the document');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.txt'));
  assert.ok(html.includes('href="/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E.txt"'),
    'the href is percent-encoded per segment');
});

test('server serves the directory index over HTTP', async (t) => {
  const root = await makeFixture();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const rootRes = await fetch(base + '/');
  const rootHtml = await rootRes.text();
  assert.equal(rootRes.status, 200, 'the served root is no longer a 404');
  assert.match(rootRes.headers.get('content-type'), /text\/html/);
  assert.ok(rootHtml.includes('href="/top.html"'));
  assert.ok(!rootHtml.includes('redline.config.json'));
  assert.ok(!rootHtml.includes('redline:overlay-injection-point'),
    'the index is the runner\'s own page, not a document under review');

  const sub = await fetch(base + '/docs/');
  assert.equal(sub.status, 200);
  assert.ok((await sub.text()).includes('href="/docs/inner.html"'));

  const bare = await fetch(base + '/docs');
  assert.equal(bare.status, 200, 'a directory without a trailing slash lists too');

  const authored = await fetch(base + '/withindex/');
  const authoredHtml = await authored.text();
  assert.ok(authoredHtml.includes('author index wins'), 'index.html still takes precedence');
  assert.ok(authoredHtml.includes('redline:overlay-injection-point'),
    'an authored index.html is still a reviewable document');

  const head = await fetch(base + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);

  const missing = await fetch(base + '/nope/');
  assert.equal(missing.status, 404, 'a directory that does not exist is still a 404');
});

test('GET /api/dir', async (t) => {
  const root = await makeFixture();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const get = async (qs) => {
    const res = await fetch(base + '/api/dir' + qs);
    return { status: res.status, body: await res.json() };
  };

  const rootLs = await get('?path=');
  assert.equal(rootLs.status, 200);
  assert.equal(rootLs.body.path, '');
  assert.ok(rootLs.body.entries.some((e) => e.name === 'top.html'));
  assert.ok(!rootLs.body.entries.some((e) => e.name === 'redline.config.json'));

  assert.equal((await get('?path=docs')).body.path, 'docs');
  assert.equal((await get('?path=' + encodeURIComponent('..'))).status, 400);
  assert.equal((await get('?path=' + encodeURIComponent('docs/../../etc'))).status, 400);
  assert.equal((await get('?path=.history')).status, 400);
  assert.equal((await get('?path=nope')).status, 404);
  assert.equal((await get('?path=top.html')).status, 404);

  const post = await fetch(base + '/api/dir', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(post.status, 405);
});
