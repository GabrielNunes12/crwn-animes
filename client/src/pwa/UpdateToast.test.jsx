import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n/I18nProvider.jsx";
import { UpdateToast } from "./UpdateToast.jsx";
import { applyUpdate, clearRuntimeCaches, dismissUpdate, getWaitingRegistration, registerServiceWorker, SW_URL, watchRegistration } from "./serviceWorker.js";

/** navigator.serviceWorker stand-in: an EventTarget with a `controller`. */
function fakeContainer({ controller = {}, register } = {}) {
  return Object.assign(new EventTarget(), { controller, register: register ?? vi.fn() });
}
/** ServiceWorkerRegistration stand-in. */
function fakeRegistration({ waiting = null } = {}) {
  return Object.assign(new EventTarget(), { waiting, installing: null, update: vi.fn(async () => {}) });
}
const fakeWorker = (state = "installed") => Object.assign(new EventTarget(), { state, postMessage: vi.fn() });

afterEach(() => act(() => dismissUpdate()));

describe("service worker registration", () => {
  const win = (readyState = "complete") => Object.assign(new EventTarget(), { document: { readyState }, setInterval: vi.fn() });

  it("does nothing outside production builds or without service worker support", async () => {
    const container = fakeContainer();
    expect(await registerServiceWorker({ prod: false, nav: { serviceWorker: container }, win: win() })).toBeNull();
    expect(await registerServiceWorker({ prod: true, nav: {}, win: win() })).toBeNull();
    expect(container.register).not.toHaveBeenCalled();
  });

  it("registers /sw.js for the whole site, only after the load event", async () => {
    const registration = fakeRegistration();
    const container = fakeContainer({ register: vi.fn(async () => registration) });
    const w = win("loading");
    const pending = registerServiceWorker({ prod: true, nav: { serviceWorker: container }, win: w });
    await Promise.resolve();
    expect(container.register).not.toHaveBeenCalled();
    w.dispatchEvent(new Event("load"));
    expect(await pending).toBe(registration);
    expect(container.register).toHaveBeenCalledWith(SW_URL, { scope: "/" });
    expect(SW_URL).toBe("/sw.js");
    expect(w.setInterval).toHaveBeenCalled(); // periodic update checks
  });

  it("never throws when registration fails", async () => {
    const container = fakeContainer({ register: vi.fn(async () => Promise.reject(new Error("SecurityError"))) });
    expect(await registerServiceWorker({ prod: true, nav: { serviceWorker: container }, win: win() })).toBeNull();
  });
});

describe("update detection", () => {
  it("a worker waiting while another controls the page is an update", () => {
    const registration = fakeRegistration({ waiting: fakeWorker() });
    watchRegistration(registration, fakeContainer());
    expect(getWaitingRegistration()).toBe(registration);
  });

  it("the very first install (no controller yet) is not an update", () => {
    const registration = fakeRegistration({ waiting: fakeWorker() });
    watchRegistration(registration, fakeContainer({ controller: null }));
    expect(getWaitingRegistration()).toBeNull();
  });

  it("notices a worker that finishes installing later (updatefound → installed)", () => {
    const registration = fakeRegistration();
    watchRegistration(registration, fakeContainer());
    const worker = fakeWorker("installing");
    registration.installing = worker;
    registration.dispatchEvent(new Event("updatefound"));
    expect(getWaitingRegistration()).toBeNull();
    worker.state = "installed";
    registration.waiting = worker;
    worker.dispatchEvent(new Event("statechange"));
    expect(getWaitingRegistration()).toBe(registration);
  });

  it("applyUpdate returns false when nothing is waiting", () => {
    expect(applyUpdate(fakeRegistration(), { container: fakeContainer(), reload: vi.fn() })).toBe(false);
  });
});

describe("<UpdateToast>", () => {
  function setup(locale = "en") {
    const worker = fakeWorker();
    const registration = fakeRegistration({ waiting: worker });
    const container = fakeContainer();
    const reload = vi.fn();
    const apply = (reg) => applyUpdate(reg, { container, reload });
    render(
      <I18nProvider locale={locale}>
        <UpdateToast apply={apply} />
      </I18nProvider>,
    );
    return { worker, registration, container, reload };
  }

  it("keeps an empty live region until a new version is waiting", () => {
    setup();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("announces the new version; Update posts SKIP_WAITING and reloads once the new worker takes control", async () => {
    const user = userEvent.setup();
    const { worker, registration, container, reload } = setup();
    act(() => watchRegistration(registration, container));
    expect(screen.getByRole("status")).toHaveTextContent("A new version is available");

    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(reload).not.toHaveBeenCalled();

    // controllerchange may fire more than once: exactly one reload.
    registration.waiting = null;
    container.dispatchEvent(new Event("controllerchange"));
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("speaks pt-BR: “Nova versão disponível — Atualizar”", () => {
    const { registration, container } = setup("pt-BR");
    act(() => watchRegistration(registration, container));
    expect(screen.getByRole("status")).toHaveTextContent("Nova versão disponível");
    expect(screen.getByRole("button", { name: "Atualizar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dispensar" })).toBeInTheDocument();
  });

  it("can be dismissed", async () => {
    const user = userEvent.setup();
    const { registration, container, worker } = setup();
    act(() => watchRegistration(registration, container));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it("hides itself when another tab applied the update", () => {
    const { registration, container } = setup();
    act(() => watchRegistration(registration, container));
    registration.waiting = null;
    act(() => container.dispatchEvent(new Event("controllerchange")));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("clearRuntimeCaches (part of “Clear watch history”)", () => {
  const storage = (names) => {
    const left = new Set(names);
    return { keys: vi.fn(async () => [...left]), delete: vi.fn(async (n) => left.delete(n)), left };
  };

  it("deletes every build's catalog and image caches and keeps the app shell and foreign caches", async () => {
    const s = storage(["crwn-shell-b1", "crwn-api-b1", "crwn-thumbs-b1", "crwn-api-b0", "someone-else"]);
    expect(await clearRuntimeCaches(s)).toBe(3);
    expect([...s.left]).toEqual(["crwn-shell-b1", "someone-else"]);
  });

  it("does nothing without Cache Storage (plain http, old browsers) and never throws", async () => {
    expect(await clearRuntimeCaches(undefined)).toBe(0);
    expect(await clearRuntimeCaches({})).toBe(0);
    expect(await clearRuntimeCaches({ keys: async () => Promise.reject(new Error("SecurityError")) })).toBe(0);
  });
});
