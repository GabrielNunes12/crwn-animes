// Journeys 1 and 2: sign-up with e-mail verification, and logging in before verifying.
import { test, expect, createUser, linkFrom, uniqueEmail, waitForEmail, SUBJECT, headerUser, headerLogin } from "./fixtures.js";

test.describe("sign-up and e-mail verification", () => {
  test("register → check e-mail → open link → confirm password → verified and logged in", async ({ page }) => {
    const email = uniqueEmail("signup");
    const password = "my-long-passphrase-42";
    const displayName = "Novo Fã";
    const startedAt = Date.now() - 1000;

    await test.step("fill the registration form (pt-BR is the default UI)", async () => {
      await page.goto("/register");
      await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
      await expect(page.getByRole("heading", { level: 1, name: "Crie sua conta" })).toBeVisible();
      await page.getByLabel("E-mail", { exact: true }).fill(email);
      await page.getByLabel("Nome de exibição").fill(displayName);
      await page.getByLabel("Senha", { exact: true }).fill(password);
      await page.getByRole("checkbox", { name: /aviso de privacidade/ }).check();
      await page.getByRole("button", { name: "Criar conta" }).click();
    });

    await test.step("lands on the check-email page", async () => {
      await expect(page).toHaveURL(/\/check-email\?email=/);
      await expect(page.getByRole("heading", { level: 1, name: "Confira seu e-mail" })).toBeVisible();
      await expect(page.getByText(email)).toBeVisible();
    });

    const link = linkFrom(await waitForEmail(page.request, { to: email, subject: SUBJECT.verify, after: startedAt }));
    expect(new URL(link).pathname).toBe("/verify-email");

    await test.step("the verification page asks for the sign-up password", async () => {
      await page.goto(link);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const passwordField = page.getByLabel("Senha", { exact: true });
      await expect(passwordField, "verify-email page must ask for the password (API v1.1: { token, password })").toBeVisible();
      // Nothing is verified just by opening the link.
      expect((await (await page.request.get("/api/auth/me")).json()).user).toBeNull();
    });

    await test.step("a wrong password is refused and the link stays valid", async () => {
      const passwordField = page.getByLabel("Senha", { exact: true });
      await passwordField.fill("not-the-signup-password");
      await passwordField.press("Enter");
      await expect(passwordField).toHaveAttribute("aria-invalid", "true");
      await expect(passwordField).toHaveAccessibleDescription(/senha que você escolheu no cadastro/);
      await expect(page).toHaveURL(/\/verify-email\?token=/);
      expect((await (await page.request.get("/api/auth/me")).json()).user).toBeNull();
    });

    await test.step("the right password verifies the account", async () => {
      const passwordField = page.getByLabel("Senha", { exact: true });
      await passwordField.fill(password);
      await passwordField.press("Enter");
    });

    await test.step("verified, logged in, header shows the user", async () => {
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("status").filter({ hasText: "E-mail confirmado" })).toBeVisible();
      await expect(headerUser(page, displayName)).toBeVisible();
      await expect(headerLogin(page)).toHaveCount(0);
      const me = await (await page.request.get("/api/auth/me")).json();
      expect(me.user).toMatchObject({ email, displayName, role: "user" });
    });
  });

  test("logging in before verifying shows EMAIL_NOT_VERIFIED with a resend action", async ({ page }) => {
    const user = await createUser(page.request, { email: uniqueEmail("unverified"), verify: false });

    await page.goto("/login");
    await page.getByLabel("E-mail", { exact: true }).fill(user.email);
    await page.getByLabel("Senha", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();

    const alert = page.getByRole("alert").filter({ hasText: "Seu e-mail ainda não foi confirmado" });
    await expect(alert).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    const resentAt = Date.now() - 500;
    await alert.getByRole("button", { name: "Reenviar e-mail de confirmação" }).click();
    await expect(alert.getByText("Se essa conta estiver aguardando confirmação")).toBeVisible();
    const mail = await waitForEmail(page.request, { to: user.email, subject: SUBJECT.verify, after: resentAt });
    expect(linkFrom(mail)).not.toBe(user.verifyLink); // a fresh token

    const me = await (await page.request.get("/api/auth/me")).json();
    expect(me.user).toBeNull();
  });
});
