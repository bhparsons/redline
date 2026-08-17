// test/runner/open-doc.test.mjs — `redline <file.html>` and `redline demo` (#46).
//
// The two command-UX items that carry a first-time user from "I have a
// document" to "I am looking at it". Almost everything here is a negative:
//
//   - a bare unknown word must still be an unknown command, not an attempt to
//     open a file, or the CLI stops telling you when you mistyped;
//   - `demo` must never clobber a demo that already exists, because a sidecar
//     full of somebody's comments sits next to it;
//   - the welcome note must not stack when the sample is re-seeded, under
//     EITHER of the class names it has ever used;
//   - the CLI must start runners only where the extension will look, and that
//     list is pinned to extension/ports.js rather than copied (#126 was two
//     copies drifting apart).
//
// The browser open is injected (spawnFn) rather than stubbed globally — the
// suite must never actually launch a browser, and a test that only works
// because nobody looked at the screen is not a test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEMO_DIR, DEMO_SOURCE, PORT_WINDOW, WELCOME_NOTE,
  looksLikeDoc, browserCommand, openInBrowser, resolveDoc, pageUrl,
  withWelcomeNote, seedDemo, planOpen, pagePathFor, portFree, firstFreePort, choosePort,
} from '../../runner/lib/open-doc.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = (tag) => fs.mkdtemp(path.join(os.tmpdir(), `redline-open-${tag}-`));

test('a document path is a command; a mistyped word is still an error', async () => {
  const dir = await tmp('looks');
  const doc = path.join(dir, 'a.html');
  await fs.writeFile(doc, '<p>x</p>');

  assert.equal(await looksLikeDoc(doc), true);
  assert.equal(await looksLikeDoc(path.join(dir, 'a.htm')), false, 'must exist, not just end in .htm');

  // The whole point of the narrow rule.
  assert.equal(await looksLikeDoc('serv'), false, 'a typo stays an unknown command');
  assert.equal(await looksLikeDoc('demo'), false);
  assert.equal(await looksLikeDoc('--port'), false);
  assert.equal(await looksLikeDoc(''), false);
  assert.equal(await looksLikeDoc(undefined), false);
  assert.equal(await looksLikeDoc(dir), false, 'a directory is not a document');
});

test('an unsupported extension is not a document, even if the file exists', async () => {
  // This used to use .md as its example. #52 made Markdown a reviewable source
  // — it is converted to HTML and THAT is what gets reviewed — so the example
  // moved rather than the rule: a file redline cannot render is still not a
  // document, and a bare word is still a subcommand.
  const dir = await tmp('ext');
  for (const name of ['notes.txt', 'data.json', 'script.mjs', 'README']) {
    const f = path.join(dir, name);
    await fs.writeFile(f, 'x');
    assert.equal(await looksLikeDoc(f), false, `${name} is not a reviewable document`);
  }
});

test('a Markdown file IS a document — it is converted, then reviewed (#52)', async () => {
  const dir = await tmp('md-doc');
  for (const name of ['plan.md', 'plan.markdown', 'PLAN.MD']) {
    const f = path.join(dir, name);
    await fs.writeFile(f, '# x');
    assert.equal(await looksLikeDoc(f), true, `${name} is a reviewable source`);
  }
  assert.equal(await looksLikeDoc(path.join(dir, 'missing.md')), false,
    'a path that is not a file is still not a document');
});

test('the browser command is the platform default, and failing to open is not fatal', () => {
  assert.deepEqual(browserCommand('http://x/y', 'darwin'), ['open', ['http://x/y']]);
  assert.deepEqual(browserCommand('http://x/y', 'linux'), ['xdg-open', ['http://x/y']]);
  assert.deepEqual(browserCommand('http://x/y', 'win32'), ['cmd', ['/c', 'start', '', 'http://x/y']]);

  const calls = [];
  const ok = openInBrowser('http://x/y', {
    platform: 'linux',
    spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; },
  });
  assert.equal(ok, true);
  assert.equal(calls[0].cmd, 'xdg-open');
  assert.equal(calls[0].opts.detached, true, 'the browser must outlive the CLI');

  // A headless box with no opener prints a URL; it does not fail the command.
  const failed = openInBrowser('http://x/y', {
    platform: 'linux',
    spawnFn: () => { throw new Error('ENOENT'); },
  });
  assert.equal(failed, false);
});

