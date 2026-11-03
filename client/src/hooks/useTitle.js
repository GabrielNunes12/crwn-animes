import { useEffect } from "react";
import { useT } from "../i18n/useT.js";

export const SITE_NAME = "Crwn Animes";

/** Full document title: "Page · Crwn Animes", or just the site name. */
export function fullTitle(title) {
  return title ? `${title} · ${SITE_NAME}` : SITE_NAME;
}

function setMetaDescription(content) {
  let el = document.head.querySelector('meta[name="description"]');
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", "description");
    document.head.append(el);
  }
  el.setAttribute("content", content);
}

/**
 * Sets the exact document title and <meta name="description">, so both stay
 * right after client-side navigation. In pt-BR they match what the server
 * renders on first load (server/src/seo.js, docs/API.md v1.2). Pages without
 * their own description get the site default.
 */
export function useMeta({ title, description }) {
  const { t } = useT();
  const desc = description || t("meta.default");
  useEffect(() => {
    document.title = title || SITE_NAME;
    setMetaDescription(desc);
  }, [title, desc]);
}

/** useTitle("Page", description?) → "Page · Crwn Animes". */
export function useTitle(title, description) {
  useMeta({ title: fullTitle(title), description });
}
