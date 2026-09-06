// Encrypted-at-rest Facebook cookie vault.
// The scraper never needs a Facebook password. Users export cookies from an
// already-authenticated browser; this module validates, encrypts, and later
// injects them into the Python bridge.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { one, query } from '../db.js';

const KEY_INFO = 'lokum:facebook-cookie:v1';

function encryptionKey() {
  const secret = process.env.FACEBOOK_COOKIE_KEY ||
    process.env.FACEBOOK_COOKIE_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.DATABASE_URL;
  if (!secret) throw new Error('No cookie encryption key configured');
  return scryptSync(String(secret), KEY_INFO, 32);
}

function hmacFingerprint(value) {
  return createHmac('sha256', encryptionKey()).update(String(value)).digest('hex').slice(0, 16);
}

function cookieExpires(cookie) {
  const seconds = Number(
    cookie.expirationDate ??
    cookie.expiry ??
    cookie.expires_unix ??
    (typeof cookie.expires === 'number' ? cookie.expires : null)
  );
  if (Number.isFinite(seconds) && seconds > 1_000_000_000) return new Date(seconds * 1000);
  if (typeof cookie.expires === 'string') {
    const date = new Date(cookie.expires);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function normalizeCookieList(input) {
  let source = input;
  if (typeof source === 'string') {
    const text = source.trim();
    if (!text) return [];
    if (text.startsWith('[') || text.startsWith('{')) {
      try { source = JSON.parse(text); } catch { source = text; }
    }
  }

  if (source && !Array.isArray(source) && typeof source === 'object') {
    if (Array.isArray(source.cookies)) source = source.cookies;
    else source = Object.entries(source).map(([name, value]) => ({ name, value }));
  }

  if (Array.isArray(source)) {
    return source
      .filter(cookie => cookie?.name && cookie?.value != null)
      .filter(cookie => !cookie.domain || /\.?(facebook|meta)\.com$/i.test(String(cookie.domain)))
      .map(cookie => ({
        name: String(cookie.name),
        value: String(cookie.value),
        domain: cookie.domain || '.facebook.com',
        path: cookie.path || '/',
        expirationDate: cookie.expirationDate ?? cookie.expiry ?? cookie.expires_unix ?? null,
        expires: !/\d/.test(String(cookie.expires ?? '')) ? cookie.expires : undefined,
        secure: cookie.secure !== false,
        httpOnly: !!cookie.httpOnly,
      }));
  }

  // Netscape cookies.txt format.
  if (/\t/.test(String(source)) && /\b(c_user|xs)\b/.test(String(source))) {
    return String(source).split(/\r?\n/).flatMap(line => {
      const clean = line.startsWith('#HttpOnly_ ') || line.startsWith('#HttpOnly_')
        ? line.replace(/^#HttpOnly_/, '')
        : line;
      if (!clean || (clean.startsWith('#') && !clean.startsWith('#HttpOnly_'))) return [];
      const parts = clean.trim().split('\t');
      if (parts.length < 7) return [];
      const [domain, _flag, path, secure, expires, name, value] = parts;
      if (!/facebook\.com$/i.test(domain) || !name || !value) return [];
      return [{
        name, value, domain, path,
        secure: secure === 'TRUE',
        expirationDate: Number(expires) || null,
        httpOnly: line.startsWith('#HttpOnly_'),
      }];
    });
  }

  // Common header / semicolon paste: c_user=...; xs=...
  const parsed = [];
  for (const piece of String(source).split(/[;\r\n]+/)) {
    const match = piece.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (match) parsed.push({ name: match[1], value: match[2].replace(/^"|"$/g, ''), domain: '.facebook.com', path: '/' });
  }
  return parsed;
}

export function parseFacebookCookies(input) {
  const all = normalizeCookieList(input);
  const byKey = new Map();
  for (const cookie of all) {
    const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
    const previous = byKey.get(key);
    const previousTime = previous ? cookieExpires(previous)?.getTime() || 0 : 0;
    const currentTime = cookieExpires(cookie)?.getTime() || 0;
    if (!previous || currentTime >= previousTime) byKey.set(key, cookie);
  }

  const cookies = [...byKey.values()];
  const names = new Set(cookies.map(cookie => cookie.name));
  const missing = ['c_user', 'xs'].filter(name => !names.has(name));
  if (missing.length) {
    const error = new Error(`Facebook cookies missing required fields: ${missing.join(', ')}`);
    error.code = 'invalid_facebook_cookies';
    throw error;
  }

  const expirations = cookies
    .map(cookieExpires)
    .filter(Boolean)
    .sort((a, b) => a - b);
  const cUser = cookies.find(cookie => cookie.name === 'c_user');
  const xs = cookies.find(cookie => cookie.name === 'xs');
  return {
    cookies,
    cUserHash: hmacFingerprint(cUser.value),
    xsFingerprint: hmacFingerprint(xs.value),
    expiresAt: expirations[0] || null,
  };
}

export function encryptFacebookCookies(cookies) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(cookies), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function decryptFacebookCookies(encoded) {
  const [ivRaw, tagRaw, dataRaw] = String(encoded).split('.');
  if (!ivRaw || !tagRaw || !dataRaw) throw new Error('Malformed cookie payload');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataRaw, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

export async function saveFacebookCookieSession({ input, userId, label }) {
  const parsed = parseFacebookCookies(input);
  const encrypted = encryptFacebookCookies(parsed.cookies);
  await query(`UPDATE facebook_cookie_sessions SET is_active = FALSE, updated_at = NOW() WHERE is_active = TRUE`);
  const row = await one(
    `INSERT INTO facebook_cookie_sessions
       (user_id, label, encrypted_payload, c_user_hash, xs_fingerprint, expires_at, is_active, last_status)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'stored')
     RETURNING id, label, expires_at, created_at`,
    [userId || null, label || 'Browser export', encrypted, parsed.cUserHash, parsed.xsFingerprint, parsed.expiresAt]
  );
  return row;
}

export async function activeFacebookCookieSession() {
  const row = await one(
    `SELECT * FROM facebook_cookie_sessions WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1`
  );
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    await markFacebookCookieSession(row.id, 'expired', 'Facebook cookies expired');
    await query(`UPDATE facebook_cookie_sessions SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [row.id]);
    return null;
  }
  return row;
}

export async function getActiveFacebookCookies() {
  const session = await activeFacebookCookieSession();
  if (!session) return null;
  return {
    sessionId: session.id,
    cookies: decryptFacebookCookies(session.encrypted_payload),
    expiresAt: session.expires_at,
  };
}

export async function markFacebookCookieSession(sessionId, status, error = null) {
  await query(
    `UPDATE facebook_cookie_sessions
     SET last_checked_at = NOW(), last_status = $2, last_error = $3, updated_at = NOW()
     WHERE id = $1`,
    [sessionId, status, error]
  );
}
