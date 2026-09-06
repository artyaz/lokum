-- migration_006: Nieruchomosci-online.pl source (Task D1)
-- Biggest single Warsaw rental source we were missing (127k listings,
-- JSON-LD on detail pages with GPS coords, no Playwright needed).

INSERT INTO sources (id, name, slug, color, base_url) VALUES
  (8, 'Nieruchomosci-online', 'nieruchomosci-online', '#2D7A3E', 'https://www.nieruchomosci-online.pl')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  color = EXCLUDED.color,
  base_url = EXCLUDED.base_url;
