// test/runner/scope-session-edits.test.mjs — #195: the scope gate over session
// edits.
//
// Before this, the guardrail was a run-lane feature. A free local session
// applying edits through /api/propose-edits went straight past it — so it could
// rewrite twelve headers with no pause while the paid lane asked before
// rewriting two. The threshold is UNCHANGED (decision 14); what changed is who
// it applies to.
//
// Four things are pinned here:
//   - a proposal reaching outside its comment's section PAUSES, holding its
//     leases, and applies verbatim on Allow;
//   - a decline writes nothing and records nothing, because a session edit
//     costs nothing — #128's "every call that spends money is on a record" has
//     no work to do here;
//   - the agent's scope WAIVER lets a deliberate sweep through with its intent
//     stated, rather than looking like an accident;
//   - every gate decision is logged, fired or not, so the false-positive rate
//     is a measurement rather than an argument.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';
import { traceDir } from '../../runner/lib/trace.mjs';

delete process.env.OPENROUTER_API_KEY;
delete process.env.REDLINE_OTEL_ENDPOINT;

// Two sections, so "outside the anchored section" is a real place to be.
const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<section data-rev="r-s1"><h2 data-rev="r-h1">One</h2>\n'
  + '<p data-rev="r-0001">alpha</p>\n<p data-rev="r-0002">bravo</p></section>\n'
  + '<section data-rev="r-s2"><h2 data-rev="r-h2">Two</h2>\n'
  + '<p data-rev="r-0003">charlie</p></section>\n</body></html>\n';

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-scopesession-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
    agent: { apiKey: 'k', endpoint: 'http://127.0.0.1:1/chat', timeoutMs: 500 },
    telemetry: { endpoint: null },
  }, null, 2));
  return dir;
}

const post = (url, payload) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

