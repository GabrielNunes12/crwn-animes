// Response compression (docs/API.md v1.7). Two parts, one negotiation:
//
// - servePrecompressed(): built files with a `<file>.br` / `<file>.gz` sibling (written by
//   the client build) are answered with the sibling the browser accepts — no CPU per
//   request. Content-Type and cache headers are the original file's, the ETag names the
//   encoding (so it differs per encoding), Range is ignored for a variant (a 200).
// - compressPublic(): everything else that is PUBLIC and text is compressed on the fly
//   (brotli, else gzip, node:zlib streams): the server-rendered HTML shell, sitemaps,
//   robots.txt, uncompressed static files (sw.js, the manifest, offline.html, SVG) and API
//   JSON whose Cache-Control starts with "public". Anything private/no-store is NEVER
//   compressed (BREACH-style length side channels: auth, me, admin, ratings, errors),
//   and neither are images or bodies under 1 KB.
//
// Accept-Encoding: q-values honoured; the highest q wins, ties go br > gzip > identity;
// "*" covers codings not listed; identity stays acceptable unless excluded. When nothing
// is acceptable the original is sent anyway (never a 406).
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

export const COMPRESS_MIN_BYTES = 1024;
/** Codings by preference (ties); identity is the uncompressed original. */
const PREFERENCE = ["br", "gzip", "identity"];
const SIBLING_EXT = { br: ".br", gzip: ".gz" };

/** Content types worth compressing: text, JSON/XML (and their +json/+xml), JS, the manifest, SVG. */
const COMPRESSIBLE_TYPE =
  /^\s*(?:text\/(?!event-stream\b)[\w.+-]+|application\/(?:json|javascript|ecmascript|xml|[\w.-]+\+(?:json|xml))|image\/svg\+xml)\s*(?:;|$)/i;
