# Crwn Animes

Watch anime and manga, episode by episode. Every episode is a YouTube video embedded on the
site — we only store its YouTube ID. Admins paste a link and the server works out on its own
whether it is anime or manga, which series it belongs to and which episode/chapter it is, then
routes it to the right page.

- **Viewers** browse, watch, resume where they left off, and rate the episode they are watching
  (1–5 stars + a reaction 🔥 😂 😭 😮 ❤️). Rating is the only thing normal users can post.
- **Admins** create, edit and delete series, add episodes one by one or in bulk, review the
  pending queue, and fix videos YouTube has removed.
- **Accounts**: register → verification e-mail → login, password reset, sign out everywhere,
  export or delete your data.
- **Privacy (RGPD / LGPD)**: only the essential session cookie, no analytics or trackers,
  self-hosted fonts, YouTube loads only when you press Play, watch progress stays in your browser,
  unverified accounts are deleted after 7 days. See [`docs/API.md`](docs/API.md#personal-data-we-keep-data-minimisation).
- **Languages**: Português (Brasil) and English.

## Stack

| | |
|---|---|
| `client/` | Vite, React 19, React Router (data router, lazy routes), modern CSS (`@layer`, `oklch`, container queries, scroll-driven reveal animations, CSS route entrances), Vitest |
| `server/` | Node.js, Express 5, SQLite (better-sqlite3), nodemailer, helmet, `node:test` |
| `docs/` | [`API.md`](docs/API.md) — the contract between client and server · [`ROADMAP.md`](docs/ROADMAP.md) |

## Run it locally

Requires Node.js 20.19+ (22 recommended).

```bash
npm run setup
```

```bash
cp server/.env.example server/.env
```

Put your own e-mail in `ADMIN_EMAILS` inside `server/.env`, then start both apps:

```bash
npm run dev
```

Open http://localhost:5173. Without SMTP settings, e-mails are not sent: the verification link is
printed in the server console (and listed at http://localhost:4000/api/dev/outbox).

Other commands:

```bash
npm test
```

```bash
npm run lint
```

```bash
npm run build
```

`npm run build` writes `client/dist`; `npm start` then serves the API and the built site from one
Node process on port 4000. Production needs `NODE_ENV=production` and SMTP settings — see
[`server/README.md`](server/README.md).
