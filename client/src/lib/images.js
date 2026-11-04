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

const DESCRIPTOR = /^(?:\d+w|\d+(?:\.\d+)?x)$/;

/**
 * A `srcset` (e.g. Video.thumbnailSrcSet, docs/API.md v1.7:
 * "/api/thumbs/<id>-m.jpg 320w, /api/thumbs/<id>.jpg 480w") when EVERY candidate is on this
 * origin with at most one width/density descriptor; otherwise null, and the image falls back
 * to its plain `src`. One foreign candidate would let the browser pick a third-party URL.
 */
export function sameOriginSrcSet(srcset, origin = window.location.origin) {
  if (typeof srcset !== "string" || srcset.trim() === "") return null;
  const candidates = srcset.split(",").map((c) => c.trim());
  if (candidates.some((c) => c === "")) return null;
  for (const candidate of candidates) {
    const [url, ...descriptors] = candidate.split(/\s+/);
    if (!sameOriginImage(url, origin)) return null;
    if (descriptors.length > 1 || (descriptors.length === 1 && !DESCRIPTOR.test(descriptors[0]))) return null;
  }
  return candidates.join(", ");
}

/**
 * `sizes` of each thumbnail layout: the CSS width the image is shown at, so the browser picks
 * the 320w file where it is enough. Kept in step with the layout CSS:
 *   card   — VideoCard / ContinueCard in .row-scroll (≤ 18rem columns) and .grid-videos
 *            (2 columns on phones, ≥ 15rem columns from 40rem): never wider than 18rem;
 *   row    — Series episode list (.item: 7.5rem column);
 *   side   — Watch side list (.sideItem: 6rem column);
 *   admin  — admin lists and the series board (≤ 160px);
 *   player — the poster fills the player: full width on phones, the main column on desktop.
 */
export const THUMB_SIZES = {
  card: "(min-width: 40rem) 18rem, 14rem",
  row: "7.5rem",
  side: "6rem",
  admin: "160px",
  player: "(min-width: 64rem) 58rem, 100vw",
};

/** srcset of our own thumbnail URL (/api/thumbs/<id>.jpg → its 320w + 480w files), else null. */
export function thumbSrcSetOf(thumbUrl) {
  const id = /^\/api\/thumbs\/([A-Za-z0-9_-]{11})\.jpg$/.exec(thumbUrl ?? "")?.[1];
  return id ? `/api/thumbs/${id}-m.jpg 320w, /api/thumbs/${id}.jpg 480w` : null;
}
