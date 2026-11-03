// Runs once before the suite ("setup" project): makes sure admin@e2e.test
// exists, is verified (ADMIN_EMAILS promotes it to admin) and saves its
// session to .auth/admin.json for the tests that need an admin.
import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ADMIN, ADMIN_STATE, createUser } from "./fixtures.js";

setup("admin account (admin@e2e.test) is registered, verified and logged in", async ({ request }) => {
  const login = await request.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } });
  if (login.status() !== 200) {
    await createUser(request, ADMIN);
  }
  const me = await (await request.get("/api/auth/me")).json();
  expect(me.user?.email).toBe(ADMIN.email);
  expect(me.user?.role, "ADMIN_EMAILS=admin@e2e.test must promote the account").toBe("admin");

  fs.mkdirSync(path.dirname(ADMIN_STATE), { recursive: true });
  await request.storageState({ path: ADMIN_STATE });
});
