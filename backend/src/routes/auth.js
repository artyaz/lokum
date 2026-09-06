import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  createUser, findUserByEmail, findUserById,
  createSession, destroySession, verifyPassword,
  addPasskey, getPasskeyByCredentialId, updatePasskeyCounter,
  listPasskeysForUser
} from '../services/auth.js';
import { requireUser } from '../middleware/auth.js';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { one } from '../db.js';

const router = Router();

// Cookie SameSite mode. Default 'lax' (same-origin UI served by this
// server). Set COOKIE_SAMESITE=none when the UI runs on a different origin
// (Vercel) so the session cookie is sent cross-site (requires HTTPS, i.e.
// COOKIE_SECURE != '0', which browsers mandate for SameSite=None).
const COOKIE_SAMESITE = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase() === 'none' ? 'none' : 'lax';

// RP config — works behind flats.chmyl.com nginx
function rpConfig(req) {
  const origin = process.env.PUBLIC_ORIGIN || `https://${req.headers.host}`;
  const url = new URL(origin);
  return {
    rpName: 'Lokum',
    rpID: url.hostname,
    origin,
    expectedOrigin: origin
  };
}

// ---------- signup ----------
router.post('/signup', async (req, res) => {
  try {
    const { email, name, password } = req.body || {};
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const existing = await findUserByEmail(email);
    if (existing && existing.has_password) {
      return res.status(409).json({ error: 'email_in_use' });
    }
    const user = await createUser({ email, name, password });
    const { sid, expiresAt } = await createSession(user.id);
    res.cookie('sid', sid, {
      httpOnly: true,
      sameSite: COOKIE_SAMESITE,
      secure: process.env.COOKIE_SECURE !== '0',
      maxAge: expiresAt - new Date(),
      path: '/'
    });
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    console.error('[auth] signup', e);
    res.status(500).json({ error: 'signup_failed', detail: e.message });
  }
});

// ---------- login (password) ----------
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
    const user = await findUserByEmail(email);
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    const { sid, expiresAt } = await createSession(user.id);
    res.cookie('sid', sid, {
      httpOnly: true, sameSite: COOKIE_SAMESITE,
      secure: process.env.COOKIE_SECURE !== '0',
      maxAge: expiresAt - new Date(), path: '/'
    });
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    console.error('[auth] login', e);
    res.status(500).json({ error: 'login_failed', detail: e.message });
  }
});

// ---------- logout ----------
router.post('/logout', async (req, res) => {
  try {
    if (req.cookies?.sid) await destroySession(req.cookies.sid);
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'logout_failed' });
  }
});

// ---------- me ----------
router.get('/me', requireUser, async (req, res) => {
  const passkeys = await listPasskeysForUser(req.user.id);
  res.json({
    user: { id: req.user.id, email: req.user.email, name: req.user.name },
    hasPasskey: passkeys.length > 0
  });
});

// ===================== PASSKEY =====================
// Step 1: registration options
router.post('/passkey/register/options', requireUser, async (req, res) => {
  try {
    const { rpID, rpName } = rpConfig(req);
    const existing = await listPasskeysForUser(req.user.id);
    const opts = await generateRegistrationOptions({
      rpName, rpID,
      userName: req.user.email,
      userDisplayName: req.user.name,
      attestationType: 'none',
      excludeCredentials: existing.map(p => ({
        type: 'public-key',
        id: p.credential_id
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred'
      }
    });
    // stash challenge in session-like cookie (short-lived)
    res.cookie('pk_reg_challenge', opts.challenge, {
      httpOnly: true, sameSite: COOKIE_SAMESITE,
      secure: process.env.COOKIE_SECURE !== '0',
      maxAge: 5 * 60_000, path: '/'
    });
    res.json(opts);
  } catch (e) {
    console.error('[auth] pk reg options', e);
    res.status(500).json({ error: 'pk_options_failed', detail: e.message });
  }
});

// Step 2: verify registration
router.post('/passkey/register/verify', requireUser, async (req, res) => {
  try {
    const { rpID, origin, expectedOrigin } = rpConfig(req);
    const challenge = req.cookies?.pk_reg_challenge;
    if (!challenge) return res.status(400).json({ error: 'no_challenge' });

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'verification_failed' });
    }
    const info = verification.registrationInfo;
    await addPasskey({
      userId: req.user.id,
      credential: {
        id: Buffer.from(info.credentialID).toString('base64url'),
        publicKey: info.credentialPublicKey,
        counter: info.counter,
        transports: info.credentialDeviceType === 'multiDevice'
          ? ['internal']
          : ['internal'],
        deviceType: info.credentialDeviceType
      }
    });
    res.clearCookie('pk_reg_challenge', { path: '/' });
    res.json({ verified: true });
  } catch (e) {
    console.error('[auth] pk reg verify', e);
    res.status(500).json({ error: 'pk_verify_failed', detail: e.message });
  }
});

// Step 3: login options
router.post('/passkey/login/options', async (req, res) => {
  try {
    const { rpID } = rpConfig(req);
    const opts = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred'
    });
    res.cookie('pk_auth_challenge', opts.challenge, {
      httpOnly: true, sameSite: COOKIE_SAMESITE,
      secure: process.env.COOKIE_SECURE !== '0',
      maxAge: 5 * 60_000, path: '/'
    });
    res.json(opts);
  } catch (e) {
    console.error('[auth] pk login options', e);
    res.status(500).json({ error: 'pk_login_options_failed', detail: e.message });
  }
});

// Step 4: verify login
router.post('/passkey/login/verify', async (req, res) => {
  try {
    const { rpID, expectedOrigin } = rpConfig(req);
    const challenge = req.cookies?.pk_auth_challenge;
    if (!challenge) return res.status(400).json({ error: 'no_challenge' });

    const rawId = req.body?.id;
    const passkey = await getPasskeyByCredentialId(rawId);
    if (!passkey) return res.status(401).json({ error: 'unknown_credential' });

    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
      authenticator: {
        credentialID: Buffer.from(passkey.credential_id, 'base64url'),
        credentialPublicKey: passkey.public_key,
        counter: Number(passkey.counter)
      }
    });
    if (!verification.verified) {
      return res.status(401).json({ error: 'verification_failed' });
    }
    await updatePasskeyCounter(passkey.credential_id, verification.authenticationInfo.newCounter);

    const user = await findUserById(passkey.user_id);
    if (!user) return res.status(401).json({ error: 'no_user' });

    const { sid, expiresAt } = await createSession(user.id);
    res.cookie('sid', sid, {
      httpOnly: true, sameSite: COOKIE_SAMESITE,
      secure: process.env.COOKIE_SECURE !== '0',
      maxAge: expiresAt - new Date(), path: '/'
    });
    res.clearCookie('pk_auth_challenge', { path: '/' });
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    console.error('[auth] pk login verify', e);
    res.status(500).json({ error: 'pk_login_verify_failed', detail: e.message });
  }
});

export default router;
