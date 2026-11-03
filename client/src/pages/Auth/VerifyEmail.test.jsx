import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component as VerifyEmail } from "./VerifyEmail.jsx";
import { authValue, mockFetch, renderApp } from "../../test/utils.jsx";

const USER = { id: 1, email: "ana@example.com", displayName: "Ana", role: "user", createdAt: "2026-01-01" };

function setup(handler, path = "/verify-email?token=tok123") {
  const fetch = mockFetch(handler);
  const auth = authValue(null, { setUser: vi.fn() });
  const utils = renderApp(null, {
    path,
    auth,
    routes: [
      { path: "/verify-email", element: <VerifyEmail /> },
      { path: "/", element: <p>home page</p> },
      { path: "/forgot-password", element: <p>forgot</p> },
    ],
  });
  return { fetch, auth, ...utils };
}

describe("Verify email page", () => {
  it("does not submit on load; posts { token, password } and logs in", async () => {
    const user = userEvent.setup();
    const { fetch, auth, router } = setup(() => [200, { user: USER }]);
    expect(screen.getByText("Enter the password you chose at sign-up to activate your account.")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Password"), "my-secret-pass");
    await user.click(screen.getByRole("button", { name: "Confirm and log in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/auth/verify-email");
    expect(JSON.parse(init.body)).toEqual({ token: "tok123", password: "my-secret-pass" });
    expect(auth.setUser).toHaveBeenCalledWith(USER);
  });

  it("wrong password (401 INVALID_CREDENTIALS) keeps the form so they can retry", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { fetch, router } = setup(() => (++calls === 1 ? [401, { error: { code: "INVALID_CREDENTIALS", message: "Wrong password." } }] : [200, { user: USER }]));
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Confirm and log in" }));
    expect(await screen.findByText(/isn't the password you chose at sign-up/)).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    await user.type(screen.getByLabelText("Password"), "right-password");
    await user.click(screen.getByRole("button", { name: "Confirm and log in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ token: "tok123", password: "right-password" });
  });

  it("expired/used link (400 INVALID_TOKEN) offers to resend a new link", async () => {
    const user = userEvent.setup();
    const { fetch } = setup((url) => (url.endsWith("/verify-email") ? [400, { error: { code: "INVALID_TOKEN", message: "x" } }] : [202, { message: "ok" }]));
    await user.type(screen.getByLabelText("Password"), "whatever-pass");
    await user.click(screen.getByRole("button", { name: "Confirm and log in" }));
    expect(await screen.findByText("This verification link is invalid, already used or expired.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.click(screen.getByRole("button", { name: "Resend verification email" }));
    expect(await screen.findByText(/we sent a new link/)).toBeInTheDocument();
    const [url, init] = fetch.mock.calls[1];
    expect(url).toBe("/api/auth/resend-verification");
    expect(JSON.parse(init.body)).toEqual({ email: "ana@example.com", locale: "en" });
  });
});
