// test/runner/agent-contract-coverage.test.mjs — the contract cannot drift
// silently.
//
// docs/AGENT-CONTRACT.md is what an external agent builds against, and it went
// eight endpoints out of date without anything noticing: presence, leases,
// hold, and the scope-gate pause. Worse than absent, two of its claims had
// become FALSE — "only one run at a time per page" (leases made concurrency
// per-block in #38) and "any per-comment failure fails the whole run" (Send-All
// became partial-apply in WP8). A contract that lies is worse than one that is
// merely incomplete: it is believed.
//
// So this is the guard that would have caught it. Every route the runner
// answers must appear in the contract, and every route the contract names must
// exist. Adding an endpoint without documenting it fails here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

const API_SOURCE = new URL('../../runner/lib/api.mjs', import.meta.url);
const CONTRACT = new URL('../../docs/AGENT-CONTRACT.md', import.meta.url);

/** Every literal `/api/...` path handleApi dispatches on. */
function routesInSource(src) {
  const routes = new Set();
  for (const m of src.matchAll(/pathname === '(\/api\/[\w/-]+)'/g)) routes.add(m[1]);
  // The two patterned routes, which no literal comparison would catch.
  if (src.includes("pathname.startsWith('/api/lease/')")) routes.add('/api/lease/:id');
  const sub = /\^\\\/api\\\/comment\\\/\(\[\^\/\]\+\)\\\/\(([\w|-]+)\)\$/.exec(src);
  if (sub !== null) for (const action of sub[1].split('|')) routes.add(`/api/comment/:id/${action}`);
  return [...routes].sort();
}

test('every endpoint the runner answers is in docs/AGENT-CONTRACT.md', async () => {
  const src = await fs.readFile(API_SOURCE, 'utf8');
  const doc = await fs.readFile(CONTRACT, 'utf8');
  const routes = routesInSource(src);

  // Sanity: if the extraction breaks, this test must fail loudly rather than
  // pass by finding nothing to check.
  assert.ok(routes.length >= 20, `expected to parse the API routes, found ${routes.length}`);
  assert.ok(routes.includes('/api/lease/:id'), 'the patterned lease route was parsed');
  assert.ok(routes.includes('/api/comment/:id/reply'), 'the patterned comment routes were parsed');

  const undocumented = routes.filter((route) => !doc.includes(route));
  assert.deepEqual(undocumented, [],
    `these endpoints exist and are not in the contract: ${undocumented.join(', ')}`);
});

test('the contract does not promise endpoints the runner does not answer', async () => {
  const src = await fs.readFile(API_SOURCE, 'utf8');
  const doc = await fs.readFile(CONTRACT, 'utf8');
  const routes = new Set(routesInSource(src));

  // Only the endpoint TABLE is checked. Prose mentions paths with query
  // strings and partial forms, and holding those to a literal match would make
  // the test about formatting rather than about truth.
  const table = doc.split('\n').filter((line) => /^\|\s*(GET|POST|DELETE|PUT|PATCH)\s*\|/.test(line));
  assert.ok(table.length >= 20, `expected the endpoint table, found ${table.length} rows`);

  const invented = [];
  for (const row of table) {
    const path = /`([^`]+)`/.exec(row)?.[1] ?? '';
    // Strip the query-string hint the table uses for readability.
    const bare = path.replace(/\?.*$/, '');
    if (bare === '/health') continue; // served outside handleApi
    if (!routes.has(bare)) invented.push(bare);
  }
  assert.deepEqual(invented, [],
    `the contract documents endpoints that do not exist: ${invented.join(', ')}`);
});

test('the contract states the facts that were wrong before, not the old ones', async () => {
  const doc = await fs.readFile(CONTRACT, 'utf8');

  // Each of these was a live claim in the contract that had stopped being true.
  // Pinning the corrections means a future rewrite cannot quietly restore them.
  assert.doesNotMatch(doc, /Only one run at a time per page/,
    'concurrency is per BLOCK since #38 — disjoint writers proceed together');
  assert.match(doc, /blocks-leased/, 'the 409 refusal vocabulary is documented');
  assert.match(doc, /awaiting-confirmation/, 'so is the paused-write refusal');
  assert.match(doc, /a \*\*batch\*\* applies each comment independently/,
    'Send-All is partial-apply (WP8), not all-or-nothing');
  assert.match(doc, /pendingConfirmation/, 'the scope-gate pause is a documented outcome');
  assert.match(doc, /Only `POST \/api\/run` spends money/,
    'which lane costs money is the first thing an agent needs to know');
});
