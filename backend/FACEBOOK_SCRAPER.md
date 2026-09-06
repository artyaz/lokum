# Facebook group scraping

Lokum uses [`kevinzg/facebook-scraper`](https://github.com/kevinzg/facebook-scraper)
0.2.59 through a small Python JSON-lines bridge. All 365 unique Warsaw groups
from **Warsaw_Rental_Facebook_Groups_Complete_Directory.docx** are stored in
`data/facebook_groups.json` and seeded by `src/sql/migration_005_facebook.sql`.
Fifteen Tier-1 groups are marked essential.

## Setup

```bash
npm run setup:facebook
```

This creates `backend/.scraper-venv` and installs `requirements.facebook.txt`.
The Node adapter automatically uses that interpreter.

Facebook normally requires an authenticated session for group pages. There are
two supported ways to hook cookies:

### 1. In-app cookie vault (recommended)

Log into Lokum, open **Settings → Facebook scraping**, and upload/paste a
Facebook cookies export containing both `c_user` and `xs`. The payload is
encrypted with AES-256-GCM and injected into the scraper automatically on every
fetch. No Facebook password is collected or stored. Set `ADMIN_EMAILS` to lock
replacement after initial setup; otherwise the cookie creator can replace their
session.

### 2. Environment file fallback

Set:

```bash
FACEBOOK_COOKIES=/opt/lokum/backend/facebook.cookies.json
```

The bridge also accepts `FACEBOOK_EMAIL` and `FACEBOOK_PASSWORD`, but cookies are
strongly preferred because they avoid Facebook's interactive 2FA/checkpoint flow.
Never commit a cookie file.

For cookie-vault encryption, set a random 32+ character `FACEBOOK_COOKIE_KEY` in
`backend/.env`. If omitted, the app derives a key from `DATABASE_URL`, but a
dedicated key is preferable.

## Fetching

The Facebook source has database id `7`. A normal cycle selects enabled groups
with this ordering: essential first, then Tier, confidence, and name.

Defaults are deliberately conservative:

- `FACEBOOK_MAX_TIER=1` — fetch Tier 1 only
- `FACEBOOK_GROUP_LIMIT=15` — the 15 essential/high-confidence groups
- `FACEBOOK_PAGES=3`
- `FACEBOOK_POSTS_PER_PAGE=25`
- `FACEBOOK_MAX_POSTS_PER_GROUP=75` (defaults to pages × posts-per-page; `0` disables the cap)
- `FACEBOOK_GROUP_DELAY_MS=750`
- `FACEBOOK_REQUEST_TIMEOUT=30`
- `FACEBOOK_BRIDGE_TIMEOUT=900`

To fetch the entire DOCX directory:

```bash
FACEBOOK_MAX_TIER=3 FACEBOOK_GROUP_LIMIT=0 \
  node src/run_scrape.js 7 --cities 1
```

Use `FACEBOOK_STOP_AT_SINCE=1` to pass the previous successful run timestamp to
the upstream library's `latest_date` stop condition. It is off by default because
many Facebook group posts do not expose a timestamp.

Posts are filtered conservatively for rental language and normalized into Lokum's
price, rooms, area, floor, district, image, URL, and source metadata fields.
Per-group success/error information is retained in `facebook_groups`.

The bridge is streaming and backpressured: each sanitized post is normalized and
persisted before Python fetches further output. This keeps memory roughly flat
even for a full 365-group run.

Anonymous scraping is disabled by default (`FACEBOOK_REQUIRE_AUTH=1`) because
Facebook currently serves either a login wall or an "Unsupported Browser" page to
the scraper. Set `FACEBOOK_REQUIRE_AUTH=0` to attempt it anyway. `FACEBOOK_BASE_URL`
can override the default `https://mbasic.facebook.com`.
