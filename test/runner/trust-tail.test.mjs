// test/runner/trust-tail.test.mjs — F5, F6, F7 from the trust-layer review
// (#291, via #282). None of these was destroying documents; all three were
// guards that would not have held the first time something unusual arrived.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { revIds, sameRevMarks } from '../../runner/lib/surgery.mjs';
import { mintId } from '../../runner/lib/instrument.mjs';
import { resolvePage } from '../../runner/lib/store.mjs';

test('F5: a data-rev in single quotes or unquoted is still a block id', async () => {
  // The trap: nothing in this codebase emits anything but double quotes, so a
  // hand-edited or externally-generated document was read as having NO ids —
  // and a guard comparing [] against [] waves everything through.
  assert.deepEqual(revIds('<p data-rev="r-0001">x</p>'), ['r-0001']);
  assert.deepEqual(revIds("<p data-rev='r-0002'>x</p>"), ['r-0002']);
  assert.deepEqual(revIds('<p data-rev=r-0003>x</p>'), ['r-0003']);
  assert.deepEqual(revIds('<p DATA-REV="r-0004">x</p>'), ['r-0004']);
  assert.deepEqual(
    revIds(`<p data-rev="r-a">1</p><p data-rev='r-b'>2</p><p data-rev=r-c>3</p>`),
    ['r-a', 'r-b', 'r-c'],
  );
});

test('F5: an edit that drops a single-quoted id is now caught', async () => {
  // This is the failure the fix exists for. Before it, both sides read as "no
  // ids", so an edit deleting the mark compared equal and was accepted.
  const before = "<p data-rev='r-0001'>alpha</p>";
  assert.equal(sameRevMarks(before, "<p data-rev='r-0001'>bravo</p>"), true, 'a real edit still passes');
  assert.equal(sameRevMarks(before, '<p>bravo</p>'), false, 'dropping the id is refused');
  assert.equal(sameRevMarks(before, "<p data-rev='r-9999'>bravo</p>"), false, 'changing the id is refused');
});

test('F6: minting fails loudly on an exhausted id space instead of hanging', () => {
  // A hang is the worst available failure — it looks like slowness, so it gets
  // waited on rather than reported. The id space is 16 bits, so "exhausted" is
  // reachable on a large document, not hypothetical.
  const full = new Set();
  for (let i = 0; i < 0x10000; i++) full.add('r-' + i.toString(16).padStart(4, '0'));
  assert.equal(full.size, 0x10000, 'every id in the space is taken');

  assert.throws(() => mintId(full), /id space/, 'it reports rather than spinning');

  // And it still mints normally when there is room.
  const roomy = new Set(['r-0000']);
  const id = mintId(roomy);
  assert.match(id, /^r-[0-9a-f]{4}$/);
  assert.ok(roomy.has(id), 'the new id is reserved against the next call');
});

test('F7: a symlink escaping the served root is refused', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-f7-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-f7-out-'));
  const secret = path.join(outside, 'secret.html');
  await fs.writeFile(secret, '<p>not yours</p>');
  await fs.writeFile(path.join(root, 'real.html'), '<p>yours</p>');
  await fs.symlink(secret, path.join(root, 'escape.html'));

  assert.ok(await resolvePage(root, 'real.html'), 'an ordinary page still resolves');
  assert.equal(await resolvePage(root, 'escape.html'), null,
    'a symlink pointing outside the root is not a page in this root');

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test('F7: a symlink that stays inside the root keeps working', async () => {
  // The fix must not break the legitimate case — a link is a normal way to
  // arrange files, and refusing all of them would be a different bug.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-f7-in-'));
  await fs.mkdir(path.join(root, 'sub'));
  await fs.writeFile(path.join(root, 'sub', 'target.html'), '<p>inside</p>');
  await fs.symlink(path.join(root, 'sub', 'target.html'), path.join(root, 'link.html'));

  const resolved = await resolvePage(root, 'link.html');
  assert.ok(resolved, 'an in-root symlink still resolves');
  assert.equal(await fs.readFile(resolved, 'utf8'), '<p>inside</p>');

  await fs.rm(root, { recursive: true, force: true });
});
