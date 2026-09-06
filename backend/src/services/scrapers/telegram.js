// Public Telegram channel previews scraper.
//
// Scrapes https://t.me/s/<channel> — Telegram's public web preview that
// returns plain server-rendered HTML with no anti-bot challenge, no JS,
// no auth. Each "listing" is a single Telegram message in the channel
// (the home_Warszawa channel uses an automated bot that reposts OLX
// listings with a Russian-language description template + the OLX
// listing's cover photo as the message attachment).
//
// Channel scope (verified 2026-08-29 via direct curl):
//   - t.me/s/home_Warszawa — VERIFIED scrapable. ~20 messages/page, 1
//     photo per message, full text + ISO timestamp + data-post id.
//     Multiple posts/day, Russian/Polish mixed text, Warsaw districts as
//     hashtags (#Mokotów, #Praga_Południe, #Śródmieście, #Wola, #Ursus).
//   - t.me/s/warszawakvartira — VERIFIED NOT scrapable (HTTP 302 →
//     t.me/warszawakvartira): the channel owner has disabled the public
//     preview. The scraper detects this case via the redirect (or the
//     "if you have Telegram" landing page) and skips the channel. Listed
//     in DEFAULT_CHANNELS nonetheless — if the owner ever re-enables
//     the preview, the scraper will pick it up automatically.
//
// HTML layout (verified on live channel home_Warszawa, message 920997):
//   <div class="tgme_widget_message_wrap js-widget_message_wrap">
//     <div class="tgme_widget_message ... js-widget_message"
//          data-post="home_Warszawa/920997"           ← external id
//          data-view="...">
//       ...
//       <a class="tgme_widget_message_photo_wrap ..."
//          href="https://t.me/home_Warszawa/920997"
//          style="...;background-image:url('https://cdn4.telesco.pe/file/...jpg')">
//         <div class="tgme_widget_message_photo" style="padding-top:75%"></div>
//       </a>
//       <div class="tgme_widget_message_text js-message_text" dir="auto">
//         <a href="https://www.olx.pl/d/oferta/..."><b>WYNAJMĘ SUPER MIESZKANIE</b></a>
//         <br/><br/>
//         <b>📍 Район: </b><a href="?q=%23Praga_Po%C5%82udnie"><b>#Praga_Południe</b></a>
//         <br/>
//         <b>💰 Цена</b>: 3000 zł [+300 zł медиа]
//         <br/>
//         <b>🔢 Комнаты</b>: #1_комната
//         <br/>
//         <b>〽 Площадь</b>: 38.0 м²
//         ...
//       </div>
//       <div class="tgme_widget_message_footer ...">
//         ...
//         <a class="tgme_widget_message_date" href="https://t.me/home_Warszawa/920997">
//           <time datetime="2026-08-29T17:15:43+00:00" class="time">17:15</time>
//         </a>
//       </div>
//     </div>
//   </div>
//
// Pagination: the page emits a single "load more" link at the top:
//   <a href="/s/home_Warszawa?before=920997"
//      class="tme_messages_more js-messages_more"
//      data-before="920997"></a>
// Following ?before=N returns the next 20 messages with id < N. We walk
// backwards (newest → oldest) until we've collected MAX_MESSAGES (default
// 200, env-overridable via TG_MAX_MESSAGES).
//
// Quality bar (per Task D brief):
//   - Photos: take what's available — Telegram posts in this channel
//     have exactly 1 photo per message (the OLX cover photo). Multi-
//     photo albums in other channels would appear as sequential messages,
//     each with its own photo_wrap, so the per-message extraction still
//     returns 1 photo each. We collect them all into the listing's
//     images[] array (capped at 20 by persistListing).
//   - Description: full message text with <br> converted to newlines,
//     HTML stripped, entities decoded. Every line preserved — district,
//     price, rooms, area, broker/owner, date.
//   - Price: best-effort regex parse from Polish/Russian text. Patterns
//     covered: "3000 zł", "2 500 zł", "3000zl", "3000 PLN", "3000PLN",
//     "Цена: 3000 zł [+300 zł медиа]" (bracketed media portion stripped).
//   - Location: best-effort — parse Warsaw district names from text.
//     Handles hashtag form (#Mokotów, #Praga_Południe) and plain-text
//     form. lat/lng is NULL — enrich.js will reverse-geocode from the
//     parsed district.

import { BaseScraper } from './base.js';

const SOURCE_ID = 20;

// Number of messages to walk per fetch cycle. Default 200 — covers ~10
// days of activity on home_Warszawa at ~20 messages/day. Pairs with the
// 3×/day schedule so each fetch catches everything added in the past
// ~8h with margin to spare. Env-overridable for operators who want to
// dial it up/down per environment.
const MAX_MESSAGES_DEFAULT = 200;
// t.me/s/<channel> returns ~20 messages per page (verified on
// home_Warszawa across 3 different pages).
const MESSAGES_PER_PAGE = 20;
// Stop walking after this many consecutive page-fetch failures — same
// pattern as domiporta/rentola/nieruchomosciOnline/okolica/wynajem24.
// 3 strikes → bail.
const MAX_CONSECUTIVE_FAILURES = 3;
// Polite delay between page fetches — t.me/s/ is a free public preview
// and we don't want to look like a load-testing bot. 500 ms/page × 10
// pages = 5 s of polite pacing per channel per fetch cycle.
const REQUEST_DELAY_MS = 500;

