# Crwn Animes — API contract

This is the single source of truth shared by `server/` (Express) and `client/` (React).
If something here is wrong or missing, change this file first, then both sides.

- Base path: `/api`. JSON in, JSON out. Dev: the server listens on `:4000`, the Vite dev
  server (`:5173`) proxies `/api` to it, so the browser sees one origin.
- Auth: an **httpOnly** session cookie named `sid` (`SameSite=Lax`, `Secure` in production,
  `Path=/`, 30 days). The client never reads it; it just sends `credentials: "include"`.
- Every request with a body must be `Content-Type: application/json` (the server rejects
  others with 415 — this is part of the CSRF defence together with `SameSite=Lax`).
- Every POST/PUT/PATCH/DELETE under `/api` must come from our own origin: it is allowed when
  `Sec-Fetch-Site` is `same-origin` or `none`, or when `Origin` equals the `APP_URL` origin or a
  configured `CLIENT_ORIGIN`; otherwise, if either header is present, it gets `403 CROSS_SITE_REQUEST`.
  Requests with neither header (curl, server-to-server) are allowed. Logout routes only send a
  cookie-clearing `Set-Cookie` when the request actually carried a `sid` cookie.
- Malformed `%`-escapes in a path give `400 VALIDATION_ERROR` (never 500), and e-mail addresses
  containing control characters are rejected with `400`.
- Errors always look like:
  ```json
  { "error": { "code": "SOME_CODE", "message": "Human readable text", "details": {} } }
  ```
  Common codes: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `INVALID_CREDENTIALS` (401),
  `EMAIL_NOT_VERIFIED` (403), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409),
  `UNSUPPORTED_MEDIA_TYPE` (415), `UNPROCESSABLE` (422), `RATE_LIMITED` (429), `UPSTREAM_ERROR` (502).

## Data shapes

```ts
type Section = "anime" | "manga";
type Role = "user" | "admin";
type ReactionKey = "fire" | "laugh" | "cry" | "wow" | "love"; // 🔥 😂 😭 😮 ❤️

type User = { id: number; email: string; displayName: string; role: Role; createdAt: string };

type Series = {
  id: number; slug: string; name: string; synopsis: string | null;
  aliases: string[]; genres: string[]; coverUrl: string | null;
};
// In section listings a series also has:
type SeriesListItem = Series & { videoCount: number; route: string; rating: RatingAverage };

type Video = {
  id: number; youtubeVideoId: string; title: string; channel: string | null;
  thumbnailUrl: string;                 // https://i.ytimg.com/vi/<id>/hqdefault.jpg
  section: Section | null; seriesId: number | null; seriesSlug: string | null;
  seriesName: string | null; season: number; number: number | null;
  status: "published" | "pending";
  route: string | null;                 // front-end path, null while pending
  rating: RatingAverage;
  // admin-only fields (present only in /api/admin/* responses):
  classification?: { scores: { anime: number; manga: number }; reasons: string[]; suggestedNumber: number | null };
  overrides?: { section?: Section; seriesSlug?: string; season?: number; number?: number };
  createdAt: string; updatedAt: string;
};

type RatingAverage = { average: number | null; count: number }; // average rounded to 1 decimal
type RatingSummary = RatingAverage & {
  distribution: { "1": number; "2": number; "3": number; "4": number; "5": number };
  reactions: Record<ReactionKey, number>;
  mine: { score: number; reaction: ReactionKey | null } | null; // null when logged out / not rated
};
```

### Front-end routes (the server builds `route` values with these)

| Page | Path |
|---|---|
| Section | `/anime`, `/manga` (optional `?genre=Shonen`) |
| Series | `/anime/:slug`, `/manga/:slug` |
| Anime episode, season 1 | `/anime/:slug/episode/:number` |
| Anime episode, season ≥ 2 | `/anime/:slug/season/:season/episode/:number` |
| Manga chapter | `/manga/:slug/chapter/:number` |

