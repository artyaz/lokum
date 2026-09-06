# Lokum — rental aggregator (Warsaw + more)

Two modules, one repo:

| Module | What | Where it runs |
|---|---|---|
| `frontend/` | Svelte + Vite SPA (feed, cards, map, auth UI) | **Vercel** |
| `backend/` | Node + Express + Postgres + Playwright fetch pipeline, cron, AI rewrites/pricing, metro + aesthetic passes | **VPS** (fetch + cron + JSON API) |

The backend never runs on Vercel: `vercel.json` + `.vercelignore` at the
repo root pin any Vercel build to `frontend/` only, and the backend has no
serverless entry point (it needs Postgres, Chromium, and long-lived cron).

## Run together locally (as before)

```sh
npm run install:all        # install backend + frontend deps
npm run build:frontend     # build the UI into frontend/dist
npm run start:backend      # API on :9120, serves frontend/dist too (SERVE_FRONTEND=1)
```

Copy `backend/.env.example` to `backend/.env` and fill in real values
(`DATABASE_URL` at minimum; every variable is documented in that file).
With `FAKE_DB=1` the backend runs against in-memory sample data — no
database needed for UI work.

## Split deploy (UI on Vercel, API + fetch on VPS)

1. Vercel project with **Root Directory = `frontend`** (preferred), or
   import the repo root — `vercel.json` falls back to building `frontend/`
   only either way. Set `VITE_API_URL` to the public API origin.
2. Backend + cron stay on the VPS. Full steps: `docs/VERCEL.md`,
   then the API-only cutover: `docs/VPS-API-ONLY.md`.

## Tests

```sh
npm run test:backend   # pure-logic tests (price heuristic, metro, aesthetic)
```

Scraper tests live in `backend/test/scrapers/` and run against captured
fixtures (see file headers). UI smoke tests: `backend/scripts/ui-*.cjs`
need a running server.

## Secrets

Never commit `.env` files, cookie exports, or provider keys — see
`SECURITY.md`. `backend/.env.example` contains only pattern-free
placeholders.
