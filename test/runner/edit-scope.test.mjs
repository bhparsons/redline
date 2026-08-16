// test/runner/edit-scope.test.mjs — quote rescue, any-block edit scope, and
// insert ops (design/07-api-contract.md, Amendments 2026-07-22).
//
// Self-contained like the other runner tests: fixture dir in a tmpdir, the
// runner on an OS-assigned port, a stub OpenRouter server — NO real network.
// Covers: a blockId-less comment rescued onto the right block (entity
// decoding included) with the blockId persisted to the sidecar; a stale
// blockId re-rescued; ambiguous quotes falling back to quote-only; edits
// landing on a NON-anchored block; inserts (after + before) with
// server-minted ids and correct run records; insert failure lanes (unknown
// anchor, smuggled data-rev, multi-root) each failing the whole run
// all-or-nothing; and undo reverting an insert via the pre-run snapshot.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { findQuoteBlock, insertSiblingBlock, revIds, checkBalanced, isAsciiOnly } from '../../runner/lib/surgery.mjs';
import { promptText } from '../../runner/lib/agent.mjs';

const DOC_HTML = [
  '<!doctype html>',
  '<html><head><title>t</title></head>',
  '<body>',
  '<p data-rev="r-0001">alpha bravo charlie</p>',
  '<p data-rev="r-0002">unique &mdash; caf&eacute; sentence</p>',
  '<div data-rev="r-0003">intro <p data-rev="r-0004">child &ldquo;quoted&rdquo; text</p> outro</div>',
  '<p data-rev="r-0005">repeated words</p>',
  '<p data-rev="r-0006">repeated words</p>',
  '</body></html>',
  '',
].join('\n');

