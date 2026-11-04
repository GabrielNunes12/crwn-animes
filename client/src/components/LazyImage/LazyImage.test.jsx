import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { LazyImage } from "./LazyImage.jsx";
import { sameOriginImage, sameOriginSrcSet, THUMB_SIZES, thumbSrcSetOf } from "../../lib/images.js";
import { VideoCard } from "../Cards/VideoCard.jsx";
import { ContinueCard } from "../Cards/ContinueCard.jsx";
import { Player } from "../Player/Player.jsx";
import { renderApp } from "../../test/utils.jsx";

const ORIGIN = "https://crwn.example";

describe("sameOriginImage", () => {
  it("keeps paths on our own server", () => {
    expect(sameOriginImage("/api/thumbs/dQw4w9WgXcQ.jpg", ORIGIN)).toBe("/api/thumbs/dQw4w9WgXcQ.jpg");
    expect(sameOriginImage("/api/covers/12.img?v=1a2b3c4d", ORIGIN)).toBe("/api/covers/12.img?v=1a2b3c4d");
    expect(sameOriginImage(`${ORIGIN}/api/covers/1.img`, ORIGIN)).toBe(`${ORIGIN}/api/covers/1.img`);
  });

  it("drops other hosts, however they are spelled, and empty values", () => {
    for (const src of [
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      "https://img1.ak.crunchyroll.com/x.jpg",
      "//evil.example/x.jpg",
      "/\\evil.example/x.jpg",
      "/\t/evil.example/x.jpg",
      "http://crwn.example/api/covers/1.img", // other scheme = other origin
      "data:image/png;base64,AAAA",
      "",
      "   ",
      null,
      undefined,
      42,
    ]) {
      expect(sameOriginImage(src, ORIGIN), String(src)).toBeNull();
    }
  });
});

describe("<LazyImage> — the one placeholder for missing, foreign or broken images", () => {
  const placeholder = (container) => container.querySelector('[data-state="error"] [aria-hidden="true"]');

  it("renders a same-origin image", () => {
    const { container } = render(<LazyImage src="/api/thumbs/dQw4w9WgXcQ.jpg" alt="" fallbackLabel="One Piece" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "/api/thumbs/dQw4w9WgXcQ.jpg");
    expect(placeholder(container)).toBeNull();
  });

  it("null (e.g. a trashed video's thumbnail) → gradient placeholder with initials, no <img>", () => {
    const { container } = render(<LazyImage src={null} alt="" fallbackLabel="One Piece" />);
    expect(container.querySelector("img")).toBeNull();
    expect(placeholder(container)).toHaveTextContent("OP");
  });

  it("an external URL is never requested: placeholder instead", () => {
    const { container } = render(<LazyImage src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" alt="" fallbackLabel="Naruto" />);
    expect(container.querySelector("img")).toBeNull();
    expect(placeholder(container)).toHaveTextContent("NA");
  });

  it("a load error (502 from the proxy) swaps in the placeholder", () => {
    const { container } = render(<LazyImage src="/api/covers/3.img?v=x" alt="Cover" fallbackLabel="Bleach" />);
    fireEvent.error(container.querySelector("img"));
    expect(container.querySelector("img")).toBeNull();
    expect(placeholder(container)).toHaveTextContent("BL");
  });

  it("`fill` covers the positioned parent instead of reserving an aspect ratio", () => {
    const { container } = render(<LazyImage src="/api/thumbs/dQw4w9WgXcQ.jpg" fill eager fetchPriority="high" />);
    const frame = container.firstChild;
    expect(frame).toHaveAttribute("data-fill", "true");
    expect(frame.style.aspectRatio).toBe("");
    expect(container.querySelector("img")).toHaveAttribute("loading", "eager");
    expect(container.querySelector("img")).toHaveAttribute("fetchpriority", "high");
  });
});

describe("responsive thumbnails: srcset + sizes (docs/API.md v1.7)", () => {
  const SRCSET = "/api/thumbs/dQw4w9WgXcQ-m.jpg 320w, /api/thumbs/dQw4w9WgXcQ.jpg 480w";

  it("sameOriginSrcSet keeps an all-same-origin srcset and drops any with a foreign or malformed candidate", () => {
    expect(sameOriginSrcSet(SRCSET, ORIGIN)).toBe(SRCSET);
    expect(sameOriginSrcSet(" /a.jpg 1x ,/b.jpg 2x ", ORIGIN)).toBe("/a.jpg 1x, /b.jpg 2x");
    for (const bad of [
      "/api/thumbs/dQw4w9WgXcQ-m.jpg 320w, https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg 480w",
      "//evil.example/x.jpg 320w",
      "/a.jpg 320w,, /b.jpg 480w",
      "/a.jpg 320w 2x",
      "/a.jpg big",
      "data:image/png;base64,AAAA 1x",
      "",
      null,
      undefined,
    ]) {
      expect(sameOriginSrcSet(bad, ORIGIN), String(bad)).toBeNull();
    }
  });

  it("renders srcset and sizes on the <img>, with explicit width/height and lazy loading", () => {
    const { container } = render(<LazyImage src="/api/thumbs/dQw4w9WgXcQ.jpg" srcSet={SRCSET} sizes="7.5rem" width={160} height={90} />);
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("srcset", SRCSET);
    expect(img).toHaveAttribute("sizes", "7.5rem");
    expect(img).toHaveAttribute("width", "160");
    expect(img).toHaveAttribute("height", "90");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).not.toHaveAttribute("fetchpriority");
    expect(container.firstChild.style.aspectRatio).toBe("16 / 9");
  });

  it("a foreign srcset is dropped (the plain src still loads); no src means no srcset either", () => {
    const foreign = render(<LazyImage src="/api/thumbs/dQw4w9WgXcQ.jpg" srcSet="https://i.ytimg.com/x.jpg 480w" sizes="6rem" />);
    expect(foreign.container.querySelector("img")).not.toHaveAttribute("srcset");
    expect(foreign.container.querySelector("img")).not.toHaveAttribute("sizes");
    const none = render(<LazyImage src={null} srcSet={SRCSET} fallbackLabel="One Piece" />);
    expect(none.container.querySelector("img")).toBeNull();
  });

  it("thumbSrcSetOf derives the 320w + 480w pair from our own thumbnail URL only", () => {
    expect(thumbSrcSetOf("/api/thumbs/dQw4w9WgXcQ.jpg")).toBe(SRCSET);
    expect(thumbSrcSetOf("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")).toBeNull();
    expect(thumbSrcSetOf(null)).toBeNull();
  });
});

