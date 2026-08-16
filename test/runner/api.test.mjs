// test/runner/api.test.mjs — Session 3: comments API + sidecar storage.
//
// Self-contained like server.test.mjs: fixture dir in a tmpdir, server on an
// OS-assigned port. Covers the full round-trip (create → list → reply →
// resolve → reopen), sidecar placement/validity, the reviewed HTML staying
// byte-identical, the 400/404/405 cases, and atomic-write hygiene.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { load, save, resolvePage, sidecarPath, newId } from '../../runner/lib/store.mjs';

const DOC_HTML = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n<p>plain paragraph</p>\n</body></html>\n';

async function makeFixtureDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-api-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(dir, 'style.css'), 'p { color: red; }\n');
  await fs.writeFile(path.join(dir, '.hidden.html'), '<body>dot</body>\n');
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'page.html'), '<body><p>sub page</p></body>\n');
  // A real .html OUTSIDE the root: a traversal page param must never reach it.
  await fs.writeFile(path.join(path.dirname(dir), `escape-${path.basename(dir)}.html`), '<body>outside</body>\n');
  return dir;
}

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

test('comments API', async (t) => {
  const root = await makeFixtureDir();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.join(path.dirname(root), `escape-${path.basename(root)}.html`), { force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const htmlBefore = await fs.readFile(docPath);

  const anchor = {
    blockId: 'r-0001',
    quote: 'bravo',
    prefix: 'alpha ',
    suffix: ' charlie',
  };
  let commentId;

  await t.test('POST /api/comment creates a comment', async () => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html',
      body: 'Tighten this phrase.',
      anchor,
    });
    assert.equal(res.status, 201);
    const comment = await res.json();
    assert.match(comment.id, /^c-[0-9a-f]{12}$/);
    assert.equal(comment.body, 'Tighten this phrase.');
    assert.equal(comment.status, 'open');
    assert.deepEqual(comment.replies, []);
    assert.deepEqual(comment.anchor, anchor);
    assert.ok(!Number.isNaN(Date.parse(comment.createdAt)), 'createdAt is a timestamp');
    commentId = comment.id;
  });

  await t.test('sidecar lands next to the HTML and is valid JSON', async () => {
    const raw = await fs.readFile(path.join(root, 'doc.html.review.json'), 'utf8');
    const data = JSON.parse(raw);
    assert.equal(data.comments.length, 1);
    assert.equal(data.comments[0].id, commentId);
    assert.deepEqual(data.comments[0].anchor, anchor);
  });

  await t.test('GET /api/comments lists the comment', async () => {
    const res = await fetch(`${base}/api/comments?page=doc.html`);
    assert.equal(res.status, 200);
    const { comments } = await res.json();
    assert.equal(comments.length, 1);
    assert.equal(comments[0].id, commentId);
  });

  await t.test('POST /api/comment/:id/reply appends a reply', async () => {
    const res = await postJson(`${base}/api/comment/${commentId}/reply`, {
      page: 'doc.html',
      body: 'Agreed — shorter is better.',
    });
    assert.equal(res.status, 200);
    const comment = await res.json();
    assert.equal(comment.replies.length, 1);
    assert.match(comment.replies[0].id, /^rp-[0-9a-f]{12}$/);
    assert.equal(comment.replies[0].body, 'Agreed — shorter is better.');
    assert.ok(!Number.isNaN(Date.parse(comment.replies[0].createdAt)));
  });

  await t.test('POST /api/comment/:id/status resolves then reopens', async () => {
    let res = await postJson(`${base}/api/comment/${commentId}/status`, {
      page: 'doc.html',
      status: 'resolved',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'resolved');

    res = await postJson(`${base}/api/comment/${commentId}/status`, {
      page: 'doc.html',
      status: 'open',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'open');

    const { comments } = await (await fetch(`${base}/api/comments?page=doc.html`)).json();
    assert.equal(comments[0].status, 'open');
    assert.equal(comments[0].replies.length, 1, 'reply survived the status flips');
  });

  await t.test('POST /api/comment/:id/ai-edits toggles batch membership (#96)', async () => {
    // Default: absent === in the AI-edits batch.
    let list = await (await fetch(`${base}/api/comments?page=doc.html`)).json();
    assert.equal(list.comments[0].aiEdits, undefined, 'defaults to absent (in batch)');

    // Off → persisted as aiEdits:false.
    let res = await postJson(`${base}/api/comment/${commentId}/ai-edits`, { page: 'doc.html', value: false });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).aiEdits, false);
    list = await (await fetch(`${base}/api/comments?page=doc.html`)).json();
    assert.equal(list.comments[0].aiEdits, false, 'off state survives to the sidecar');

    // Back on → field deleted, returns to default-absent.
    res = await postJson(`${base}/api/comment/${commentId}/ai-edits`, { page: 'doc.html', value: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).aiEdits, undefined);
    list = await (await fetch(`${base}/api/comments?page=doc.html`)).json();
    assert.equal(list.comments[0].aiEdits, undefined, 'on returns to absent, not stored true');

    // Non-boolean → 400, comment untouched.
    res = await postJson(`${base}/api/comment/${commentId}/ai-edits`, { page: 'doc.html', value: 'yes' });
    assert.equal(res.status, 400);

    // Unknown comment → 404.
    res = await postJson(`${base}/api/comment/c-doesnotexist/ai-edits`, { page: 'doc.html', value: false });
    assert.equal(res.status, 404);
  });

  await t.test('POST /api/comment/:id/anchor re-anchors an orphaned comment (#157)', async () => {
    const newAnchor = { blockId: 'r-0002', quote: 'delta', prefix: 'x ', suffix: ' y' };
    let res = await postJson(`${base}/api/comment/${commentId}/anchor`, { page: 'doc.html', anchor: newAnchor });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).anchor, newAnchor, 'the comment carries the new anchor');
    const list = await (await fetch(`${base}/api/comments?page=doc.html`)).json();
    assert.deepEqual(list.comments[0].anchor, newAnchor, 'the new anchor survives to the sidecar');

    // Missing/invalid anchor → 400, comment untouched.
    res = await postJson(`${base}/api/comment/${commentId}/anchor`, { page: 'doc.html', anchor: { quote: '' } });
    assert.equal(res.status, 400);

    // Unknown comment → 404.
    res = await postJson(`${base}/api/comment/c-doesnotexist/anchor`, { page: 'doc.html', anchor: newAnchor });
    assert.equal(res.status, 404);

    // Restore the original anchor so later assertions on this comment hold.
    res = await postJson(`${base}/api/comment/${commentId}/anchor`, { page: 'doc.html', anchor });
    assert.equal(res.status, 200);
  });

  await t.test('anchor is optional-fields-tolerant (quote only)', async () => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'sub/page.html',
      body: 'Second page comment.',
      anchor: { quote: 'sub page' },
    });
    assert.equal(res.status, 201);
    assert.deepEqual((await res.json()).anchor, { quote: 'sub page' });
    // Sidecar lands next to THAT page.
    const data = JSON.parse(await fs.readFile(path.join(root, 'sub', 'page.html.review.json'), 'utf8'));
    assert.equal(data.comments.length, 1);
  });

  await t.test('concurrent creates never lose writes', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) =>
      postJson(`${base}/api/comment`, {
        page: 'sub/page.html',
        body: `parallel ${n}`,
        anchor: { quote: 'sub page' },
      })));
    for (const res of results) assert.equal(res.status, 201);
    const { comments } = await (await fetch(`${base}/api/comments?page=${encodeURIComponent('sub/page.html')}`)).json();
    assert.equal(comments.length, 6);
  });

  await t.test('unknown page → 404 (list and create)', async () => {
    assert.equal((await fetch(`${base}/api/comments?page=nope.html`)).status, 404);
    const res = await postJson(`${base}/api/comment`, {
      page: 'nope.html', body: 'x', anchor: { quote: 'q' },
    });
    assert.equal(res.status, 404);
  });

  await t.test('traversal/dotfile/non-html page params → 404', async () => {
    const escapeName = `../escape-${path.basename(root)}.html`;
    for (const page of [escapeName, '..%2F..%2Fetc%2Fpasswd.html', '.hidden.html', 'style.css', 'sub']) {
      const res = await fetch(`${base}/api/comments?page=${encodeURIComponent(page)}`);
      assert.equal(res.status, 404, `page=${page}`);
    }
  });

  await t.test('missing page param → 400', async () => {
    assert.equal((await fetch(`${base}/api/comments`)).status, 400);
  });

  await t.test('missing/empty/oversized body → 400', async () => {
    for (const body of [undefined, '', '   ', 42]) {
      const res = await postJson(`${base}/api/comment`, {
        page: 'doc.html', body, anchor: { quote: 'q' },
      });
      assert.equal(res.status, 400, `body=${JSON.stringify(body)}`);
    }
    // Whole request payload over the 64 KB cap.
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html', body: 'x'.repeat(70 * 1024), anchor: { quote: 'q' },
    });
    assert.equal(res.status, 400);
  });

  await t.test('missing or malformed anchor → 400', async () => {
    for (const bad of [undefined, null, 'quote', { quote: '' }, { quote: 42 }, {}, { quote: 'q', blockId: '../x' }]) {
      const res = await postJson(`${base}/api/comment`, { page: 'doc.html', body: 'x', anchor: bad });
      assert.equal(res.status, 400, `anchor=${JSON.stringify(bad)}`);
    }
  });

  await t.test('bad JSON → 400', async () => {
    for (const raw of ['{nope', '', '[1,2]', 'null']) {
      const res = await postJson(`${base}/api/comment`, raw);
      assert.equal(res.status, 400, `payload=${raw}`);
    }
  });

  await t.test('unknown comment id → 404 (reply and status)', async () => {
    let res = await postJson(`${base}/api/comment/c-doesnotexist/reply`, { page: 'doc.html', body: 'x' });
    assert.equal(res.status, 404);
    res = await postJson(`${base}/api/comment/c-doesnotexist/status`, { page: 'doc.html', status: 'resolved' });
    assert.equal(res.status, 404);
  });

  await t.test('invalid status → 400', async () => {
    for (const status of ['closed', 'OPEN', '', 42, undefined]) {
      const res = await postJson(`${base}/api/comment/${commentId}/status`, { page: 'doc.html', status });
      assert.equal(res.status, 400, `status=${JSON.stringify(status)}`);
    }
  });

  await t.test('wrong methods and unknown API paths', async () => {
    assert.equal((await fetch(`${base}/api/comment`)).status, 405);
    assert.equal((await postJson(`${base}/api/comments`, {})).status, 405);
    assert.equal((await fetch(`${base}/api/comment/${commentId}/reply`)).status, 405);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api`)).status, 404);
  });

  await t.test('the reviewed HTML file is byte-identical throughout', async () => {
    const htmlAfter = await fs.readFile(docPath);
    assert.equal(Buffer.compare(htmlBefore, htmlAfter), 0);
  });

  await t.test('atomic writes leave no .tmp files behind', async () => {
    const entries = [
      ...(await fs.readdir(root)),
      ...(await fs.readdir(path.join(root, 'sub'))),
    ];
    assert.ok(!entries.some((name) => name.includes('.tmp')), `leftovers: ${entries}`);
  });
});

test('store unit checks', async (t) => {
  const root = await makeFixtureDir();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.join(path.dirname(root), `escape-${path.basename(root)}.html`), { force: true });
  });

  await t.test('resolvePage guards match the file server', async () => {
    assert.equal(await resolvePage(root, 'doc.html'), path.join(root, 'doc.html'));
    assert.equal(await resolvePage(root, '/doc.html'), path.join(root, 'doc.html'));
    assert.equal(await resolvePage(root, 'sub/page.html'), path.join(root, 'sub', 'page.html'));
    assert.equal(await resolvePage(root, '.hidden.html'), null, 'dotfile');
    assert.equal(await resolvePage(root, 'sub/../.hidden.html'), null, 'dotfile via traversal');
    assert.equal(await resolvePage(root, 'style.css'), null, 'non-html');
    assert.equal(await resolvePage(root, 'missing.html'), null, 'nonexistent');
    assert.equal(await resolvePage(root, 'sub'), null, 'directory');
    assert.equal(await resolvePage(root, `../escape-${path.basename(root)}.html`), null, 'escape clamped');
    assert.equal(await resolvePage(root, ''), null);
    assert.equal(await resolvePage(root, 42), null);
  });

  await t.test('load/save round-trip, missing sidecar → fresh state', async () => {
    const htmlPath = path.join(root, 'doc.html');
    assert.deepEqual(await load(htmlPath), { comments: [], rev: 0 });
    const data = { comments: [{ id: newId(), body: 'hi' }] };
    await save(htmlPath, data); // stamps data.rev = 1 (concurrency guard)
    assert.equal(sidecarPath(htmlPath), `${htmlPath}.review.json`);
    assert.deepEqual(await load(htmlPath), data);
  });

  await t.test('newId shape', () => {
    assert.match(newId(), /^c-[0-9a-f]{12}$/);
    assert.match(newId('rp'), /^rp-[0-9a-f]{12}$/);
    assert.notEqual(newId(), newId());
  });
});
