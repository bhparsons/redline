// runner/lib/identity.mjs — signed link tokens (#41).
//
// A token is a capability handed to a person (in a share link) that maps to
// {name, role}. Write endpoints that receive a VALID token stamp identity
// from it instead of trusting the unauthenticated payload creator/agentName —
// the commenter-identity substrate for the hosted comment store (#44).
//
// Deliberately stdlib-small: HMAC-SHA256 over a JSON payload, base64url on
// both halves, constant-time verification. The secret is per served root,
// generated once and persisted as a DOTFILE next to the sidecar data —
// resolvePath refuses every dotfile, and the directory index skips them, so
// it is unservable by the same construction that protects .history/ (the
// config's protection is a basename check; dotfiles are refused earlier).

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SECRET_FILENAME = '.redline-secret';

// The fixed role vocabulary. Small on purpose: a role means nothing until a
// route enforces it, and enforcement-by-absence-of-routes is #44's job.
export const ROLES = new Set(['commenter']);

const NAME_RE = /^[\w][\w .'-]{0,63}$/;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Read the root's secret, minting and persisting one on first use. */
export async function loadSecret(root) {
  const file = path.join(root, SECRET_FILENAME);
  try {
    const raw = (await fs.readFile(file, 'utf8')).trim();
    if (raw.length >= 32) return raw;
  } catch { /* first use — fall through and mint */ }
  const secret = crypto.randomBytes(32).toString('base64url');
  await fs.writeFile(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

/** token = b64url(payload JSON) + '.' + b64url(HMAC-SHA256(payload)). */
export function mintToken({ name, role }, secret) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('name must be 1-64 word/space/.-\' characters');
  }
  if (!ROLES.has(role)) {
    throw new Error(`role must be one of: ${[...ROLES].join(', ')}`);
  }
  const payload = b64url(JSON.stringify({ name, role }));
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** → {name, role} for a token minted with THIS secret, else null. Tampered,
 *  truncated, malformed, and foreign-secret tokens all verify null — one
 *  answer, so a caller can't tell which check failed. */
export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', secret).update(payload).digest();
  let given;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { name, role } = parsed;
  if (typeof name !== 'string' || !NAME_RE.test(name) || !ROLES.has(role)) return null;
  return { name, role };
}
