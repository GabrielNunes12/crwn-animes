# Crwn Animes — roadmap

Worked through top to bottom by the hourly improvement cycle. Each cycle takes the highest unchecked
items that fit in one PR, ships them (build → independent review → tests green → PR → merge) and ticks them here.

Ground rules that never change:
- Normal users can only **rate** (stars + reaction). No comments or other free text from users.
- No new personal data unless it is justified in the "Personal data we keep" table in `docs/API.md`.
- No analytics, trackers or third-party requests other than YouTube on Play and `i.ytimg.com` thumbnails.
- Never skip or disable a test to make CI green.

## Release 1 (shipped)
- [x] Base platform: anime/manga sections, auto-classification, admin CRUD, ratings, email auth, RGPD (docs/API.md base)
- [x] v1.1: password reset, security headers, bulk add, broken-video health check, continue watching, discovery rows, pt-BR/en
- [x] Playwright e2e of the core journeys + axe accessibility checks
- [x] GitHub Actions CI running server tests, client lint/test/build and e2e on every PR

## Next
- [ ] SEO: server-rendered `<title>`/description/OpenGraph per series and episode, canonical URLs, `sitemap.xml`, VideoObject JSON-LD
- [ ] Unified accent-insensitive search across anime + manga (reuse `normalize()`), ⌘K command palette, genre pages with sort (top/new/A–Z)
- [ ] Pagination for `/latest` and admin lists; virtualised long episode lists; `?season=` filter
- [ ] Admin series board: drag to reorder/renumber episodes, season tabs, draft preview, 7-day trash with restore instead of hard deletes
- [ ] PWA: manifest, service worker caching the app shell and catalog, offline page; proxy thumbnails same-origin
- [ ] Watch progress portability: export/import localStorage history as a file, "watched N/M" per series, binge mode
- [ ] Playlist / channel import (YouTube Data API key kept server-side) feeding the bulk-paste preview
- [ ] Passkeys (WebAuthn) as an optional login — stores only a public key
- [ ] Performance budget: Lighthouse CI ≥ 90 on home/series/episode, image `srcset`, route prefetch on hover
- [ ] Admin metrics page built only from anonymous aggregates (ratings per series, pending queue age) — no user tracking
