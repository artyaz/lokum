-- 2026_08_dedupe_phash: cross-provider duplicate detection via perceptual photo hashing
--
-- Background:
--   The existing dedupe pipeline (backend/src/services/dedupe.js) only matches
--   listings whose photo URLs normalize to the SAME string. Because OLX and
--   Otodom (and every other portal) host photos on DIFFERENT CDNs with
--   different image IDs, the same flat cross-posted by the same agent never
--   shares a photo URL key — so the photo-overlap signal is always 0 for
--   cross-provider pairs. That leaves only geo + street + rooms + price
--   proximity, which is too brittle: slightly different coords, slightly
--   different prices (one with czynsz, one without), slightly different
--   room/area formatting, and the pair is silently dropped from candidate
--   sets or fails the hard gates inside compareListings.
--
-- This migration prepares the listings table for a perceptual-hash (pHash)
-- based cross-provider dedupe. A separate worker (agent A6) computes a
-- 64-bit pHash for each listing's primary photo (listing_images.position=0)
-- and stores it in listings.photo_phash as 16-char lowercase hex. Two
-- listings whose pHashes agree (exact match, or within a small Hamming
-- distance) are almost certainly the same photo, regardless of which portal
-- hosts the bytes — closing the cross-provider blind spot.
--
-- Type note (deviation from task spec):
--   The task spec asked for `duplicate_of_id BIGINT NULL REFERENCES
--   listings(id)`. We use UUID here because `listings.id` is UUID (see
--   schema.sql). Postgres will reject a BIGINT FK pointing at a UUID PK at
--   apply time. Migrating listings.id to BIGINT would cascade through
--   ~8 FK tables (listing_images, listing_conveniences, cron_run_listings,
--   saved_listings, share_tokens, listing_duplicates.id_a/id_b,
--   telegram_sent, plus this new column) — out of scope for this audit.
--   See findings/B7-dedupe-audit.md for the full write-up.

-- 1. Photo perceptual hash (16-char lowercase hex == 64 bits).
--    NULL until the phash worker (agent A6) backfills it.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS photo_phash TEXT;

-- 2. Cross-provider duplicate back-reference. If this listing is a
--    duplicate of another (the "kept" / canonical listing), this column
--    points to it. NULL = canonical (or not yet checked). ON DELETE SET
--    NULL so deleting the canonical row doesn't wipe the duplicate — the
--    duplicate simply becomes "unclaimed" and is eligible for re-dedup
--    on the next scan.
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS duplicate_of_id UUID
  REFERENCES listings(id) ON DELETE SET NULL;

-- 3. Which provider flagged the duplicate relationship? E.g. an Otodom
--    listing whose pHash matches an OLX listing gets
--    duplicate_source = 'olx' (meaning "this Otodom row is a dup of an
--    OLX row"). Drives the UI badge ("also listed on OLX") and lets us
--    pick the canonical row deterministically (OLX wins per SOURCE_PRIO
--    in dedupe.js). NULL when duplicate_of_id is NULL.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS duplicate_source TEXT;

-- 4. Fast pHash lookup. The dedupe service uses this index for the cheap
--    exact-match pass; near-miss (small Hamming distance) is handled by
--    a prefix bucket scan plus JS-side bit-counting. Partial index keeps
--    it small — only listings that have actually been hashed.
CREATE INDEX IF NOT EXISTS idx_listings_photo_phash
  ON listings(photo_phash)
  WHERE photo_phash IS NOT NULL;

-- 5. Inverse lookup: "show me everything flagged as a duplicate of X".
--    Powers the duplicates admin UI without walking union-find every time.
CREATE INDEX IF NOT EXISTS idx_listings_duplicate_of
  ON listings(duplicate_of_id)
  WHERE duplicate_of_id IS NOT NULL;
