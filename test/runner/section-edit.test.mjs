// test/runner/section-edit.test.mjs — WP2: section-wide edits end to end.
//
// A comment anchored to a stamped <section> gets the section-scoped prompt
// view (section outer HTML + flat sibling/top-level indexes), the agent
// edits SEVERAL blocks inside the section and inserts a new sibling block
// anchored to one of them, and the runner applies all of it through the
// same surgery pipeline. Also: section anchors never take the tactical
// lane, and ordinary block anchors keep the plain block view.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { revIds } from '../../runner/lib/surgery.mjs';
import { promptText } from '../../runner/lib/agent.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_ENDPOINT;

// Two stamped sections + a stamped top-level paragraph; s-one holds the
// anchored section's children.
const DOC_HTML = [
  '<!doctype html>',
  '<html><head><title>t</title></head>',
  '<body>',
  '<section data-rev="r-sec1">',
  '<h2 data-rev="r-h2">Pricing</h2>',
  '<p data-rev="r-p1">Plan A costs $40.</p>',
  '<p data-rev="r-p2">Plan B costs $90.</p>',
  '</section>',
  '<section data-rev="r-sec2">',
  '<h2 data-rev="r-h2b">Support</h2>',
  '<p data-rev="r-p3">Email us any time.</p>',
  '</section>',
  '<p data-rev="r-tail">Footer note.</p>',
  '</body></html>',
  '',
].join('\n');

function startStub() {
  const state = { revise: null, reviseRequests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const content = promptText(parsed.messages);
      const chat = (reply) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }],
        }));
      };
      // Router/tactical calls: garbage → fallback/escalation (covered elsewhere).
      if (content.startsWith('# Redline comment router')
        || content.startsWith('# Redline tactical edit')) {
        return chat('not json');
      }
      state.reviseRequests.push(parsed);
      return chat(state.revise);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      state,
      url: `http://127.0.0.1:${server.address().port}/chat/completions`,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('section-scoped runs', async (t) => {
  const stub = await startStub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-section-'));
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
  const createComment = async (body, blockId) => {
    const res = await postJson(`${base}/api/comment`, {
      page: 'doc.html', body, anchor: { blockId, quote: 'Pricing' },
    });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };

  await t.test('section anchor: section-scoped prompt view + multi-block edits + insert', async () => {
    const cid = await createComment('Rewrite the whole pricing section in a warmer tone.', 'r-sec1');
    stub.state.revise = {
      decisions: [{ id: cid, decision: 'addressed', summary: 'Warmed up the section.' }],
      edits: [
        { blockId: 'r-h2', newInner: 'Pricing, made simple' },
        { blockId: 'r-p1', newInner: 'Plan A is just $40.' },
        { blockId: 'r-p2', newInner: 'Plan B is $90, everything included.' },
      ],
      inserts: [
        { afterBlockId: 'r-p2', html: '<p>Not sure which fits? We will help you pick.</p>' },
      ],
    };
    const res = await postJson(`${base}/api/run`, { page: 'doc.html', commentId: cid });
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.status, 'ok');
    assert.equal(run.lane, 'standard', 'section anchors never take the tactical lane');
    assert.equal(run.edits.length, 4, 'three edits + one insert record');

    // The prompt carried the SECTION view, not a bare block inner.
    const prompt = promptText(stub.state.reviseRequests.at(-1).messages);
    assert.ok(prompt.includes('anchored to a whole SECTION'), 'section view present');
    assert.ok(prompt.includes('data-rev="r-sec1"'), 'section id named');
    assert.ok(prompt.includes('Section outer HTML:'), 'outer HTML section present');
    assert.ok(prompt.includes('Sibling sections (flat index):'), 'sibling index present');
    assert.ok(/- r-sec2 <section> Support/.test(prompt), 'sibling section indexed with text');
    assert.ok(prompt.includes('Top-level blocks in the document (flat index):'));
    assert.ok(/- r-tail <p> Footer note\./.test(prompt), 'top-level paragraph indexed');
    assert.ok(!/- r-p1 <p>.*\n.*Top-level/.test(prompt), 'nested blocks are not top-level entries');

    // Every edit landed; the insert was minted a fresh id inside the doc.
    const after = await fs.readFile(docPath, 'utf8');
    assert.ok(after.includes('Pricing, made simple'));
    assert.ok(after.includes('Plan A is just $40.'));
    assert.ok(after.includes('Plan B is $90, everything included.'));
    assert.ok(after.includes('We will help you pick.'));
    const ids = revIds(after);
    assert.equal(ids.length, 9, 'the 8 originals plus one minted id');
    assert.equal(new Set(ids).size, 9);
    const insertRecord = run.edits.find((e) => e.insertedAfter === 'r-p2');
    assert.ok(insertRecord, 'insert recorded with its anchor');
    assert.ok(ids.includes(insertRecord.blockId), 'minted id present in the doc');
  });

  await t.test('ordinary block anchor keeps the plain block view', async () => {
    const cid = await createComment('Make this friendlier in tone please.', 'r-p3');
    stub.state.revise = {
      decisions: [{ id: cid, decision: 'declined', summary: 's' }],
      edits: [],
    };
    assert.equal((await postJson(`${base}/api/run`, { page: 'doc.html', commentId: cid })).status, 200);
    const prompt = promptText(stub.state.reviseRequests.at(-1).messages);
    assert.ok(prompt.includes('blockId: r-p3'), 'plain block view');
    assert.ok(!prompt.includes('anchored to a whole SECTION'), 'no section view for a leaf block');
  });
});
