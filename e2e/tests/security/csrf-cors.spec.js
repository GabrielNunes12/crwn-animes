// Security: CSRF, CORS and framing, attacked from a real page on another
// origin. A small attacker server runs on its own port and is visited both as
//   http://127.0.0.1:<port>  — a different SITE (SameSite=Lax cookies are not
//                              sent on its cross-site POSTs / fetches), and
//   http://localhost:<port>  — the SAME SITE but another ORIGIN (Lax cookies
//                              ARE sent; only the API's own checks protect it).
// The victim is logged in on the app; the attack targets the API origin
// (http://localhost:4517, the production-shaped server).
//
// IMPORTANT: the victim's browser context here has NO request interception.
// While page/context.route() is active, Playwright answers CORS preflights
// itself with permissive headers, so the browser would send cross-origin
// requests that a real browser never sends (false positives). The attacker
// pages only ever talk to localhost/127.0.0.1, so no network guard is needed.
import { expect, API_ORIGIN, createUser, uniqueEmail, ADMIN } from "../fixtures.js";
import { apiClient, rawRequest, startAttackerServer, test as base, whoIs } from "./helpers.js";

const test = base.extend({
  // A plain context (no route(), see above) replaces the guarded default one.
  context: async ({ browser }, use) => {
    const context = await browser.newContext({ locale: "pt-BR" });
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    await use(await context.newPage());
  },
});

let attacker;
test.beforeAll(async () => {
  attacker = await startAttackerServer();
});
test.afterAll(async () => {
  await attacker?.close();
});

const ENCTYPES = ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"];

/**
 * Form fields whose text/plain encoding is valid JSON: name + "=" + value gives
 * {"a":"1","b":"2","x":"="} — the classic JSON-CSRF trick.
 */
function jsonTrickFields(obj) {
  const json = JSON.stringify({ ...obj, x: "" });
  return [[json.slice(0, -2), "\"}"]]; // name = '{..,"x":' + '"', value = '"}'
}

/** An attacker page holding a POST form to `action`; its own script submits it when told to. */
function formPage({ action, enctype, fields }) {
  const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const inputs = fields.map(([n, v]) => `<input type="hidden" name="${esc(n)}" value="${esc(v)}">`).join("");
  return `<!doctype html><html><body><form id="f" method="POST" action="${esc(action)}" enctype="${esc(enctype)}">${inputs}</form>
<script>window.attack = () => setTimeout(() => document.getElementById("f").submit(), 0);</script></body></html>`;
}

/** The victim opens the attacker's page, whose script submits a form to the API; returns the API's status. */
async function submitFromAttacker(page, origin, { path, enctype = "application/x-www-form-urlencoded", fields = [] }) {
  const pagePath = `/csrf-${Math.random().toString(36).slice(2)}`;
  attacker.pages.set(pagePath, formPage({ action: `${API_ORIGIN}${path}`, enctype, fields }));
  // A fresh tab per attack, so a previous form navigation can never interrupt this one.
  const tab = await page.context().newPage();
  try {
    await tab.goto(`${origin}${pagePath}`);
    const [response] = await Promise.all([
      tab.waitForResponse((r) => r.url() === `${API_ORIGIN}${path}` && r.request().method() === "POST"),
      tab.evaluate(() => window.attack()),
    ]);
    return { status: response.status() };
  } finally {
    await tab.close();
  }
}

async function loggedInVictim(page, prefix) {
  const user = await createUser(page.request, { email: uniqueEmail(prefix), displayName: "Victim" });
  expect((await (await page.request.get(`${API_ORIGIN}/api/auth/me`)).json()).user?.email).toBe(user.email);
  return user;
}