test('a document resolves to its directory and a root-relative page', async () => {
  const dir = await tmp('resolve');
  const sub = path.join(dir, 'docs');
  await fs.mkdir(sub);
  const doc = path.join(sub, 'plan.html');
  await fs.writeFile(doc, '<p>x</p>');

  const r = await resolveDoc(doc);
  assert.equal(r.page, 'plan.html', 'the runner serves the parent, so the page is the basename');
  assert.equal(await fs.realpath(r.root), await fs.realpath(sub));
});

test('the page URL escapes a name that would otherwise break it', () => {
  assert.equal(pageUrl('http://127.0.0.1:5175', 'a.html'), 'http://127.0.0.1:5175/a.html');
  assert.equal(pageUrl('http://127.0.0.1:5175/', 'a.html'), 'http://127.0.0.1:5175/a.html');
  assert.equal(pageUrl('http://x', 'my notes.html'), 'http://x/my%20notes.html');
  assert.equal(pageUrl('http://x', 'sub/a.html'), 'http://x/sub/a.html', 'a slash is a path, not a character');
});

test('the welcome note goes in the body and never stacks', () => {
  const html = '<title>t</title>\n<style>body{}</style>\n<section data-rev="r-1"><h1 data-rev="r-2">T</h1></section>\n';
  const once = withWelcomeNote(html);
  assert.equal((once.match(/class="rv-welcome"/g) || []).length, 1);
  assert.ok(once.indexOf('rv-welcome') > once.indexOf('</style>'),
    'the note lands after the sample stylesheet, not between <title> and <style>');
  assert.ok(once.indexOf('rv-welcome') < once.indexOf('<section'));

  const twice = withWelcomeNote(once);
  assert.equal((twice.match(/class="rv-welcome"/g) || []).length, 1, 're-seeding must not stack notes');
  assert.equal(twice, once);
});

test('a demo seeded before the rename does not get a second note', () => {
  // The note was called a "first-run strip" with class rv-firstrun until
  // 2026-08-14. Anyone who ran `demo` before that has the old class on disk,
  // and a guard that only knew the new one would hand them a second banner.
  const old = '<title>t</title>\n<div class="rv-firstrun">old note</div>\n<section data-rev="r-1">x</section>';
  assert.equal(withWelcomeNote(old), old, 'the old class still counts as "already has a note"');
});

test('the note is not stamped — it is scaffolding, not part of the review', () => {
  assert.ok(!/data-rev=/.test(WELCOME_NOTE),
    'a stamped note would invite a comment on it and then a revision of it');
});

test('demo seeds a document and a config, and says it seeded', async () => {
  const dir = await tmp('demo');
  const target = path.join(dir, DEMO_DIR);
  const r = await seedDemo({ repoRoot: REPO_ROOT, dir: target });

  assert.equal(r.seeded, true);
  assert.equal(r.name, path.basename(DEMO_SOURCE));
  const html = await fs.readFile(r.absFile, 'utf8');
  assert.ok(html.includes('class="rv-welcome"'));
  assert.ok(html.includes('data-rev='), 'the sample keeps its block ids');
  // An empty config keeps interactive onboarding off a directory the person
  // did not choose and does not own yet.
  assert.equal(await fs.readFile(path.join(target, 'redline.config.json'), 'utf8'), '{}\n');
});

