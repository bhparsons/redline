// runner/lib/open-doc.mjs — `redline <file.html>` and `redline demo` (#46).
//
// Two command-UX items that share one job: get a person from "I have a
// document" to "I am looking at it in the browser with Review mode available",
// without making them think about the runner at all.
//
//   redline path/to/doc.html      serve that file's DIRECTORY, print + open the page
//   redline demo                  seed a sample into ./redline-demo and open it
//
// WHY THE DIRECTORY. The runner's security boundary is the served root, and it
// serves a tree, not a file. Pointing it at the file's parent is the only shape
// that works — so this resolves the parent, and computes the page path the same
// way every agent surface does (discovery.pageForFile), rather than guessing.
//
// REUSE BEFORE START. A runner already covering that directory is used as-is,
// under discovery.mjs's three checks (live pid + healthy /health + an
// /api/info root that CONTAINS the target). Starting a second runner on a tree
// another one already serves is the #181 failure, and it is silent: two
// processes, one lock, and writes landing in the wrong place.
//
// THE WELCOME NOTE IS IN THE DOCUMENT, not the overlay. A first-time user
// very often does not have the extension loaded yet — that is precisely the
// moment they need to be told what to do — and an overlay element cannot
// render when the overlay is not there. So `demo` seeds a copy of the sample
// carrying a note as ordinary markup: it shows up with or without the
// extension, and it is the user's file, so deleting it is a normal edit
// rather than a setting.

import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { discoverRunner, pageForFile } from './discovery.mjs';

export const DEMO_DIR = 'redline-demo';
export const DEMO_SOURCE = 'samples/sample-memo.html';

/**
 * The ports the extension will look on — the same list as `extension/ports.js`,
 * pinned to it by test/runner/open-doc.test.mjs. An ephemeral port would bind
 * fine and be INVISIBLE to the extension, which is a worse failure than not
 * starting at all: the page loads, nothing appears, and nothing says why.
 *
 * (`scripts/dev-up.sh` walks only the first five. That is its own tested
 * behaviour (#181) and is left alone here; a runner this CLI starts on 5180
 * is still found by the extension, which is what matters to a user.)
 */
export const PORT_WINDOW = [5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182, 5183, 5184];

/** Is a TCP port free on the loopback the runner binds? */
export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * The first free port in the window, or null when every one is taken.
 * Without this, `redline demo` on a machine with anything on 5175 dies with a
 * raw EADDRINUSE — which is what it did the first time this was run.
 */
export async function firstFreePort(window = PORT_WINDOW) {
  for (const p of window) if (await portFree(p)) return p;
  return null;
}

/**
 * A port to start on, and whether the extension's fallback scan will find it.
 *
 * A busy machine must never stop the product from starting (Blake, 2026-08-14:
 * "I don't want the product to become unusable for people who are using a lot
 * of other connected apps"). The window is a PREFERENCE, not a requirement:
 * the extension talks to whatever origin served the page, so any port works
 * for a served document. Only a `file://` page and the popup consult the list.
 *
 * So: take a window port when one is free, otherwise take any free port and
 * say what the user loses by it. `port: 0` lets the OS choose at bind time.
 */
export async function choosePort(window = PORT_WINDOW) {
  const preferred = await firstFreePort(window);
  if (preferred !== null) return { port: preferred, scannable: true };
  return {
    port: 0,
    scannable: false,
    note: `every port in ${window[0]}-${window.at(-1)} is busy, so this runner starts on a free port `
      + 'outside that range. Documents it serves work normally; only the extension popup and '
      + 'file:// pages, which have to guess, will not find it automatically.',
  };
}

/** Exit codes, matching runner/lib/cli.mjs's table. */
export const EXIT = { ok: 0, usage: 1, runner: 2 };

/**
 * Does this argument name a document to open, rather than a subcommand?
 * Deliberately narrow: an existing .html/.htm FILE. A bare unknown word must
 * keep erroring as an unknown command — swallowing typos into "I'll try to
 * open that" is how a CLI stops telling you when you got it wrong.
 */
export async function looksLikeDoc(arg) {
  if (typeof arg !== 'string' || !arg || arg.startsWith('-')) return false;
  // .md joins .html here (#52): a Markdown file is a document you want to
  // review, it just needs converting first. Still narrow — an existing FILE
  // with one of these extensions, so a bare unknown word keeps erroring as an
  // unknown command instead of being swallowed into "I'll try to open that".
  if (!/\.(html?|md|markdown)$/i.test(arg)) return false;
  const stat = await fs.stat(path.resolve(arg)).catch(() => null);
  return Boolean(stat?.isFile());
}