## Auth

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `POST /api/auth/register` | `{ email, password, displayName, acceptPrivacy: true }` | `201 { message }` | password ≥ 10 chars; displayName 2–30 chars; `acceptPrivacy` must be `true`. Sends a verification email. **Same 201 if the email already exists** (no account enumeration; the existing owner gets a "someone tried to register" email instead). |
| `POST /api/auth/verify-email` | `{ token, password }` | `200 { user }` + sets `sid` | Token is single-use, valid 24 h. Invalid/expired → 400 `INVALID_TOKEN`. `password` must match the password chosen at sign-up, else 401 `INVALID_CREDENTIALS` (the token stays valid; rate limited). This stops a pre-registration takeover: someone who signed up with your e-mail first can never get *their* password activated by you clicking a link. |
| `POST /api/auth/resend-verification` | `{ email }` | `202 { message }` | Always 202. |
| `POST /api/auth/login` | `{ email, password }` | `200 { user }` + sets `sid` | 401 `INVALID_CREDENTIALS`; 403 `EMAIL_NOT_VERIFIED` if not verified yet. Rate limited. |
| `POST /api/auth/logout` | – | `204` | Deletes the session, clears the cookie. |
| `GET /api/auth/me` | – | `200 { user: User \| null }` | Never 401. |

The verification email links to `${APP_URL}/verify-email?token=<token>`; that page asks for the
password chosen at sign-up and POSTs `{ token, password }` to `/api/auth/verify-email`. Signing up
again with a still-unverified e-mail replaces the pending password and invalidates older links.

## Your data (RGPD / LGPD)

| Method & path | Body | Success |
|---|---|---|
| `GET /api/me/export` | – | `200` JSON download (`Content-Disposition: attachment`) with the account, live sessions (expiry only), pending e-mail links (purpose + expiry only, never the token) and every rating |
| `PATCH /api/me` | `{ displayName }` | `200 { user }` |
| `DELETE /api/me` | `{ password }` | `204` — deletes the account, its sessions and its ratings; clears the cookie |

## Catalog (public)

| Method & path | Success |
|---|---|
| `GET /api/sections` | `200 [{ section, route, seriesCount, videoCount }]` (always both sections) |
| `GET /api/genres` | `200 string[]` — every genre used by any series, sorted |
| `GET /api/latest?limit=12` | `200 Video[]` — newest published videos, both sections (limit ≤ 50) |
| `GET /api/:section/series?genre=&q=` | `200 SeriesListItem[]` — series with ≥ 1 published video in that section; `q` searches name/aliases |
| `GET /api/:section/series/:slug` | `200 { series: Series, videos: Video[] }` — published videos of that section ordered by season, number. 404 if the series doesn't exist. |
| `GET /api/videos/:id` | `200 { video, series, prev: Video \| null, next: Video \| null }` — published only, else 404 |

Unknown `:section` → 404.

## Ratings ("reactions") — the only thing normal users can post

| Method & path | Body | Auth | Success |
|---|---|---|---|
| `GET /api/videos/:id/rating` | – | optional | `200 RatingSummary` |
| `PUT /api/videos/:id/rating` | `{ score: 1..5, reaction?: ReactionKey \| null }` | verified user | `200 RatingSummary` — one rating per user per video, PUT replaces it |
| `DELETE /api/videos/:id/rating` | – | verified user | `200 RatingSummary` |

## Admin (role `admin` only — 401 if logged out, 403 if not admin)

| Method & path | Body | Success |
|---|---|---|
| `GET /api/admin/series` | – | `200 Series[]` (all, including ones with no videos) |
| `POST /api/admin/series` | `{ name, slug?, synopsis?, aliases?, genres?, coverUrl? }` | `201 { series, published: Video[] }` — after creating, pending videos are re-classified; `published` lists the ones that now found their home |
| `PATCH /api/admin/series/:id` | any subset of the POST fields | `200 { series, published }` |
| `DELETE /api/admin/series/:id` | – | `204` — deletes the series, its videos and their ratings |
| `GET /api/admin/videos?status=pending\|published` | – | `200 Video[]` (with `classification` + `overrides`) |
| `POST /api/admin/videos` | `{ url, title?, section?, seriesSlug?, season?, number? }` | `201 { video }` — `url` is any YouTube link or 11-char ID; the server reads the title from YouTube oEmbed (unless `title` is given) and classifies it. 409 `CONFLICT` with `details.video` if already added. |
| `PATCH /api/admin/videos/:id` | `{ section?, seriesSlug?, season?, number? }` — `null` clears a manual override | `200 { video }` |
| `DELETE /api/admin/videos/:id` | – | `204` |

