// Same-origin series covers (docs/API.md v1.5): GET /api/covers/<seriesId>.img.
// The source is a URL an admin typed, fetched BY THE SERVER, so this is the SSRF
// boundary:
//   - https: only, port 443 only, no user name/password in the URL;
//   - the host name is resolved once and EVERY address must be public unicast
//     (src/netPolicy.js); the connection is pinned to that validated address (a
//     custom `lookup` handed to https.request), so a DNS answer that changes
//     between check and connect (rebinding) is never used. TLS still verifies
//     the certificate against the host name (SNI);
//   - no redirects (https.request never follows them; any non-200 is refused);
//   - 200 with image/jpeg|png|webp|avif whose bytes really are that type, at
//     most 2 MB (refused from Content-Length, or cut off while streaming);
//   - 5 s for everything (lookup included).
// Every failure is the same 502: nothing about the host, address or answer.
import { createHash } from "node:crypto";
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { IMAGE_TYPES, abortion, createImageSource, mediaType, sniffImageType, upstreamError } from "./imageCache.js";
import { isPublicAddress } from "./netPolicy.js";

export const COVER_MAX_BYTES = 2 * 1024 * 1024;
export const COVER_TIMEOUT_MS = 5000;
const ACCEPT = Object.keys(IMAGE_TYPES).join(",");
const USER_AGENT = "Mozilla/5.0 (compatible; CrwnAnimesCovers/1.0)";

/** 8 hex characters of SHA-256(source URL): the ?v= of Series.coverUrl and part of the cache key. */
export const coverHash = (sourceUrl) => createHash("sha256").update(sourceUrl).digest("hex").slice(0, 8);
/** Series.coverUrl for a series whose cover source is `sourceUrl`. */
export const coverPath = (seriesId, sourceUrl) => `/api/covers/${seriesId}.img?v=${coverHash(sourceUrl)}`;
/** The image cache key of that cover. */
export const coverKey = (seriesId, sourceUrl) => `cover-${seriesId}-${coverHash(sourceUrl)}`;
/** { seriesId, hash } of a cover cache key, or null for any other key. */
export function parseCoverKey(key) {
  const match = /^cover-([1-9]\d{0,15})-([0-9a-f]{8})$/.exec(key);
  return match ? { seriesId: Number(match[1]), hash: match[2] } : null;
}

/** The parts of an admin-typed URL we may fetch, or null (not https, not port 443, credentials, ...). */
export function coverTarget(sourceUrl) {
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  // WHATWG URL drops the default port, so "" is 443; it also normalises IPv4 spellings (0x7f.1 -> 127.0.0.1).
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password || !url.hostname) return null;
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  return { hostname, path: `${url.pathname}${url.search}` };
}

/** The address to connect to: the host's own if it is an IP literal, else every DNS answer must be public. */
async function resolvePublic(hostname, lookup) {
  const family = net.isIP(hostname);
  const answers = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true });
  if (!Array.isArray(answers) || answers.length === 0) throw upstreamError();
  for (const { address } of answers) if (!isPublicAddress(address)) throw upstreamError();
  const { address, family: answerFamily } = answers[0];
  return { address, family: answerFamily === 6 || net.isIPv6(address) ? 6 : 4 };
}

/** One GET over a connection pinned to `pinned`; resolves { body, type } or rejects. */
function download(target, pinned, { request, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      req?.destroy();
      reject(upstreamError());
    };
    // net.connect asks for one address, or for all of them (autoSelectFamily): only ever the validated one.
    const lookup = (hostname, options, callback) => {
      if (typeof options === "function") [options, callback] = [{}, options];
      if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    };
    let req = null;
    try {
      req = request(
        {
          protocol: "https:",
          hostname: target.hostname,
          port: 443,
          method: "GET",
          path: target.path,
          headers: { accept: ACCEPT, "user-agent": USER_AGENT },
          lookup,
          agent: false, // a fresh connection every time: never one pinned for another host
          signal,
        },
        (res) => {
          const type = mediaType(res.headers["content-type"]);
          const declared = Number(res.headers["content-length"] ?? 0);
          if (res.statusCode !== 200 || !IMAGE_TYPES[type] || declared > maxBytes) {
            res.resume();
            return fail();
          }
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxBytes) return fail();
            chunks.push(chunk);
          });
          res.on("error", fail);
          res.on("aborted", fail);
          res.on("end", () => {
            if (settled) return;
            const body = Buffer.concat(chunks, size);
            if (sniffImageType(body) !== type) return fail();
            settled = true;
            resolve({ body, type });
          });
        }
      );
      req.on("error", fail);
      req.end();
    } catch {
      fail();
    }
  });
}

/**
 * The default `fetchCover(sourceUrl)`: { body, type } or an HttpError 502.
 * `lookup` (dns.promises.lookup) and `request` (https.request) are injectable for tests.
 */
export async function fetchCover(
  sourceUrl,
  { lookup = dns.promises.lookup, request = https.request, timeoutMs = COVER_TIMEOUT_MS, maxBytes = COVER_MAX_BYTES } = {}
) {
  const target = coverTarget(sourceUrl);
  if (!target) throw upstreamError();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const pinned = await Promise.race([resolvePublic(target.hostname, lookup), abortion(signal)]);
    return await Promise.race([download(target, pinned, { request, signal, maxBytes }), abortion(signal)]);
  } catch {
    throw upstreamError();
  }
}

/**
 * Covers into the shared image cache. `get(seriesId, sourceUrl, { onMiss })` -> { body, type };
 * the key carries the URL's hash, so a new source URL is a new fetch (and a fresh failure memory).
 */
export function createCoverSource({ cache, fetchCover: fetchOne = fetchCover, ...options }) {
  const source = createImageSource({
    cache,
    maxBytes: COVER_MAX_BYTES,
    fetch: (key, sourceUrl) => fetchOne(sourceUrl), // requests sharing a key share the URL (its hash is in the key)
    ...options,
  });
  return {
    ...source,
    get: (seriesId, sourceUrl, { onMiss } = {}) => source.get(coverKey(seriesId, sourceUrl), { onMiss, context: sourceUrl }),
  };
}
