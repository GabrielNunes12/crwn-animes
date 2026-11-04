// Images are only ever loaded from our own server (/api/thumbs/…, /api/covers/…): the CSP is
// `img-src 'self' data:` and no third party may learn about a visit before Play (docs/API.md v1.5).

/**
 * `src` when it resolves to this origin, else null (the caller shows its gradient placeholder).
 * Resolving with URL catches every spelling a browser would treat as another host
 * ("//evil.example", "/\\evil.example", "/\t/evil.example", "https://…").
 */
export function sameOriginImage(src, origin = window.location.origin) {
  if (typeof src !== "string" || src.trim() === "") return null;
  try {
    return new URL(src, origin).origin === origin ? src : null;
  } catch {
    return null;
  }
}
