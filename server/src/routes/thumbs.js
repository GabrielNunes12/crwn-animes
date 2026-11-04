import { Router } from "express";
import { notFound } from "../errors.js";

const THUMB_FILE = /^([A-Za-z0-9_-]{11})\.jpg$/;

// GET /api/thumbs/<youtubeVideoId>.jpg (docs/API.md v1.5): the video's YouTube
// thumbnail, served from this origin. Mounted before the session loader: it is
// anonymous and never sets a cookie. Requests are not logged.
export function thumbRoutes({ repo, thumbnails }) {
  const router = Router();

  router.get("/:file", async (req, res) => {
    const id = THUMB_FILE.exec(req.params.file)?.[1];
    // The database decides before anything goes upstream: unknown IDs and the trash are 404, never proxied.
    if (!id || repo.thumbnailState(id) !== "live") throw notFound("There is no thumbnail here.");
    const body = await thumbnails.get(id); // 502 UPSTREAM_ERROR when YouTube does not deliver
    res.set({
      "Cache-Control": "public, max-age=604800, immutable",
      "Content-Type": "image/jpeg",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.send(body);
  });

  return router;
}
