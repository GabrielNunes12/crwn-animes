import { useEffect, useRef } from "react";
import { getBool, SINGLE_KEY_SHORTCUTS_KEY } from "../lib/prefs.js";

export function isTypingTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return false;
}

/** Normalised key id: "N" with Shift → "shift+n"; "?" → "?"; "/" → "/"; "t" → "t". */
export function keyId(e) {
  const k = e.key;
  if (k === "?" || k === "/") return k;
  if (k.length === 1 && /[a-z]/i.test(k)) return `${e.shiftKey ? "shift+" : ""}${k.toLowerCase()}`;
  return k.toLowerCase();
}

/**
 * useShortcuts({ "shift+n": fn, "t": fn, "/": fn }). Ignored while typing in a
 * field, with Ctrl/Meta/Alt held, or when a modal <dialog> is open. Single-key
 * shortcuts are skipped when the user turned them off.
 */
export function useShortcuts(map, enabled = true) {
  const ref = useRef(map);
  useEffect(() => {
    ref.current = map;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    function onKey(e) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector("dialog[open]")) return;
      const id = keyId(e);
      // Single-character shortcuts can be switched off (WCAG 2.1.4); Shift+key ones stay.
      if (!id.startsWith("shift+") && !getBool(SINGLE_KEY_SHORTCUTS_KEY, true)) return;
      const fn = ref.current[id];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
