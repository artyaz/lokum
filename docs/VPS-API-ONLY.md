# VPS as API + fetch/cron host (UI removed)

Target state: the VPS runs **only** the JSON API, the Playwright fetch
pipeline, and cron. The UI lives on Vercel (see `VERCEL.md`).

## Fetch performance profile (current, honest notes)

- Scrapers already persist **streaming** (`onListing`) where supported, so
  peak memory is roughly flat vs. page depth; the rest accumulate one
  source/city page in RAM.
- HTTP keep-alive is pooled (undici, 6 conns/host); the pg pool is capped
  at 5 with a 5 s idle timeout so sockets drain between cycles.
- The Playwright singleton idle-closes (30 s, 5 s in oneshot) and AI runs
  batched (≤5 listings/call) with regex/heuristic fallbacks, so a dead AI
  backend degrades instead of blocking.
- Node heap is capped at 2 GB (`npm start`); observed steady state is
  ~0.5 GB RSS. Chromium is the dominant cost during fetch cycles and is
  unavoidable while sources require JS rendering.
- **Zero-idle option**: cron already supports oneshot mode
  (`npm run cron:oneshot` → `LOKUM_ONESHOT=1 node src/run_cron.js` exits
  after due jobs; OS reclaims everything). For ~zero idle RAM/CPU between
  cycles: system crontab every 5 min + `LOKUM_ALWAYS_ON=0` on the API
  server (disables the sub-minute watcher + its persistent Chromium).
- **On a Rust rewrite**: the fetchers are Playwright/Chromium scrapers
  with per-site DOM extractors (20 sources). Moving to Rust means
  re-implementing browser automation (e.g. chromiumoxide) plus all 20
  extractors — a multi-week rewrite, not an optimization pass. The honest
  recommendation is to keep Node for fetching (I/O-bound, already
  streaming) and only consider Rust if a CPU-bound hotspot is ever
  profiled (none is known today).

## Cutover checklist (ONLY after the Vercel UI is verified live)

1. Vercel project deployed and logging in against the VPS API
   (`VITE_API_URL`, `CORS_ORIGIN`, `COOKIE_SAMESITE=none` per `VERCEL.md`).
2. On the VPS, in `/opt/lokum/backend/.env`:
   ```sh
   SERVE_FRONTEND=0
   LOKUM_ALWAYS_ON=0   # optional: ~zero idle (keep 1 for sub-minute watcher)
   ```
   Restart the backend (`npm start` or the process manager in use).
   Non-API routes now return `404 {error: frontend_disabled}`.
3. Confirm: `curl https://flats.chmyl.com/api/health` → `{"ok":true,...}`;
   `curl https://flats.chmyl.com/` → `frontend_disabled`.
4. Only then remove the frontend artefacts from the VPS (they remain in
   git history + GitHub, nothing is lost):
   ```sh
   rm -rf /opt/lokum/frontend/dist /opt/lokum/frontend/node_modules
   ```
   Keep `/opt/lokum/frontend/src` (or delete the whole dir — GitHub is
   the source of truth now).
5. Cron stays on the backend: user cron jobs fire inside the API process
   via node-cron, or via the oneshot system crontab
   (`*/5 * * * * cd /opt/lokum/backend && LOKUM_ONESHOT=1 node src/run_cron.js`).
   Both paths run `runFetchCycle`, including the AI backlog, metro,
   and aesthetic passes.