function startAgentStub() {
  const state = { result: null, requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      state.requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(state.result) } }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}/chat/completions`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('quote rescue + any-block edits + inserts', async (t) => {
  const stub = await startAgentStub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-scope-'));
  await fs.writeFile(path.join(root, 'doc.html'), DOC_HTML);
  await fs.writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'test-key', endpoint: stub.url, timeoutMs: 5000 },
    telemetry: { endpoint: null }, // never export from tests
  }));
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const readDoc = () => fs.readFile(docPath, 'utf8');
  const readSidecar = async () => JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
  const runOn = (commentId) => postJson(`${base}/api/run`, { page: 'doc.html', commentId });
  const createComment = async (body, anchor) => {
    const res = await postJson(`${base}/api/comment`, { page: 'doc.html', body, anchor });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };
  const decisionFor = (id) => [{ id, decision: 'addressed', summary: 's' }];
  const lastPrompt = () => promptText(stub.state.requests.at(-1).messages);

  await t.test('prompt carries the full document source', async () => {
    const cid = await createComment('Anything.', { blockId: 'r-0001', quote: 'bravo' });
    stub.state.result = { decisions: decisionFor(cid), edits: [] };
    assert.equal((await runOn(cid)).status, 200);
    const prompt = lastPrompt();
    assert.ok(prompt.includes('r-0006'), 'a far-away block id is visible');
    assert.ok(prompt.includes('unique &mdash; caf&eacute; sentence'), 'raw entity-encoded source shown');
    assert.ok(!prompt.includes('{{'), 'no unrendered placeholders');
  });

  await t.test('blockId-less comment: quote rescued (entities decoded), blockId persisted', async () => {
    // The quote is what the browser's textContent yields — decoded em dash
    // and e-acute; on disk the block is ASCII with &mdash;/&eacute;.
    const cid = await createComment('Fix this.', { quote: 'unique — café sentence' });
    stub.state.result = { decisions: decisionFor(cid), edits: [] };
    assert.equal((await runOn(cid)).status, 200);
    assert.ok(lastPrompt().includes('blockId: r-0002'), 'prompt shows the rescued block');
    const sidecar = await readSidecar();
    assert.equal(sidecar.comments.find((c) => c.id === cid).anchor.blockId, 'r-0002',
      'rescued blockId persisted onto the stored anchor');
  });

  await t.test('stale blockId: rescued to the innermost enclosing block', async () => {
    const cid = await createComment('Fix that.', {
      blockId: 'r-9999', quote: 'child “quoted” text',
    });
    stub.state.result = { decisions: decisionFor(cid), edits: [] };
    assert.equal((await runOn(cid)).status, 200);
    assert.ok(lastPrompt().includes('blockId: r-0004'), 'innermost block wins over its parent');
    const sidecar = await readSidecar();
    assert.equal(sidecar.comments.find((c) => c.id === cid).anchor.blockId, 'r-0004');
  });

  await t.test('ambiguous quote: no rescue, quote-only fallback kept', async () => {
    const cid = await createComment('Which one?', { quote: 'repeated words' });
    stub.state.result = { decisions: decisionFor(cid), edits: [] };
    assert.equal((await runOn(cid)).status, 200);
    assert.ok(lastPrompt().includes('no stable block id'), 'fallback note in the prompt');
    const sidecar = await readSidecar();
    assert.equal(sidecar.comments.find((c) => c.id === cid).anchor.blockId, undefined,
      'ambiguous rescue never writes a blockId');
  });

  await t.test('edits may land on a NON-anchored block', async () => {
    const cid = await createComment('Apply this style to the whole section.',
      { blockId: 'r-0001', quote: 'alpha' });
    stub.state.result = {
      decisions: decisionFor(cid),
      edits: [{ blockId: 'r-0005', newInner: 'repeated <em>words</em>' }],
    };
    const res = await runOn(cid);
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.deepEqual(run.edits, [{
      blockId: 'r-0005',
      beforeInner: 'repeated words',
      afterInner: 'repeated <em>words</em>',
    }]);
    const doc = await readDoc();
    assert.ok(doc.includes('<p data-rev="r-0005">repeated <em>words</em></p>'), 'edit applied');
    assert.ok(doc.includes('<p data-rev="r-0001">alpha bravo charlie</p>'), 'anchored block untouched');
    // Reset for the tests below.
    assert.equal((await postJson(`${base}/api/undo`, { page: 'doc.html' })).status, 200);
    assert.equal(await readDoc(), DOC_HTML);
  });

  let insertRunDoc = null;

  await t.test('inserts: fresh server-minted ids, valid doc, correct records', async () => {
    const cid = await createComment('Add a summary after this and a kicker before the intro.',
      { blockId: 'r-0002', quote: 'unique' });
    stub.state.result = {
      decisions: decisionFor(cid),
      edits: [],
      inserts: [
        { afterBlockId: 'r-0002', html: '<p>brand new — block</p>' },
        { beforeBlockId: 'r-0001', html: '<p>kicker</p>' },
      ],
    };
    const res = await runOn(cid);
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.status, 'ok');
    assert.equal(run.edits.length, 2);

    const [after, before] = run.edits;
    assert.equal(after.insertedAfter, 'r-0002');
    assert.equal(after.afterInner, 'brand new &mdash; block', 'insert html entity-encoded');
    assert.equal(after.beforeInner, undefined, 'inserts have no beforeInner');
    assert.equal(before.insertedBefore, 'r-0001');
    assert.equal(before.afterInner, 'kicker');

    const doc = await readDoc();
    const preIds = revIds(DOC_HTML);
    for (const record of [after, before]) {
      assert.match(record.blockId, /^r-[0-9a-f]{4}$/, 'minted id shape');
      assert.ok(!preIds.includes(record.blockId), 'minted id is fresh');
    }
    assert.notEqual(after.blockId, before.blockId, 'minted ids distinct within the run');
    const ids = revIds(doc);
    assert.equal(ids.length, preIds.length + 2, 'the id set grew by exactly two');
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
    assert.ok(doc.includes(
      '<p data-rev="r-0002">unique &mdash; caf&eacute; sentence</p>\n'
      + `<p data-rev="${after.blockId}">brand new &mdash; block</p>`), 'sibling placed after its anchor');
    assert.ok(doc.includes(
      `<p data-rev="${before.blockId}">kicker</p>\n<p data-rev="r-0001">alpha bravo charlie</p>`),
    'sibling placed before its anchor');
    assert.equal(checkBalanced(doc).ok, true);
    assert.equal(isAsciiOnly(doc), true, 'ASCII invariant held through the insert');
    insertRunDoc = doc;
  });

  await t.test('undo reverts the inserts (pre-run snapshot restore)', async () => {
    assert.notEqual(insertRunDoc, null);
    const res = await postJson(`${base}/api/undo`, { page: 'doc.html' });
    assert.equal(res.status, 200);
    assert.equal(await readDoc(), DOC_HTML, 'doc byte-identical — inserted blocks gone');
  });

  await t.test('insert failure lanes: whole run fails, doc restored (all-or-nothing)', async () => {
    const cid = await createComment('Break things.', { blockId: 'r-0001', quote: 'alpha' });
    const cases = [
      ['unknown anchor block', { afterBlockId: 'r-9999', html: '<p>x</p>' }, 'unknown-block'],
      ['smuggled data-rev', { afterBlockId: 'r-0002', html: '<p data-rev="r-7777">x</p>' }, 'data-rev-tampered'],
      ['multi-root fragment', { afterBlockId: 'r-0002', html: '<p>a</p><p>b</p>' }, 'invalid-insert'],
      ['unbalanced fragment', { afterBlockId: 'r-0002', html: '<p>a' }, 'unbalanced'],
    ];
    for (const [label, insert, _code] of cases) {
      stub.state.result = {
        decisions: decisionFor(cid),
        // A valid edit FIRST proves it is rolled back with the failing insert.
        edits: [{ blockId: 'r-0001', newInner: 'alpha bravo charlie!' }],
        inserts: [insert],
      };
      const res = await runOn(cid);
      assert.equal(res.status, 422, label);
      const body = await res.json();
      assert.equal(body.errorType, 'validation', label);
      assert.equal(body.run.status, 'failed', label);
      assert.equal(await readDoc(), DOC_HTML, `doc byte-identical (${label})`);
    }
    const sidecar = await readSidecar();
    assert.equal(sidecar.comments.find((c) => c.id === cid).status, 'open',
      'failed runs never resolve the comment');
  });
});

// --- surgery/rescue unit checks ------------------------------------------------

test('findQuoteBlock units', async (t) => {
  await t.test('decodes entities and skips tags like textContent', () => {
    assert.equal(findQuoteBlock(DOC_HTML, 'unique — café sentence'), 'r-0002');
    // Quote spanning an inline element boundary inside a block.
    const doc = '<p data-rev="r-1">The <span class="m">big</span> deal &mdash; done.</p>';
    assert.equal(findQuoteBlock(doc, 'The big deal — done.'), 'r-1');
    // Numeric entities decode too.
    assert.equal(findQuoteBlock('<p data-rev="r-2">caf&#233; au lait</p>', 'café au lait'), 'r-2');
  });

  await t.test('astral entities (surrogate pairs) do not desync the offset map', () => {
    // &#128512; decodes to a 2-unit surrogate pair; the offset map must stay
    // aligned per UTF-16 unit or every quote AFTER the emoji maps to shifted
    // source offsets (rescue fails, or worse, lands on the wrong block).
    const doc = '<p data-rev="r-a">smile &#128512;</p>\n<p data-rev="r-b">target words here</p>\n';
    assert.equal(findQuoteBlock(doc, 'target words here'), 'r-b');
    assert.equal(findQuoteBlock(doc, 'smile 😀'), 'r-a', 'the astral quote itself matches too');
    const hexDoc = '<p data-rev="r-a">smile &#x1F600; mid</p>\n<p data-rev="r-b">xy</p>\n';
    assert.equal(findQuoteBlock(hexDoc, 'xy'), 'r-b', 'hex astral entities as well');
  });

  await t.test('innermost enclosing block wins', () => {
    assert.equal(findQuoteBlock(DOC_HTML, 'child “quoted” text'), 'r-0004');
    assert.equal(findQuoteBlock(DOC_HTML, 'intro'), 'r-0003', 'text outside the child maps to the parent');
  });

  await t.test('ambiguous, missing, or unenclosed → null', () => {
    assert.equal(findQuoteBlock(DOC_HTML, 'repeated words'), null, 'two occurrences');
    assert.equal(findQuoteBlock(DOC_HTML, 'never in the doc'), null);
    assert.equal(findQuoteBlock('<p>no ids here</p>', 'no ids here'), null, 'no enclosing data-rev block');
    assert.equal(findQuoteBlock(DOC_HTML, ''), null);
    assert.equal(findQuoteBlock(DOC_HTML, 42), null);
  });

  await t.test('script/style/comment content never matches', () => {
    const doc = '<script>var x = "needle";</script><p data-rev="r-1">needle</p>';
    assert.equal(findQuoteBlock(doc, 'needle'), 'r-1', 'script copy invisible — text match unique');
  });
});

test('insertSiblingBlock units', async (t) => {
  await t.test('after and before splices, entity-encoded, id stamped on the root', () => {
    const after = insertSiblingBlock(DOC_HTML, {
      anchorBlockId: 'r-0001', position: 'after', html: '<p>new — one</p>', newBlockId: 'r-aaaa',
    });
    assert.equal(after.ok, true);
    assert.equal(after.blockId, 'r-aaaa');
    assert.equal(after.afterInner, 'new &mdash; one');
    assert.ok(after.source.includes(
      '<p data-rev="r-0001">alpha bravo charlie</p>\n<p data-rev="r-aaaa">new &mdash; one</p>'));
    assert.equal(checkBalanced(after.source).ok, true);

    const before = insertSiblingBlock(DOC_HTML, {
      anchorBlockId: 'r-0004', position: 'before', html: '<p>lead-in</p>', newBlockId: 'r-bbbb',
    });
    assert.equal(before.ok, true);
    assert.ok(before.source.includes(
      '<p data-rev="r-bbbb">lead-in</p>\n<p data-rev="r-0004">child &ldquo;quoted&rdquo; text</p>'),
    'inserting before a nested block stays inside its parent');
  });

  await t.test('typed failures: anchor, tamper, shape, balance, id reuse', () => {
    const call = (over) => insertSiblingBlock(DOC_HTML, {
      anchorBlockId: 'r-0001', position: 'after', html: '<p>x</p>', newBlockId: 'r-cccc', ...over,
    });
    assert.equal(call({ anchorBlockId: 'r-nope' }).code, 'unknown-block');
    assert.equal(call({ html: '<p data-rev="r-1">x</p>' }).code, 'data-rev-tampered');
    assert.equal(call({ html: "<p data-rev='r-1'>x</p>" }).code, 'data-rev-tampered', 'single quotes too');
    assert.equal(call({ html: '<p>a</p><p>b</p>' }).code, 'invalid-insert');
    assert.equal(call({ html: 'plain text' }).code, 'invalid-insert');
    assert.equal(call({ html: 'text <p>then block</p>' }).code, 'invalid-insert');
    assert.equal(call({ html: '<hr>' }).ok, true, 'void root now allowed (WP5)');
    assert.equal(call({ html: '<hr>trailing' }).code, 'invalid-insert', 'void with trailing content refused');
    assert.equal(call({ html: '<img alt="no src">' }).code, 'invalid-insert', 'srcless img refused');
    assert.equal(call({ html: '<p>a' }).code, 'unbalanced');
    assert.equal(call({ newBlockId: 'r-0002' }).code, 'invalid-insert', 'taken id refused');
    assert.equal(call({ position: 'sideways' }).code, 'invalid-insert');
  });

  await t.test('nested same-tag fragment is still a single root', () => {
    const r = insertSiblingBlock(DOC_HTML, {
      anchorBlockId: 'r-0003', position: 'after',
      html: '<div>outer <div>inner</div> tail</div>', newBlockId: 'r-dddd',
    });
    assert.equal(r.ok, true);
    assert.equal(r.afterInner, 'outer <div>inner</div> tail');
  });
});