test('the scope gate covers session edits, on the same threshold', async (t) => {
  const root = await makeRoot();
  const { port, close } = await startServer({ root, port: 0 });
  t.after(async () => { await close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const docPath = path.join(root, 'doc.html');
  const readDoc = () => fs.readFile(docPath, 'utf8');
  const sidecar = async () => JSON.parse(await fs.readFile(`${docPath}.review.json`, 'utf8'));
  const status = async () => (await fetch(`${base}/api/status?page=doc.html`)).json();
  const propose = (payload) => post(`${base}/api/propose-edits`, { page: 'doc.html', dryRun: false, ...payload });
  const confirm = (runId, allow) => post(`${base}/api/run/confirm`, { page: 'doc.html', runId, allow });
  const scopeTrace = async (runId) => JSON.parse(
    await fs.readFile(path.join(traceDir(runId), 'scope.json'), 'utf8'));

  // One comment, anchored inside section one. Every proposal below answers it,
  // so "the anchored section" means section one throughout.
  const comment = await (await post(`${base}/api/comment`, {
    page: 'doc.html', body: 'tighten this', anchor: { quote: 'alpha', blockId: 'r-0001' },
  })).json();

  await t.test('a proposal inside the anchored section just applies', async () => {
    const res = await propose({
      commentId: comment.id, edits: [{ blockId: 'r-0001', newInner: 'ALPHA' }],
    });
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.status, 'ok');
    // The decision is on the record even when it did not fire — that is the
    // whole point of logging both outcomes.
    assert.equal(run.scopeGate.fired, false);
    assert.equal(run.scopeGate.level, 'block');
    assert.equal((await scopeTrace(run.runId)).lane, 'proposed');
  });

  let pendingRunId = null;

  await t.test('a proposal reaching into the OTHER section pauses instead of applying', async () => {
    const before = await readDoc();
    const res = await propose({
      commentId: comment.id,
      edits: [
        { blockId: 'r-0001', newInner: 'alpha again' },
        { blockId: 'r-0003', newInner: 'charlie rewritten' },
      ],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pendingConfirmation, true);
    assert.equal(body.scope.level, 'section');
    assert.deepEqual(body.scope.reasons, ['edits blocks outside the commented section']);
    // The ask names the reach in the document's own words, never by data-rev id.
    assert.ok(body.scope.reach.some((r) => r.text === 'charlie'));
    assert.equal(await readDoc(), before, 'nothing written while it waits');
    pendingRunId = body.runId;
  });

  await t.test('the paused proposal HOLDS its blocks, so nothing races it', async () => {
    const s = await status();
    assert.equal(s.pendingConfirmation.runId, pendingRunId);
    assert.equal(s.leases['r-0003'], pendingRunId, 'the widened reach is held, not just the named edits');
    const raced = await post(`${base}/api/edit`, {
      page: 'doc.html', blockId: 'r-0003', newInner: 'someone else',
    });
    assert.equal(raced.status, 409);
    assert.equal((await raced.json()).reason, 'awaiting-confirmation');
  });

  await t.test('Allow applies exactly what was previewed, as one undoable run', async () => {
    const res = await confirm(pendingRunId, true);
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.runId, pendingRunId, 'the same run, not a fresh one');
    assert.equal(run.lane, 'proposed');
    assert.equal(run.scopeGate.fired, true);
    const doc = await readDoc();
    assert.match(doc, /<p data-rev="r-0003">charlie rewritten<\/p>/);
    assert.deepEqual((await status()).leases, {}, 'and the lease is handed back');

    const undone = await post(`${base}/api/undo`, { page: 'doc.html', expectRunId: run.runId });
    assert.equal(undone.status, 200);
    assert.match(await readDoc(), /<p data-rev="r-0003">charlie<\/p>/);
  });

  await t.test('Decline writes nothing and records nothing — it cost nothing', async () => {
    const before = await readDoc();
    const runsBefore = (await sidecar()).runs.length;
    const paused = await (await propose({
      commentId: comment.id,
      edits: [{ blockId: 'r-0003', newInner: 'not wanted' }],
    })).json();
    assert.equal(paused.pendingConfirmation, true);

    const res = await confirm(paused.runId, false);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, declined: true, runId: paused.runId, lane: 'proposed' });
    assert.equal(await readDoc(), before);
    // #128 puts a declined RUN in the log because the agent call was billed.
    // A declined proposal spent nothing, so a record would be an entry with no
    // cost, no edit and no decision. The gate log already has what happened.
    assert.equal((await sidecar()).runs.length, runsBefore);
    assert.deepEqual((await status()).leases, {}, 'the lease is released either way');
  });

  await t.test('the scope waiver lets a declared sweep through, and says so', async () => {
    const res = await propose({
      commentId: comment.id,
      edits: [
        { blockId: 'r-0001', newInner: 'swept one' },
        { blockId: 'r-0003', newInner: 'swept two' },
      ],
      // The agent declaring document-wide intent up front (decision 14), so a
      // deliberate sweep does not look like an accident.
      scope: { level: 'page', requiresConfirmation: false, summary: 'The author asked for every paragraph.' },
    });
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.status, 'ok', 'applied without an ask');
    assert.equal(run.scopeGate.fired, false);
    assert.equal(run.scopeGate.broad, true, 'the reach WAS broad — it was waived, not narrow');
    assert.equal(run.scopeGate.waived, true);
    assert.equal(run.scopeGate.agentDeclared, 'page');
    await post(`${base}/api/undo`, { page: 'doc.html', expectRunId: run.runId });
  });

  await t.test('the agent can also ASK for a confirmation it would not have got', async () => {
    const res = await propose({
      commentId: comment.id,
      edits: [{ blockId: 'r-0001', newInner: 'unsure about this' }],
      scope: { requiresConfirmation: true, summary: 'I am not sure this is what you meant.' },
    });
    const body = await res.json();
    assert.equal(body.pendingConfirmation, true);
    assert.equal(body.scope.summary, 'I am not sure this is what you meant.');
    await confirm(body.runId, false);
  });

  await t.test('a theme edit fires the gate even with no comment to anchor to', async () => {
    const res = await propose({ theme: 'color: #333;' });
    const body = await res.json();
    assert.equal(body.pendingConfirmation, true);
    assert.equal(body.scope.level, 'page');
    assert.deepEqual(body.scope.reasons, ['changes the page-level theme']);
    // A theme edit reaches every block, so the lease escalates to the page.
    assert.equal((await status()).leases['*'], body.runId);
    await confirm(body.runId, false);
  });

  await t.test('KNOWN LIMIT: an anchorless multi-block proposal is not gated', async () => {
    // The rule measures reach against the section the COMMENT is anchored to.
    // No commentId means no section, so `outOfSection` can never be true and
    // only a theme edit fires. Decision 14 forbids inventing a threshold here,
    // so this is pinned as a known hole for whoever tunes the rule from the
    // logs — not closed by guesswork. If the threshold ever grows a
    // reach-count rule, this test should fail and be rewritten.
    const res = await propose({
      edits: [
        { blockId: 'r-0001', newInner: 'ungated one' },
        { blockId: 'r-0003', newInner: 'ungated two' },
      ],
    });
    const run = await res.json();
    assert.equal(run.status, 'ok');
    assert.equal(run.scopeGate.fired, false);
    assert.equal(run.scopeGate.outOfSection, false, 'no anchor, so nothing is "outside"');
    assert.equal(run.scopeGate.level, 'section', 'the reach IS recorded as wider than one block');
    await post(`${base}/api/undo`, { page: 'doc.html', expectRunId: run.runId });
  });

  await t.test('a direct edit logs its reach and, being one block, never gates', async () => {
    const res = await post(`${base}/api/edit`, {
      page: 'doc.html', blockId: 'r-0002', newInner: 'BRAVO',
    });
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.lane, 'direct-edit');
    assert.equal(run.scopeGate.fired, false);
    assert.deepEqual(run.scopeGate.touchedBlocks, ['r-0002']);
    assert.equal((await scopeTrace(run.runId)).lane, 'direct-edit');
    await post(`${base}/api/undo`, { page: 'doc.html', expectRunId: run.runId });
  });

  await t.test('a dry run never gates — it writes nothing to gate', async () => {
    const res = await post(`${base}/api/propose-edits`, {
      page: 'doc.html', commentId: comment.id,
      edits: [{ blockId: 'r-0003', newInner: 'would reach out of section' }],
    });
    const body = await res.json();
    assert.equal(body.dryRun, true);
    assert.equal(body.valid, true);
    assert.equal(body.pendingConfirmation, undefined);
    assert.deepEqual((await status()).leases, {});
  });

  await t.test('#188\'s break-glass cannot yank a paused proposal\'s lease', async () => {
    const before = await readDoc();
    const paused = await (await propose({
      commentId: comment.id, edits: [{ blockId: 'r-0003', newInner: 'stale write' }],
    })).json();
    assert.equal(paused.pendingConfirmation, true);
    // #188's break-glass door, used against a paused proposal: the stash is
    // only still valid because nothing else could touch those blocks.
    await fetch(`${base}/api/lease?page=doc.html&force=1`, { method: 'DELETE' });
    // The pause is a RUN lease, not a held lease, so force-release must leave
    // it alone — the gate's stash stays valid.
    const res = await confirm(paused.runId, true);
    assert.equal(res.status, 200, 'a run lease is not force-releasable, so the confirm still lands');
    await post(`${base}/api/undo`, { page: 'doc.html', expectRunId: paused.runId });
    assert.equal(await readDoc(), before);
  });
});
