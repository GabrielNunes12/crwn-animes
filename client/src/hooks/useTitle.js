import { useEffect } from "react";

export function useTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · Crwn Animes` : "Crwn Animes";
  }, [title]);
}
