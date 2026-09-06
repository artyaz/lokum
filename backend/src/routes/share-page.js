// Server-rendered share page for /s/:token.
// Telegram (and other messengers) fetch this URL when a link is posted and
// read the OpenGraph meta — og:image gives them the photo to embed.
// Human visitors are redirected into the SPA (#/s/:token).

import { Router } from 'express';
import { one, many } from '../db.js';

const router = Router();

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n) {
  if (n == null) return '';
  return n.toLocaleString('pl-PL').replace(/,/g, ' ') + ' zł';
}

router.get('/:token', async (req, res) => {
  try {
    const share = await one(`SELECT listing_id FROM share_tokens WHERE token = $1`, [req.params.token]);
    if (!share) return res.status(404).send(ogPage({ notFound: true, token: req.params.token }));

    const l = await one(
      `SELECT l.*, s.name AS source_name, c.name AS city_name
       FROM listings l
       JOIN sources s ON s.id = l.source_id
       JOIN cities c ON c.id = l.city_id
       WHERE l.id = $1`,
      [share.listing_id]
    );
    if (!l) return res.status(404).send(ogPage({ notFound: true, token: req.params.token }));

    const imgs = await many(
      `SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position LIMIT 1`,
      [l.id]
    );

    const bits = [];
    if (l.rooms) bits.push(`${l.rooms} room${l.rooms === 1 ? '' : 's'}`);
    if (l.area) bits.push(`${l.area} m²`);
    bits.push(l.district || l.city_name);
    const priceLine = `${fmt(l.price)}/mo${l.total_estimate && l.total_estimate !== l.price ? ` (≈ ${fmt(l.total_estimate)} all-in)` : ''}`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(ogPage({
      token: req.params.token,
      title: l.title,
      priceLine,
      desc: `${priceLine} · ${bits.join(' · ')} — via ${l.source_name} on Lokum`,
      image: imgs[0]?.url || null,
      sourceUrl: l.url
    }));
  } catch (e) {
    console.error('[share-page]', e);
    res.status(500).send('error');
  }
});

function ogPage({ token, title, priceLine, desc, image, sourceUrl, notFound }) {
  const appUrl = `/#/s/${token}`;
  const pageTitle = notFound ? 'Listing unavailable — Lokum' : `${esc(title)} — Lokum`;
  const pageDesc = notFound ? 'This shared listing is no longer available.' : esc(desc || '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<meta property="og:type" content="article">
<meta property="og:site_name" content="Lokum">
<meta property="og:title" content="${pageTitle}">
<meta property="og:description" content="${pageDesc}">
${image ? `<meta property="og:image" content="${esc(image)}">
<meta property="og:image:secure_url" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(image)}">` : ''}
<meta http-equiv="refresh" content="0;url=${appUrl}">
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#FAF9F5;color:#201E1B;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
  .card{background:#fff;border-radius:18px;padding:36px 30px;max-width:420px;box-shadow:0 12px 40px -16px rgba(35,31,27,.18)}
  .brand{font-family:Georgia,serif;font-size:26px;margin-bottom:8px}
  .price{font-size:20px;font-weight:700;margin:10px 0 4px}
  .t{color:#7A756B;font-size:15px;line-height:1.5}
  a{color:#C15F3C}
  .btn{display:inline-block;margin-top:18px;background:#C15F3C;color:#fff;text-decoration:none;padding:12px 22px;border-radius:12px;font-weight:600}
</style>
</head>
<body>
<div class="card">
  <div class="brand">Lokum</div>
  ${notFound
    ? `<div class="t">This shared listing is no longer available.</div>`
    : `<div class="price">${esc(priceLine || '')}</div>
       <div class="t">${esc(title || '')}</div>
       <a class="btn" href="${appUrl}">Open listing</a>
       ${sourceUrl ? `<div class="t" style="margin-top:14px"><a href="${esc(sourceUrl)}">View original ad</a></div>` : ''}`}
</div>
<script>location.replace(${JSON.stringify(appUrl)});</script>
</body>
</html>`;
}

export default router;