Admins are the accounts whose email is listed in the `ADMIN_EMAILS` env var (comma separated),
applied when they verify their email or log in. `npm run make-admin -- someone@example.com`
promotes an existing account.

## Dev-only

`GET /api/dev/outbox` (only when `NODE_ENV !== "production"`): `200 [{ to, subject, text, html, sentAt }]`,
the last 50 emails the server "sent" when no SMTP server is configured. Used by e2e tests and
for local development (the verification link is also printed to the server console).

## Personal data we keep (data minimisation)

| Table | Personal fields | Why | Kept until |
|---|---|---|---|
| `users` | email, display name, scrypt password hash, `privacy_accepted_at` | login, show name, prove consent | account deleted; **unverified accounts are deleted after 7 days** |
| `sessions` | SHA-256 of the session token, user id, expiry, session epoch | stay logged in | expiry (30 days) — purged automatically; at most 20 per user (a new login drops the oldest); password change/reset and "sign out everywhere" end every session, including logins still in flight |
| `email_tokens` | SHA-256 of the token, user id, expiry | verify email | used or expired (24 h) — purged automatically |
| `ratings` | user id, video id, score, reaction | the rating feature | account deleted |
| `rating_activity` | none — per-video daily counts with no user id (not personal data) | trending row | 30 days |

Deleted rows are overwritten in the database file (`PRAGMA secure_delete`), and the write-ahead log is
truncated after an account is deleted or purged, so erased accounts leave no readable copy behind.
E-mail is only sent over TLS (implicit or mandatory STARTTLS).

No IP addresses, user agents, analytics or third-party trackers are stored. The only cookie is
the essential `sid` session cookie. Watch progress lives only in the browser's `localStorage`.
YouTube's player is loaded from `www.youtube-nocookie.com`.

---

# v1.1 additions (wave 2 — accepted from product review)

These extend everything above; nothing above is removed.

## Fixes to the base contract
- Deleting a series **deletes** its videos (FK `ON DELETE CASCADE`), not `SET NULL`.
- `Video` gains: `publishedAt: string | null` (set when it first becomes published), `isNew: boolean`
  (published in the last 7 days), `availability: "ok" | "unavailable"`.
- `/api/latest`, `/api/top-rated`, `/api/trending`, `/api/random` never return unavailable videos.
  Series pages still list them (the client greys them out).
- Requests that send email (`register`, `resend-verification`, `forgot-password`, `reset-password`, `POST /api/me/password`) accept an optional
  `locale: "pt-BR" | "en"` (default `"pt-BR"`). It is used for that email only and **never stored**.

## Security & caching headers (server)
- CSP: `default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com;
  frame-src https://www.youtube-nocookie.com https://www.youtube.com; img-src 'self' data: https:;
  style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self';
  frame-ancestors 'none'; form-action 'self'`. No cross-origin isolation (COEP) header.
- `Referrer-Policy: strict-origin-when-cross-origin` (the default `no-referrer` breaks YouTube embeds).
- Public catalog GETs: `Cache-Control: public, max-age=60, stale-while-revalidate=600` + ETag (304 support).
  `/api/auth/*`, `/api/me/*`, `/api/admin/*`, every `/rating` route: `Cache-Control: private, no-store`.
- Static client: hashed `/assets/*` → `public, max-age=31536000, immutable`; `index.html` → `no-cache`.
- Fonts are self-hosted (no Google Fonts: it would leak visitor IPs to a third party).

## Password reset & session management
| Method & path | Body | Success |
|---|---|---|
| `POST /api/auth/forgot-password` | `{ email, locale? }` | `202 { message }` always. Reset token valid 1 h, single use; issuing a new one invalidates older reset tokens. |
| `POST /api/auth/reset-password` | `{ token, password }` | `200 { user }` + new `sid`. Deletes **all** the user's other sessions, marks email verified, sends "your password was changed" email. 400 `INVALID_TOKEN`. |
| `POST /api/me/password` | `{ currentPassword, newPassword }` | `200 { user }` + new `sid`; revokes all other sessions; sends "password changed" email. 401 `INVALID_CREDENTIALS` on wrong current password. |
| `POST /api/auth/logout-all` | – | `204` — deletes every session of the user (sign out everywhere). |

