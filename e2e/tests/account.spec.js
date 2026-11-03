// Journeys 5 and 6: password reset (signs out other sessions) and
// "your data": export and account deletion.
import fs from "node:fs";
import { test, expect, createUser, linkFrom, newGuardedContext, uniqueEmail, waitForEmail, SUBJECT } from "./fixtures.js";

async function loginViaUi(page, { email, password }) {
  await page.goto("/login");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

test("forgot password → reset link → new password works, the old session is logged out", async ({ page, browser }) => {
  const user = await createUser(page.request, { email: uniqueEmail("reset"), displayName: "Esquecido" });
  const newPassword = "brand-new-passphrase-77";

  await test.step("device A is logged in", async () => {
    await page.goto("/");
    await expect(page.getByLabel(`Menu da conta de ${user.displayName}`)).toBeVisible();
  });

  const deviceB = await newGuardedContext(browser);
  const pageB = await deviceB.newPage();
  try {
    const startedAt = Date.now() - 1000;
    await test.step("device B asks for a reset link", async () => {
      await pageB.goto("/login");
      await pageB.getByRole("link", { name: "Esqueceu a senha?" }).click();
      await expect(pageB).toHaveURL(/\/forgot-password$/);
      // The URL changes before the lazily loaded page replaces the old one: wait for it.
      await expect(pageB.getByRole("heading", { level: 1, name: "Esqueceu a senha?" })).toBeVisible();
      await pageB.getByLabel("E-mail", { exact: true }).fill(user.email);
      await pageB.getByRole("button", { name: "Enviar link" }).click();
      await expect(pageB.getByRole("status")).toContainText("Se existir uma conta com esse e-mail");
    });

    await test.step("device B opens the e-mailed link and sets a new password", async () => {
      const link = linkFrom(await waitForEmail(pageB.request, { to: user.email, subject: SUBJECT.reset, after: startedAt }));
      expect(new URL(link).pathname).toBe("/reset-password");
      await pageB.goto(link);
      await expect(pageB.getByRole("heading", { level: 1, name: "Escolha uma nova senha" })).toBeVisible();
      await pageB.getByLabel("Nova senha", { exact: true }).fill(newPassword);
      await pageB.getByLabel("Repita a nova senha", { exact: true }).fill(newPassword);
      await pageB.getByRole("button", { name: "Salvar nova senha" }).click();
      await expect(pageB).toHaveURL(/\/$/);
      await expect(pageB.getByRole("status").filter({ hasText: "Sua senha foi alterada" })).toBeVisible();
      await expect(pageB.getByLabel(`Menu da conta de ${user.displayName}`)).toBeVisible();
    });

    await test.step("device A's old session was revoked", async () => {
      await page.reload();
      await expect(page.getByRole("link", { name: "Entrar", exact: true })).toBeVisible();
      await expect(page.getByLabel(`Menu da conta de ${user.displayName}`)).toHaveCount(0);
      expect((await (await page.request.get("/api/auth/me")).json()).user).toBeNull();
    });

    await test.step("the old password no longer works, the new one does", async () => {
      await loginViaUi(page, { email: user.email, password: user.password });
      await expect(page.getByRole("alert")).toContainText("E-mail ou senha incorretos.");
      await page.getByLabel("Senha", { exact: true }).fill(newPassword);
      await page.getByRole("button", { name: "Entrar", exact: true }).click();
      await expect(page.getByLabel(`Menu da conta de ${user.displayName}`)).toBeVisible();
      await expect(page).toHaveURL(/\/$/);
    });

    await test.step("the reset link is single-use", async () => {
      const mail = await waitForEmail(pageB.request, { to: user.email, subject: SUBJECT.reset, after: startedAt });
      const token = new URL(linkFrom(mail)).searchParams.get("token");
      const res = await pageB.request.post("/api/auth/reset-password", { data: { token, password: "yet-another-passphrase" } });
      expect(res.status()).toBe(400);
      expect((await res.json()).error.code).toBe("INVALID_TOKEN");
    });
  } finally {
    await deviceB.close();
  }
});

test("account: download my data (no password hash), delete account with password → logged out, login fails", async ({ page }) => {
  const user = await createUser(page.request, { email: uniqueEmail("gdpr"), displayName: "Titular" });
  await page.goto("/account");
  await expect(page.getByRole("heading", { level: 1, name: "Minha conta" })).toBeVisible();

  await test.step("download my data", async () => {
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Baixar meus dados" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("crwn-animes-my-data.json");
    const text = fs.readFileSync(await download.path(), "utf8");
    const data = JSON.parse(text);
    expect(data.account).toMatchObject({ email: user.email, displayName: user.displayName, role: "user" });
    expect(data.account.privacyAcceptedAt).toBeTruthy();
    expect(Array.isArray(data.ratings)).toBe(true);
    // No password hash (nor any other secret) in the export.
    expect(text).not.toMatch(/password|hash|scrypt|token/i);
    expect(text).not.toContain(user.password);
  });

  await test.step("delete: a wrong password is refused", async () => {
    await page.getByRole("button", { name: "Excluir minha conta" }).click();
    const dialog = page.getByRole("dialog", { name: "Excluir sua conta?" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Sua senha", { exact: true }).fill("not-my-password-at-all");
    await dialog.getByRole("button", { name: "Excluir minha conta" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("E-mail ou senha incorretos.");
  });

  await test.step("delete with the right password → logged out on the home page", async () => {
    const dialog = page.getByRole("dialog", { name: "Excluir sua conta?" });
    await dialog.getByLabel("Sua senha", { exact: true }).fill(user.password);
    await dialog.getByRole("button", { name: "Excluir minha conta" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("status").filter({ hasText: "Sua conta e todos os seus dados foram excluídos." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Entrar", exact: true })).toBeVisible();
    expect((await (await page.request.get("/api/auth/me")).json()).user).toBeNull();
  });

  await test.step("logging in again fails", async () => {
    await loginViaUi(page, user);
    await expect(page.getByRole("alert")).toContainText("E-mail ou senha incorretos.");
    await expect(page).toHaveURL(/\/login/);
  });
});