/** Is this a Markdown source rather than an HTML document? */
export function isMarkdown(file) {
  return /\.(md|markdown)$/i.test(file);
}

/**
 * Convert a Markdown file to the reviewable HTML beside it, and return that
 * path (#52). Re-conversion is the normal case — the ids are content-derived,
 * so a paragraph nobody touched keeps its id and keeps its comments.
 *
 * REFUSES to overwrite an HTML file it did not generate. The converted document
 * is named after its source, so `plan.md` claims `plan.html`; if something is
 * already there without our marker it is somebody's hand-written page, and
 * silently replacing it would destroy work to save a rename. The source .md is
 * never written, on any path.
 */
export async function convertMarkdown(absMdPath) {
  const { convert, sourceOf } = await import('./markdown.mjs');
  const out = absMdPath.replace(/\.(md|markdown)$/i, '.html');
  const existing = await fs.readFile(out, 'utf8').catch(() => null);
  if (existing !== null && sourceOf(existing) === null) {
    return {
      error: `${path.basename(out)} already exists and was not generated from `
        + `${path.basename(absMdPath)} — move it aside, or rename the Markdown file`,
    };
  }
  const md = await fs.readFile(absMdPath, 'utf8');
  const html = convert(md, { sourceName: path.basename(absMdPath) });
  const changed = existing !== html;
  if (changed) await fs.writeFile(out, html);
  return { out, changed, reconverted: existing !== null };
}

/** The argv that opens a URL in the platform's default browser. */
export function browserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

/**
 * Open a URL, detached, never blocking the caller and never failing the
 * command: a missing xdg-open on a headless box is a printed URL, not an error.
 */