`email_tokens.purpose` is `"verify" | "reset"`. The session token is rotated on every login, verify and reset.
The reset email links to `${APP_URL}/reset-password?token=<token>`.

## Rating-driven discovery (public)
| Method & path | Success |
|---|---|
| `GET /api/top-rated?section=&limit=12` | `200 Video[]` — Bayesian average `(C·m + Σscores) / (C + n)` with `C = 5`, `m` = site-wide mean; needs `n ≥ 3`. |
| `GET /api/trending?section=&limit=12` | `200 Video[]` — most ratings in the last 7 days (from `rating_activity`). |
| `GET /api/random?section=` | `200 { video }` — a random published, available video; 404 if none. Sent with `Cache-Control: no-store` (a cached "random" would always be the same). |

`rating_activity(video_id, day, count, score_sum)` is **anonymous** (no user id), aggregated per video per
day and purged after 30 days. Add it to the personal-data table as "not personal data".

## Admin productivity & resilience
| Method & path | Body | Success |
|---|---|---|
| `POST /api/admin/videos/bulk` | `{ text?: string, urls?: string[], defaults?: { section?, seriesSlug?, season? }, dryRun?: boolean }` | `200 { results: BulkRow[] }` — extracts every YouTube ID from `text`/`urls` (max 50, de-duplicated), oEmbed lookups 3 at a time. |
| `POST /api/admin/videos/health-check` | – | `200 { checked: number, unavailable: Video[] }` — re-runs oEmbed for every video (also runs daily in-process); 401/403/404 → `availability: "unavailable"`. |
| `GET /api/admin/videos?availability=unavailable` | – | `200 Video[]` (combinable with `status`) |
| `PATCH /api/admin/videos/:id` | also accepts `{ url }` | swaps the YouTube ID (re-checks oEmbed), keeps route and ratings, resets availability to `"ok"`. |

```ts
type BulkRow = {
  input: string; youtubeVideoId: string | null;
  outcome: "created" | "would-create" | "duplicate" | "invalid" | "unavailable" | "error";
  video?: Video;          // created, or the existing one for duplicate
  preview?: { section, seriesSlug, season, number, status, route, reasons: string[] }; // dryRun
  message?: string;
};
```

---

# v1.2 additions (cycle 2 — SEO + search)

## Server-rendered meta for crawlers and link previews (production, when `client/dist` is served)

For every non-`/api` GET that falls back to `index.html`, the server injects into `<head>` (replacing the
static `<title>`), with **every value HTML-escaped**:

- `<title>`, `<meta name="description">`, `<link rel="canonical" href="${APP_URL}${canonicalPath}">`
- Open Graph + Twitter: `og:site_name` ("Crwn Animes"), `og:title`, `og:description`, `og:url`, `og:image`
  (series cover, else episode thumbnail, else none), `og:type` (`website` | `video.tv_show` | `video.episode`),
  `og:locale` `pt_BR`, `twitter:card` (`summary_large_image` when there is an image, else `summary`).
- Episode/chapter pages: one `<script type="application/ld+json">` VideoObject: `name`, `description`,
  `thumbnailUrl`, `uploadDate` (`publishedAt`), `embedUrl` (`https://www.youtube-nocookie.com/embed/<id>`),
  `isPartOf` (the series as `TVSeries` for anime, `CreativeWorkSeries` for manga). `</` inside JSON is
  escaped as `<\/`. Series pages: `TVSeries`/`CreativeWorkSeries` JSON-LD with `name`, `description`, `image`, `genre`.
- `<meta name="robots" content="noindex">` on `/admin*`, `/account`, `/login`, `/register`, `/check-email`,
  `/verify-email`, `/forgot-password`, `/reset-password`, `/search`.
- `/index.html` → **301** to `/`. Manga chapters are always season 1.
- Unknown section/series/episode/genre, a series page with no published video in that section, or a genre with no published series → **HTTP 404** with the SPA
  shell (title "Página não encontrada · Crwn Animes", `noindex`). Non-canonical watch URLs
  (`/episode/01`, `/season/1/episode/2`) → **301** to the canonical route.
- Canonical URLs always use `APP_URL` (never the request Host). In production the server refuses to start unless
  `APP_URL` is an `https://` URL.
- Pages: home, `/anime`, `/manga`, `/genre/:genre`, series, episode/chapter, `/privacy` get real titles and
  descriptions (pt-BR copy; synopsis truncated to 160 chars on a word boundary).

