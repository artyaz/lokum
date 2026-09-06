# Security policy

- **Secrets live only in environment / local `.env` files.** `backend/.env`
  (and any `*.cookies.json`, `*-credentials` files) are git-ignored —
  see `.gitignore`. Never commit them, never paste them into issues.
- **`backend/.env.example` holds placeholders only.** Placeholders must
  stay pattern-free (no `sk-…`, key-like, or base64-looking values) so
  secret scanners don't fire on them.
- **Test fixtures must not contain real credentials, cookies, or session
  tokens.** Use obviously-fake values (`example.com`, `1000000001`).
- **If a real secret reaches GitHub** (pushed `.env`, hardcoded key):
  1. Rotate/revoke it at the provider immediately (it is compromised the
     moment it is pushed, even if removed seconds later).
  2. Purge it from history (`git filter-repo` or a fresh squashed import),
     force-push, and confirm the scanner alert is resolved.
- **Vercel env vars** (`VITE_API_URL`, preview/production) are set in the
  Vercel dashboard, never in this repo.
