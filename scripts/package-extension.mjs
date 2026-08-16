#!/usr/bin/env node
// scripts/package-extension.mjs — zip extension/ into dist/redline-extension.zip.
//
//   node scripts/package-extension.mjs [--out <dir>]
//
// Uses the system `zip` binary via node:child_process (the project is
// zero-dependency — no archiver packages). Files land at the zip root (zip
// runs with cwd=extension/), which is the layout Chrome expects for an
// unpacked-equivalent archive. --out overrides the output directory (tests
// point it at a tmpdir so the repo's dist/ stays untouched).

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT_DIR = path.join(REPO_ROOT, 'extension');
const ZIP_NAME = 'redline-extension.zip';

const args = process.argv.slice(2);
let outDir = path.join(REPO_ROOT, 'dist');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') { outDir = path.resolve(args[++i] ?? ''); continue; }
  console.error(`unknown argument: ${args[i]}`);
  console.error('usage: node scripts/package-extension.mjs [--out <dir>]');
  process.exit(1);
}

await fs.access(path.join(EXT_DIR, 'manifest.json')).catch(() => {
  console.error(`no extension manifest at ${EXT_DIR}`);
  process.exit(1);
});

await fs.mkdir(outDir, { recursive: true });
const zipPath = path.join(outDir, ZIP_NAME);
await fs.rm(zipPath, { force: true });

try {
  // -r recurse, -X drop platform extra fields, -x exclude junk files.
  await execFileP('zip', ['-r', '-X', zipPath, '.', '-x', '.*', '-x', '*/.*', '-x', '*.DS_Store'], {
    cwd: EXT_DIR,
  });
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error('the `zip` binary was not found on PATH — install zip and retry');
  } else {
    console.error(`zip failed: ${err.message}`);
  }
  process.exit(1);
}

const stat = await fs.stat(zipPath);
console.log(`packaged extension → ${zipPath} (${stat.size} bytes)`);