| Method & path | Success |
|---|---|
| `GET /sitemap.xml` | `200 application/xml` — home, `/anime`, `/manga`, every genre page, every series page that has published videos (per section), every published **available** episode/chapter; `<lastmod>` from `publishedAt`/`updatedAt`. Cached `public, max-age=3600`. |
| `GET /sitemap-<n>.xml` | Only when the site has more than 50,000 URLs: `/sitemap.xml` then becomes a sitemap index pointing at `/sitemap-1.xml` … `/sitemap-N.xml` (≤ 50,000 URLs each). Otherwise 404. Generated XML is cached in memory until the catalog changes. |
| `GET /robots.txt` | `200 text/plain` — `Disallow: /admin`, `/account`, `/api/`; `Sitemap: ${APP_URL}/sitemap.xml`. |

## Search & browse

Matching ignores case and accents and works on series name + aliases ("pokemon" finds "Pokémon",
"jjk" finds "Jujutsu Kaisen" via its alias). Implemented with a `series.search_text` column
(`normalize(name + aliases)`), kept up to date on create/patch and filled by a migration.

| Method & path | Success |
|---|---|
| `GET /api/search?q=&section=&genre=&sort=&limit=20&offset=0` | `200 { items: SearchItem[], total: number }` |

- `q` optional (≤ 80 chars; empty → browse everything). `section` optional (`anime`/`manga`); `genre`
  optional (case-insensitive exact genre); `sort` = `relevance` (default when `q` given: exact name match,
  then prefix, then substring; ties by rating) | `top` (Bayesian rating of the series in that section, as
  `/top-rated`) | `new` (latest `publishedAt` in that section) | `az` (default when no `q`).
  `limit` 1–50, `offset` ≥ 0; invalid values → 400 `VALIDATION_ERROR`.
- Only series with ≥ 1 published video in a section appear; a series published in both sections appears
  as **two items** (one per section).
- Public cache headers like other catalog GETs.

```ts
type SearchItem = SeriesListItem & { section: Section; latestPublishedAt: string | null };
```

`GET /api/genres` now lists only genres of series with ≥ 1 published, available video (genre spelling is
canonicalised to the first-seen form; comparisons are case-insensitive with pt-BR rules). The existing
`GET /api/:section/series?q=` uses the same accent-insensitive matching and the same 80-char limit.
Letters of every script are kept for matching ("鬼滅" finds "鬼滅の刃"); a non-empty `q` with nothing
searchable in it (only emoji or punctuation) matches nothing: `{ items: [], total: 0 }`.

## Front-end routes added
| Page | Path |
|---|---|
| Search (filters + sort + "load more") | `/search?q=&section=&genre=&sort=` |
| Genre page (both sections, sortable) | `/genre/:genre` |

Plus a ⌘K / Ctrl+K command palette (ARIA combobox) with instant, debounced results from `/api/search`.

---

# v1.3 additions (cycle 3 — pagination, seasons, progress portability)

## Pagination
| Method & path | Change |
|---|---|
| `GET /api/latest?limit=12&offset=0&section=` | adds `offset` (0–10000) and optional `section`; still returns `Video[]` |
| `GET /api/admin/videos?status=&availability=&q=&limit=50&offset=0` | **now returns `{ items: Video[], total }`**, newest first; `q` matches the video title or series name (accent-insensitive, ≤ 80 chars); `limit` 1–100 (default 50); blank filters mean "no filter" |
| `GET /api/admin/series?q=&limit=50&offset=0` | **now returns `{ items: (Series & { videoCounts: { anime, manga } })[], total }`**; `videoCounts` are published videos per section (a series with none is not shown on the site yet); `q` uses the same matching as `/api/search`; `limit` 1–100 |

Ordering is stable (ties broken by id) so paging never repeats or skips an item.

## Seasons on series pages
`GET /api/:section/series/:slug?season=N` → `{ series, videos, seasons }`:
- `seasons: number[]` — every season that has published videos in that section (ascending; manga is `[1]` when it
  has chapters; `[]` when the series has no published videos in that section).
- With `season`, `videos` only holds that season; without it, every published video (unchanged).
- Unknown season → `200` with `videos: []`; invalid value → `400 VALIDATION_ERROR`.

