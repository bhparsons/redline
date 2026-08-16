// test/runner/instrument.test.mjs — data-rev stamping: lib, CLI, endpoint.
//
// Self-contained like the other runner tests: fixture dirs in tmpdirs, the
// runner on an OS-assigned port, no network beyond localhost. Covers
// instrumentSource (what gets stamped, idempotency, existing ids never
// altered, collision-checked minting, protected ranges), the CLI's --check
// exit codes, and POST /api/instrument (happy, idempotent second call, 404,
// 405, unbalanced-page refusal).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrumentSource, instrumentFile, mintId, STAMP_TAGS, CONTAINER_TAGS } from '../../runner/lib/instrument.mjs';
import { revIds, checkBalanced, isAsciiOnly } from '../../runner/lib/surgery.mjs';
import { startServer } from '../../runner/lib/server.mjs';

const execFileP = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'runner', 'instrument.mjs');

const UNSTAMPED_HTML = [
  '<!doctype html>',
  '<html><head><title>t</title><style>p { color: red; }</style></head>',
  '<body>',
  '<section id="s1">',
  '<h1>Heading &mdash; one</h1>',
  '<p>alpha <span class="m">bravo</span> charlie</p>',
  '<div class="pull">leaf text div with <em>inline</em> content</div>',
  '<div class="wrap"><p>nested paragraph</p></div>',
  '<ul><li>first</li><li>second</li></ul>',
  '</section>',
  '<!-- <p>commented out</p> -->',
  '<script>const html = "<p>not real</p>";</script>',
  '</body></html>',
  '',
].join('\n');

test('instrumentSource', async (t) => {
  await t.test('stamps leaf text blocks, sections, and leaf text divs only', () => {
    const { source, added, total } = instrumentSource(UNSTAMPED_HTML);
    // section, h1, p, leaf div, nested p, li, li — the wrapper div (block
    // child), the inline span, title/style/script/comment content: never.
    assert.equal(added, 7);
    assert.equal(total, 7);
    const ids = revIds(source);
    assert.equal(ids.length, 7);
    assert.equal(new Set(ids).size, 7, 'all minted ids unique');
    for (const id of ids) assert.match(id, /^r-[0-9a-f]{4}$/);
    assert.match(source, /<section data-rev="r-[0-9a-f]{4}" id="s1">/);
    assert.match(source, /<div data-rev="r-[0-9a-f]{4}" class="pull">/);
    assert.match(source, /<div class="wrap"><p data-rev="r-[0-9a-f]{4}">nested paragraph<\/p><\/div>/,
      'wrapper div unstamped, its leaf p stamped');
    assert.ok(!/<span[^>]*data-rev/.test(source), 'inline tags never stamped');
    assert.ok(!/<title[^>]*data-rev/.test(source));
    assert.ok(source.includes('<!-- <p>commented out</p> -->'), 'comments untouched');
    assert.ok(source.includes('const html = "<p>not real</p>";'), 'script content untouched');
    assert.equal(checkBalanced(source).ok, true);
    assert.equal(isAsciiOnly(source), true, 'stamping an ASCII doc keeps it ASCII');
  });

  await t.test('idempotent: a second pass is a byte-for-byte no-op', () => {
    const first = instrumentSource(UNSTAMPED_HTML);
    const second = instrumentSource(first.source);
    assert.equal(second.added, 0);
    assert.equal(second.total, first.total);
    assert.equal(second.source, first.source);
  });

  await t.test('existing ids are never altered; minting avoids them', () => {
    const seeded = UNSTAMPED_HTML.replace('<p>alpha', '<p data-rev="r-aaaa">alpha');
    const { source, added, total } = instrumentSource(seeded);
    assert.equal(added, 6, 'the pre-stamped p is skipped');
    assert.equal(total, 7);
    assert.match(source, /<p data-rev="r-aaaa">alpha <span class="m">bravo<\/span> charlie<\/p>/,
      'pre-existing id byte-identical');
    const ids = revIds(source);
    assert.equal(ids.filter((id) => id === 'r-aaaa').length, 1, 'no duplicate of the seeded id');
    assert.equal(new Set(ids).size, 7);
  });

  await t.test('mintId retries past collisions and never returns a taken id', () => {
    const taken = new Set(['r-aaaa']);
    for (let i = 0; i < 200; i++) {
      const id = mintId(taken);
      assert.match(id, /^r-[0-9a-f]{4}$/);
    }
    assert.equal(taken.size, 201, '200 minted + the seed, all distinct');
    // Force the collision path: has() reports "taken" a few times before
    // yielding — mintId must keep going and add exactly the id it returns.
    let rejections = 3;
    const added = [];
    const fake = { has: () => rejections-- > 0, add: (id) => added.push(id) };
    const id = mintId(fake);
    assert.equal(added.length, 1);
    assert.equal(added[0], id);
  });

  await t.test('STAMP_TAGS is the leaf-block set plus the containers (WP2)', () => {
    assert.deepEqual([...STAMP_TAGS].sort(), [
      'article', 'aside', 'blockquote', 'figcaption', 'footer',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
      'li', 'main', 'nav', 'p', 'pre', 'section', 'td', 'th',
    ]);
    assert.deepEqual([...CONTAINER_TAGS].sort(),
      ['article', 'aside', 'footer', 'header', 'main', 'nav', 'section']);
    for (const tag of CONTAINER_TAGS) assert.ok(STAMP_TAGS.has(tag), tag);
  });

  await t.test('multi-level: container AND its child blocks both stamped, nested ids distinct', () => {
    const html = '<!doctype html>\n<html><body>\n<main>\n'
      + '<article>\n<h2>Title</h2>\n<p>body text</p>\n</article>\n'
      + '<aside><p>aside note</p></aside>\n'
      + '</main>\n</body></html>\n';
    const { source, added } = instrumentSource(html);
    // main, article, h2, p, aside, p — every level stamped.
    assert.equal(added, 6);
    assert.match(source, /<main data-rev="r-[0-9a-f]{4}">/);
    assert.match(source, /<article data-rev="r-[0-9a-f]{4}">/);
    assert.match(source, /<aside data-rev="r-[0-9a-f]{4}">/);
    const ids = revIds(source);
    assert.equal(new Set(ids).size, ids.length, 'no collisions across nesting levels');
    assert.equal(checkBalanced(source).ok, true);
    assert.equal(instrumentSource(source).added, 0, 'idempotent with nesting');
  });
});

