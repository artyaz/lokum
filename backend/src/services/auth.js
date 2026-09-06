import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { query, one } from '../db.js';

const SESSION_TTL_DAYS = 30;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export async function createUser({ email, name, password }) {
  const hash = password ? await hashPassword(password) : null;
  return one(
    `INSERT INTO users (email, name, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, email, name, (password_hash IS NOT NULL) AS has_password`,
    [email.toLowerCase(), name, hash]
  );
}

export async function findUserByEmail(email) {
  return one(
    `SELECT id, email, name, password_hash,
            (password_hash IS NOT NULL) AS has_password
     FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );
}

export async function findUserById(id) {
  return one(
    `SELECT id, email, name,
            (password_hash IS NOT NULL) AS has_password
     FROM users WHERE id = $1`,
    [id]
  );
}

export async function createSession(userId) {
  const sid = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000);
  await query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [sid, userId, expiresAt]
  );
  return { sid, expiresAt };
}

export async function verifySession(sid) {
  if (!sid) return null;
  const row = await one(
    `SELECT s.id AS sid, s.user_id, s.expires_at, u.email, u.name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [sid]
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await query(`DELETE FROM sessions WHERE id = $1`, [sid]);
    return null;
  }
  await query(`UPDATE sessions SET last_seen_at = NOW() WHERE id = $1`, [sid]);
  return { id: row.user_id, email: row.email, name: row.name };
}

export async function destroySession(sid) {
  await query(`DELETE FROM sessions WHERE id = $1`, [sid]);
}

// ===================== PASSKEY HELPERS =====================
// Simple WebAuthn-style passkey storage. We use @simplewebauthn/server
// for registration & verification but store raw credential data ourselves.

export async function addPasskey({ userId, credential }) {
  await query(
    `INSERT INTO passkeys
       (user_id, credential_id, public_key, counter, transports, device_type)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter || 0,
      credential.transports || [],
      credential.deviceType || null
    ]
  );
}

export async function getPasskeyByCredentialId(credId) {
  return one(`SELECT * FROM passkeys WHERE credential_id = $1`, [credId]);
}

export async function listPasskeysForUser(userId) {
  const r = await query(
    `SELECT * FROM passkeys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return r.rows;
}

export async function updatePasskeyCounter(credId, counter) {
  await query(`UPDATE passkeys SET counter = $2 WHERE credential_id = $1`, [
    credId,
    counter
  ]);
}
