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
PWA files of the build (v1.5): `/sw.js` and `/manifest.webmanifest` are sent with `Cache-Control: no-cache`
(`sw.js` also with `Service-Worker-Allowed: /` and `text/javascript`, the manifest as `application/manifest+json`),
`/offline.html` like any other static page (`no-cache`); the CSP adds `worker-src 'self'; manifest-src 'self'`.
`GET /sitemap.xml` and `GET /robots.txt` (absolute URLs from `APP_URL`) are
served even without a built client. The sitemap is cached until the catalog
changes; above 50,000 URLs `/sitemap.xml` becomes a sitemap index of
`/sitemap-1.xml`, `/sitemap-2.xml`, … (≤ 50,000 URLs each).

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Start the API (`src/index.js`). |
| `npm run dev` | Same, with `node --watch`. |
| `npm test` | All tests (`node --test`): classifier, auth, sessions, admin, ratings, catalog, search, pagination/seasons, SEO/sitemap, GDPR, headers, trash, admin board, thumbnails, PWA files. In-memory DB, fake YouTube lookups and thumbnails (nothing reaches youtube.com / ytimg.com), a temporary thumbnail cache per server, a temporary fake `client/dist` (`createApp({ config: { clientDist } })`). |
| `npm run make-admin -- someone@example.com` | Promote an existing account to admin. |
| `node src/scripts/bench-admin-lists.js [50000]` | Times the paginated admin lists, `/api/latest` and `/api/search` over HTTP on a throwaway database with that many videos (1% of them and 10 series in the trash; p50/p95). |

## Environment

See [`.env.example`](.env.example) — each variable is documented there.
`DATABASE_FILE`, `CLIENT_DIST` and `THUMB_CACHE_DIR` are resolved relative to `server/` and `.env` is read from
`server/.env`, whatever directory you start the process from.

## Layout

- `src/app.js` — `createApp({ db, config, mailer, fetchVideoInfo, fetchThumbnail })`, no `listen` (tests use it).
- `src/index.js` — loads `.env`, opens the DB, starts background jobs, listens.
- `src/routes/` — `auth`, `me`, `catalog`, `ratings`, `admin`, `dev`, `thumbs`.
- `src/thumbnails.js` — same-origin thumbnails (below): the upstream fetch and the on-disk LRU cache.
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
  admin list indexes, 10 session epochs, 11 `series_version` (keys the classifier's pre-normalised catalog),
  12 `video_rating_stats` + triggers (per-video rating count/sum for every video list and `/api/top-rated`),
  13 the trash (below).
  `catalog_version` keys the in-memory genre and sitemap caches.); `src/retention.js` — cleanup and YouTube health-check jobs.
- Trash (v1.4, `src/trashService.js`, migration 13): `DELETE /api/admin/{series,videos}/:id` set `deleted_at`; a series
  takes its live videos with it (same `deleted_at`, `trashed_with_series = 1`), so `videos.deleted_at` alone says
  whether a video is visible. Every live query filters `deleted_at IS NULL` (public reads, sitemap, SEO, genres,
  admin lists, the classifier's catalog, re-classification, the health check); `getVideo`/`getSeries*` are live-only,
  `getAnyVideo`/`getAnySeriesById` include the trash. Aggregates treat trashed rows as absent: `series_stats` covers
  live videos of live series (stats triggers skip a non-live series; a series trash/restore rebuilds its rows once),
  `rating_totals` counts ratings of live videos only (trash/restore moves a video's ratings out/in; a hard delete
  of a live video takes them out in a `BEFORE DELETE` trigger, since FK cascades run after the parent row is gone);
  `video_rating_stats`/`rating_activity` stay per video and are filtered by the lists. The published-slot unique
  index ignores trashed videos; restoring a video re-checks its slot (taken → `pending` + reason) and refuses
  (409) while its series is trashed; restoring a series restores the videos trashed with it, then re-classifies
  pending videos. A trashed slug stays reserved (409). `GET /api/admin/trash`: a series' `videoCount` is every video
  its delete-forever removes (videos trashed on their own before it are counted there and also listed). Purge: `purgeTrash()` in the hourly retention job deletes
  what was trashed ≥ 7 days ago (ratings cascade) and checkpoints the WAL, like delete-forever.
  Partial indexes `WHERE deleted_at IS NULL` replace the list indexes; the two admin-list indexes also carry
  `deleted_at` because SQLite only treats `col = const` partial-index terms as covered (without it the counts
  scan the table). The unfiltered admin count is `COUNT(*) − trashed` (btree count, no row visits).
- Admin board (v1.4): `GET /api/admin/series/:id` (per section: seasons + live published videos by season, number);
  `PUT /api/admin/series/:id/order`, in one synchronous transaction: `expected` (the order the client loaded) must
  equal the season's current order, else 409 with `details.current` (two saves from one board: one 200, one 409);
  `videoIds` must be exactly that season's set (400); then it renumbers 1..n (changing videos go through `-n`
  first so the unique slot index never collides) and pins each number as `overrides.number`; `GET /api/admin/videos/:id/preview` returns any non-purged video (pending/trashed too).

