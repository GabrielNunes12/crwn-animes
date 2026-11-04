import { useEffect } from "react";
import { matchRoutes } from "react-router";

// Route-module prefetch (docs/API.md v1.7): hovering an in-app link for HOVER_DELAY_MS, or
// focusing it, starts downloading the page module(s) of its lazy route(s), so the click
// renders sooner. Module only, never data (loaders run on navigation, as always); never an
// admin page for visitors who are not admins; nothing at all with Save-Data / Lite mode.

export const HOVER_DELAY_MS = 100;

/** True when the visitor asked the browser to save data (navigator.connection.saveData). */
export function saveDataOn(nav = globalThis.navigator) {
  return nav?.connection?.saveData === true;
}

/** Lazy functions already called: each module is requested at most once (until it fails). */
const started = new WeakSet();

/**
 * Starts the module download of every lazy route matching `href` (calls the route's `lazy`,
 * which imports the page module; the browser's module map dedupes it with the navigation's own
 * import). Skips other origins, Save-Data, and routes under a `handle.admin` route unless
 * `isAdmin`. Returns how many downloads it started.
 */
export function prefetchRoute(routes, href, { isAdmin = false, origin = window.location.origin, nav = globalThis.navigator } = {}) {
  if (saveDataOn(nav)) return 0;
  let url;
  try {
    url = new URL(href, origin);
  } catch {
    return 0;
  }
  if (url.origin !== origin) return 0;
  const matches = matchRoutes(routes, url.pathname) ?? [];
  if (!isAdmin && matches.some((m) => m.route.handle?.admin)) return 0;
  let count = 0;
  for (const { route } of matches) {
    const lazy = route.lazy;
    if (typeof lazy !== "function" || started.has(lazy)) continue;
    started.add(lazy);
    // A failed download (offline, deploy in progress) may be tried again on the next hover.
    Promise.resolve()
      .then(lazy)
      .catch(() => started.delete(lazy));
    count += 1;
  }
  return count;
}

/** The in-app link an event happened on, or null (new-tab, download and non-http links are left alone). */
function linkOf(target) {
  const a = target instanceof Element ? target.closest("a[href]") : null;
  if (!a || a.hasAttribute("download") || (a.target && a.target !== "_self")) return null;
  return /^https?:$/.test(a.protocol) ? a : null;
}

/**
 * Prefetches lazy route modules for every link on the page (one set of delegated listeners on
 * `document`): pointer hover ≥ `delay` ms (touch is ignored: the tap navigates right away) or
 * keyboard/programmatic focus.
 */
export function useRoutePrefetch(routes, { isAdmin = false, delay = HOVER_DELAY_MS } = {}) {
  useEffect(() => {
    let timer = null;
    let pending = null;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
      pending = null;
    };
    const prefetch = (a) => prefetchRoute(routes, a.href, { isAdmin });

    const onOver = (e) => {
      if (e.pointerType === "touch") return;
      const a = linkOf(e.target);
      if (a === pending) return; // moving between children of the hovered link
      cancel();
      if (!a) return;
      pending = a;
      timer = setTimeout(() => {
        pending = null;
        timer = null;
        prefetch(a);
      }, delay);
    };
    const onOut = (e) => {
      if (!pending) return;
      if (e.relatedTarget instanceof Node && pending.contains(e.relatedTarget)) return;
      cancel(); // left the link before the delay: no download
    };
    const onFocus = (e) => {
      const a = linkOf(e.target);
      if (a) prefetch(a);
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onFocus);
    return () => {
      cancel();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onFocus);
    };
  }, [routes, isAdmin, delay]);
}
