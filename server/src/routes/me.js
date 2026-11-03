import { Router } from "express";
import { rateLimit } from "../middleware/rateLimit.js";
import { clearSessionCookie, requireUser, setSessionCookie } from "../middleware/session.js";
import { toIso } from "../repository.js";
import { videoRoute } from "../routing.js";
import { bodyOf, validator } from "../validation.js";

// "Your data" (RGPD / LGPD): export, rename, change password, delete account.
export function meRoutes({ auth, ratings, config }) {
  const router = Router();
  router.use(requireUser);

  // Both routes check a password with scrypt: limit per IP and per account
  // (a stolen session must not allow brute-forcing the current password).
  const guard = (name) => [
    rateLimit({ ...config.rateLimit, name: `${name}-ip` }),
    rateLimit({ ...config.rateLimit, name: `${name}-user`, key: (req) => `user:${req.user.id}` }),
  ];

  router.get("/export", (req, res) => {
    const u = req.user;
    const data = {
      exportedAt: new Date().toISOString(),
      account: {
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        role: u.role,
        emailVerifiedAt: u.email_verified_at,
        privacyAcceptedAt: u.privacy_accepted_at,
        createdAt: u.created_at,
      },
      sessions: auth.users.listSessions(u.id),
      ratings: ratings.listByUser(u.id).map((r) => ({
        videoId: r.video_id,
        youtubeVideoId: r.youtube_video_id,
        videoTitle: r.source_title,
        route:
          r.status === "published"
            ? videoRoute({ section: r.section, seriesSlug: r.series_slug, season: r.season, number: r.number })
            : null,
        score: r.score,
        reaction: r.reaction,
        updatedAt: toIso(r.updated_at),
      })),
    };
    res.attachment("crwn-animes-my-data.json");
    res.type("application/json").send(JSON.stringify(data, null, 2));
  });

  router.patch("/", (req, res) => {
    const v = validator(bodyOf(req));
    const displayName = v.displayName();
    v.done();
    res.json({ user: auth.toUser(auth.updateDisplayName(req.user.id, displayName)) });
  });

  router.post("/password", guard("change-password"), async (req, res) => {
    const v = validator(bodyOf(req));
    const currentPassword = v.password("currentPassword", { checkStrength: false });
    const newPassword = v.password("newPassword");
    const locale = v.locale();
    v.done();
    const row = await auth.changePassword(req.user.id, { currentPassword, newPassword, locale });
    // Every session was revoked; this device gets a fresh one.
    setSessionCookie(res, config, auth.rotateSession(row.id, null));
    res.json({ user: auth.toUser(row) });
  });

  router.delete("/", guard("delete-account"), async (req, res) => {
    const v = validator(bodyOf(req));
    const password = v.password("password", { checkStrength: false });
    v.done();
    await auth.deleteAccount(req.user.id, password);
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  return router;
}
