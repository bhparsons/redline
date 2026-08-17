// test/runner/browser-provenance.test.mjs — R-005: a human edit must say so.
//
// Every agent write records {creator:'agent', agentName}. A browser write
// recorded nothing at all, so "who changed this block" was answerable for
// agents and answerable for humans only by noticing that a field was MISSING.
// Absence is a fragile thing to build a review history on, and it is
// indistinguishable from an older sidecar that predates provenance entirely.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../runner/lib/server.mjs';
import { CONFIG_FILENAME } from '../../runner/lib/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = '<!doctype html>\n<html><head><title>t</title></head>\n<body>\n'
  + '<p data-rev="r-0001">alpha bravo charlie</p>\n</body></html>\n';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-prov-'));
  await fs.writeFile(path.join(dir, 'doc.html'), DOC);
  await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ telemetry: { endpoint: null } }));
  const server = await startServer({ root: dir, port: 0 });
  return { dir, server, base: `http://127.0.0.1:${server.port}` };
}

test('a write declaring creator:human is recorded as a human run', async (t) => {
  const f = await fixture();
  t.after(async () => { await f.server.close(); await fs.rm(f.dir, { recursive: true, force: true }); });

  const res = await fetch(`${f.base}/api/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 'doc.html', blockId: 'r-0001', newInner: 'edited by a person', creator: 'human' }),
  });
  assert.equal(res.status, 200);

  const { runs } = await fetch(`${f.base}/api/comments?page=doc.html`).then((r) => r.json());
  const run = runs.at(-1);
  assert.equal(run.lane, 'direct-edit');
  assert.equal(run.actor?.creator, 'human', 'the run names a human, rather than leaving it to be inferred');
  assert.equal(run.actor?.agentName, undefined, 'a human has no agent name');
});

test('an agent run stays distinguishable from a human one', async (t) => {
  const f = await fixture();
  t.after(async () => { await f.server.close(); await fs.rm(f.dir, { recursive: true, force: true }); });

  const post = (payload) => fetch(`${f.base}/api/edit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  await post({ page: 'doc.html', blockId: 'r-0001', newInner: 'by a person', creator: 'human' });
  await post({ page: 'doc.html', blockId: 'r-0001', newInner: 'by a bot', creator: 'agent', agentName: 'claude-code' });

  const { runs } = await fetch(`${f.base}/api/comments?page=doc.html`).then((r) => r.json());
  const [human, agent] = runs.slice(-2);
  assert.equal(human.actor.creator, 'human');
  assert.equal(agent.actor.creator, 'agent');
  assert.equal(agent.actor.agentName, 'claude-code');
});

test('the overlay declares itself on every write it makes', async () => {
  // The server would accept a silent write forever — absence still means human,
  // because that is what every M1 sidecar carries. So the guarantee has to be
  // asserted on the CALLER, or the overlay quietly stops saying it again.
  const overlay = await fs.readFile(path.join(REPO, 'extension', 'overlay.js'), 'utf8');
  for (const route of ['/api/edit', '/api/undo']) {
    const marker = `apiRaw('${route}'`;
    const sites = [];
    for (let i = overlay.indexOf(marker); i !== -1; i = overlay.indexOf(marker, i + 1)) sites.push(i);
    assert.ok(sites.length > 0, `expected the overlay to call ${route}`);
    for (const at of sites) {
      // The payload literal, however it is formatted. Scanning a window beats a
      // regex over the argument list: the first version of this test capped the
      // window at 400 characters and the comment explaining the fix pushed the
      // field out of range, so the guard failed on correct code.
      const window = overlay.slice(at, at + 800);
      assert.match(window, /creator:\s*'human'/,
        `${route} at index ${at} must declare creator:'human'`);
    }
  }
});
