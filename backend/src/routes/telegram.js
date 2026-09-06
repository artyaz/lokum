import { Router } from 'express';
import { query, one } from '../db.js';
import { requireUser } from '../middleware/auth.js';
import { getBotToken, setBotToken, getRecentChats, sendTestNotification } from '../services/telegram.js';

const router = Router();

// GET /api/telegram — current user's telegram settings (+ whether bot token exists)
router.get('/', requireUser, async (req, res) => {
  try {
    const s = await one(`SELECT * FROM telegram_settings WHERE user_id = $1`, [req.user.id]);
    const token = await getBotToken();
    res.json({
      settings: s ? {
        enabled: s.enabled,
        chat_id: s.chat_id,
        min_price: s.min_price,
        max_price: s.max_price,
        region_ids: s.region_ids || []
      } : { enabled: false, chat_id: null, min_price: null, max_price: null, region_ids: [] },
      bot_token_set: !!token
    });
  } catch (e) {
    res.status(500).json({ error: 'get_failed', detail: e.message });
  }
});

// PUT /api/telegram — save settings. bot_token optional (only when changing).
router.put('/', requireUser, async (req, res) => {
  try {
    const { enabled, chat_id, min_price, max_price, region_ids, bot_token } = req.body || {};

    if (bot_token && typeof bot_token === 'string') {
      // sanity check token format: digits:alphanumeric
      if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(bot_token.trim())) {
        return res.status(400).json({ error: 'invalid_token', detail: 'Token should look like 123456789:AAE…' });
      }
      await setBotToken(bot_token.trim());
    }

    const regions = Array.isArray(region_ids) ? region_ids.filter(x => typeof x === 'string') : [];

    const s = await one(
      `INSERT INTO telegram_settings (user_id, enabled, chat_id, min_price, max_price, region_ids, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::uuid[], NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         chat_id = EXCLUDED.chat_id,
         min_price = EXCLUDED.min_price,
         max_price = EXCLUDED.max_price,
         region_ids = EXCLUDED.region_ids,
         updated_at = NOW()
       RETURNING *`,
      [
        req.user.id,
        !!enabled,
        chat_id ? String(chat_id).trim() : null,
        min_price != null && !isNaN(min_price) ? parseInt(min_price) : null,
        max_price != null && !isNaN(max_price) ? parseInt(max_price) : null,
        regions
      ]
    );
    const token = await getBotToken();
    res.json({
      settings: {
        enabled: s.enabled, chat_id: s.chat_id,
        min_price: s.min_price, max_price: s.max_price,
        region_ids: s.region_ids || []
      },
      bot_token_set: !!token
    });
  } catch (e) {
    console.error('[telegram] save', e);
    res.status(500).json({ error: 'save_failed', detail: e.message });
  }
});

// GET /api/telegram/chats — chats that recently wrote to the bot (for chat-id detection)
router.get('/chats', requireUser, async (req, res) => {
  try {
    const token = await getBotToken();
    if (!token) return res.status(400).json({ error: 'no_token', detail: 'Set the bot token first' });
    const chats = await getRecentChats(token);
    res.json({ chats });
  } catch (e) {
    res.status(502).json({ error: 'telegram_failed', detail: e.message });
  }
});

// POST /api/telegram/test — send a test notification to the current user
router.post('/test', requireUser, async (req, res) => {
  try {
    const r = await sendTestNotification(req.user.id);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, detail: e.message });
  }
});

export default router;
