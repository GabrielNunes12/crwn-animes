// Service worker registration and the "new version" update flow (docs/API.md v1.5).
// Registered only in production builds, after the page has loaded. When a new worker is
// installed and waiting, `getWaitingRegistration()` holds its registration and the
// <UpdateToast> offers "Update": it posts SKIP_WAITING and reloads once the new worker
// takes control.

export const SW_URL = "/sw.js";
/** How often an open tab asks the server for a newer sw.js. */
export const UPDATE_CHECK_MS = 60 * 60 * 1000;

let waitingRegistration = null;
const listeners = new Set();
/** Containers that already reload on controllerchange (a second click must not reload twice). */
const armed = new WeakSet();

function setWaiting(registration) {
  if (waitingRegistration === registration) return;
  waitingRegistration = registration;
  for (const fn of listeners) fn();
}

/** For useSyncExternalStore: the registration whose `waiting` worker is ready to take over, or null. */
export function getWaitingRegistration() {
  return waitingRegistration;
}

export function subscribeWaiting(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Hides the toast (the waiting worker still takes over once every tab of the app is closed). */
export function dismissUpdate() {
  setWaiting(null);
}

/**
 * Tracks `registration` for an update: a worker that finishes installing while another one
 * controls the page is waiting for us. The very first install (no controller yet) is not
 * an update. `container` is navigator.serviceWorker.
 */
export function watchRegistration(registration, container) {
  const check = () => {
    if (registration.waiting && container.controller) setWaiting(registration);
  };
  check();
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed") check();
    });
  });
  // Another tab applied the update: nothing is waiting any more.
  container.addEventListener("controllerchange", () => {
    if (waitingRegistration === registration && !registration.waiting) setWaiting(null);
  });
}

/**
 * "Update": tells the waiting worker to activate, then reloads exactly once when it has taken
 * control (controllerchange can fire more than once). Returns false when nothing is waiting.
 */
export function applyUpdate(registration, { container = navigator.serviceWorker, reload = () => window.location.reload() } = {}) {
  const worker = registration?.waiting;
  if (!worker || !container) return false;
  if (!armed.has(container)) {
    armed.add(container);
    let reloading = false;
    container.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      reload();
    });
  }
  worker.postMessage({ type: "SKIP_WAITING" });
  return true;
}

/**
 * Registers /sw.js after the load event, in production only. Never throws: the app works the
 * same without a service worker. Resolves with the registration, or null.
 */
export function registerServiceWorker({ prod = import.meta.env.PROD, nav = navigator, win = window } = {}) {
  const container = nav?.serviceWorker;
  if (!prod || !container) return Promise.resolve(null);
  return new Promise((resolve) => {
    const start = async () => {
      try {
        const registration = await container.register(SW_URL, { scope: "/" });
        watchRegistration(registration, container);
        win.setInterval(() => registration.update().catch(() => {}), UPDATE_CHECK_MS);
        resolve(registration);
      } catch {
        resolve(null); // e.g. blocked by the browser or private mode
      }
    };
    if (win.document.readyState === "complete") start();
    else win.addEventListener("load", start, { once: true });
  });
}
