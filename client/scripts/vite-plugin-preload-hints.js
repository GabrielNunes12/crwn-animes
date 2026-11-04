// Vite plugin: resource hints in index.html (docs/API.md v1.7), production builds only (the
// hashed file names exist only there). They let the browser fetch, while the entry bundle is
// still downloading, files it would otherwise only discover after running it:
//
// - <link rel="preload" as="font"> for the Latin subset of the two self-hosted variable fonts.
//   @fontsource's CSS declares every subset with `unicode-range` and `font-display: swap`; all
//   pt-BR / en text is Latin, the other subsets still load on demand.
// - <link rel="modulepreload"> for the `catalog` chunk (vite.config.js) that every catalog page
//   (home, sections, series, episode, genre, search) imports.
// - <meta name="crwn-locale-chunks"> mapping each locale to its dictionary chunk: /theme-init.js,
//   the classic script that already runs in <head> before anything else, modulepreloads the
//   visitor's one (same detection as src/i18n/core.js detectLocale). The dictionary then arrives
//   with the entry instead of one round trip after it.
export const PRELOADED_FONT = /^assets\/(?:inter|outfit)-latin-wght-normal-[\w-]+\.woff2$/;
export const LOCALE_META = "crwn-locale-chunks";
const LOCALE_SOURCE = /[\\/]src[\\/]i18n[\\/]([\w-]+)\.json$/;

/** The hints for a Rollup/Rolldown output bundle: { fonts, modules, locales: { locale: url } }. */
export function preloadHints(bundle, base = "/") {
  const files = Object.values(bundle);
  const fonts = files.filter((f) => f.type === "asset" && PRELOADED_FONT.test(f.fileName)).map((f) => base + f.fileName);
  const modules = files.filter((f) => f.type === "chunk" && f.name === "catalog" && !f.isEntry).map((f) => base + f.fileName);
  const locales = {};
  for (const f of files) {
    const locale = f.type === "chunk" ? LOCALE_SOURCE.exec(f.facadeModuleId ?? "")?.[1] : null;
    if (locale) locales[locale] = base + f.fileName;
  }
  return { fonts: fonts.sort(), modules: modules.sort(), locales };
}

export function preloadHintsPlugin() {
  let base = "/";
  return {
    name: "crwn:preload-hints",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const { fonts, modules, locales } = preloadHints(ctx.bundle ?? {}, base);
        const tags = [];
        const pairs = Object.entries(locales).sort(([a], [b]) => a.localeCompare(b));
        // Before /theme-init.js, which reads it.
        if (pairs.length) tags.push({ tag: "meta", attrs: { name: LOCALE_META, content: pairs.map(([l, url]) => `${l}=${url}`).join(" ") }, injectTo: "head-prepend" });
        for (const href of modules) tags.push({ tag: "link", attrs: { rel: "modulepreload", crossorigin: "", href }, injectTo: "head" });
        // Fonts are always fetched in CORS mode: without `crossorigin` the preload would not be reused.
        for (const href of fonts) tags.push({ tag: "link", attrs: { rel: "preload", href, as: "font", type: "font/woff2", crossorigin: "" }, injectTo: "head" });
        return tags;
      },
    },
  };
}
