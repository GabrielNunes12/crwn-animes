import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { PASSWORD, addVideo, lastEmail, signUp, startServer, tokenFrom } from "./helpers.js";

describe("password reset & session management", () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(() => srv.close());

  test("forgot -> reset: new password works, old sessions are revoked, e-mails sent", async () => {
    const laptop = await signUp(srv, { email: "reset@example.com" });
    const phone = srv.client();
    await phone.post("/api/auth/login", { email: "reset@example.com", password: PASSWORD });
    assert.ok((await phone.get("/api/auth/me")).body.user);

    const forgot = await srv.client().post("/api/auth/forgot-password", { email: "reset@example.com", locale: "en" });
    assert.equal(forgot.status, 202);
    const firstToken = tokenFrom(lastEmail(srv.mailer, "reset@example.com", /Reset your/), "reset-password");
    assert.ok(firstToken);

    // A second request invalidates the first link.
    await srv.client().post("/api/auth/forgot-password", { email: "reset@example.com" });
    const email = lastEmail(srv.mailer, "reset@example.com", /Redefina/);
    assert.match(email.text, /http:\/\/app.test\/reset-password\?token=/);
    assert.match(email.text, /1 hora/);
    const token = tokenFrom(email, "reset-password");
    const stale = await srv.client().post("/api/auth/reset-password", { token: firstToken, password: "brand-new-password" });
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error.code, "INVALID_TOKEN");

    const weak = await srv.client().post("/api/auth/reset-password", { token, password: "short" });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, "VALIDATION_ERROR");

    const browser = srv.client();
    const reset = await browser.post("/api/auth/reset-password", { token, password: "brand-new-password" });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.user.email, "reset@example.com");
    assert.ok(browser.cookie, "logged in with a new session");
    assert.match(lastEmail(srv.mailer, "reset@example.com").subject, /senha .* foi alterada/);

    assert.equal((await laptop.get("/api/auth/me")).body.user, null, "old session revoked");
    assert.equal((await phone.get("/api/auth/me")).body.user, null, "old session revoked");
    assert.ok((await browser.get("/api/auth/me")).body.user);

    assert.equal((await srv.client().post("/api/auth/reset-password", { token, password: "another-password" })).status, 400, "single use");
    assert.equal((await srv.client().post("/api/auth/login", { email: "reset@example.com", password: PASSWORD })).status, 401);
    assert.equal((await srv.client().post("/api/auth/login", { email: "reset@example.com", password: "brand-new-password" })).status, 200);
  });

  test("reset verifies an unverified account; unknown e-mail still 202", async () => {
    await srv.client().post("/api/auth/register", { email: "unv@example.com", password: PASSWORD, displayName: "Unv", acceptPrivacy: true });
    await srv.client().post("/api/auth/forgot-password", { email: "unv@example.com" });
    const token = tokenFrom(lastEmail(srv.mailer, "unv@example.com", /Redefina/), "reset-password");
    assert.equal((await srv.client().post("/api/auth/reset-password", { token, password: "fresh-password-1" })).status, 200);
    assert.equal((await srv.client().post("/api/auth/login", { email: "unv@example.com", password: "fresh-password-1" })).status, 200);

    const before = srv.mailer.outbox.length;
    const unknown = await srv.client().post("/api/auth/forgot-password", { email: "nobody@example.com" });
    assert.equal(unknown.status, 202);
    assert.equal(srv.mailer.outbox.length, before);
  });

  test("reset token expires after 1 hour", async () => {
    await signUp(srv, { email: "late-reset@example.com" });
    await srv.client().post("/api/auth/forgot-password", { email: "late-reset@example.com" });
    const token = tokenFrom(lastEmail(srv.mailer, "late-reset@example.com", /Redefina/), "reset-password");
    const row = srv.db.prepare("SELECT expires_at FROM email_tokens WHERE purpose = 'reset'").all().at(-1);
    const ttl = Date.parse(row.expires_at) - Date.now();
    assert.ok(ttl > 59 * 60_000 && ttl <= 60 * 60_000, `ttl ${ttl}`);
    srv.db.prepare("UPDATE email_tokens SET expires_at = ? WHERE purpose = 'reset'").run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await srv.client().post("/api/auth/reset-password", { token, password: "fresh-password-1" })).status, 400);
  });

  test("POST /api/me/password", async () => {
    const client = await signUp(srv, { email: "change@example.com" });
    const other = srv.client();
    await other.post("/api/auth/login", { email: "change@example.com", password: PASSWORD });

    const wrong = await client.post("/api/me/password", { currentPassword: "not-it-at-all", newPassword: "a-better-password" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, "INVALID_CREDENTIALS");

    const before = client.cookie;
    const ok = await client.post("/api/me/password", { currentPassword: PASSWORD, newPassword: "a-better-password", locale: "en" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, "change@example.com");
    assert.notEqual(client.cookie, before, "session rotated");
    assert.ok((await client.get("/api/auth/me")).body.user);
    assert.equal((await other.get("/api/auth/me")).body.user, null, "other sessions revoked");
    assert.match(lastEmail(srv.mailer, "change@example.com").subject, /password was changed/);

    assert.equal((await srv.client().post("/api/me/password", { currentPassword: "x", newPassword: "y" })).status, 401, "needs login");
  });

  test("logout-all signs out every device", async () => {
    const a = await signUp(srv, { email: "many@example.com" });
    const b = srv.client();
    await b.post("/api/auth/login", { email: "many@example.com", password: PASSWORD });
    const res = await a.post("/api/auth/logout-all");
    assert.equal(res.status, 204);
    assert.equal(a.cookie, null);
    assert.equal((await b.get("/api/auth/me")).body.user, null);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'many@example.com'").get().n, 0);
  });
});

describe("permissions", () => {
  let srv;
  before(async () => {
    srv = await startServer();
    await addVideo(srv, 1, "One Piece Episode 1");
  });
  after(() => srv.close());

  test("anonymous PUT rating -> 401", async () => {
    const res = await srv.client().put("/api/videos/1/rating", { score: 5 });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHENTICATED");
    assert.equal((await srv.client().del("/api/videos/1/rating")).status, 401);
  });

  test("normal user on /api/admin/* -> 403, anonymous -> 401", async () => {
    const user = await signUp(srv, { email: "plain@example.com" });
    for (const [method, path] of [
      ["GET", "/api/admin/series"],
      ["POST", "/api/admin/series"],
      ["GET", "/api/admin/videos"],
      ["POST", "/api/admin/videos/bulk"],
      ["DELETE", "/api/admin/videos/1"],
    ]) {
      const res = await user.request(method, path, { body: method === "GET" ? undefined : {} });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.error.code, "FORBIDDEN");
      assert.equal((await srv.client().request(method, path)).status, 401);
    }
  });

  test("ADMIN_EMAILS makes an account admin on verify", async () => {
    const admin = await signUp(srv, { email: "Admin@Example.com" });
    const me = await admin.get("/api/auth/me");
    assert.equal(me.body.user.role, "admin");
    const res = await admin.get("/api/admin/videos");
    assert.equal(res.status, 200);
    assert.ok(res.body[0].classification, "admin responses include classification");
    assert.ok(res.body[0].overrides);
  });

  test("ADMIN_EMAILS applies on login too", async () => {
    const client = await signUp(srv, { email: "later-admin@example.com" });
    assert.equal((await client.get("/api/auth/me")).body.user.role, "user");
    srv.services.config.adminEmails.push("later-admin@example.com");
    const login = await srv.client().post("/api/auth/login", { email: "later-admin@example.com", password: PASSWORD });
    assert.equal(login.body.user.role, "admin");
  });
});
