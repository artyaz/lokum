# Lokum UI on Vercel (split deploy)

The UI is a hash-routed Svelte SPA, so Vercel needs no rewrite config —
any route serves `index.html` and the `#/...` hash does the rest.

## Deploy steps

1. Vercel → Add New Project → import `artyaz/lokum`.
2. Root Directory: `frontend` (preferred). Framework preset: Vite. Build
   command and output use the defaults (`npm run build` → `dist`).
   Importing the repo root works too — root `vercel.json` + `.vercelignore`
   pin the build to `frontend/` only, so the backend is never installed,
   built, uploaded, or run on Vercel.
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
