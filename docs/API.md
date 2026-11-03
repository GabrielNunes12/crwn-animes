# Crwn Animes — API contract

This is the single source of truth shared by `server/` (Express) and `client/` (React).
If something here is wrong or missing, change this file first, then both sides.

- Base path: `/api`. JSON in, JSON out. Dev: the server listens on `:4000`, the Vite dev
  server (`:5173`) proxies `/api` to it, so the browser sees one origin.
- Auth: an **httpOnly** session cookie named `sid` (`SameSite=Lax`, `Secure` in production,
  `Path=/`, 30 days). The client never reads it; it just sends `credentials: "include"`.
- Every request with a body must be `Content-Type: application/json` (the server rejects
  others with 415 — this is part of the CSRF defence together with `SameSite=Lax`).
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
| `POST /api/auth/verify-email` | `{ token }` | `200 { user }` + sets `sid` | Token is single-use, valid 24 h. Invalid/expired → 400 `INVALID_TOKEN`. |
| `POST /api/auth/resend-verification` | `{ email }` | `202 { message }` | Always 202. |
| `POST /api/auth/login` | `{ email, password }` | `200 { user }` + sets `sid` | 401 `INVALID_CREDENTIALS`; 403 `EMAIL_NOT_VERIFIED` if not verified yet. Rate limited. |
| `POST /api/auth/logout` | – | `204` | Deletes the session, clears the cookie. |
| `GET /api/auth/me` | – | `200 { user: User \| null }` | Never 401. |

The verification email links to `${APP_URL}/verify-email?token=<token>`; that page POSTs the
token to `/api/auth/verify-email`.

## Your data (RGPD / LGPD)

| Method & path | Body | Success |
|---|---|---|
| `GET /api/me/export` | – | `200` JSON download (`Content-Disposition: attachment`) with the account and every rating |
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
| `sessions` | SHA-256 of the session token, user id, expiry | stay logged in | expiry (30 days) — purged automatically |
| `email_tokens` | SHA-256 of the token, user id, expiry | verify email | used or expired (24 h) — purged automatically |
| `ratings` | user id, video id, score, reaction | the rating feature | account deleted |

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
- Requests that send email (`register`, `resend-verification`, `forgot-password`) accept an optional
  `locale: "pt-BR" | "en"` (default `"pt-BR"`). It is used for that email only and **never stored**.

## Security & caching headers (server)
- CSP: `default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com;
  frame-src https://www.youtube-nocookie.com https://www.youtube.com; img-src 'self' data: https://i.ytimg.com;
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
| `GET /api/random?section=` | `200 { video }` — a random published, available video; 404 if none. |

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