test('instrument CLI', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-inst-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'doc.html');

  await t.test('--check on an unstamped file: exit 1 with count, file untouched', async () => {
    await fs.writeFile(file, UNSTAMPED_HTML);
    const err = await execFileP(process.execPath, [CLI, '--check', file]).catch((e) => e);
    assert.ok(err instanceof Error, '--check on an unstamped file must exit nonzero');
    assert.equal(err.code, 1);
    assert.match(err.stdout, /7 unstamped blocks/);
    assert.equal(await fs.readFile(file, 'utf8'), UNSTAMPED_HTML, '--check never writes');
  });

  await t.test('stamping run: exit 0, file stamped; second run is a no-op', async () => {
    const first = await execFileP(process.execPath, [CLI, file]);
    assert.match(first.stdout, /stamped .*7 new blocks/);
    const stamped = await fs.readFile(file, 'utf8');
    assert.equal(revIds(stamped).length, 7);

    const second = await execFileP(process.execPath, [CLI, file]);
    assert.match(second.stdout, /already stamped \(7 blocks\), no changes/);
    assert.equal(await fs.readFile(file, 'utf8'), stamped, 'second run byte-identical');
  });

  await t.test('--check on a fully stamped file: exit 0', async () => {
    const { stdout } = await execFileP(process.execPath, [CLI, '--check', file]);
    assert.match(stdout, /fully stamped \(7 blocks\)/);
  });

  await t.test('unbalanced source is refused (exit 1, nothing written)', async () => {
    const bad = path.join(dir, 'bad.html');
    await fs.writeFile(bad, '<body><p>oops</body>\n');
    const err = await execFileP(process.execPath, [CLI, bad]).catch((e) => e);
    assert.equal(err.code, 1);
    assert.match(err.stderr, /balance check/);
    assert.equal(await fs.readFile(bad, 'utf8'), '<body><p>oops</body>\n');
  });

  await t.test('usage errors: no file, two files', async () => {
    for (const args of [[CLI], [CLI, '--check'], [CLI, file, file]]) {
      const err = await execFileP(process.execPath, args).catch((e) => e);
      assert.equal(err.code, 1, JSON.stringify(args));
      assert.match(err.stderr, /usage:/);
    }
  });
});

test('POST /api/instrument', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-inst-api-'));
  await fs.writeFile(path.join(root, 'doc.html'), UNSTAMPED_HTML);
  await fs.writeFile(path.join(root, 'broken.html'), '<body><p>oops</body>\n');
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (payload) => fetch(`${base}/api/instrument`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  await t.test('happy path: stamps the page atomically', async () => {
    const res = await post({ page: 'doc.html' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, added: 7, total: 7 });
    const onDisk = await fs.readFile(path.join(root, 'doc.html'), 'utf8');
    assert.equal(revIds(onDisk).length, 7);
    assert.equal(checkBalanced(onDisk).ok, true);
    const entries = await fs.readdir(root);
    assert.ok(!entries.some((n) => n.includes('.tmp')), `leftovers: ${entries}`);
  });

  await t.test('idempotent: second call adds nothing and changes nothing', async () => {
    const before = await fs.readFile(path.join(root, 'doc.html'), 'utf8');
    const res = await post({ page: 'doc.html' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, added: 0, total: 7 });
    assert.equal(await fs.readFile(path.join(root, 'doc.html'), 'utf8'), before);
  });

  await t.test('unknown page → 404; GET → 405; unbalanced page → 422', async () => {
    assert.equal((await post({ page: 'nope.html' })).status, 404);
    assert.equal((await fetch(`${base}/api/instrument`)).status, 405);
    const res = await post({ page: 'broken.html' });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /balance/);
    assert.equal(await fs.readFile(path.join(root, 'broken.html'), 'utf8'),
      '<body><p>oops</body>\n', 'unbalanced page never written');
  });
});

test('instrumentFile helper', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-inst-lib-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'doc.html');
  await fs.writeFile(file, UNSTAMPED_HTML);

  await t.test('check mode reports without writing; write mode stamps', async () => {
    // WP6: instrumenting also creates the page-level theme zone (once).
    assert.deepEqual(await instrumentFile(file, { check: true }), { added: 7, total: 7, themeCreated: true, wrote: false });
    assert.equal(await fs.readFile(file, 'utf8'), UNSTAMPED_HTML);
    assert.deepEqual(await instrumentFile(file), { added: 7, total: 7, themeCreated: true, wrote: true });
    assert.deepEqual(await instrumentFile(file), { added: 0, total: 7, themeCreated: false, wrote: false });
  });
});