/** Never compressed whatever their headers say: per-user API routes (and the dev outbox). */
const PRIVATE_API = /^\/api\/(?:auth|me|admin|dev)(?:[/?#]|$)|^\/api\/videos\/[^/?#]+\/rating(?:[/?#]|$)/i;
const API = /^\/api(?:[/?#]|$)/i;
/** Responses whose Cache-Control forbids it, or that are not shared with everyone. */
const NOT_PUBLIC = /(?:^|,)\s*(?:private|no-store|no-transform)\s*(?:[,=]|$)/i;
/** Requests for images (a 304 has lost its Content-Type, so the path decides). */
const IMAGE_PATH = /^\/api\/(?:thumbs|covers)\/|\.(?:png|jpe?g|gif|webp|avif|ico|bmp)$/i;
const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Accept-Encoding as Map(coding -> q), codings lowercased ("x-gzip" is gzip); null when the
 * header is absent. Malformed entries (bad token, q outside 0..1 or not a number) are ignored;
 * a coding listed twice keeps its first q.
 */
export function parseAcceptEncoding(header) {
  if (header === undefined || header === null) return null;
  const accepted = new Map();
  for (const entry of String(header).split(",")) {
    const [rawName, ...params] = entry.split(";");
    let name = rawName.trim().toLowerCase();
    if (!TOKEN.test(name)) continue;
    if (name === "x-gzip") name = "gzip";
    let q = 1;
    let valid = true;
    for (const param of params) {
      const at = param.indexOf("=");
      const key = (at < 0 ? param : param.slice(0, at)).trim().toLowerCase();
      if (key !== "q") continue;
      const value = at < 0 ? "" : param.slice(at + 1).trim();
      if (!QVALUE.test(value)) valid = false;
      else q = Number(value);
    }
    if (valid && !accepted.has(name)) accepted.set(name, q);
  }
  return accepted;
}

/**
 * The coding to send: the acceptable one (q > 0) with the highest q among `available`
 * ("br"/"gzip") and identity, ties br > gzip > identity. No header: identity. Nothing
 * acceptable (e.g. "identity;q=0" alone, "*;q=0"): identity, the original (never a 406).
 */
export function chooseEncoding(header, available = ["br", "gzip"]) {
  const accepted = parseAcceptEncoding(header);
  if (!accepted) return "identity";
  const star = accepted.get("*");
  // Identity is acceptable unless excluded; when not listed it ranks with the lowest q listed
  // (as negotiator does), so "gzip;q=0.5" still means gzip. Other codings must be listed (or "*").
  const implicitIdentity = Math.min(1, ...[...accepted.values()].filter((q) => q > 0));
  const qOf = (coding) => {
    if (accepted.has(coding)) return accepted.get(coding);
    if (star !== undefined) return star;
    return coding === "identity" ? implicitIdentity : 0;
  };
  let best = "identity";
  let bestQ = 0;
  for (const coding of PREFERENCE) {
    if (coding !== "identity" && !available.includes(coding)) continue;
    const q = qOf(coding);
    if (q > bestQ) {
      best = coding;
      bestQ = q;
    }
  }
  return best;
}

/** "W/<tag>" for an ETag that is not weak yet: the compressed bytes are not the original's. */
const weaken = (etag) => (typeof etag === "string" && !etag.startsWith("W/") ? `W/${etag}` : etag);

const statFile = async (file) => {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
};

/** True for "/x.br" and "/x.gz": the build's siblings are only ever served as a Content-Encoding. */
export const isSiblingPath = (urlPath) => /\.(?:br|gz)$/i.test(urlPath);

/**
 * Serves `<file>.br` / `<file>.gz` from `root` (GET/HEAD) when the browser accepts it, with
 * Content-Encoding, the ORIGINAL file's Content-Type, `setHeaders(res, originalFile)` (the
 * cache headers express.static would add), `Vary: Accept-Encoding` and a weak ETag naming the
 * encoding. Otherwise (no sibling, identity preferred, a dot segment, index.html) next():
 * express.static sends the original, still with Vary when siblings exist.
 */
export function servePrecompressed(root, { setHeaders = () => {} } = {}) {
  const rootDir = path.resolve(root);
  return async function precompressed(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let decoded;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      return next(); // a malformed escape is answered elsewhere (400)
    }
    const segments = decoded.split("/").filter(Boolean);
    if (
      segments.length === 0 ||
      decoded.includes("\0") ||
      decoded.includes("\\") ||
      segments.some((s) => s.startsWith(".")) || // dotfiles, "." and ".."
      segments.at(-1).toLowerCase() === "index.html" || // the shell always goes through the SEO renderer
      isSiblingPath(decoded)
    ) {
      return next();
    }
    const relative = segments.join("/");
    const file = path.join(rootDir, relative);
    if (!file.startsWith(rootDir + path.sep)) return next();
    if (!(await statFile(file))) return next();
    const variants = {};
    for (const [coding, ext] of Object.entries(SIBLING_EXT)) {
      const stat = await statFile(file + ext);
      if (stat) variants[coding] = stat;
    }
    const available = Object.keys(variants);
    if (available.length === 0) return next();
    res.vary("Accept-Encoding");
    const coding = chooseEncoding(req.headers["accept-encoding"], available);
    if (coding === "identity") return next();

    const stat = variants[coding];
    res.type(path.extname(file)); // what express.static would say for the original
    setHeaders(res, file, stat);
    res.setHeader("Content-Encoding", coding);
    res.setHeader("ETag", `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-${coding}"`);
    // `root` keeps send's dotfile check to the URL part (the build may live under a dot directory).
    const options = { root: rootDir, acceptRanges: false, cacheControl: false, etag: false, lastModified: true };
    res.sendFile(relative + SIBLING_EXT[coding], options, (error) => {
      if (!error || res.headersSent) return;
      // The sibling vanished meanwhile: send the original instead.
      for (const name of ["Content-Encoding", "Content-Type", "ETag", "Last-Modified", "Cache-Control"]) res.removeHeader(name);
      next();
    });
  };
}

/**
 * Compresses public text responses on the fly (see the top of this file). Mount it first:
 * it hooks write()/end() and decides when the first byte goes out, from the final status
 * and headers. A response it leaves alone is passed through untouched.
 */
export function compressPublic({ minBytes = COMPRESS_MIN_BYTES, brotliQuality = 5, gzipLevel = 6 } = {}) {
  return function compression(req, res, next) {
    const { write, end, on } = res;
    let decided = false;
    let stream = null;
    let ended = false;
    let drainListeners = []; // "drain" listeners added before the decision (a pipe() into res)

    /** Whether this response may vary by Accept-Encoding at all (public, text). */
    function eligible() {
      const url = req.originalUrl.split("?")[0]; // req.url is relative to a router while it answers
      if (PRIVATE_API.test(url)) return false;
      if (res.getHeader("Content-Encoding")) return false; // a pre-compressed file (or someone else's)
      const cacheControl = String(res.getHeader("Cache-Control") ?? "");
      if (NOT_PUBLIC.test(cacheControl)) return false;
      // API JSON only when its Cache-Control says so; pages and files outside /api have no per-user content.
      if (API.test(url) && !/^\s*public\b/i.test(cacheControl)) return false;
      const type = res.getHeader("Content-Type");
      if (res.statusCode === 304) return !type ? !IMAGE_PATH.test(url) : COMPRESSIBLE_TYPE.test(type);
      return [200, 203, 404, 410].includes(res.statusCode) && COMPRESSIBLE_TYPE.test(String(type ?? ""));
    }

    function decide(chunk, encoding, isEnd) {
      decided = true;
      if (res.headersSent || !eligible()) return;
      res.vary("Accept-Encoding"); // also on 304s, small bodies and identity answers: the same URL can vary
      if (req.method === "HEAD" || res.statusCode === 304) return;
      const declared = res.getHeader("Content-Length");
      const length = declared !== undefined ? Number(declared) : isEnd ? byteLength(chunk, encoding) : Infinity;
      if (length < minBytes) return;
      const coding = chooseEncoding(req.headers["accept-encoding"]);
      if (coding === "identity") return;

      stream =
        coding === "br"
          ? zlib.createBrotliCompress({
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
                ...(Number.isFinite(length) ? { [zlib.constants.BROTLI_PARAM_SIZE_HINT]: length } : {}),
              },
            })
          : zlib.createGzip({ level: gzipLevel });
      res.setHeader("Content-Encoding", coding);
      res.removeHeader("Content-Length");
      res.removeHeader("Accept-Ranges"); // byte ranges would be of the uncompressed file
      if (res.getHeader("ETag")) res.setHeader("ETag", weaken(res.getHeader("ETag")));
      stream.on("data", (data) => {
        if (write.call(res, data) === false) stream.pause();
      });
      stream.on("end", () => end.call(res));
      stream.on("error", (error) => res.destroy(error));
      on.call(res, "drain", () => stream.resume());
    }

    // A pipe() into res waits for "drain" once write() returns false (it adds the listener then):
    // while compressing, that is the zlib stream's drain, for the whole response.
    res.on = function (type, listener) {
      if (type !== "drain") return on.call(this, type, listener);
      if (stream) stream.on(type, listener);
      else if (drainListeners) drainListeners.push(listener);
      else on.call(this, type, listener);
      return this;
    };
    const flushDrainListeners = () => {
      for (const listener of drainListeners) (stream ?? res).on("drain", listener);
      drainListeners = null;
      if (!stream) res.on = on; // passed through: nothing to redirect any more
    };

    res.write = function (chunk, encoding, callback) {
      if (ended) return false;
      if (!decided) {
        decide(chunk, encoding, false);
        flushDrainListeners();
      }
      if (!stream) return write.call(this, chunk, encoding, callback);
      if (typeof encoding === "function") [encoding, callback] = [undefined, encoding];
      return stream.write(toBuffer(chunk, encoding), callback);
    };

    res.end = function (chunk, encoding, callback) {
      if (typeof chunk === "function") [chunk, encoding, callback] = [undefined, undefined, chunk];
      else if (typeof encoding === "function") [encoding, callback] = [undefined, encoding];
      if (ended) return this;
      if (!decided) {
        decide(chunk, encoding, true);
        flushDrainListeners();
      }
      if (!stream) return end.call(this, chunk, encoding, callback);
      ended = true;
      if (callback) this.once("finish", callback);
      if (chunk !== undefined && chunk !== null && byteLength(chunk, encoding) > 0) stream.end(toBuffer(chunk, encoding));
      else stream.end();
      return this;
    };

    next();
  };
}

const toBuffer = (chunk, encoding) => (typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
const byteLength = (chunk, encoding) =>
  chunk === undefined || chunk === null ? 0 : typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
