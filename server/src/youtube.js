import { HttpError } from "./errors.js";

// Reads a video's title and channel through YouTube's public oEmbed endpoint.
// No API key needed. oEmbed also answers "can this be embedded?": it returns
// 401/403 for private videos and videos whose owner turned embedding off,
// which would never play on our site anyway.
export async function fetchVideoInfo(youtubeVideoId, { fetchImpl = globalThis.fetch } = {}) {
  const watchUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`;

  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new HttpError(
      502,
      "Could not reach YouTube to read the video title. Send `title` with the request to classify it anyway."
    );
  }
  if (response.status === 404 || response.status === 400) {
    throw new HttpError(404, "YouTube has no public video with this ID.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(422, "This video is private or its owner does not allow embedding, so it cannot play here.");
  }
  if (!response.ok) {
    throw new HttpError(502, `YouTube answered with HTTP ${response.status}.`);
  }
  const data = await response.json();
  return { title: data.title, channel: data.author_name ?? null };
}