// Channels to walk, in priority order. The first channel that yields
// listings is the canonical source; subsequent channels are walked too
// (each is a distinct source of listings with a distinct external_id
// namespace: external_id = "<channel>/<msg_id>" — no collision across
// channels).
//
// Env-overridable via TG_CHANNELS=chan1,chan2 (comma-separated, no @
// prefix, no t.me/ prefix — just the bare channel username).
const DEFAULT_CHANNELS = ['home_Warszawa', 'warszawakvartira'];

// Warsaw districts — the 18 dzielnicas (Praga split into Północ + Południe).
// Used for case-insensitive text + hashtag matching. Each entry is the
// canonical Polish form (with diacritics). Hashtag form (#Mokotów) and
// plain-text form both match here — the parser lowercases both sides
// and normalizes _ → - before comparison.
//
// Source: https://en.wikipedia.org/wiki/Districts_of_Warsaw
const WARSAW_DISTRICTS = [
  'Śródmieście', 'Mokotów', 'Praga-Północ', 'Praga-Południe', 'Żoliborz',
  'Wola', 'Ochota', 'Włochy', 'Ursus', 'Ursynów', 'Wilanów', 'Targówek',
  'Rembertów', 'Wawer', 'Wesoła', 'Bielany', 'Białołęka', 'Bemowo'
];

// Some channels also use bare "Praga" (covers both Północ + Południe).
// We resolve to a combined label since the channel doesn't disambiguate.
// The enrich.js reverse-geocoder accepts either form; we keep "Praga"
// as the literal district label when only the bare form is present.
const WARSAW_DISTRICTS_LOWER = WARSAW_DISTRICTS.map(d => d.toLowerCase());

// Approximate center coordinates (lat, lng) for each Warsaw district.
// Used as a fallback when a Telegram message text mentions a district
// name but no specific street address. Telegram messages don't carry
// GPS coordinates — the platform has no concept of message-level geo —
// so without this map every telegram listing would have lat/lng = NULL
// and never appear on the map. District-center coords place the listing
// pin in the right neighborhood; the dedupe step (services/dedupe.js)
// uses a 200m radius tolerance, so district-level precision is good
// enough for cross-source matching.
//
// Coordinates sourced from Wikipedia district pages + OpenStreetMap
// centroid queries (2026-08-29). Each is the approximate geographic
// center of the district, NOT the city hall address.
const WARSAW_DISTRICT_COORDS = {
  'Śródmieście':    { lat: 52.2310, lng: 21.0090 },
  'Mokotów':        { lat: 52.2000, lng: 21.0200 },
  'Praga-Północ':   { lat: 52.2530, lng: 21.0400 },
  'Praga-Południe': { lat: 52.2400, lng: 21.0600 },
  'Praga':          { lat: 52.2470, lng: 21.0500 }, // bare form: combined centroid
  'Żoliborz':       { lat: 52.2700, lng: 20.9800 },
  'Wola':           { lat: 52.2350, lng: 20.9800 },
  'Ochota':         { lat: 52.2190, lng: 20.9940 },
  'Włochy':         { lat: 52.2000, lng: 20.9300 },
  'Ursus':          { lat: 52.1900, lng: 20.8800 },
  'Ursynów':        { lat: 52.1500, lng: 21.0500 },
  'Wilanów':        { lat: 52.1700, lng: 21.0800 },
  'Targówek':       { lat: 52.2600, lng: 21.0800 },
  'Rembertów':      { lat: 52.2500, lng: 21.1600 },
  'Wawer':          { lat: 52.2200, lng: 21.1500 },
  'Wesoła':         { lat: 52.2500, lng: 21.2300 },
  'Bielany':        { lat: 52.2900, lng: 20.9700 },
  'Białołęka':      { lat: 52.3200, lng: 21.0300 },
  'Bemowo':         { lat: 52.2600, lng: 20.9300 }
};

