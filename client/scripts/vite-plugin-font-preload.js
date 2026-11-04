// Vite plugin: <link rel="preload" as="font"> for the Latin subset of the self-hosted variable
// fonts (docs/API.md v1.7). @fontsource's CSS declares every subset with `unicode-range` and
// `font-display: swap`; a browser only discovers the file it needs after the stylesheet has
// loaded and text has been laid out. All pt-BR / en text is in the Latin subset, so its files
// are requested together with the stylesheet instead. Production builds only (the hashed
// file names exist only there); the other subsets still load on demand.
export const PRELOADED_FONT = /^assets\/(?:inter|outfit)-latin-wght-normal-[\w-]+\.woff2$/;

export function fontPreloadPlugin() {
  let base = "/";
  return {
    name: "crwn-font-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        return Object.keys(ctx.bundle ?? {})
          .filter((name) => PRELOADED_FONT.test(name))
          .sort()
          .map((name) => ({
            tag: "link",
            // Fonts are always fetched in CORS mode: without `crossorigin` the preload would not be reused.
            attrs: { rel: "preload", href: base + name, as: "font", type: "font/woff2", crossorigin: "" },
            injectTo: "head",
          }));
      },
    },
  };
}