## Same-origin thumbnails (v1.5, `src/thumbnails.js`, `src/routes/thumbs.js`)

`Video.thumbnailUrl` is `/api/thumbs/<youtubeVideoId>.jpg` (absolute, `APP_URL` + that path, in `og:image` and
the JSON-LD `thumbnailUrl`), so a visitor's browser never contacts Google before pressing Play.
`GET /api/thumbs/:id.jpg`:
1. The file name must be exactly `<11 × [A-Za-z0-9_-]>.jpg`, and a **live** video (published or pending, not in
   the trash) must have that YouTube ID; anything else is **404** before anything goes upstream (never an open proxy).
2. Cache hit (`THUMB_CACHE_DIR/<id>.jpg`): served from disk. Otherwise one upstream `GET
   https://i.ytimg.com/vi/<id>/hqdefault.jpg` (injectable `fetchThumbnail(id)`; default `fetchYoutubeThumbnail`):
   5 s timeout (`AbortSignal.timeout`, body included), redirects refused, it must be `200` + `image/jpeg` + JPEG
   bytes + ≤ 512 KB (a larger `Content-Length` is refused at once, a stream is cancelled once it passes 512 KB).
   Anything else is **502 `UPSTREAM_ERROR`**, nothing cached, nothing logged (the client shows its placeholder).
3. Concurrent requests for one ID share one upstream fetch (single-flight); at most 4 upstream fetches run at
   once, up to 256 more wait their turn (beyond that: 502 at once), so a burst of IDs never hammers Google.
4. The file is written to `<id>.<random>.tmp` and renamed (atomic); just before the rename the video must
   still exist, so a video purged mid-download leaves nothing behind. An in-memory index (size, recency) keeps
   the files under `THUMB_CACHE_MB` (default 200; least recently served evicted first; `0` = no disk cache).
   At the first use the directory is scanned (oldest write first), leftover `.tmp` files are deleted, files
   not named like a thumbnail are never touched.
5. Headers: `Cache-Control: public, max-age=604800, immutable`, `Content-Type: image/jpeg`,
   `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`. The route sits before the
   session loader (no cookie lookup, never a `Set-Cookie`). Errors are `private, no-store` JSON.
6. Tests only: `THUMB_UPSTREAM` (a base URL) replaces `https://i.ytimg.com` outside production, e.g. a local
   fake for end-to-end runs; same checks. With `NODE_ENV=production` the server refuses to start while it
   is set (`assertSafeConfig`), and `createApp` ignores it there anyway (`thumbnailUpstream()` in `src/config.js`).
7. Removal: delete-forever (a video, or a series with all its videos) and the 7-day trash purge delete the
   files of those videos; the hourly retention run then also deletes cached files no video uses any more
   (an upload an admin swapped out, a crash between purge and delete). A video in the trash keeps its file
   (restoring it brings it back) but is 404 while trashed.

