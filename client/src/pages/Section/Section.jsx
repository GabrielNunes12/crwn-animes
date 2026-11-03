import { Form, Link, useLoaderData } from "react-router";
import { catalogApi } from "../../api/client.js";
import { AsyncView } from "../../components/Await/AsyncView.jsx";
import { CardGridSkeleton, Skeleton } from "../../components/Skeleton/Skeleton.jsx";
import { Reveal } from "../../components/Reveal/Reveal.jsx";
import { SeriesCard } from "../../components/Cards/SeriesCard.jsx";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import styles from "./Section.module.css";

export function loader({ request, section }) {
  const url = new URL(request.url);
  const genre = url.searchParams.get("genre") ?? "";
  const q = url.searchParams.get("q") ?? "";
  return {
    section,
    genre,
    q,
    series: catalogApi.seriesList(section, { genre, q }, { signal: request.signal }),
    genres: catalogApi.genres().catch(() => []),
  };
}

function hrefWith(section, { genre, q }) {
  const p = new URLSearchParams();
  if (genre) p.set("genre", genre);
  if (q) p.set("q", q);
  const s = p.toString();
  return `/${section}${s ? `?${s}` : ""}`;
}

export function Component() {
  const { section, genre, q, series, genres } = useLoaderData();
  const { t } = useT();
  const title = t(`common.${section}`);
  useTitle(title);
  const other = section === "anime" ? "manga" : "anime";

  return (
    <div className="container">
      <header className={styles.head}>
        <div>
          <p className={styles.kicker}>{t("section.kicker")}</p>
          <h1>
            <span className="gradient-text">{title}</span>
          </h1>
          <p className="muted">{t(`section.subtitle.${section}`)}</p>
        </div>
        <Form method="get" role="search" className={styles.search} key={`${section}-${q}`}>
          {genre && <input type="hidden" name="genre" value={genre} />}
          <label htmlFor="section-search" className="visually-hidden">
            {t("section.searchLabel", { section: title })}
          </label>
          <input id="section-search" className="input" type="search" name="q" defaultValue={q} placeholder={t("section.searchPlaceholder")} />
          <button type="submit" className="btn btn-primary">
            {t("section.search")}
          </button>
        </Form>
      </header>

      <nav aria-label={t("common.genres")} className={styles.genres}>
        <AsyncView resolve={genres} fallback={<Skeleton style={{ blockSize: "2.25rem", inlineSize: "60%" }} />}>
          {(list) => (
            <ul className="cluster" role="list">
              <li>
                <Link className="chip" to={hrefWith(section, { q })} aria-current={!genre ? "page" : undefined}>
                  {t("section.allGenres")}
                </Link>
              </li>
              {list.map((g) => (
                <li key={g}>
                  <Link className="chip" to={hrefWith(section, { genre: g, q })} aria-current={g === genre ? "page" : undefined}>
                    {g}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </AsyncView>
      </nav>

      {(genre || q) && (
        <p className={styles.filters}>
          {q && <span>{t("section.resultsFor", { q })}</span>}
          {genre && <span className="badge">{genre}</span>}
          <Link to={`/${section}`}>{t("section.clear")}</Link>
          <Link to={hrefWith(other, { genre, q })}>{t("section.tryOther", { section: t(`common.${other}`) })}</Link>
        </p>
      )}

      <AsyncView key={`${genre}|${q}`} resolve={series} fallback={<CardGridSkeleton count={10} kind="series" />}>
        {(items) =>
          items.length ? (
            <>
              <p className="visually-hidden" role="status">
                {t("common.seriesCount", { count: items.length })}
              </p>
              <ul className="grid-cards" role="list">
                {items.map((s, i) => (
                  <Reveal as="li" key={s.id} index={i % 6}>
                    <SeriesCard series={s} section={section} />
                  </Reveal>
                ))}
              </ul>
            </>
          ) : (
            <div className="card stack" role="status">
              <p>{t("section.empty")}</p>
              {(genre || q) && (
                <Link to={`/${section}`} className="btn" style={{ justifySelf: "start" }}>
                  {t("section.clear")}
                </Link>
              )}
            </div>
          )
        }
      </AsyncView>
    </div>
  );
}
