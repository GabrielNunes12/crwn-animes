import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { PASSWORD, lastEmail, signUp, startServer, tokenFrom } from "./helpers.js";

describe("auth", () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(() => srv.close());

  test("register -> e-mail -> verify -> me -> logout", async () => {
    const client = srv.client();
    const reg = await client.post("/api/auth/register", {
      email: "  Ana@Example.com ",
      password: PASSWORD,
      displayName: "Ana",
      acceptPrivacy: true,
    });
    assert.equal(reg.status, 201);
    assert.ok(reg.body.message);
    assert.equal(client.cookie, null, "registering does not log in");

    // The dev outbox has the verification e-mail (pt-BR by default), with HTML + text.
    const outbox = await client.get("/api/dev/outbox");
    assert.equal(outbox.status, 200);
    const email = outbox.body.filter((m) => m.to === "ana@example.com").at(-1);
    assert.match(email.subject, /Confirme seu e-mail/);
    assert.match(email.text, /24 horas/);
    assert.match(email.text, /pedir a senha que você escolheu/);
    assert.match(email.html, /#0b0b14/);
    assert.match(email.html, /#ff5c9a/);
    assert.ok(email.sentAt);
    const token = tokenFrom(email);
    assert.match(email.text, new RegExp(`http://app.test/verify-email\\?token=`));
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");

    // Tokens are stored hashed only.
    const stored = srv.db.prepare("SELECT token_hash, purpose FROM email_tokens").all();
    assert.ok(stored.every((row) => row.token_hash !== token && /^[0-9a-f]{64}$/.test(row.token_hash)));

    assert.deepEqual((await client.get("/api/auth/me")).body, { user: null });

    const verified = await client.post("/api/auth/verify-email", { token, password: PASSWORD });
    assert.equal(verified.status, 200);
    assert.deepEqual(Object.keys(verified.body.user).sort(), ["createdAt", "displayName", "email", "id", "role"]);
    assert.equal(verified.body.user.email, "ana@example.com");
    assert.equal(verified.body.user.role, "user");
    const cookie = verified.setCookie.find((c) => c.startsWith("sid="));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=2592000/);
    assert.doesNotMatch(cookie, /Secure/i, "not Secure outside production");
    assert.ok(lastEmail(srv.mailer, "ana@example.com", /Bem-vindo/), "welcome e-mail sent");

    const me = await client.get("/api/auth/me");
    assert.equal(me.body.user.displayName, "Ana");
    assert.equal(me.headers.get("cache-control"), "private, no-store");

    // Session token is stored hashed too.
    const sessions = srv.db.prepare("SELECT token_hash FROM sessions").all();
    assert.ok(sessions.every((s) => `sid=${s.token_hash}` !== client.cookie));

    const logout = await client.post("/api/auth/logout");
    assert.equal(logout.status, 204);
    assert.equal(client.cookie, null);
    assert.deepEqual((await client.get("/api/auth/me")).body, { user: null });
  });

  test("verification token is single use", async () => {
    const client = srv.client();
    await client.post("/api/auth/register", { email: "once@example.com", password: PASSWORD, displayName: "Once", acceptPrivacy: true });
    const token = tokenFrom(lastEmail(srv.mailer, "once@example.com"));
    assert.equal((await client.post("/api/auth/verify-email", { token, password: PASSWORD })).status, 200);
    const again = await srv.client().post("/api/auth/verify-email", { token, password: PASSWORD });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, "INVALID_TOKEN");
    const garbage = await srv.client().post("/api/auth/verify-email", { token: "nope", password: PASSWORD });
    assert.equal(garbage.body.error.code, "INVALID_TOKEN");
  });

  test("duplicate register answers the same 201 and warns the owner", async () => {
    await signUp(srv, { email: "dup@example.com" });
    const before = srv.mailer.outbox.length;
    const res = await srv.client().post("/api/auth/register", {
      email: "DUP@example.com",
      password: "another-password-1",
      displayName: "Impostor",
      acceptPrivacy: true,
      locale: "en",
    });
    assert.equal(res.status, 201);
    const fresh = await srv.client().post("/api/auth/register", {
      email: "fresh@example.com",
      password: PASSWORD,
      displayName: "Fresh",
      acceptPrivacy: true,
    });
    assert.deepEqual(res.body, fresh.body, "no account enumeration");
    const notice = srv.mailer.outbox.slice(before).find((m) => m.to === "dup@example.com");
    assert.match(notice.subject, /Someone tried to sign up/);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'dup@example.com'").get().n, 1);
    // The password did not change.
    assert.equal((await srv.client().post("/api/auth/login", { email: "dup@example.com", password: PASSWORD })).status, 200);
  });

  test("register validation", async () => {
    const res = await srv.client().post("/api/auth/register", {
      email: "bad",
      password: "short",
      displayName: "x",
      acceptPrivacy: "yes",
      locale: "fr",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(Object.keys(res.body.error.details).sort(), ["acceptPrivacy", "displayName", "email", "locale", "password"]);
  });

  test("login: unverified 403, wrong password 401, unknown e-mail 401", async () => {
    await srv.client().post("/api/auth/register", { email: "slow@example.com", password: PASSWORD, displayName: "Slow", acceptPrivacy: true });
    const unverified = await srv.client().post("/api/auth/login", { email: "slow@example.com", password: PASSWORD });
    assert.equal(unverified.status, 403);
    assert.equal(unverified.body.error.code, "EMAIL_NOT_VERIFIED");

    const wrongPasswordOfUnverified = await srv.client().post("/api/auth/login", { email: "slow@example.com", password: "wrong-password!" });
    assert.equal(wrongPasswordOfUnverified.status, 401, "no 403 without the right password");

    await signUp(srv, { email: "bob@example.com" });
    const wrong = await srv.client().post("/api/auth/login", { email: "bob@example.com", password: "wrong-password!" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, "INVALID_CREDENTIALS");
    const unknown = await srv.client().post("/api/auth/login", { email: "ghost@example.com", password: PASSWORD });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.code, "INVALID_CREDENTIALS");

    const ok = await srv.client().post("/api/auth/login", { email: "BOB@example.com", password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, "bob@example.com");
  });

  test("login rotates the session", async () => {
    const client = await signUp(srv, { email: "rot@example.com" });
    const first = client.cookie;
    await client.post("/api/auth/login", { email: "rot@example.com", password: PASSWORD });
    assert.notEqual(client.cookie, first);
    const old = srv.client();
    old.cookie = first;
    assert.equal((await old.get("/api/auth/me")).body.user, null, "old session was dropped");
  });

  test("resend-verification always answers 202 and sends a new link (en)", async () => {
    await srv.client().post("/api/auth/register", { email: "late@example.com", password: PASSWORD, displayName: "Late", acceptPrivacy: true });
    const firstToken = tokenFrom(lastEmail(srv.mailer, "late@example.com"));
    const res = await srv.client().post("/api/auth/resend-verification", { email: "late@example.com", locale: "en" });
    assert.equal(res.status, 202);
    const email = lastEmail(srv.mailer, "late@example.com");
    assert.match(email.subject, /Confirm your e-mail/);
    assert.match(email.text, /expires in 24 hours/);
    assert.match(email.text, /asked for the password you chose/);
    assert.equal((await srv.client().post("/api/auth/verify-email", { token: firstToken, password: PASSWORD })).status, 400, "older link replaced");
    assert.equal((await srv.client().post("/api/auth/verify-email", { token: tokenFrom(email), password: PASSWORD })).status, 200);

    const unknown = await srv.client().post("/api/auth/resend-verification", { email: "nobody@example.com" });
    assert.equal(unknown.status, 202);
    assert.deepEqual(unknown.body, res.body);
  });

  test("bodies that are not application/json get 415", async () => {
    const client = srv.client();
    const text = await client.request("POST", "/api/auth/login", {
      body: "email=a@b.c&password=x",
      raw: true,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(text.status, 415);
    assert.equal(text.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
    const plain = await client.request("POST", "/api/auth/register", { body: "{}", raw: true, headers: { "content-type": "text/plain" } });
    assert.equal(plain.status, 415);
    const bad = await client.request("POST", "/api/auth/login", { body: "{oops", raw: true, headers: { "content-type": "application/json" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "VALIDATION_ERROR");
    const big = await client.post("/api/auth/login", { email: "a@b.cd", password: "x".repeat(30_000) });
    assert.equal(big.status, 413);
  });

  test("unknown API routes give a JSON 404", async () => {
    const res = await srv.client().get("/api/does-not-exist");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: { code: "NOT_FOUND", message: res.body.error.message, details: {} } });
  });
});

describe("rate limiting", () => {
  test("the 11th login attempt within the window gets 429", async () => {
    const srv = await startServer({ config: { rateLimit: { max: 10, windowMs: 60_000 } } });
    try {
      const client = srv.client();
      for (let i = 0; i < 10; i++) {
        const res = await client.post("/api/auth/login", { email: "x@example.com", password: "whatever-pass" });
        assert.equal(res.status, 401);
      }
      const limited = await client.post("/api/auth/login", { email: "x@example.com", password: "whatever-pass" });
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error.code, "RATE_LIMITED");
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      // Other endpoints have their own budget.
      const register = await client.post("/api/auth/register", { email: "y@example.com", password: PASSWORD, displayName: "Yy", acceptPrivacy: true });
      assert.equal(register.status, 201);
      // Nothing about the IP is stored in the database.
      const tables = srv.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table'").all();
      assert.ok(tables.every((t) => !/\bip\b|user_agent/i.test(t.sql)));
    } finally {
      await srv.close();
    }
  });
});
