-- migration_013: bezposrednio.net.pl source (Task D-bezposrednio-7)
-- bezposrednio.net.pl — Polish direct-from-owner ("bez pośredników") real-
-- estate portal with a small but distinct Warszawa wynajem inventory
-- (~57 listings total — sum of all district sub-pages). Site is independent
-- (not part of the Morizon/Gratka/Agora oligopoly) and 100% of listings are
-- direct-from-owner by design — the portal's USP is "no agency fees".
-- High cross-source dedupe overlap expected with olx/otodom direct-from-
-- owner listings + the other long-tail Polish portals (odwlasciciela.pl,
-- sprzedajemy.pl, tabelaofert.pl `?klient_typ=osoba_prywatna` subset) —
-- caught by services/dedupe.js via geo + area + rooms fingerprint.
--
-- Search URL: https://bezposrednio.net.pl/mieszkania_wynajem,<city>,c<code>
--   warszawa=c68551, krakow=c50807, wroclaw=c42271, gdansk=c31024,
--   poznan=c71899. Pagination via ?page=N (the small inventory rarely
--   spills past page 1 — the walk exits after the first empty page).
-- Detail URL: https://bezposrednio.net.pl/<slug>-do_wynajecia-t-<code>.html
--   the 3-char trailing code (e.g. "ZFd", "Z7s") is the stable externalId.
--   Sale listings end with -sprzedam-t-<code>.html and are skipped.
--
-- Source id 14 — slot reserved by the orchestrator for parallel D-chunk
-- scrapers (alongside slot 11 and slot 13 — see migration_014_okolica.sql
-- note). Migration_013 → source_id 14 to keep the migration sequence
-- monotonic with the source id (slots 11 and 13 are intentionally unused).

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (14, 'Bezposrednio', 'bezposrednio', '#0A8D71', 'https://bezposrednio.net.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
