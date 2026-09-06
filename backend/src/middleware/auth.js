import { query, one } from '../db.js';
import { verifySession } from '../services/auth.js';

export async function requireUser(req, res, next) {
  try {
    const sid = req.cookies?.sid;
    if (!sid) return res.status(401).json({ error: 'no_session' });
    const user = await verifySession(sid);
    if (!user) return res.status(401).json({ error: 'invalid_session' });
    req.user = user;
    next();
  } catch (e) {
    console.error('[auth mw]', e.message);
    res.status(401).json({ error: 'auth_failed' });
  }
}

export async function optionalUser(req, res, next) {
  try {
    const sid = req.cookies?.sid;
    if (sid) {
      const user = await verifySession(sid);
      if (user) req.user = user;
    }
  } catch (e) {
    /* ignore */
  }
  next();
}
