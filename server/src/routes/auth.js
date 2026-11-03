import { Router } from "express";
import { rateLimit } from "../middleware/rateLimit.js";
import { clearSessionCookie, setSessionCookie } from "../middleware/session.js";
import { bodyOf, validator } from "../validation.js";

export function authRoutes({ auth, config }) {
  const router = Router();
  const limit = (name) => rateLimit({ ...config.rateLimit, name });
  const limitRegister = limit("register");
  const limitLogin = limit("login");
  const limitResend = limit("resend-verification");
  const limitForgot = limit("forgot-password");
  const limitReset = limit("reset-password");

  /** Rotates the session (drops the one in the cookie, if any) and sends { user }. */
  const signIn = (req, res, row, status = 200) => {
    setSessionCookie(res, config, auth.rotateSession(row.id, req.sessionToken));
    res.status(status).json({ user: auth.toUser(row) });
  };

  router.post("/register", limitRegister, async (req, res) => {
    const v = validator(bodyOf(req));
    const email = v.email();
    const password = v.password();
    const displayName = v.displayName();
    const locale = v.locale();
    if (req.body?.acceptPrivacy !== true) v.fail("acceptPrivacy", "You must accept the privacy policy.");
    v.done();
    await auth.register({ email, password, displayName, locale });
    // Same answer whether or not the e-mail already has an account.
    res.status(201).json({ message: "Check your inbox: we sent you a link to confirm your e-mail." });
  });

  router.post("/verify-email", async (req, res) => {
    const v = validator(bodyOf(req));
    const token = v.token();
    v.done();
    signIn(req, res, await auth.verifyEmail(token));
  });

  router.post("/resend-verification", limitResend, async (req, res) => {
    const v = validator(bodyOf(req));
    const email = v.email();
    const locale = v.locale();
    v.done();
    await auth.resendVerification({ email, locale });
    res.status(202).json({ message: "If this e-mail has an unconfirmed account, we sent a new link." });
  });

  router.post("/login", limitLogin, async (req, res) => {
    const v = validator(bodyOf(req));
    const email = v.email();
    const password = v.password("password", { checkStrength: false });
    v.done();
    signIn(req, res, await auth.login({ email, password }));
  });

  router.post("/logout", (req, res) => {
    auth.endSession(req.sessionToken);
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  router.post("/logout-all", (req, res) => {
    if (req.user) auth.endAllSessions(req.user.id);
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  router.get("/me", (req, res) => {
    res.json({ user: auth.toUser(req.user) });
  });

  router.post("/forgot-password", limitForgot, async (req, res) => {
    const v = validator(bodyOf(req));
    const email = v.email();
    const locale = v.locale();
    v.done();
    await auth.forgotPassword({ email, locale });
    res.status(202).json({ message: "If this e-mail has an account, we sent a link to reset the password." });
  });

  router.post("/reset-password", limitReset, async (req, res) => {
    const v = validator(bodyOf(req));
    const token = v.token();
    const password = v.password();
    const locale = v.locale();
    v.done();
    signIn(req, res, await auth.resetPassword({ token, password, locale }));
  });

  return router;
}
