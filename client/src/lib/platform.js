/** True on macOS / iOS, where the palette shortcut is ⌘K instead of Ctrl+K. */
export function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  const p = navigator.userAgentData?.platform || navigator.platform || "";
  return /mac|iphone|ipad|ipod/i.test(p);
}

/** ⌘K on Apple platforms, Ctrl+K elsewhere (any Ctrl/⌘ + K is accepted everywhere). */
export function isPaletteShortcut(e) {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && typeof e.key === "string" && e.key.toLowerCase() === "k";
}
