import { Router } from "express";
import { notFound } from "../errors.js";
import { parseThumbKey } from "../thumbnails.js";

// Matched against the path exactly as sent (req.path is not %-decoded, and this is case-sensitive):
// "<id>.jpg" or "<id>-m.jpg" and nothing else — no %-escapes, no trailing slash, no other spelling,
// so every image has one URL. The captured stem is the cache key ("<id>" or "<id>-m").
const THUMB_PATH = /^\/thumbs\/([A-Za-z0-9_-]{11}(?:-m)?)\.jpg$/;
const COVER_FILE = /^([1-9]\d{0,15})\.img$/;

// Same-origin images (docs/API.md v1.5, v1.7), mounted before the session loader: anonymous,
// never a cookie, requests not logged. The database decides before anything goes
// upstream; `misses` is the per-IP limit on cache misses (429).
//   GET /api/thumbs/<youtubeVideoId>.jpg   — hqdefault (480×360); live, available videos only
//   GET /api/thumbs/<youtubeVideoId>-m.jpg — mqdefault (320×180); the same rules, its own cache file
//   GET /api/covers/<seriesId>.img[?v=…] — live series with a cover; ?v= only busts browser caches
export function imageRoutes({ repo, thumbnails, covers, misses }) {
  const router = Router();
  const onMiss = (req, res) => () => misses(req, res, () => {});
  const send = (res, { body, type }, cacheControl) => {
    res.set({
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.setHeader("Content-Type", type); // exactly the validated type
    res.send(body);
  };

  router.get("/thumbs/:file", async (req, res) => {
    const thumb = parseThumbKey(THUMB_PATH.exec(req.path)?.[1] ?? "");
    // Any other file name, unknown IDs, the trash and videos YouTube no longer serves: 404, never proxied.
    if (!thumb || repo.thumbnailState(thumb.id) !== "live") throw notFound("There is no thumbnail here.");
    // 502 when YouTube does not deliver.
    const image = await thumbnails.get(thumb.id, { size: thumb.size, onMiss: onMiss(req, res) });
    send(res, image, "public, max-age=604800, immutable");
  });

  router.get("/covers/:file", async (req, res) => {
    const id = Number(COVER_FILE.exec(req.params.file)?.[1] ?? 0);
    const cover = id && Number.isSafeInteger(id) ? repo.coverSource(id) : null;
    if (!cover || cover.trashed || !cover.sourceUrl) throw notFound("There is no cover here.");
    const image = await covers.get(id, cover.sourceUrl, { onMiss: onMiss(req, res) });
    send(res, image, "public, max-age=604800");
  });

  return router;
}