## Data we store and why

| Table | Personal data | Why | Kept until |
|---|---|---|---|
| `users` | e-mail, display name, scrypt password hash, privacy-consent time | login, show your name, prove consent | account deleted; **unverified accounts are deleted after 7 days** |
| `sessions` | SHA-256 of the session token, user id, expiry, epoch | stay logged in | 30-day expiry, purged hourly; at most 20 per user (a login drops the oldest) |
| `email_tokens` | SHA-256 of the token, user id, purpose (`verify`/`reset`), expiry | confirm e-mail, reset password | used, or expired (24 h / 1 h), purged hourly |
| `ratings` | user id, video id, score, reaction | the rating feature | account deleted, or 7 days after its video went to the trash |
| `rating_activity` | **not personal data**: per-video, per-day counts, no user id | "trending" | 30 days |

Never stored: IP addresses (the rate limiter keeps them, IPv6 by /64, in a
capped in-memory map for 15 minutes), user agents, analytics, the e-mail language choice. The thumbnail cache
holds public images keyed by the public YouTube ID only; thumbnail requests are not logged. Nothing logs
e-mail addresses or passwords. The only cookie is the essential `sid`
(httpOnly, SameSite=Lax, Secure in production). Users can export their data
(`GET /api/me/export`) and delete their account (`DELETE /api/me`).

## CSRF and request hygiene (`src/middleware/security.js`, `src/app.js`)

On every `POST`/`PUT`/`PATCH`/`DELETE` under `/api`, in this order:
1. A body must be `application/json`, else **415** (a cross-site `<form>` cannot send JSON).
2. `requireSameOrigin`: allowed when `Sec-Fetch-Site` is `same-origin` or `none`, or when `Origin` is a
   trusted origin (the `APP_URL` origin or any `CLIENT_ORIGIN`, compared exactly). Otherwise, if
   `Sec-Fetch-Site` or `Origin` is present, **403 `CROSS_SITE_REQUEST`**. Requests with neither header
   (curl, server-to-server, tests) are allowed. The client always calls a relative `/api`, so through the Vite
   dev/preview proxy or when this server serves it, its requests are same-origin.

`/api/auth/logout` and `/logout-all` send a cookie-clearing `Set-Cookie` only when the request carried a
`sid` cookie (valid or not). A malformed `%`-escape in a route parameter is **400 `VALIDATION_ERROR`**
(`details.url`); any other 4xx error from Express or a middleware keeps its status; neither is logged.
E-mail addresses with control characters (`\p{Cc}`: NUL, ESC, DEL, C1) are refused like other invalid ones.

## Background jobs (in-process, unref'd timers)

- Retention: at startup and hourly — purge expired sessions/tokens, unverified
  accounts older than 7 days, rating activity older than 30 days, series/videos trashed 7 days ago (with ratings
  and cached thumbnails), then cached thumbnails no video uses any more.
- YouTube health check: hourly ticks re-check videos not checked in 24 h via
  oEmbed; 401/403/404 marks a video `unavailable` (hidden from latest/top-rated/
  trending/random). Admins can also run it with `POST /api/admin/videos/health-check`. Runs are single-flight:
  a request (or tick) while one is going waits for that run and gets its result.

## Concurrency rules (auth and catalog)

- Each session stores its user's `session_epoch`; password change/reset and logout-all bump it, so every
  older session (including one a login still in flight is about to create) is invalid.
- Login re-reads the account after scrypt: deleted, or password changed/reset meanwhile → 401
  `INVALID_CREDENTIALS` (never a session, never a 500). The upgrade-rehash only replaces the hash it verified.
- Series POST/PATCH re-classify only pending videos whose title contains an old or new name/alias (or whose
  override names the old/new slug), in one transaction; a synopsis/genre/cover edit re-classifies nothing.