function envInt(name, fallback) {
  const v = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function envList(name, fallback) {
  const v = (process.env[name] || '').trim();
  if (!v) return fallback;
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

// Strip HTML tags + decode entities from a fragment. Mirrors the
// domiporta/rentola stripTags helper, but tuned for Telegram's HTML
// (which uses <br/> for line breaks and <b>...</b> for bold labels).
function stripTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/[a-z]+>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Polish/Slavic number parse — accepts "2 500", "2 500,50", "2500",
// "2.500" (Polish thousand sep), "2,500" (English thousand sep).
// Spaces and \u00A0 (non-breaking space) are stripped before parsing.
function parseNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v)
    .replace(/[\s\u00A0]/g, '')
    // Normalize Polish thousand sep "." → drop, but keep "." as decimal
    // only when followed by exactly 1-2 digits at the end. Best-effort:
    // strip all "." that look like thousand separators (3-digit groups).
    .replace(/(\d)\.(\d{3})/g, '$1$2')
    .replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

export class TelegramScraper extends BaseScraper {
  // Streaming disabled — same reason as rentola/nieruchomosciOnline/
  // domiporta: the post-extraction step (price/rooms/area/district regex
  // parsing from the message text) needs the full message in hand before
  // it can produce a normalized listing. We retain the listings array
  // (~400 KB for 200 listings × 2 KB payload) and return it all at once.
  supportsStreaming = false;

  constructor() {
    super({
      sourceId: SOURCE_ID,
      sourceSlug: 'telegram',
      baseUrl: 'https://t.me'
    });
  }

  // The runner calls fetchCity(city, options) per city. Telegram channels
  // are Warsaw-specific (the channels target the Warsaw rental market
  // only) — we no-op for any city that isn't 'warsaw'.
  async fetchCity(city, options = {}) {
    if (city.slug !== 'warsaw') return [];
    const { filters = {}, sinceTime = null } = options;

    const channels = envList('TG_CHANNELS', DEFAULT_CHANNELS);
    const maxMessages = envInt('TG_MAX_MESSAGES', MAX_MESSAGES_DEFAULT);
    const ads = [];
    const seenExternalIds = new Set();

    for (const channel of channels) {
      const channelListings = await this._walkChannel(channel, city, {
        maxMessages,
        filters,
        sinceTime,
        seenExternalIds
      });
      ads.push(...channelListings);
      console.log(
        `[tg] ${channel}: ${channelListings.length} listings ` +
        `(total across channels: ${ads.length})`
      );
    }
    return ads;
  }

  // Walk a single channel backwards (newest → oldest) until we've
  // collected `maxMessages` listings OR run out of pages OR hit the
  // sinceTime early-exit (a message older than sinceTime means every
  // older message in this channel is also older — safe to stop).
  async _walkChannel(channel, city, { maxMessages, filters, sinceTime, seenExternalIds }) {
    const out = [];
    let before = null; // first page: no ?before= (newest)
    let consecutiveFailures = 0;
    const maxPages = Math.ceil(maxMessages / MESSAGES_PER_PAGE) + 2;

    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams();
      if (before != null) params.set('before', String(before));
      const qs = params.toString();
      const url = `${this.baseUrl}/s/${channel}${qs ? '?' + qs : ''}`;

      let html;
      try {
        html = await this._fetch(url, { desktop: true, timeout: 20000 });
      } catch (e) {
        console.warn(`[tg] ${channel} page ${page}: fetch failed (${e.message})`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `[tg] ${channel}: ${MAX_CONSECUTIVE_FAILURES} consecutive page fetch failures — aborting walk at page ${page}`
          );
          break;
        }
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      consecutiveFailures = 0;

      const messages = this._parseMessages(html, channel, city);
      if (!messages.length) {
        if (page === 1) {
          // Two failure modes here: (a) the channel 302-redirected to
          // the "view in Telegram" landing page (public preview
          // disabled — e.g. warszawakvartira), or (b) the channel
          // genuinely has no messages. Either way, no point paginating.
          console.warn(
            `[tg] ${channel}: no messages on page 1 — public preview disabled or empty channel, skipping`
          );
        } else {
          console.log(`[tg] ${channel} page ${page}: empty page — stopping`);
        }
        break;
      }

      let oldestIdThisPage = null;
      let stopForSince = false;
      let newThisPage = 0;
      for (const msg of messages) {
        if (seenExternalIds.has(msg.externalId)) continue;
        seenExternalIds.add(msg.externalId);

        // Defensive runner-level filters — same pattern as domiporta/
        // rentola. The price filter skips free-form text messages that
        // didn't yield a parseable price.
        if (filters.maxPrice != null && msg.price && msg.price > filters.maxPrice) continue;
        if (filters.minPrice != null && (msg.price == null || msg.price < filters.minPrice)) continue;

        // sinceTime early-exit: messages are returned newest-first
        // within a page AND across pages (because ?before=N keeps
        // walking backwards). Once we hit a message older than
        // sinceTime, every subsequent message in this and later
        // pages is older too — safe to stop the whole walk.
        if (sinceTime && msg.postedAt) {
          if (new Date(msg.postedAt) < sinceTime) {
            stopForSince = true;
            continue;
          }
        }

        out.push(msg);
        newThisPage++;

        // Track the lowest message id on this page so we can request
        // the next page (?before=<lowest id>).
        const idNum = this._msgIdNum(msg.externalId);
        if (idNum != null && (oldestIdThisPage == null || idNum < oldestIdThisPage)) {
          oldestIdThisPage = idNum;
        }

        if (out.length >= maxMessages) break;
      }

      console.log(
        `[tg] ${channel} page ${page}: ${messages.length} messages ` +
        `(new this page: ${newThisPage}, total ${out.length})`
      );

      if (out.length >= maxMessages) break;
      if (stopForSince) {
        console.log(`[tg] ${channel}: hit sinceTime cutoff at page ${page} — stopping`);
        break;
      }
      if (oldestIdThisPage == null) break; // nothing to paginate further

      // The "load more" link's data-before points to the lowest id on
      // the current page — using it requests the next-older batch.
      // We prefer the explicitly-emitted data-before when available
      // (matches Telegram's own pagination contract), but fall back to
      // the lowest id we parsed (defensive — Telegram can change the
      // tme_messages_more class name).
      before = this._extractDataBefore(html) || oldestIdThisPage;

      await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    }
    return out;
  }

  // Parse all <div class="tgme_widget_message_wrap"> blocks on a page
  // into normalized listing objects. Each block's root <div> carries
  // the data-post="<channel>/<msg_id>" attribute — that's our external
  // id (channel-scoped, so messages from different channels never
  // collide).
  //
  // Media-group (album) handling: when a Telegram channel posts an
  // album (multiple photos sent as one logical message), the public
  // preview emits each photo as a SEPARATE <div class="tgme_widget_message
  // ..."> block, all sharing the same data-grouped-id="<id>" attribute.
  // We detect this and collapse the grouped messages into ONE listing
  // with all the photos (up to 20 — the persistListing cap). The first
  // message's text/title/price/rooms/area/district is used (albums
  // typically only caption the first photo; subsequent photos are bare).
  //
  // For channels that don't use albums (e.g. home_Warszawa — every
  // message is a single reposted OLX cover photo), data-grouped-id is
  // absent and every message becomes its own listing (unchanged
  // behavior).
  _parseMessages(html, channel, city) {
    const out = [];
    const s = String(html);

    // Walk each message_wrap block. We slice on the wrap-open tag and
    // extract fields up to the matching wrap-close. Telegram's HTML
    // is well-formed enough that a simple indexOf-walk is reliable;
    // we don't need a full DOM parser for this.
    const wrapOpen = '<div class="tgme_widget_message_wrap';

    // First pass: extract each message block + its data-grouped-id.
    const blocks = [];
    let pos = 0;
    while (true) {
      const start = s.indexOf(wrapOpen, pos);
      if (start === -1) break;
      // Find next wrap-open OR end-of-document — that's the block end.
      const nextStart = s.indexOf(wrapOpen, start + 1);
      const end = nextStart === -1 ? s.length : nextStart;
      const block = s.slice(start, end);
      pos = end;

      // data-grouped-id is on the inner <div class="tgme_widget_message...">,
      // NOT on the outer wrap div. We extract it here so we can group
      // sibling message blocks that share it.
      const groupedMatch = block.match(/data-grouped-id="([^"]+)"/);
      const groupedId = groupedMatch ? groupedMatch[1] : null;

      const fields = this._parseMessageFields(block, channel);
      if (fields) blocks.push({ fields, groupedId });
    }

    // Second pass: group consecutive blocks by groupedId. Albums are
    // always consecutive in the channel feed (Telegram emits them as
    // back-to-back messages with monotonic IDs), so a simple linear
    // walk with a "current group" pointer is sufficient.
    for (let i = 0; i < blocks.length; i++) {
      const { groupedId } = blocks[i];
      if (groupedId) {
        // Collect ALL consecutive blocks with the same groupedId.
        const group = [blocks[i]];
        while (i + 1 < blocks.length && blocks[i + 1].groupedId === groupedId) {
          group.push(blocks[i + 1]);
          i++;
        }
        const listing = this._combineGroupedMessages(
          group.map(g => g.fields), channel, city
        );
        if (listing) out.push(listing);
      } else {
        // Ungrouped message — produce a single-message listing.
        const listing = this._combineGroupedMessages(
          [blocks[i].fields], channel, city
        );
        if (listing) out.push(listing);
      }
    }
    return out;
  }

  // Extract raw per-message fields from a single message_wrap HTML block.
  // Returns { externalId, msgId, url, postedAt, photos[], text, title,
  // price, rooms, area, district, street, olxUrl } or null when the block
  // has no valid data-post attribute (defensive — service messages,
  // channel-creator joins, etc. don't carry a data-post).
  //
  // This is intentionally a "fields-only" extractor — it does NOT produce
  // a full listing object. The caller (_parseMessages → _combineGroupedMessages)
  // is responsible for combining fields from multiple grouped messages into
  // one listing + resolving coords.
  _parseMessageFields(block, channel) {
    // 1. data-post="<channel>/<msg_id>" — the canonical id.
    const postMatch = block.match(/data-post="([^"]+)"/);
    if (!postMatch) return null;
    const dataPost = postMatch[1]; // e.g. "home_Warszawa/920997"
    // Defensive: only accept messages from the channel we're walking
    // (Telegram's preview shouldn't cross channels, but verify anyway).
    if (!dataPost.startsWith(`${channel}/`)) return null;
    const msgId = dataPost.split('/')[1];
    if (!msgId) return null;
    const externalId = `${channel}/${msgId}`;
    const url = `https://t.me/${channel}/${msgId}`;

    // 2. postedAt — from <time datetime="ISO">.
    let postedAt = null;
    const timeMatch = block.match(
      /<time[^>]*datetime="([^"]+)"[^>]*>/i
    );
    if (timeMatch) {
      const d = new Date(timeMatch[1]);
      if (!isNaN(d.getTime())) postedAt = d.toISOString();
    }

    // 3. Photos — all tgme_widget_message_photo_wrap anchors; the URL
    // is in the style attribute as background-image:url('...'). We
    // collect every photo_wrap in the block (albums surface multiple
    // photo_wraps within the same message block, though the home_Warszawa
    // channel only emits 1 per message — the bot posts the OLX cover
    // photo as the message attachment).
    const photos = [];
    const photoRe = /<a[^>]*class="[^"]*tgme_widget_message_photo_wrap[^"]*"[^>]*>/gi;
    let pm;
    while ((pm = photoRe.exec(block)) !== null) {
      const urlMatch = pm[0].match(/background-image:url\(['"]?([^'")]+)['"]?\)/i);
      if (urlMatch && urlMatch[1]) {
        const u = urlMatch[1].replace(/\\\//g, '/'); // unescape \/ if any
        if (!photos.includes(u)) photos.push(u);
      }
    }

    // 4. Message text — strip HTML, preserve <br> as newlines.
    // The text div has class "tgme_widget_message_text js-message_text".
    const textMatch = block.match(
      /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i
    );
    const textHtml = textMatch ? textMatch[1] : '';
    const text = stripTags(textHtml);

    // 5. Title — first non-empty line of the stripped text. For
    // home_Warszawa this is the bold <a><b>OLX TITLE</b></a> link at the
    // top of the message. Fallback to a generic channel-prefixed label.
    const firstLine = (text.split('\n').map(l => l.trim()).filter(Boolean)[0]) || '';
    const title = firstLine || `Telegram post ${msgId}`;

    // 6. Embedded OLX URL — home_Warszawa messages almost always contain
    // a link to the source OLX listing (the bot reposts OLX listings).
    // We extract it here so fetchOneListing can cross-fetch the full
    // OLX photo gallery (8-12 photos vs the 1 cover photo the Telegram
    // message carries). Best-effort: returns null when no OLX link is
    // present (rare owner-direct posts without an OLX cross-listing).
    const olxUrl = this._extractOlxUrl(block, text);

    // 7-10. Price / rooms / area / district / street — parsed from the
    // text via the existing best-effort regex helpers. The price parse
    // strips the bracketed "+N zł медиа" suffix first.
    const textNoMedia = text
      .replace(/\[[^\]]*\+(?:\s*\d[\d\s]*)?\s*(?:zł|zl|pln|медиа|czynsz|kom|комуналка|komunikacja)[^\]]*\]/gi, '')
      .replace(/\(\s*\+\s*\d[\d\s]*\s*(?:zł|zl|pln|медиа|czynsz)[^)]*\)/gi, '');
    const price = this._parsePrice(textNoMedia);
    const rooms = this._parseRooms(text);
    const area = this._parseArea(text);
    const district = this._parseDistrict(text);
    const street = this._parseStreet(text);

    return {
      externalId,
      msgId,
      url,
      postedAt,
      photos,
      text,
      title,
      price,
      rooms,
      area,
      district,
      street,
      olxUrl
    };
  }

  // Combine one or more parsed message-field objects into a single
  // normalized listing. For a single-message listing (no album), this
  // is a thin reshape. For an album (multiple grouped messages), this
  // merges photos from every message + uses the first non-empty text
  // (albums typically only caption the first photo).
  //
  // Coords are resolved at the END via _resolveCoords: district-center
  // when a district is parsed, city-center as the ultimate fallback.
  // This guarantees every telegram listing has lat/lng set so it shows
  // on the map (previously 0% coords — listings were invisible).
  _combineGroupedMessages(messages, channel, city) {
    if (!messages || !messages.length) return null;

    // Find the "primary" message — the first one with non-empty text.
    // For albums, this is the captioned first photo. Falls back to the
    // first message overall when no message has text (rare: pure-photo
    // album with no caption — we still want a listing, just with a
    // generated title).
    let primary = messages.find(m => m.text && m.text.trim().length > 0) || messages[0];

    // External id: use the primary message's id. For albums this means
    // the listing is keyed by the first photo's message id — subsequent
    // re-scrapes will UPSERT the same row (good — no duplicates).
    const externalId = primary.externalId;
    const url = primary.url;
    const msgId = primary.msgId;

    // Combine photos from ALL messages in the group (dedup by URL).
    // Album messages each carry 1 photo; grouped together they yield
    // the full album (up to 10 photos per album — Telegram's media-
    // group limit). Single-message listings just get their own photos.
    const photos = [];
    for (const m of messages) {
      for (const p of m.photos) {
        if (!photos.includes(p)) photos.push(p);
      }
    }

    // Text: use the primary message's text. For albums, concatenating
    // all messages' text would duplicate the caption across every
    // photo (Telegram doesn't add per-photo text — only the first
    // message has the caption). So we just take the primary's text.
    const text = primary.text || '';
    if (!text && !photos.length) return null; // empty message (rare)

    // Title / price / rooms / area / district / street: from primary.
    const title = primary.title || `Telegram post ${msgId}`;
    const price = primary.price;
    const rooms = primary.rooms;
    const area = primary.area;
    const district = primary.district;
    const street = primary.street;

    // Resolve lat/lng: district-center when available, else city center.
    // Both branches ensure the listing has coords so it appears on the
    // map. The city-center fallback is better than null — at least the
    // listing shows up in the city it's posted for.
    const { lat, lng } = this._resolveCoords(district, city);

    // Collect OLX URLs from all messages in the group (some albums
    // might split the OLX link across messages — defensive). Use the
    // first non-null olxUrl as the canonical cross-reference.
    const olxUrl = messages.map(m => m.olxUrl).find(Boolean) || null;

    return {
      externalId,
      sourceId: SOURCE_ID,
      cityId: city.id,
      title,
      description: text,
      price,
      currency: 'PLN',
      rooms,
      area,
      floor: null,
      district: district || city.name_pl,
      street,
      address: [street, district].filter(Boolean).join(', ') || district || city.name_pl,
      lat,
      lng,
      url,
      postedAt: primary.postedAt,
      images: photos.slice(0, 20), // persistListing cap
      conveniences: [],
      raw: {
        channel,
        msgId,
        url,
        postedAt: primary.postedAt,
        photoCount: photos.length,
        messageCount: messages.length, // 1 for non-album, >1 for album
        grouped: messages.length > 1,
        olxUrl,
        priceText: price != null ? String(price) : null,
        coordsSource: lat === city.lat && lng === city.lng
          ? 'city-center-fallback'
          : (district ? 'district-center' : 'city-center-fallback')
      }
    };
  }

  // Resolve lat/lng for a telegram listing. Telegram messages don't
  // carry GPS coordinates — the platform has no concept of message-
  // level geo. We use a 2-tier fallback:
  //   1. If a Warsaw district was parsed from the message text, return
  //      that district's approximate center coordinates (good enough
  //      for map placement + dedupe's 200m tolerance).
  //   2. Otherwise, fall back to the city's center coordinates (city.lat
  //      / city.lng from the cities table). This ensures every listing
  //      has SOME coords so it appears on the map at all.
  _resolveCoords(district, city) {
    if (district && WARSAW_DISTRICT_COORDS[district]) {
      return WARSAW_DISTRICT_COORDS[district];
    }
    // District not parsed, or parsed to a label not in our map (rare —
    // every Warsaw district is in WARSAW_DISTRICT_COORDS). Fall back to
    // city center.
    if (city && typeof city.lat === 'number' && typeof city.lng === 'number') {
      return { lat: city.lat, lng: city.lng };
    }
    // Last-resort hardcode for Warsaw (the only city telegram channels
    // target today) — defensive in case the caller passes a city without
    // lat/lng populated.
    return { lat: 52.2297, lng: 21.0122 };
  }

  // Extract the embedded OLX listing URL from a telegram message body.
  // The home_Warszawa bot reposts OLX listings — each message has an
  // <a href="https://www.olx.pl/d/oferta/...-ID<shortid>.html"> link
  // pointing back to the source. We extract it so fetchOneListing can
  // cross-fetch the OLX page for the full photo gallery (8-12 photos
  // vs the 1 cover photo on the Telegram side).
  //
  // Returns the absolute OLX URL or null when no OLX link is present.
  _extractOlxUrl(block, text) {
    // Prefer the HTML <a href> form (more reliable — the URL might
    // contain query params or fragments that the text form would lose).
    const hrefMatch = block.match(
      /href="(https?:\/\/(?:www\.)?olx\.pl\/d\/oferta\/[^"]+)"/i
    );
    if (hrefMatch) return hrefMatch[1];
    // Fallback: bare URL in stripped text.
    const textMatch = String(text || '').match(
      /(https?:\/\/(?:www\.)?olx\.pl\/d\/oferta\/[^\s<]+)/i
    );
    if (textMatch) return textMatch[1];
    return null;
  }

  // Best-effort price parser. Returns integer PLN or null.
  //
  // Strategy:
  //   1. Strip the bracketed "+N zł медиа" / "+N zł czynsz" suffix (caller
  //      already did this; we keep it defensive).
  //   2. Prefer prices attached to a price keyword in any of 4 languages
  //      (PL/UK/RU/EN): "Cena"/"Цена"/"Ціна"/"Price"/"Стоимость" + ":"
  //      + number + "zł/zl/PLN/грн/złoty".
  //   3. Fall back to the first "<number> zł/PLN" anywhere in text.
  //   4. Polish thousand-separator aware: "2 500" → 2500, "2.500" → 2500.
  _parsePrice(text) {
    if (!text) return null;
    const s = String(text);

    // Currency markers — zł, zl (ASCII fallback), PLN, złoty/złote (declined),
    // грн (Ukrainian hryvnia, sometimes seen for乌克兰 expat posts).
    const CUR = '(?:zł|zl|pln|złoty|złote|зл|грн)';

    // Price keyword in 4 languages + optional ":" + whitespace + number.
    // Captures the integer part (with thousand seps preserved for parseNum).
    const kwRe = new RegExp(
      '(?:Cena|Цена|Ціна|Ціна|Цэна|Price|Стоимость|Вартість|Кошт)[:\\s]*' +
      '(\\d[\\d\\s.]*\\d|\\d+)\\s*' + CUR,
      'i'
    );
    const kwMatch = s.match(kwRe);
    if (kwMatch) {
      const n = parseNum(kwMatch[1]);
      if (Number.isFinite(n) && n >= 100 && n <= 50000) return Math.round(n);
    }

    // Fallback: first "<number> zł/PLN" anywhere. Restrict to 3-5 digit
    // numbers (100-99999) so we don't accidentally match a phone number
    // fragment or a media-cost suffix.
    const fallbackRe = new RegExp(
      '(\\d[\\d\\s.]*\\d|\\d{3,5})\\s*' + CUR,
      'i'
    );
    const fm = s.match(fallbackRe);
    if (fm) {
      const n = parseNum(fm[1]);
      if (Number.isFinite(n) && n >= 100 && n <= 50000) return Math.round(n);
    }
    return null;
  }

  // Best-effort rooms parser. Returns 1..10 or null.
  // Handles: "#N_комната/комнаты/комнат" (Russian hashtag),
  // "N pokój/pokoje/pokoi" (Polish), "N room/rooms" (English),
  // "kawalerka/studio/odisplaystudio" (synonyms for 1).
  _parseRooms(text) {
    if (!text) return null;
    const s = String(text);

    // Hashtag form: #1_комната, #2_комнаты, #3_комнаты, ...
    const hashRe = /#(\d{1,2})[_\s]*(?:комнат[аыуе]|poko[ji]|pokoi|room)/i;
    const hm = s.match(hashRe);
    if (hm) {
      const n = parseInt(hm[1], 10);
      if (n >= 1 && n <= 10) return n;
    }

    // Plain text: "1 pokój", "2 pokoje", "3 комнаты", "2 rooms"
    const plainRe = /(\d{1,2})\s*(?:комнат[аыуе]|poko[ji]|pokoi|room[s]?|chambre[s]?)/i;
    const pm = s.match(plainRe);
    if (pm) {
      const n = parseInt(pm[1], 10);
      if (n >= 1 && n <= 10) return n;
    }

    // Synonyms for 1-room (kawalerka / studio / квартиру-студию)
    if (/kawalerk|studio|студи/i.test(s)) return 1;

    return null;
  }

  // Best-effort area parser. Returns number (m²) or null.
  // Handles: "38.0 м²", "54 m²", "54m²", "54 m2", "54m2",
  // "54 sqm", "54 sq.m".
  _parseArea(text) {
    if (!text) return null;
    const s = String(text);
    const re = /(\d+(?:[.,]\d{1,2})?)\s*(?:м²|m²|m2|m^2|sqm|sq\.?\s?m|metr[a-zy]*)/i;
    const m = s.match(re);
    if (!m) return null;
    const n = parseNum(m[1]);
    if (!Number.isFinite(n) || n < 8 || n > 500) return null; // sanity bounds
    return n;
  }

  // Best-effort Warsaw district parser. Returns the canonical Polish
  // form (with diacritics) or null.
  //
  // Checks (in order):
  //   1. Hashtag form: "#Mokotów", "#Praga_Południe", "#Śródmieście"
  //      — strip "#", replace "_" with "-", lowercase, compare.
  //   2. Canonical-form exact substring match (catches nominative
  //      mentions with full diacritics preserved, e.g. "Mieszkanie w
  //      Mokotów"). Longest-first so "Praga-Południe" wins over bare
  //      "Praga".
  //   3. Stem-based match — catches Polish declined forms (locative,
  //      genitive, etc.) where the declined word doesn't contain the
  //      full canonical form. 3-char ASCII-folded stem is enough to
  //      disambiguate all Warsaw districts except Praga-Półnec/
  //      Południe (excluded here — they're handled by step 4's bare-
  //      Praga fallback). Example: "w Woli" → stem "wol" → Wola;
  //      "na Śródmieściu" → stem "sro" → Śródmieście; "w Mokotowie"
  //      → stem "mok" → Mokotów.
  //   4. Bare "Praga" fallback — when the text mentions "Praga" or
  //      any declined form (Pradze, Pragą, Pragę) without specifying
  //      Północ or Południe. Returns the literal "Praga" label.
  _parseDistrict(text) {
    if (!text) return null;
    const s = String(text);

    // 1. Hashtag form. Match #<name>[_<name>]+ allowing diacritics.
    // Capture the name part, normalize, compare.
    const hashRe = /#([A-Za-zÀ-ÿąćęłńóśźżĄĆĘŁŃÓŚŹŻ][A-Za-zÀ-ÿąćęłńóśźżĄĆĘŁŃÓŚŹŻ_\-]{2,30})/g;
    let m;
    while ((m = hashRe.exec(s)) !== null) {
      const norm = m[1].replace(/_/g, '-').toLowerCase();
      const idx = WARSAW_DISTRICTS_LOWER.indexOf(norm);
      if (idx !== -1) return WARSAW_DISTRICTS[idx];
    }

    // Prepare ASCII-folded lowercased text for the remaining checks.
    // ł → l is special-cased because NFD decomposition doesn't strip ł.
    const sAscii = s.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/ł/g, 'l').replace(/Ł/g, 'L');

    // Sort districts by length DESC so the more-specific match wins
    // (Praga-Południe before bare Praga, etc.).
    const sorted = [...WARSAW_DISTRICTS].sort((a, b) => b.length - a.length);

    // 2. Canonical-form exact substring match.
    for (const d of sorted) {
      const dAscii = d.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/ł/g, 'l').replace(/Ł/g, 'L');
      if (sAscii.includes(dAscii)) return d;
    }

    // 3. Stem-based match — declined-form fallback.
    for (const d of sorted) {
      if (d.startsWith('Praga-')) continue; // handled by step 4
      const dAscii = d.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/ł/g, 'l').replace(/Ł/g, 'L');
      const stem = dAscii.slice(0, 3);
      if (stem.length < 3) continue;
      // \b + stem + 0-10 trailing ASCII letters catches any declined
      // form that shares the stem prefix (e.g. "Woli" matches stem "wol").
      const re = new RegExp(`\\b${stem}[a-z]{0,10}`, 'i');
      if (re.test(sAscii)) return d;
    }

    // 4. Bare "Praga" fallback — matches Praga, Pradze, Pragą, Pragę.
    if (/\bprag[a-z]{0,5}/i.test(sAscii)) return 'Praga';
    return null;
  }

  // Best-effort street parser. Returns the street name (without "ul."
  // prefix) or null. Looks for "ul. <Name>" or "ulica <Name>" patterns.
  _parseStreet(text) {
    if (!text) return null;
    const m = String(text).match(/\b(?:ul\.?|ulica|al\.?|aleja)\s+([A-ZÀ-ÿĄĆĘŁŃÓŚŹŻ][\wÀ-ÿąćęłńóśźżĄĆĘŁŃÓŚŹŻ\-\s]{2,40})/);
    if (!m) return null;
    return m[1].trim();
  }

  // Extract the lowest message id on the page from the
  // <a class="tme_messages_more" data-before="N"> pagination element.
  // Returns a Number or null when missing (page is the oldest the
  // channel exposes — there's no "load more" link).
  _extractDataBefore(html) {
    const m = String(html).match(/data-before="(\d+)"/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  // Parse the trailing numeric message id from "<channel>/<msg_id>"
  // external_id form. Returns a Number (for page-walk comparison) or null.
  _msgIdNum(externalId) {
    const m = String(externalId || '').match(/\/(\d+)$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  // Per-listing detail-page fetcher used by the post-run enrichBackfill
  // pipeline (services/enrich.js) when a telegram listing is missing
  // photos (and only photos — description / coords / district are already
  // set by the main fetchCity path now that district-geocoding +
  // city-center fallback are in place).
  //
  // Telegram channels like home_Warszawa are OLX-reposter bots: each
  // message contains a link back to the source OLX listing. The Telegram
  // message itself only carries the OLX cover photo (1 photo), but the
  // OLX listing page has the full gallery (8-12 photos). This method
  // follows the OLX URL embedded in the telegram message and extracts
  // the full photo array from the OLX HTML page's __NEXT_DATA__ block.
  //
  // Returns { images: [...] } when the OLX cross-fetch succeeds and
  // yields MORE photos than the listing already has. Returns null
  // when:
  //   - The OLX URL can't be extracted from the telegram message
  //     (rare owner-direct posts without an OLX cross-listing)
  //   - The OLX page returns 4xx/5xx (OLX rate-limits / CloudFront
  //     blocks — common from this server's IP; the listing keeps its
  //     1 telegram photo)
  //   - The OLX HTML doesn't contain a parseable photo array
  //     (page redesign — should be rare, but defensive)
  //
  // The brief explicitly says fetchOneListing is OPTIONAL for telegram
  // ("You may not need fetchOneListing at all"). The main fix is in
  // fetchCity (media-group grouping + district-geocode + city-center
  // fallback). This method is a best-effort enhancement that lifts avg
  // photos from 1.0 → 8-12 WHEN OLX is reachable from the cron host.
  // When OLX is unreachable, the listing keeps its 1 telegram photo +
  // the now-correct lat/lng — still a big improvement over the pre-fix
  // state (0% coords, 1.0 photos).
  async fetchOneListing(url, { city, externalId } = {}) {
    if (!url) return null;

    // 1. Fetch the telegram message page to extract the embedded OLX URL.
    // The t.me/<channel>/<msg_id> page is a small (~37 KB) HTML doc with
    // og:image + og:description meta tags. We re-parse it here to get
    // the OLX URL (stored in the message body / og:description).
    let html;
    try {
      html = await this._fetch(url, { desktop: true, timeout: 15000 });
    } catch (e) {
      console.warn(`[tg] fetchOneListing: telegram fetch failed for ${url}: ${e.message}`);
      return null;
    }

    // Extract the OLX URL from the telegram page. The href form is in
    // the message body HTML; the text form is in og:description (the
    // single-message view puts the full message text there).
    let olxUrl = this._extractOlxUrl(html, '');
    if (!olxUrl) {
      // Fallback: try the og:description meta tag content.
      const descMatch = html.match(
        /<meta\s+property="og:description"\s+content="([^"]+)"/i
      );
      if (descMatch) {
        const desc = descMatch[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'");
        olxUrl = this._extractOlxUrl('', desc);
      }
    }
    if (!olxUrl) {
      // No OLX URL in the message — nothing we can cross-fetch.
      return null;
    }

    // 2. Fetch the OLX page. This is the risky step — OLX's CloudFront
    // frequently 403s requests from cloud IPs. We try with full browser
    // headers (matches what the OLX scraper itself uses for its HTML
    // fallback path). On any failure, return null gracefully (the
    // listing keeps its 1 telegram photo, but lat/lng is already set).
    let olxHtml;
    try {
      olxHtml = await this._fetch(olxUrl, { desktop: true, timeout: 20000 });
    } catch (e) {
      // Common: HTTP 403 from CloudFront. Don't log a warning per-listing
      // — this fires for EVERY telegram listing when OLX is blocking the
      // server IP, which would spam the run log. The empty return is the
      // signal; enrich.js will skip the (no-op) enrichment.
      return null;
    }

    // 3. Extract photos from the OLX HTML page. OLX renders the listing
    // as a Next.js app with a `<script id="__NEXT_DATA__">` JSON block
    // containing the full ad record (same shape as the OLX detail API:
    // `{ props.pageProps.ad.photos: [{ link: 'url' }, ...] }`).
    const photos = this._extractOlxPhotos(olxHtml);
    if (!photos || !photos.length) return null;

    // 4. Build the partial listing object that enrich.js's default-case
    // branch will merge into the existing row. Only `images` is set —
    // description / lat / lng / street are already populated by the
    // main fetchCity path (district-geocode + city-center fallback),
    // and applyEnrichment only overwrites when the new value is
    // strictly better (e.g. more images than the existing 1).
    return {
      externalId: String(externalId || ''),
      sourceId: SOURCE_ID,
      cityId: city?.id ?? null,
      url,
      images: photos.slice(0, 20),
      // Pass-through the existing lat/lng so applyEnrichment doesn't
      // see them as "missing" and try to overwrite. (applyEnrichment
      // actually only writes lat/lng when listing.lat IS NULL — so
      // passing the same values back is a no-op.)
      lat: city?.lat ?? null,
      lng: city?.lng ?? null,
      description: '',
      street: null,
      raw: { olxUrl, olxPhotoCount: photos.length }
    };
  }

  // Extract photo URLs from an OLX detail-page HTML document. Tries
  // multiple strategies in order:
  //   1. __NEXT_DATA__ JSON block → props.pageProps.ad.photos[].link
  //      (canonical Next.js hydration data — present on every OLX page)
  //   2. JSON-LD <script type="application/ld+json"> → image[] array
  //      (defensive — present when OLX emits schema.org markup)
  //   3. og:image meta tag (only 1 image, but better than nothing)
  // Returns an array of photo URLs (deduped) or [] when nothing matched.
  _extractOlxPhotos(html) {
    const s = String(html || '');
    const out = new Set();

    // 1. __NEXT_DATA__ block.
    const ndMatch = s.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (ndMatch) {
      try {
        const data = JSON.parse(ndMatch[1]);
        const ad = data?.props?.pageProps?.ad;
        if (ad && Array.isArray(ad.photos)) {
          for (const p of ad.photos) {
            const u = p?.link || p?.url || (typeof p === 'string' ? p : null);
            if (u && typeof u === 'string') out.add(u);
          }
        }
      } catch {}
    }

    // 2. JSON-LD blocks.
    const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let ldM;
    while ((ldM = ldRe.exec(s)) !== null) {
      try {
        const ld = JSON.parse(ldM[1]);
        const candidates = Array.isArray(ld) ? ld : [ld];
        for (const c of candidates) {
          // Schema.org Product / Offer image can be a string or array.
          const img = c?.image;
          if (typeof img === 'string') out.add(img);
          else if (Array.isArray(img)) {
            for (const u of img) {
              if (u && typeof u === 'string') out.add(u);
            }
          }
        }
      } catch {}
    }

    // 3. og:image meta tag (last resort — only 1 photo).
    if (!out.size) {
      const ogM = s.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
      if (ogM) out.add(ogM[1]);
    }

    return [...out];
  }
}