test.describe("CSRF", () => {
  for (const site of ["crossSite", "sameSite"]) {
    test(`${site}: form POSTs with a body (text/plain JSON trick, urlencoded, multipart) are rejected with 415 and change nothing`, async ({ page }) => {
      const user = await loggedInVictim(page, `csrf-${site}`);
      const origin = attacker[site];
      const newPassword = "pwned-by-csrf-12345";
      for (const enctype of ENCTYPES) {
        const fields = enctype === "text/plain" ? jsonTrickFields({ currentPassword: user.password, newPassword }) : [["currentPassword", user.password], ["newPassword", newPassword]];
        const pw = await submitFromAttacker(page, origin, { path: "/api/me/password", enctype, fields });
        expect(pw.status, `${enctype} → POST /api/me/password`).toBe(415);

        const name = await submitFromAttacker(page, origin, { path: "/api/auth/logout-all", enctype, fields: [["a", "b"]] });
        expect(name.status, `${enctype} → POST /api/auth/logout-all with a body`).toBe(415);

        const login = await submitFromAttacker(page, origin, {
          path: "/api/auth/login",
          enctype,
          fields: enctype === "text/plain" ? jsonTrickFields({ email: "attacker@e2e.test", password: "attacker-password" }) : [["email", "attacker@e2e.test"], ["password", "attacker-password"]],
        });
        expect(login.status, `${enctype} → login CSRF`).toBe(415);
      }
      // Still logged in as the victim, with the original password.
      expect((await (await page.request.get(`${API_ORIGIN}/api/auth/me`)).json()).user?.email).toBe(user.email);
      const check = await apiClient();
      expect((await check.post("/api/auth/login", { data: { email: user.email, password: user.password } })).status()).toBe(200);
      expect((await check.post("/api/auth/login", { data: { email: user.email, password: newPassword } })).status()).toBe(401);
      await check.dispose();
    });
  }

  test("admin victim: a cross-origin JSON-trick form cannot create a series", async ({ page, admin }) => {
    // A separate admin session in this browser context (the shared one is never touched).
    expect((await page.request.post(`${API_ORIGIN}/api/auth/login`, { data: { email: ADMIN.email, password: ADMIN.password } })).status()).toBe(200);
    for (const site of ["crossSite", "sameSite"]) {
      for (const enctype of ENCTYPES) {
        const slug = `sec-csrf-${site.toLowerCase()}-${enctype.replace(/\W+/g, "-")}`;
        const fields = enctype === "text/plain" ? jsonTrickFields({ name: `CSRF ${slug}`, slug }) : [["name", `CSRF ${slug}`], ["slug", slug]];
        const res = await submitFromAttacker(page, attacker[site], { path: "/api/admin/series", enctype, fields });
        expect(res.status, `${site} ${enctype}`).toBe(415);
      }
    }
    const created = (await (await admin.get("/api/admin/series?q=csrf")).json()).items.filter((s) => s.slug.startsWith("sec-csrf-"));
    expect(created).toEqual([]);
  });

  test("crossSite: a body-less form POST to logout / logout-all carries no cookie (SameSite=Lax): the server session survives", async ({ page, context }) => {
    for (const path of ["/api/auth/logout", "/api/auth/logout-all"]) {
      const user = await loggedInVictim(page, "csrf-empty-xsite");
      const sid = (await context.cookies()).find((c) => c.name === "sid").value;
      const res = await submitFromAttacker(page, attacker.crossSite, { path });
      expect([204, 403, 415], path).toContain(res.status); // 403 CROSS_SITE_REQUEST since the Origin/Sec-Fetch-Site check
      expect((await whoIs(sid))?.email, `${path}: server-side session still valid`).toBe(user.email);
      await context.clearCookies();
    }
  });

  // FINDING (low): /api/auth/logout and /api/auth/logout-all always answer with
  // a cookie-clearing Set-Cookie (server/src/routes/auth.js:60-71 call
  // clearSessionCookie() even when no session came with the request). From ANY
  // website, an auto-submitted empty <form method=POST> to either route is a
  // top-level navigation whose response the browser honours: the victim's sid
  // cookie is deleted and they are signed out (forced-logout CSRF). The server
  // session itself survives (the Lax cookie was not sent).
  test("crossSite: a body-less form POST to logout / logout-all must not delete the victim's cookie", async ({ page, context }) => {
    for (const path of ["/api/auth/logout", "/api/auth/logout-all"]) {
      const user = await loggedInVictim(page, "csrf-empty-xsite2");
      await submitFromAttacker(page, attacker.crossSite, { path });
      expect((await context.cookies()).map((c) => c.name), `${path}: the browser still holds sid`).toContain("sid");
      expect((await (await page.request.get(`${API_ORIGIN}/api/auth/me`)).json()).user?.email, `${path}: still logged in`).toBe(user.email);
    }
  });

  // FINDING (low): requireJsonBody (server/src/middleware/security.js:5-18) only
  // checks the Content-Type when the request HAS a body, and nothing checks
  // Origin/Sec-Fetch-Site. A same-site page on another origin (any port on the
  // same host, or a sibling subdomain in production) can auto-submit an EMPTY
  // <form method=POST> — Lax cookies are sent same-site — and the body-less
  // state-changing routes run: POST /api/auth/logout-all (signs the victim out
  // everywhere), POST /api/auth/logout, and for admins POST
  // /api/admin/videos/health-check (outbound oEmbed for every video).
  test("sameSite: a body-less form POST to /api/auth/logout-all must not end the victim's sessions", async ({ page, context }) => {
    const user = await loggedInVictim(page, "csrf-empty-ssite");
    const sid = (await context.cookies()).find((c) => c.name === "sid").value;
    // A second device of the same user: logout-all would end it too.
    const other = await apiClient();
    await other.post("/api/auth/login", { data: { email: user.email, password: user.password } });
    const res = await submitFromAttacker(page, attacker.sameSite, { path: "/api/auth/logout-all" });
    const stillThere = { status: res.status, browser: (await whoIs(sid))?.email ?? null, otherDevice: (await (await other.get("/api/auth/me")).json()).user?.email ?? null };
    await other.dispose();
    // A fix may answer 403 (Origin / Sec-Fetch-Site check) or 415 (JSON required even without a body).
    expect([403, 415], `a cross-origin, body-less, cookie-bearing POST must be refused (${JSON.stringify(stillThere)})`).toContain(stillThere.status);
    expect(stillThere).toEqual({ status: stillThere.status, browser: user.email, otherDevice: user.email });
  });
});

