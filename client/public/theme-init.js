// Runs in <head> before first paint (external file: the CSP forbids inline scripts).
(function () {
  // Applies the saved theme.
  try {
    var t = localStorage.getItem("crwn:theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch {
    /* storage unavailable */
  }

  // Starts downloading the visitor's dictionary chunk now, with the entry bundle, instead of
  // after it has run (docs/API.md v1.7). The build lists the chunks in
  // <meta name="crwn-locale-chunks" content="en=/assets/en-….js pt-BR=/assets/pt-BR-….js">.
  // Same choice as detectLocale() in src/i18n/core.js: the saved locale, else the first
  // pt*/en* browser language, else pt-BR. A wrong guess only costs one unused download.
  try {
    var meta = document.querySelector('meta[name="crwn-locale-chunks"]');
    if (!meta) return;
    var urls = {};
    meta.content.split(" ").forEach(function (pair) {
      var at = pair.indexOf("=");
      if (at > 0) urls[pair.slice(0, at)] = pair.slice(at + 1);
    });
    var locale = null;
    try {
      locale = localStorage.getItem("crwn:locale");
    } catch {
      /* storage unavailable */
    }
    if (locale !== "pt-BR" && locale !== "en") {
      locale = "pt-BR";
      var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
      for (var i = 0; i < langs.length; i++) {
        var l = String(langs[i]).toLowerCase();
        if (l.indexOf("pt") === 0) break;
        if (l.indexOf("en") === 0) {
          locale = "en";
          break;
        }
      }
    }
    var href = urls[locale];
    if (!href || href.charAt(0) !== "/" || href.charAt(1) === "/") return; // same-origin paths only
    var link = document.createElement("link");
    link.rel = "modulepreload";
    link.crossOrigin = "";
    link.href = href;
    document.head.appendChild(link);
  } catch {
    /* hints are optional */
  }
})();
