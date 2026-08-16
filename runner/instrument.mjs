#!/usr/bin/env node
// runner/instrument.mjs — CLI for the data-rev stamper.
//
//   node runner/instrument.mjs [--check] <file.html>
//
// Stamps data-rev="r-XXXX" ids onto leaf text blocks (see lib/instrument.mjs
// — idempotent, existing ids never altered). --check writes nothing: exit 0
// when the file is fully stamped, exit 1 with the unstamped count otherwise.

import process from 'node:process';
import { instrumentFile } from './lib/instrument.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const files = args.filter((a) => a !== '--check');
if (files.length !== 1 || files[0].startsWith('--')) {
  console.error('usage: node runner/instrument.mjs [--check] <file.html>');
  process.exit(1);
}
const [file] = files;

try {
  const { added, total, wrote } = await instrumentFile(file, { check });
  if (check) {
    if (added === 0) {
      console.log(`ok ${file}: fully stamped (${total} blocks)`);
      process.exit(0);
    }
    console.log(`${file}: ${added} unstamped block${added === 1 ? '' : 's'} (${total} total once stamped)`);
    process.exit(1);
  }
  console.log(wrote
    ? `stamped ${file}: ${added} new block${added === 1 ? '' : 's'} (${total} total)`
    : `ok ${file}: already stamped (${total} blocks), no changes`);
} catch (err) {
  console.error(`instrument failed: ${err.message}`);
  process.exit(1);
}