test.describe("CORS: other origins cannot read API responses", () => {
  for (const site of ["crossSite", "sameSite"]) {
    test(`${site}: credentialed fetch/XHR of /api/auth/me, /api/me/export, /api/dev/outbox fail; preflighted JSON POST is blocked`, async ({ page }) => {
      const user = await loggedInVictim(page, `cors-${site}`);
      const pagePath = `/read-${site}`;
      attacker.pages.set(pagePath, `<!doctype html><html><body><script>
        const API = ${JSON.stringify(API_ORIGIN)};
        const tryFetch = (path, init) => fetch(API + path, init).then(
          async (r) => ({ path, ok: true, type: r.type, status: r.status, body: await r.text() }),
          (e) => ({ path, ok: false, error: String(e) })
        );
        const tryXhr = (path) => new Promise((resolve) => {
          const x = new XMLHttpRequest();
          x.open("GET", API + path);
          x.withCredentials = true;
          x.onload = () => resolve({ path, ok: true, status: x.status, body: x.responseText });
          x.onerror = () => resolve({ path, ok: false, status: x.status, body: x.responseText });
          x.send();
        });
        window.__results = Promise.all([
          tryFetch("/api/auth/me", { credentials: "include" }),
          tryFetch("/api/me/export", { credentials: "include" }),
          tryFetch("/api/dev/outbox", {}),
          tryFetch("/api/dev/outbox", { credentials: "include" }),
          tryFetch("/api/auth/me", { credentials: "include", mode: "no-cors" }),
          tryFetch("/api/auth/logout-all", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" }),
          tryFetch("/api/me", { method: "DELETE", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "x" }) }),
          tryXhr("/api/auth/me"),
          tryXhr("/api/me/export"),
        ]);
      </script></body></html>`);
      await page.goto(`${attacker[site]}${pagePath}`);
      const results = await page.evaluate(() => window.__results);
      for (const r of results) {
        // Either a network error (CORS refusal) or an opaque, unreadable response.
        if (r.ok && r.type !== "opaque") throw new Error(`${site}: could read ${r.path}: ${JSON.stringify(r).slice(0, 300)}`);
        if (r.ok) expect(r.body, `${r.path} opaque`).toBe("");
        expect(JSON.stringify(r)).not.toContain(user.email);
      }
      // The preflighted POST never reached the server: still logged in.
      expect((await (await page.request.get(`${API_ORIGIN}/api/auth/me`)).json()).user?.email).toBe(user.email);
    });
  }

  test("no Access-Control-Allow-Origin for unknown/look-alike origins (never '*'); the configured client origin is echoed exactly", async ({ baseURL }) => {
    const clientOrigin = new URL(baseURL).origin;
    const hostile = [
      "https://evil.example",
      "null",
      `${attacker.crossSite}`,
      `${attacker.sameSite}`,
      `${clientOrigin}.evil.example`,
      `${clientOrigin.replace("http://", "http://evil.")}`,
      `${clientOrigin}@evil.example`,
      clientOrigin.replace("http:", "https:"),
      `${clientOrigin}/`,
      API_ORIGIN.replace("localhost", "127.0.0.1"),
    ];
    const paths = ["/api/auth/me", "/api/me/export", "/api/dev/outbox", "/api/admin/series", "/api/latest", "/api/nope"];
    for (const origin of hostile) {
      for (const p of paths) {
        const get = await rawRequest({ path: p, headers: { origin } });
        expect(get.headers["access-control-allow-origin"], `GET ${p} Origin: ${origin}`).toBeUndefined();
        const pre = await rawRequest({
          method: "OPTIONS",
          path: p,
          headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
        });
        expect(pre.headers["access-control-allow-origin"], `OPTIONS ${p} Origin: ${origin}`).toBeUndefined();
      }
    }
    const ok = await rawRequest({ path: "/api/auth/me", headers: { origin: clientOrigin } });
    expect(ok.headers["access-control-allow-origin"]).toBe(clientOrigin);
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    expect(String(ok.headers.vary)).toMatch(/Origin/i);
    // Wildcard never appears, whatever the request.
    for (const p of paths) {
      const r = await rawRequest({ path: p });
      expect(r.headers["access-control-allow-origin"]).not.toBe("*");
    }
  });
});

test.describe("framing (clickjacking)", () => {
  test("a page on another origin cannot frame the app (frame-ancestors 'none')", async ({ page }) => {
    attacker.pages.set("/frame", `<!doctype html><html><body><iframe id="f" src="${API_ORIGIN}/account" width="800" height="600"></iframe></body></html>`);
    const [doc] = await Promise.all([
      page.waitForResponse((r) => r.url() === `${API_ORIGIN}/account`),
      page.goto(`${attacker.crossSite}/frame`),
    ]);
    expect(doc.headers()["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    await page.waitForTimeout(500);
    const child = page.mainFrame().childFrames()[0];
    const rendered = child ? await child.evaluate(() => Boolean(document.querySelector("#root"))).catch(() => false) : false;
    expect(rendered, "the framed app must not render").toBe(false);
  });
});
