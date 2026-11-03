import { Router } from "express";

// Only mounted when NODE_ENV !== "production".
export function devRoutes({ mailer }) {
  const router = Router();
  router.get("/outbox", (req, res) => {
    res.json(mailer.outbox ?? []);
  });
  return router;
}