## Watch progress portability (client only — nothing new is stored on the server)
- `/account` → "Export watch history" downloads `crwn-animes-progress.json`
  (`{ "version": 1, "exportedAt": ISO, "entries": { [youtubeVideoId]: { t, d, at, route, title, thumb } } }`);
  "Import watch history" merges a file (newest `at` wins per video; validates shape, size ≤ 1 MB,
  ignores unknown keys and bad entries, keeps the 200-entry cap). Works logged out. An entry is only
  accepted when its key is an 11-character YouTube ID and its `route` is one of our own front-end routes;
  `thumb` is kept only when it starts with `https://i.ytimg.com/` (else `null`), so a crafted file can never
  make the page request another site.
- Series pages and series cards show "watched N of M" from local progress; series page has a
  "Continue" button that opens the first unwatched episode (or resumes the in-progress one).
- Long episode lists render with `content-visibility: auto` (no JS virtualisation library), grouped by
  season with `?season=` tabs on the series page.

---

# v1.4 additions (cycle 4 — admin series board, trash, draft preview)

## 7-day trash instead of hard deletes
`DELETE /api/admin/series/:id` and `DELETE /api/admin/videos/:id` now **move the item to the trash**
(`204`). A trashed series takes its videos with it. Trashed items disappear from every public
endpoint, sitemap, search, aggregates (top-rated, trending, series stats) and from the normal admin
lists, but are kept — with their ratings — for **7 days**, then purged by the retention job (ratings
included). Personal data kept in the trash is the same ratings data, for at most 7 more days.

| Method & path | Success |
|---|---|
| `GET /api/admin/trash` | `200 { series: TrashedSeries[], videos: TrashedVideo[] }` — newest first; videos trashed together with their series are listed under that series, not separately |
| `POST /api/admin/trash/series/:id/restore` | `200 { series, published: Video[], pending: Video[] }` — restores the series and the videos trashed with it |
| `POST /api/admin/trash/videos/:id/restore` | `200 { video }` — if its episode slot was taken meanwhile it comes back as `pending` with a reason; if its series is still in the trash → `409 CONFLICT` |
| `DELETE /api/admin/trash/series/:id` · `DELETE /api/admin/trash/videos/:id` | `204` — delete forever now (cascades ratings) |

```ts
type TrashedSeries = Series & { deletedAt: string; purgeAt: string; videoCount: number };
type TrashedVideo  = Video  & { deletedAt: string; purgeAt: string };
```
A series slug in the trash stays reserved (creating the same slug → `409`) until it is purged or
deleted forever.

## Reorder / renumber episodes
`PUT /api/admin/series/:id/order` body `{ section, season, videoIds: number[] }` → `200 { videos: Video[] }`
- `videoIds` must be exactly the published, non-trashed videos of that series/section/season
  (any missing, extra, duplicate or foreign id → `400 VALIDATION_ERROR`).
- Numbers become `1..n` in that order, atomically (no unique-slot conflict mid-way). Routes change
  accordingly; old episode URLs then 404 (or 301 if they match another video's canonical form).
- Manga: season is always 1.

## Board data
`GET /api/admin/series/:id` (admin, `private, no-store`) → `200 { series, sections }` where
`series` includes `videoCounts`, and `sections` is
`{ anime: { seasons: number[], videos: Video[] }, manga: { seasons: number[], videos: Video[] } }` —
the published, non-trashed videos (available or not) of each section, ordered by season, number:
exactly the set `PUT …/order` expects per season. Trashed series → `404` (use the trash endpoints).

## Draft preview
`GET /api/admin/videos/:id/preview` (admin) → `200 { video, series }` for any non-purged video,
including `pending` and trashed ones (`classification` + `overrides` included). The client renders it
at `/admin/preview/:id` (noindex, "Draft preview" banner, the same player, no rating panel).

## Admin board (client)
`/admin/series/:id` — per-series board: section switch (Anime/Manga), season tabs, the ordered
episode list with drag-and-drop **and** keyboard reordering (Move up / Move down buttons and
Alt+ArrowUp/ArrowDown, live-region announcements), "Save order", per-row preview / edit / move to
trash. Admin gets a "Trash" tab listing trashed series and videos with "Restore" and "Delete forever"
and "purged in N days".