describe("every thumbnail passes Video.thumbnailSrcSet with a layout `sizes`", () => {
  const video = {
    id: 7,
    youtubeVideoId: "dQw4w9WgXcQ",
    title: "The one",
    thumbnailUrl: "/api/thumbs/dQw4w9WgXcQ.jpg",
    thumbnailSrcSet: "/api/thumbs/dQw4w9WgXcQ-m.jpg 320w, /api/thumbs/dQw4w9WgXcQ.jpg 480w",
    section: "anime",
    seriesName: "OP",
    seriesSlug: "op",
    season: 1,
    number: 1,
    route: "/anime/op/episode/1",
    rating: { average: null, count: 0 },
  };

  it("VideoCard (card rows and grids)", () => {
    renderApp(<VideoCard video={video} />);
    const img = document.querySelector("img");
    expect(img).toHaveAttribute("srcset", video.thumbnailSrcSet);
    expect(img).toHaveAttribute("sizes", THUMB_SIZES.card);
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("ContinueCard derives it from the stored thumbnail", () => {
    renderApp(<ContinueCard entry={{ youtubeVideoId: "dQw4w9WgXcQ", t: 30, d: 100, route: video.route, title: "OP", thumb: video.thumbnailUrl }} onRemove={() => {}} />);
    const img = document.querySelector("img");
    expect(img).toHaveAttribute("srcset", video.thumbnailSrcSet);
    expect(img).toHaveAttribute("sizes", THUMB_SIZES.card);
    expect(img).toHaveAttribute("width", "480");
    expect(img).toHaveAttribute("height", "270");
  });

  it("the player poster is the page's one high-priority, eager image", () => {
    renderApp(<Player video={video} />);
    const img = document.querySelector("img");
    expect(img).toHaveAttribute("srcset", video.thumbnailSrcSet);
    expect(img).toHaveAttribute("sizes", THUMB_SIZES.player);
    expect(img).toHaveAttribute("fetchpriority", "high");
    expect(img).toHaveAttribute("loading", "eager");
  });

  it("a video without thumbnail (null srcset) gets the placeholder", () => {
    renderApp(<VideoCard video={{ ...video, thumbnailUrl: null, thumbnailSrcSet: null }} />);
    expect(document.querySelector("img")).toBeNull();
  });
});
