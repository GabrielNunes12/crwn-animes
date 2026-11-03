import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component as Register } from "./Register.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";
import { validateRegistration } from "../../lib/validation.js";

function setup() {
  const fetch = mockFetch(() => [201, { message: "ok" }]);
  const utils = renderApp(null, {
    path: "/register",
    routes: [
      { path: "/register", element: <Register /> },
      { path: "/check-email", element: <p>check page</p> },
      { path: "/privacy", element: <p>privacy</p> },
    ],
  });
  return { fetch, ...utils };
}

async function fill(user, { email = "ana@example.com", name = "Ana", password = "a-long-password" } = {}) {
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Display name"), name);
  await user.type(screen.getByLabelText("Password"), password);
}

describe("Register form", () => {
  it("requires the privacy consent", async () => {
    const user = userEvent.setup();
    const { fetch } = setup();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("You need to accept the privacy notice to create an account.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-invalid", "true");
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "privacy notice" })).toHaveAttribute("href", "/privacy");
  });

  it("requires a password of at least 10 characters", async () => {
    const user = userEvent.setup();
    const { fetch } = setup();
    await fill(user, { password: "short" });
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Password must be at least 10 characters.")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts acceptPrivacy + locale and goes to /check-email", async () => {
    const user = userEvent.setup();
    const { fetch, router } = setup();
    await fill(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/check-email"));
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/auth/register");
    expect(JSON.parse(init.body)).toEqual({ email: "ana@example.com", password: "a-long-password", displayName: "Ana", acceptPrivacy: true, locale: "en" });
  });

  it("validateRegistration checks every field", () => {
    expect(validateRegistration({ email: "x", displayName: "A", password: "123", consent: false })).toEqual({
      email: "auth.errors.email",
      displayName: "auth.errors.displayName",
      password: "auth.errors.passwordLength",
      consent: "auth.errors.consent",
    });
    expect(validateRegistration({ email: "a@b.co", displayName: "Ana", password: "0123456789", consent: true })).toEqual({});
  });
});
