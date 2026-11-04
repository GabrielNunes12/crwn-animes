// Vite plugin: writes `<file>.br` and `<file>.gz` next to every compressible file of the build
// (docs/API.md v1.7 "Response compression"): the server sends the pre-compressed sibling the
// browser accepts, so assets never have to be compressed per request.
//
// - Which files: JS (route chunks, locale chunks, sw.js), CSS, SVG, HTML and the web manifest,
//   from 1 KB up, including what Vite copied from public/. Fonts (.woff2) and raster images
//   are already compressed and are left alone.
// - When: after everything has been written (closeBundle, last), so it also sees sw.js and the
//   public files. The siblings are files on disk only, never part of the Rollup bundle: the
//   service worker's precache list (vite-plugin-sw.js) keeps naming the original URLs, and the
//   browser undoes Content-Encoding transparently.
// - A sibling is only written when it is actually smaller than the original.
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

export const PRECOMPRESS_MIN_BYTES = 1024;
const COMPRESSIBLE = /\.(?:m?js|css|svg|html|webmanifest)$/i;

/** True for a file the plugin writes .br/.gz siblings for. */
export function shouldPrecompress(file, size) {
  return COMPRESSIBLE.test(file) && size >= PRECOMPRESS_MIN_BYTES;
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

/** Writes the siblings for every eligible file under `dir`; returns the files compressed. */
export async function precompressDir(dir) {
  const done = [];
  await Promise.all(
    listFiles(dir).map(async (file) => {
      const body = fs.readFileSync(file);
      if (!shouldPrecompress(file, body.length)) return;
      const [br, gz] = await Promise.all([
        brotli(body, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          },
        }),
        gzip(body, { level: zlib.constants.Z_BEST_COMPRESSION }),
      ]);
      if (br.length < body.length) fs.writeFileSync(`${file}.br`, br);
      if (gz.length < body.length) fs.writeFileSync(`${file}.gz`, gz);
      done.push(path.relative(dir, file));
    }),
  );
  return done.sort();
}

export function precompressPlugin() {
  let outDir = null;
  return {
    name: "crwn:precompress",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (outDir && fs.existsSync(outDir)) await precompressDir(outDir);
      },
    },
  };
}
