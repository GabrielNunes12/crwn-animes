import { Link, useLoaderData } from "react-router";
import { catalogApi } from "../../api/client.js";
import { AsyncView } from "../../components/Await/AsyncView.jsx";
import { CardGridSkeleton } from "../../components/Skeleton/Skeleton.jsx";
import { Reveal } from "../../components/Reveal/Reveal.jsx";
import { SeriesCard } from "../../components/Cards/SeriesCard.jsx";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";

const SECTIONS = ["anime", "manga"];

export function loader({ request }) {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  return {
    q,
    results: q
      ? Promise.all(SECTIONS.map((s) => catalogApi.seriesList(s, { q }, { signal: request.signal }))).then(([anime, manga]) => ({ anime, manga }))
      : Promise.resolve(null),
  };
}

export function Component() {
  const { q, results } = useLoaderData();
  const { t } = useT();
  useTitle(q ? t("search.resultsFor", { q }) : t("search.title"));

  return (
    <div className="container" style={{ paddingBlock: "var(--space-6)" }}>
      <h1 style={{ marginBlockEnd: "var(--space-5)" }}>{q ? t("search.resultsFor", { q }) : t("search.title")}</h1>
      {!q && <p className="muted">{t("search.prompt")}</p>}
      <AsyncView key={q} resolve={results} fallback={<CardGridSkeleton count={6} kind="series" />}>
        {(data) => {
          if (!data) return null;
          const total = data.anime.length + data.manga.length;
          if (!total)
            return (
              <p className="card" role="status">
                {t("search.empty")}
              </p>
            );
          return (
            <div className="stack" style={{ "--stack-gap": "var(--space-6)" }}>
              <p className="visually-hidden" role="status">
                {t("common.seriesCount", { count: total })}
              </p>
              {SECTIONS.map((s) =>
                data[s].length ? (
                  <section key={s} aria-labelledby={`search-${s}`}>
                    <div className="section-head">
                      <h2 id={`search-${s}`}>{t(`common.${s}`)}</h2>
                      <Link to={`/${s}?q=${encodeURIComponent(q)}`}>{t("common.seeAll")}</Link>
                    </div>
                    <ul className="grid-cards" role="list">
                      {data[s].map((item, i) => (
                        <Reveal as="li" key={item.id} index={i % 6}>
                          <SeriesCard series={item} section={s} />
                        </Reveal>
                      ))}
                    </ul>
                  </section>
                ) : null,
              )}
            </div>
          );
        }}
      </AsyncView>
    </div>
  );
}
