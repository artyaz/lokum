import { Router } from 'express';
import { one } from '../db.js';
import { requireUser } from '../middleware/auth.js';
import {
  activeFacebookCookieSession,
  markFacebookCookieSession,
  parseFacebookCookies,
  saveFacebookCookieSession,
} from '../services/facebook-session.js';

const router = Router();

function publicSession(row, user) {
  const adminEmails = String(process.env.ADMIN_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const canManage = !row ||
    adminEmails.includes(String(user.email).toLowerCase()) ||
    row.user_id === user.id;
  return {
    configured: !!row,
    label: row?.label || null,
    expiresAt: row?.expires_at || null,
    lastStatus: row?.last_status || null,
    lastError: row?.last_error || null,
    lastCheckedAt: row?.last_checked_at || null,
    updatedAt: row?.updated_at || null,
    canManage,
  };
}

async function requireFacebookManager(req, res, next) {
  try {
    const active = await activeFacebookCookieSession();
    const adminEmails = String(process.env.ADMIN_EMAILS || '')
      .toLowerCase()
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    if (adminEmails.includes(String(req.user.email).toLowerCase())) return next();
    if (!active || active.user_id === req.user.id) return next();
    return res.status(403).json({ error: 'facebook_admin_required' });
  } catch (e) {
    console.error('[facebook-session] authorization failed', e.message);
    res.status(500).json({ error: 'facebook_auth_failed' });
  }
}

router.use(requireUser);

router.get('/session', async (req, res) => {
  try {
    const row = await activeFacebookCookieSession();
    res.json({ session: publicSession(row, req.user) });
  } catch (e) {
    console.error('[facebook-session] status failed', e.message);
    res.status(500).json({ error: 'facebook_status_failed' });
  }
});

router.put('/session', requireFacebookManager, async (req, res) => {
  try {
    const { cookies, label } = req.body || {};
    if (!cookies || typeof cookies !== 'string' || cookies.trim().length < 20) {
      return res.status(400).json({ error: 'cookies_required' });
    }
    // Parse early so obvious exports with missing c_user/xs fail before storage.
    parseFacebookCookies(cookies);
    const session = await saveFacebookCookieSession({
      input: cookies,
      userId: req.user.id,
      label: label || 'Browser export',
    });
    res.json({ session: { ...session, canManage: true } });
  } catch (e) {
    if (e.code === 'invalid_facebook_cookies') return res.status(400).json({ error: e.code, detail: e.message });
    console.error('[facebook-session] save failed', e.message);
    res.status(500).json({ error: 'facebook_save_failed' });
  }
});

router.delete('/session', requireFacebookManager, async (req, res) => {
  try {
    const active = await activeFacebookCookieSession();
    if (active) await markFacebookCookieSession(active.id, 'removed', null);
    await one(
      `UPDATE facebook_cookie_sessions SET is_active = FALSE, updated_at = NOW()
       WHERE is_active = TRUE RETURNING id`
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[facebook-session] delete failed', e.message);
    res.status(500).json({ error: 'facebook_delete_failed' });
  }
});

export default router;