test('demo never clobbers an existing demo — there may be comments beside it', async () => {
  const dir = await tmp('reseed');
  const target = path.join(dir, DEMO_DIR);
  const first = await seedDemo({ repoRoot: REPO_ROOT, dir: target });
  await fs.writeFile(first.absFile, '<p data-rev="r-9">my own edits</p>');

  const second = await seedDemo({ repoRoot: REPO_ROOT, dir: target });
  assert.equal(second.seeded, false, 'the second seed reports reuse');
  assert.equal(await fs.readFile(second.absFile, 'utf8'), '<p data-rev="r-9">my own edits</p>',
    'a demo somebody has worked in is never overwritten');
});

test('demo seeds the teaching thread and NEVER the sample\'s own review sidecar', async () => {
  // This began as "a fresh demo has no sidecar at all", which was the right rule
  // stated through the wrong evidence: what must never travel is
  // samples/sample-memo.html.review.json — Blake's real review, with his
  // comments and his run history in it. #279 gave the demo a sidecar on purpose
  // (four cards that teach the four kinds of comment), so the assertion moved to
  // the thing actually at stake: the seeded thread is the TOUR, and none of the
  // sample's own review can be found in it.
  const dir = await tmp('sidecar');
  const target = path.join(dir, DEMO_DIR);
  const out = await seedDemo({ repoRoot: REPO_ROOT, dir: target });

  const seededThread = JSON.parse(await fs.readFile(`${out.absFile}.review.json`, 'utf8'));
  assert.ok(seededThread.comments.every((c) => c.id.startsWith('c-demo-')),
    'every seeded comment is a demo card');

  // In THIS repo the sample carries a real review to compare against. In the
  // published mirror it does not exist at all — the publisher strips every
  // *.review.json — and that absence is a stronger guarantee than any
  // comparison, so the test asserts whichever proof its tree can offer rather
  // than assuming it is running at home.
  const samplesSidecar = path.join(REPO_ROOT, 'samples', 'sample-memo.html.review.json');
  const raw = await fs.readFile(samplesSidecar, 'utf8').catch(() => null);
  if (raw === null) {
    const entries = await fs.readdir(path.join(REPO_ROOT, 'samples'));
    assert.ok(!entries.some((f) => f.endsWith('.review.json')),
      'no review sidecar ships, so none can leak into a demo');
    return;
  }
  const mine = JSON.parse(raw);
  assert.ok(mine.comments.length > 0, 'the sample really does carry a review, so this test has something to catch');
  const leaked = new Set(mine.comments.map((c) => c.id));
  for (const c of seededThread.comments) {
    assert.ok(!leaked.has(c.id), `${c.id} came from the sample's own review sidecar`);
  }
});

test('the CLI starts runners only where the extension will look', async () => {
  // #126 was two copies of this list drifting apart, and a runner on a port
  // only one of them knew about. extension/ports.js is the authority; this
  // pins node's copy to it rather than adding a third.
  const src = await fs.readFile(path.join(REPO_ROOT, 'extension', 'ports.js'), 'utf8');
  const declared = src.match(/RUNNER_PORTS\s*=\s*\[([^\]]+)\]/)[1]
    .split(',').map((n) => Number(n.trim())).filter(Number.isInteger);
  assert.ok(declared.length > 0, 'extension/ports.js must declare RUNNER_PORTS');
  assert.deepEqual(PORT_WINDOW, declared,
    'a runner started on a port the extension never probes is invisible, not broken');
});

test('firstFreePort skips a port that is taken', async () => {
  const held = net.createServer();
  await new Promise((r) => held.listen(0, '127.0.0.1', r));
  const busy = held.address().port;
  const free = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });

  assert.equal(await portFree(busy), false);
  assert.equal(await portFree(free), true);
  assert.equal(await firstFreePort([busy, free]), free, 'the taken port is skipped');
  assert.equal(await firstFreePort([busy]), null, 'a full window is null, not a throw');

  await new Promise((r) => held.close(r));
});

