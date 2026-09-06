# Lokum UI on Vercel (split deploy)

The UI is a hash-routed Svelte SPA, so Vercel needs no rewrite config —
any route serves `index.html` and the `#/...` hash does the rest.

## Deploy steps

1. Vercel → Add New Project → import `artyaz/lokum`.
2. Root Directory: `./` (the repo root — do NOT set it to `frontend`).
   The root `vercel.json` already points install/build/output at
   `frontend/`, and `.vercelignore` keeps the backend off Vercel, so the
   backend is never installed, built, uploaded, or run there.
   (If you insist on Root Directory `frontend`, you must also override
   the three Build settings to frontend-relative values —
   install `npm ci --ignore-scripts --no-audit --no-fund`, build
   `npm run build`, output `dist` — because the root `vercel.json`
   commands assume the repo root as working directory.)
3. Environment variable (Production + Preview):
   - `VITE_API_URL=https://flats.chmyl.com` (the public VPS API origin)
4. Deploy. Note the `https://<project>.vercel.app` URL.

## Backend changes required (VPS)

In `/opt/lokum/backend/.env`:

```sh
CORS_ORIGIN=https://flats.chmyl.com,https://<project>.vercel.app
COOKIE_SAMESITE=none
```

(`SameSite=None` is what lets the browser send the session cookie
cross-site; browsers reject it without HTTPS, and the API is HTTPS-only
behind nginx, so `COOKIE_SECURE` stays `1`.)

Restart the backend afterwards.

## Known limitations

- **Passkeys** are bound to the site's domain (RP ID). Existing passkey
  credentials registered on `flats.chmyl.com` will NOT work on the Vercel
  domain — users sign in with email+password there and (optionally)
  register fresh passkeys. Password + session auth works cross-origin
  via the settings above.
- The Telegram share-page OG route (`/s/:token`) stays on the VPS API
  origin; pasting a Vercel listing URL into Telegram unfurls from the
  Vercel page (no OG photo) — share links should keep pointing at the API
  origin's `/s/` URLs until the UI adds its own meta tags.
