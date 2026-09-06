-- migration_019: Telegram public channel previews source (Task D-telegram-13)
--
-- Public Telegram channel previews at https://t.me/s/<channel> are plain
-- server-rendered HTML with no anti-bot challenge, no JS, no auth. Each
-- "listing" is a single Telegram message in the channel — the
-- home_Warszawa channel uses an automated bot that reposts OLX listings
-- with a Russian/Polish description template + the OLX cover photo as
-- the message attachment.
--
-- Channel scope (verified 2026-08-29 via direct curl):
--   - t.me/s/home_Warszawa — VERIFIED scrapable. ~20 messages/page,
--     1 photo per message, full text + ISO timestamp + data-post id.
--     Multiple posts/day, Warsaw districts as hashtags.
--   - t.me/s/warszawakvartira — VERIFIED NOT scrapable (HTTP 302 →
--     t.me/warszawakvartira): the channel owner has disabled the public
--     preview. The scraper detects this case via the redirect (or the
--     "if you have Telegram" landing page) and skips the channel. Listed
--     in DEFAULT_CHANNELS nonetheless — if the owner ever re-enables
--     the preview, the scraper will pick it up automatically.
--
-- Field availability (per Task D brief + verification):
--   - Photos: 1 per message in home_Warszawa (the OLX cover photo, on
--     Telegram's CDN at cdn4.telesco.pe/file/...jpg). Multi-photo
--     albums in other channels would appear as sequential messages.
--   - Description: full message text with district/price/rooms/area/
--     broker/date. Mixed Russian + Polish text. Quote URLs in the text
--     often link to the source OLX listing.
--   - Price: best-effort regex parse from text ("3000 zł", "2 500 zł",
--     "3000zl", "3000 PLN", "Цена: 3000 zł [+300 zł медиа]"). The
--     bracketed media-cost suffix is stripped before parsing.
--   - Location: best-effort — Warsaw district names parsed from text
--     (handles both hashtag form #Mokotów and plain-text form). lat/lng
--     is NULL — services/enrich.js reverse-geocodes from the parsed
--     district during the post-run enrichment backfill.
--   - postedAt: ISO timestamp from <time datetime="..."> inside the
--     message footer — high precision (to the second, UTC).
--
-- External id format: "<channel>/<msg_id>" (channel-scoped — messages
-- from different channels never collide).
--
-- Source id 20 — after 19 (rentola, Task D-rentola-12, migration_018).
-- Slot 20 was the next free number in the monotonic migration sequence.
--
-- Cross-source dedupe overlap: HIGH — home_Warszawa reposts OLX
-- listings, so most listings here will match listings already scraped
-- by source_id=1 (olx) via services/dedupe.js geo + area + rooms
-- fingerprint. The dedupe step discards the overlap, leaving only the
-- listings we'd otherwise miss (rare owner-direct posts without an OLX
-- cross-listing, listings that were taken down from OLX but the
-- Telegram post is still active).

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (20, 'Telegram', 'telegram', '#229ED9', 'https://t.me')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
