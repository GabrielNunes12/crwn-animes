import { useEffect } from "react";

/**
 * `<meta name="robots" content="noindex">` while the page is mounted (admin board, draft
 * preview). The server already sends it on a first load of /admin*; this keeps it right after
 * client-side navigation too, and puts back whatever was there before on unmount.
 */
export function useNoIndex() {
  useEffect(() => {
    let el = document.head.querySelector('meta[name="robots"]');
    const created = !el;
    const previous = el?.getAttribute("content");
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute("name", "robots");
      document.head.append(el);
    }
    el.setAttribute("content", "noindex");
    return () => {
      if (created) el.remove();
      else el.setAttribute("content", previous ?? "");
    };
  }, []);
}