test('a full port window never stops the product from starting', async () => {
  // Blake, 2026-08-14: "I don't want the product to become unusable for people
  // who are using a lot of other connected apps." The window is a preference,
  // not a requirement — the extension talks to whatever origin served the page,
  // so any port serves documents fine. Refusing to start was the worse bug.
  const held = [];
  const busy = [];
  for (let i = 0; i < 2; i += 1) {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    held.push(srv);
    busy.push(srv.address().port);
  }

  const full = await choosePort(busy);
  assert.equal(full.port, 0, 'port 0 lets the OS pick anything free');
  assert.equal(full.scannable, false);
  assert.match(full.note, /popup|file:\/\//, 'it must say what the user loses, not just that it happened');

  const free = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const ok = await choosePort([...busy, free]);
  assert.equal(ok.port, free, 'a window port is still preferred when one is free');
  assert.equal(ok.scannable, true);
  assert.equal(ok.note, undefined, 'no warning when nothing was given up');

  await Promise.all(held.map((s) => new Promise((r) => s.close(r))));
});

test('a reused runner gets the path IT serves, not the one the document knows', async () => {
  // Blake, 2026-08-15: `redline demo` "is just launching sample-memo.html
  // directly from the port with no other path... causing it to not find the
  // target file." A runner is reused when its root CONTAINS the document, so
  // that root is usually an ANCESTOR of the document's own directory — and the
  // URL has to be relative to the runner's root, not the document's parent.
  const dir = await tmp('rebase');
  const demo = path.join(dir, 'redline-demo');
  await fs.mkdir(demo);
  const doc = path.join(demo, 'sample-memo.html');
  await fs.writeFile(doc, '<p>x</p>');

  const reused = await planOpen(doc, {
    discover: async () => ({ base: 'http://127.0.0.1:5175', port: 5175, root: dir }),
  });
  assert.equal(reused.page, 'redline-demo/sample-memo.html',
    'the runner serves the parent, so the page carries the subdirectory');
  assert.equal(pageUrl(reused.base, reused.page),
    'http://127.0.0.1:5175/redline-demo/sample-memo.html');
});

test('pagePathFor never invents a path it cannot justify', async () => {
  const doc = path.join(path.sep, 'srv', 'docs', 'sub', 'a.html');
  assert.equal(pagePathFor(path.join(path.sep, 'srv', 'docs'), doc, 'a.html'), 'sub/a.html');
  // The runner's root IS the document's directory — the old answer was right.
  assert.equal(pagePathFor(path.join(path.sep, 'srv', 'docs', 'sub'), doc, 'a.html'), 'a.html');
  // A root that does NOT contain the document cannot produce a URL; fall back
  // rather than emit `../../a.html`, which no server will honour.
  assert.equal(pagePathFor(path.join(path.sep, 'elsewhere'), doc, 'a.html'), 'a.html');
  assert.equal(pagePathFor('', doc, 'a.html'), 'a.html');
  assert.equal(pagePathFor(undefined, doc, 'a.html'), 'a.html');
});

test('planOpen reuses a runner that already covers the directory', async () => {
  const dir = await tmp('plan');
  const doc = path.join(dir, 'a.html');
  await fs.writeFile(doc, '<p>x</p>');

  const reused = await planOpen(doc, {
    discover: async () => ({ base: 'http://127.0.0.1:5176', port: 5176, root: dir }),
  });
  assert.equal(reused.serve, false, 'a covering runner is used as-is, not duplicated');
  assert.equal(pageUrl(reused.base, reused.page), 'http://127.0.0.1:5176/a.html');

  const fresh = await planOpen(doc, { discover: async () => null });
  assert.equal(fresh.serve, true);
  assert.equal(fresh.base, null);
});

test('demo constants point at a sample that exists', async () => {
  assert.equal(DEMO_DIR, 'redline-demo');
  await fs.access(path.join(REPO_ROOT, DEMO_SOURCE));
});
