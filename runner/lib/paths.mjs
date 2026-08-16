// runner/lib/paths.mjs — pure path-traversal guard, extracted from server.mjs.
//
// This was in server.mjs, which created an import cycle:
//   store.mjs → server.mjs → api.mjs → store.mjs
// Moving it here breaks the cycle so module-level init in store, server, or api
// is safe from temporal-dead-zone errors (#167).

import path from 'node:path';

// Map a request URL to an absolute file path under root. Returns null for
// anything that escapes root or touches a dot segment/dotfile (".git",
// ".history", "..", encoded or not — decoding happens before the check).
export function resolvePath(root, rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s.startsWith('.'))) return null;
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}
