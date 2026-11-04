// Script of /offline.html (a file because the CSP forbids inline scripts; the service worker
// precaches both). Picks the language like the app does (saved choice, then navigator.languages,
// default pt-BR), applies the saved theme and wires "Try again" + reload when back online.
(function () {
  var root = document.documentElement;
  var saved = {};
  try {
    saved.locale = localStorage.getItem("crwn:locale");
    saved.theme = localStorage.getItem("crwn:theme");
  } catch {
    /* storage unavailable */
  }
  if (saved.theme === "light" || saved.theme === "dark") root.dataset.theme = saved.theme;

  var lang = saved.locale === "en" || saved.locale === "pt-BR" ? saved.locale : null;
  var languages = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
  for (var i = 0; !lang && i < languages.length; i++) {
    var l = String(languages[i]).toLowerCase();
    if (l.indexOf("pt") === 0) lang = "pt-BR";
    else if (l.indexOf("en") === 0) lang = "en";
  }
  lang = lang || "pt-BR";
  root.lang = lang;
  document.title = lang === "en" ? "You're offline · Crwn Animes" : "Você está offline · Crwn Animes";

  function retry() {
    window.location.reload();
  }
  function wire() {
    var button = document.getElementById("retry");
    if (button) button.addEventListener("click", retry);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
  window.addEventListener("online", retry);
})();