export function openInBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  const [cmd, args] = browserCommand(url, platform);
  try {
    const child = spawnFn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a document lives, from the runner's point of view.
 * Returns {root, absFile, page} — page is null when the file sits outside the
 * root, which cannot happen here but is what the caller must not assume.
 */
export async function resolveDoc(target) {
  const absFile = path.resolve(target);
  const root = path.dirname(absFile);
  const page = await pageForFile(root, absFile);
  return { root, absFile, page };
}

/** The URL a person opens, given a runner base and a page path. */
export function pageUrl(base, page) {
  return `${base.replace(/\/$/, '')}/${page.split('/').map(encodeURIComponent).join('/')}`;
}

// ---- the demo document ----------------------------------------------------

/**
 * The welcome note, as markup. Not stamped with data-rev: it is scaffolding
 * for the reader, not part of the document under review, and stamping it would
 * invite a comment on it and then a revision of it. `instrument` leaves
 * unstamped blocks alone, so it stays out of the review surface permanently.
 *
 * Called a "welcome note" and not a "first-run strip" (Blake, 2026-08-14): the
 * overlay already has a RUN-STATUS STRIP, and two unrelated things called a
 * strip is one too many.
 */
export const WELCOME_NOTE = `<div class="rv-welcome" role="note">
  <strong>This is a demo document.</strong>
  Load the Redline extension, click its toolbar icon, then select any sentence
  below and comment on it. Your comments are saved next to this file; nothing
  leaves your machine until you ask for a revision.
  <br><small>Delete this block whenever you like &mdash; it is part of the document, not the tool.</small>
</div>
<style>
  .rv-welcome { border: 1px solid #d8cfc0; background: #fbf7f0; border-radius: 8px;
    padding: 12px 14px; margin: 0 0 24px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; color: #4a3f31; }
  .rv-welcome small { color: #7a6a55; }
</style>
`;

/** Both class names the note has ever used. The rename must not hand a second
 *  banner to anyone who seeded a demo before it. */
const NOTE_MARKERS = ['class="rv-welcome"', 'class="rv-firstrun"'];

/**
 * The sample with the note in front of it. Idempotent — seeding twice must
 * not stack two notes, and a user who deleted it does not get it back.
 */
export function withWelcomeNote(html) {
  if (NOTE_MARKERS.some((m) => html.includes(m))) return html;
  const marker = html.search(/<section\b|<h1\b|<body\b/i);
  if (marker < 0) return WELCOME_NOTE + html;
  // After </style> when the sample opens with its own stylesheet, so the note
  // lands in the body flow rather than between <title> and <style>.
  const styleEnd = html.toLowerCase().lastIndexOf('</style>', marker);
  const at = styleEnd >= 0 ? styleEnd + '</style>'.length : marker;
  return `${html.slice(0, at)}\n${WELCOME_NOTE}${html.slice(at)}`;
}

/**
 * Put the teaching thread beside the demo document (#279).
 *
 * The demo used to arrive with an empty sidecar, so the first thing a new user
 * saw was a document and no evidence that the tool did anything. These four
 * cards ARE the tour: an edit request, a note, a question left open, and a
 * decline with its reasoning. Reading them takes twenty seconds and answers the
 * questions the README spends a page on.
 *
 * Deliberately not work to be done. A watcher leaves pre-existing comments
 * alone — that rule is what stops it rewriting your backlog the moment it
 * attaches — so these stay put, stay readable, and never get quietly actioned
 * out of existence.
 *
 * Absent or unreadable, the demo is still a demo: a missing tour is worth less
 * than a document, and failing the seed over it would trade the whole feature
 * for its garnish.
 */
async function seedComments(repoRoot, docPath) {
  const sidecar = `${docPath}.review.json`;
  if (await fs.stat(sidecar).catch(() => null)) return false;
  try {
    const raw = await fs.readFile(path.join(repoRoot, 'samples', 'demo-comments.json'), 'utf8');
    const thread = JSON.parse(raw);
    delete thread._comment;
    await fs.writeFile(sidecar, `${JSON.stringify(thread, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed the demo directory. Never clobbers an existing demo document — someone
 * who has commented on it has real work in the sidecar beside it, and a `demo`
 * that silently resets that is a data-loss bug wearing a friendly name.
 */
export async function seedDemo({ repoRoot, dir = DEMO_DIR, source = DEMO_SOURCE } = {}) {
  const target = path.resolve(dir);
  const name = path.basename(source);
  const dest = path.join(target, name);
  await fs.mkdir(target, { recursive: true });

  const existing = await fs.stat(dest).catch(() => null);
  if (existing?.isFile()) {
    return { root: target, absFile: dest, name, seeded: false };
  }
  const html = await fs.readFile(path.join(repoRoot, source), 'utf8');
  await fs.writeFile(dest, withWelcomeNote(html));
  // An empty config keeps the runner from running interactive onboarding on a
  // directory the person did not choose and does not own yet.
  const cfg = path.join(target, 'redline.config.json');
  if (!(await fs.stat(cfg).catch(() => null))) await fs.writeFile(cfg, '{}\n');
  const comments = await seedComments(repoRoot, dest);
  return { root: target, absFile: dest, name, seeded: true, comments };
}

// ---- what bin/redline.mjs calls -------------------------------------------

/**
 * Resolve a document to a live runner + URL. Returns a plan; the caller starts
 * the runner in the foreground when `serve` is true, because a runner that
 * dies with the CLI process is not what "open this document" means.
 */
/**
 * The document's path AS THE RUNNER SERVES IT.
 *
 * Blake, 2026-08-15: `redline demo` "is just launching sample-memo.html
 * directly from the port with no other path, and I think that is causing it to
 * not find the target file." Exactly right, and here is why it only bit on the
 * second run.
 *
 * A runner is reused when its root CONTAINS the document (discovery's rule) —
 * so the root it serves is often an ANCESTOR of the document's own directory,
 * not that directory. The page path has to be relative to the runner's root,
 * and it was relative to the document's parent. Run `redline demo` anywhere
 * under a directory something is already serving and you get
 * `http://host:port/sample-memo.html` for a file that lives at
 * `redline-demo/sample-memo.html`: a 404, from a command whose whole job is
 * that a first-time user sees a document.
 *
 * Fresh runners were unaffected — they serve the document's own directory, so
 * the two paths coincide. That is why the first run of the day always worked.
 */
export function pagePathFor(runnerRoot, absFile, docPage) {
  if (typeof runnerRoot !== 'string' || runnerRoot === '') return docPage;
  const rel = path.relative(runnerRoot, absFile);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return docPage;
  return rel.split(path.sep).join('/');
}

export async function planOpen(target, { discover = discoverRunner } = {}) {
  const { root, absFile, page } = await resolveDoc(target);
  if (page === null) return { error: `cannot serve ${absFile}` };
  const found = await discover(root);
  if (found) {
    return {
      root,
      absFile,
      page: pagePathFor(found.root, absFile, page),
      base: found.base,
      port: found.port,
      serve: false,
    };
  }
  return { root, absFile, page, base: null, port: null, serve: true };
}
