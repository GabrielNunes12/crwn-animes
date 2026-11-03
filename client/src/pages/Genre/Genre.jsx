import { Link, useParams, useSearchParams } from "react-router";
import { SearchResults } from "../../components/SearchResults/SearchResults.jsx";
import { useGenres } from "../../hooks/useGenres.js";
import { useSearchResults } from "../../hooks/useSearchResults.js";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import styles from "./Genre.module.css";

const GENRE_SORTS = ["az", "top", "new"];

/** /genre/:genre — every series with that genre, anime and manga together. */
export function Component() {
  const { t } = useT();
  const { genre: rawGenre = "" } = useParams();
  // The API matches genres case-insensitively; show the catalogue's own spelling (as the server does).
  const genres = useGenres();
  const genre = genres.find((g) => g.toLowerCase() === rawGenre.trim().toLowerCase()) ?? rawGenre.trim();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSort = searchParams.get("sort");
  const sort = GENRE_SORTS.includes(rawSort) ? rawSort : "az";
  const results = useSearchResults({ q: "", section: "", genre: rawGenre.trim(), sort });

  useTitle(t("meta.genre.title", { genre }), t("meta.genre.description", { genre }));

  return (
    <div className="container">
      <header className={styles.head}>
        <div>
          <p className={styles.kicker}>{t("genre.kicker")}</p>
          <h1>
            <span className="gradient-text">{genre}</span>
          </h1>
          <p className="muted">{t("genre.subtitle", { genre })}</p>
        </div>
        <div className="field">
          <label htmlFor="genre-sort">{t("search.sortLabel")}</label>
          <select
            id="genre-sort"
            className="select"
            value={sort}
            onChange={(e) =>
              setSearchParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  if (e.target.value === "az") next.delete("sort");
                  else next.set("sort", e.target.value);
                  return next;
                },
                { preventScrollReset: true },
              )
            }
          >
            {GENRE_SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`search.sort.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </header>

      <p className={styles.links}>
        <Link to={`/anime?genre=${encodeURIComponent(genre)}`}>{t("genre.onlyIn", { section: t("common.anime") })}</Link>
        <Link to={`/manga?genre=${encodeURIComponent(genre)}`}>{t("genre.onlyIn", { section: t("common.manga") })}</Link>
      </p>

      <SearchResults
        results={results}
        empty={t("genre.empty", { genre })}
        emptyAction={
          <Link to="/" className="btn" style={{ justifySelf: "start" }}>
            {t("notFound.home")}
          </Link>
        }
      />
    </div>
  );
}
