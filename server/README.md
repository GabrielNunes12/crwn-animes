# Crwn Animes — API server

Express 5 + SQLite (better-sqlite3). Implements [`docs/API.md`](../docs/API.md).
Node ≥ 20.

## Run

```sh
cd server
npm install
cp .env.example .env      # optional; every setting has a default
npm run dev               # http://localhost:4000, restarts on change
```

In development no SMTP server is needed: e-mails go to an in-memory outbox
(`GET /api/dev/outbox`) and verification/reset links are printed to the console.
With `NODE_ENV=production` the server refuses to start without `SMTP_HOST`, or
without an `https://` `APP_URL`.
In production, if `../client/dist/index.html` (or `$CLIENT_DIST/index.html`) exists the server also serves the
built React app and falls back to `index.html` for client-side routes. That
fallback is server-rendered for crawlers and link previews (`src/seo.js`): the
static `<title>` is replaced by the page's title, description, canonical URL,
Open Graph/Twitter tags and JSON-LD, read from the database (every value
HTML-escaped; JSON-LD escapes `<` as `\u003c`). Unknown series/episodes answer
**404** with the SPA shell, non-canonical watch URLs (`/episode/01`,
`/season/1/episode/2`) **301** to the canonical route, and account/admin/search
pages carry `noindex`; `/index.html` redirects to `/`. The template is cached
and re-read when its mtime changes (checked at most every 5 s in production).
`GET /sitemap.xml` and `GET /robots.txt` (absolute URLs from `APP_URL`) are
served even without a built client. The sitemap is cached until the catalog
changes; above 50,000 URLs `/sitemap.xml` becomes a sitemap index of
`/sitemap-1.xml`, `/sitemap-2.xml`, … (≤ 50,000 URLs each).

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Start the API (`src/index.js`). |
| `npm run dev` | Same, with `node --watch`. |
| `npm test` | All tests (`node --test`): classifier, auth, sessions, admin, ratings, catalog, search, pagination/seasons, SEO/sitemap, GDPR, headers. In-memory DB, fake YouTube lookups, a temporary fake `client/dist` (`createApp({ config: { clientDist } })`). |
| `npm run make-admin -- someone@example.com` | Promote an existing account to admin. |
| `node src/scripts/bench-admin-lists.js [50000]` | Times the paginated admin lists and `/api/latest` over HTTP on a throwaway database with that many videos (p50/p95). |

## Environment

See [`.env.example`](.env.example) — each variable is documented there.
`DATABASE_FILE` is resolved relative to `server/` and `.env` is read from
`server/.env`, whatever directory you start the process from.

## Layout

- `src/app.js` — `createApp({ db, config, mailer, fetchVideoInfo })`, no `listen` (tests use it).
- `src/index.js` — loads `.env`, opens the DB, starts background jobs, listens.
- `src/routes/` — `auth`, `me`, `catalog`, `ratings`, `admin`, `dev`.
- `src/*Service.js` — auth, ratings, videos; `src/mail.js` — e-mails (pt-BR + en).
- `src/classifier.js` — works out section/series/season/number from a YouTube title.
- `src/search.js` — `series.search_text` (`|name|alias|…|`, each through `searchNormalize()`: no accents or case,
  letters/digits of every script kept), kept up to date by the repository on create/patch; `GET /api/search` and
  `GET /api/:section/series?q=` match it with `instr()`. Counts, newest `publishedAt` and ratings per (series, section)
  come from `series_stats`, which SQLite triggers keep current (no per-request aggregation).
- Paging (v1.3): `/api/latest?offset=&section=`, `GET /api/admin/series` and `GET /api/admin/videos` answer
  `{ items, total }` (`limit` 1–100, default 50). Order is stable with an id tiebreak (series: name, id; videos:
  `created_at` desc, id desc). Admin series `q` = the `/api/search` matching; admin videos `q` matches
  `videos.title_search` (title through `searchNormalize()`, set on insert) or a series whose normalised name contains
  it (names cached until the catalog changes). Each video filter combination has its own prepared statement so the
  `videos_created` / `videos_status_created` indexes serve order, filters and count (p95 ≤ ~17 ms at 50k videos).
  Query parameters go through `queryReader()` (`src/validation.js`): one 400 listing every bad field.
- Series pages: `GET /api/:section/series/:slug?season=N` → `{ series, videos, seasons }` (`seasons` = seasons with
  published videos there, `[]` when none; unknown season → empty `videos`; not 1–99 → 400).
- `src/genres.js` — one stored spelling per genre (first one used wins; compared with `toLocaleLowerCase("pt-BR")`).
  `/api/genres`, genre pages and the sitemap list genres of series with a published, available video.
- `src/seo.js` — page resolution (200/301/404) + `<head>` rendering, sitemap and robots.txt.
- `src/db.js` — schema + migrations (`PRAGMA user_version`; an entry is SQL or a JS function: 4–5 `search_text`, 6 genre spellings, 7 manga chapters
  are always season 1, 8 `series_stats` / `rating_totals` / `catalog_version` + triggers, 9 `videos.title_search` +
  admin list indexes. `catalog_version` keys the
  in-memory genre and sitemap caches.); `src/retention.js` — cleanup and YouTube health-check jobs.

## Data we store and why

| Table | Personal data | Why | Kept until |
|---|---|---|---|
| `users` | e-mail, display name, scrypt password hash, privacy-consent time | login, show your name, prove consent | account deleted; **unverified accounts are deleted after 7 days** |
| `sessions` | SHA-256 of the session token, user id, expiry | stay logged in | 30-day expiry, purged hourly |
| `email_tokens` | SHA-256 of the token, user id, purpose (`verify`/`reset`), expiry | confirm e-mail, reset password | used, or expired (24 h / 1 h), purged hourly |
| `ratings` | user id, video id, score, reaction | the rating feature | account deleted |
| `rating_activity` | **not personal data**: per-video, per-day counts, no user id | "trending" | 30 days |

Never stored: IP addresses (the rate limiter keeps them, IPv6 by /64, in a
capped in-memory map for 15 minutes), user agents, analytics, the e-mail language choice. Nothing logs
e-mail addresses or passwords. The only cookie is the essential `sid`
(httpOnly, SameSite=Lax, Secure in production). Users can export their data
(`GET /api/me/export`) and delete their account (`DELETE /api/me`).

## Background jobs (in-process, unref'd timers)

- Retention: at startup and hourly — purge expired sessions/tokens, unverified
  accounts older than 7 days, rating activity older than 30 days.
- YouTube health check: hourly ticks re-check videos not checked in 24 h via
  oEmbed; 401/403/404 marks a video `unavailable` (hidden from latest/top-rated/
  trending/random). Admins can also run it with `POST /api/admin/videos/health-check`.
