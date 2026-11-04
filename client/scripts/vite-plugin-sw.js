// Vite plugin: builds src/sw/sw.js into <outDir>/sw.js — one classic (non-module) script —
// with the build id and the precache list injected. No Workbox: the worker is hand-written.
//
// - Build id: a hash of every emitted file name (Vite names carry content hashes), index.html,
//   the public files and the worker's own sources. Same inputs → same id → no needless update.
// - Precache: the shell ("/"), the static files the offline page and the shell need, every
//   JS/CSS file a visitor can reach (admin pages excluded) and the Latin font subsets; anything
//   else under /assets/ is cached on first use.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { build } from "vite";
import { SHELL_URL, STATIC_URLS } from "../src/sw/strategy.js";

const WORKER_ENTRY = "src/sw/sw.js";
const PRECACHED_FONT = /-latin-wght-normal-[\w-]+\.woff2$/;

/** Files of `dir`, recursively, as sorted relative paths. */
function listFiles(dir, prefix = "") {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = path.posix.join(prefix, entry.name);
      return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
    })
    .sort();
}

const isAdminPage = (chunk) => (chunk.facadeModuleId ?? "").replaceAll("\\", "/").includes("/src/pages/Admin/");

/**
 * JS chunks (and their CSS) reachable from the entry without entering an admin page: what any
 * visitor may need offline. Admin pages and the chunks only they use are cached on first use.
 */
function visitorFiles(bundle) {
  const chunks = new Map(Object.values(bundle).filter((f) => f.type === "chunk").map((c) => [c.fileName, c]));
  const seen = new Set();
  const stack = [...chunks.values()].filter((c) => c.isEntry).map((c) => c.fileName);
  while (stack.length) {
    const chunk = chunks.get(stack.pop());
    if (!chunk || seen.has(chunk.fileName)) continue;
    seen.add(chunk.fileName);
    stack.push(...chunk.imports, ...chunk.dynamicImports.filter((name) => chunks.has(name) && !isAdminPage(chunks.get(name))));
  }
  const files = new Set(seen);
  for (const name of seen) for (const css of chunks.get(name).viteMetadata?.importedCss ?? []) files.add(css);
  return files;
}

export function precacheList(bundle, base = "/") {
  const visitor = visitorFiles(bundle);
  const assets = Object.keys(bundle)
    .filter((name) => name.startsWith("assets/") && (visitor.has(name) || PRECACHED_FONT.test(name)))
    .sort()
    .map((name) => base + name);
  return [SHELL_URL, ...STATIC_URLS, ...assets];
}

async function bundleWorker(root, define) {
  const result = await build({
    configFile: false,
    envFile: false,
    root,
    logLevel: "silent",
    publicDir: false,
    plugins: [],
    define,
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      sourcemap: false,
      minify: true,
      modulePreload: false,
      lib: { entry: path.resolve(root, WORKER_ENTRY), formats: ["iife"], name: "crwnServiceWorker", fileName: () => "sw.js" },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output ?? []);
  const entry = outputs.find((file) => file.type === "chunk" && file.isEntry);
  if (!entry) throw new Error("crwn:service-worker: the worker bundle has no entry chunk");
  return entry.code;
}

export function serviceWorkerPlugin() {
  let config;
  return {
    name: "crwn:service-worker",
    apply: "build",
    enforce: "post",
    configResolved(resolved) {
      config = resolved;
    },
    async generateBundle(_options, bundle) {
      const precache = precacheList(bundle, config.base);
      const hash = createHash("sha256");
      for (const name of Object.keys(bundle).sort()) {
        hash.update(name);
        if (name.endsWith(".html")) hash.update(String(bundle[name].source ?? ""));
      }
      const publicDir = config.publicDir || null;
      for (const rel of listFiles(publicDir)) hash.update(rel).update(fs.readFileSync(path.join(publicDir, rel)));
      const swDir = path.resolve(config.root, path.dirname(WORKER_ENTRY));
      for (const rel of listFiles(swDir).filter((f) => !f.includes(".test."))) hash.update(rel).update(fs.readFileSync(path.join(swDir, rel)));
      const buildId = hash.digest("hex").slice(0, 12);

      const code = await bundleWorker(config.root, {
        __SW_BUILD_ID__: JSON.stringify(buildId),
        __SW_PRECACHE__: JSON.stringify(precache),
      });
      this.emitFile({ type: "asset", fileName: "sw.js", source: `/* Crwn Animes service worker, build ${buildId} */\n${code}` });
    },
  };
}
