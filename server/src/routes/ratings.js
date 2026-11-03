import { Router } from "express";
import { notFound } from "../errors.js";
import { requireVerified } from "../middleware/session.js";
import { REACTIONS, bodyOf, idParam, validator } from "../validation.js";

// GET/PUT/DELETE /api/videos/:id/rating. Only published videos can be rated.
export function ratingRoutes({ repo, ratings }) {
  const router = Router();

  const publishedVideoId = (req) => {
    const id = idParam(req.params.id);
    const video = id && repo.getVideo(id);
    if (!video || video.status !== "published") throw notFound("Video not found.");
    return video.id;
  };

  router.get("/videos/:id/rating", (req, res) => {
    res.json(ratings.summary(publishedVideoId(req), req.user?.id));
  });

  router.put("/videos/:id/rating", requireVerified, (req, res) => {
    const videoId = publishedVideoId(req);
    const v = validator(bodyOf(req));
    const score = v.int("score", { min: 1, max: 5 });
    const reaction = v.has("reaction") ? v.oneOf("reaction", REACTIONS, { nullable: true }) : null;
    v.done();
    ratings.set(req.user.id, videoId, { score, reaction });
    res.json(ratings.summary(videoId, req.user.id));
  });

  router.delete("/videos/:id/rating", requireVerified, (req, res) => {
    const videoId = publishedVideoId(req);
    ratings.remove(req.user.id, videoId);
    res.json(ratings.summary(videoId, req.user.id));
  });

  return router;
}
