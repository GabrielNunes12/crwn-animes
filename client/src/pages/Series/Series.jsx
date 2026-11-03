import { Link, useLoaderData } from "react-router";
import { catalogApi } from "../../api/client.js";
import { AsyncView } from "../../components/Await/AsyncView.jsx";
import { Skeleton } from "../../components/Skeleton/Skeleton.jsx";
import { LazyImage } from "../../components/LazyImage/LazyImage.jsx";
import { Reveal } from "../../components/Reveal/Reveal.jsx";
import { useProgressMap } from "../../hooks/useProgress.js";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { videoLabel } from "../../lib/format.js";
import { entryCompleted, formatTime, resumePosition } from "../../lib/progress.js";
import styles from "./Series.module.css";

export function loader({ params, request, section }) {
  return { section, data: catalogApi.series(section, params.slug, { signal: request.signal }) };
}

function groupBySeason(videos) {
  const map = new Map();
  for (const v of videos) {
    const s = v.season ?? 1;
    if (!map.has(s)) map.set(s, []);
    map.get(s).push(v);
  }
  return [...map.entries()].sort(([a], [b]) => a - b);
}

function SeriesSkeleton() {
  return (
    <div className="container" role="status" aria-busy="true">
      <div className={styles.top}>
        <Skeleton className={styles.cover} style={{ aspectRatio: "2 / 3" }} />
        <div className="stack">
          <Skeleton style={{ blockSize: "2.6rem", inlineSize: "70%" }} />
          <Skeleton style={{ blockSize: "1rem" }} />
          <Skeleton style={{ blockSize: "1rem", inlineSize: "80%" }} />
          <Skeleton style={{ blockSize: "2.75rem", inlineSize: "12rem" }} />
        </div>
      </div>
      <div className="stack mt-6">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} style={{ blockSize: "4.5rem", borderRadius: "var(--radius)" }} />
        ))}
      </div>
    </div>
  );
}

function SeriesView({ section, series, videos }) {
  const { t } = useT();
  const progress = useProgressMap();
  useTitle(series.name);
  const seasons = groupBySeason(videos);
  const playable = videos.filter((v) => v.availability !== "unavailable" && v.route);
  const nextUp = playable.find((v) => !entryCompleted(progress[v.youtubeVideoId])) ?? playable[0];
  const started = nextUp && progress[nextUp.youtubeVideoId];
  const isManga = section === "manga";

  return (
    <div className={styles.page}>
      <div className={styles.banner} aria-hidden="true" style={series.coverUrl ? { "--cover": `url("${encodeURI(series.coverUrl)}")` } : undefined} />
      <div className="container">
        <div className={styles.top}>
          <div className={styles.cover}>
            <LazyImage src={series.coverUrl} alt={t("series.coverAlt", { name: series.name })} ratio="2 / 3" width={300} height={450} fallbackLabel={series.name} eager />
          </div>
          <div className={styles.info}>
            <p className={styles.kicker}>
              <Link to={`/${section}`}>{t(`common.${section}`)}</Link>
            </p>
            <h1 className={styles.title}>{series.name}</h1>
            {series.aliases?.length > 0 && (
              <p className="hint">
                {t("common.aliases")}: {series.aliases.join(" · ")}
              </p>
            )}
            {series.genres?.length > 0 && (
              <ul className="cluster" role="list" aria-label={t("common.genres")}>
                {series.genres.map((g) => (
                  <li key={g}>
                    <Link className="chip" to={`/${section}?genre=${encodeURIComponent(g)}`}>
                      {g}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {series.synopsis && <p className={styles.synopsis}>{series.synopsis}</p>}
            <p className="muted">{t(isManga ? "common.chapters" : "common.episodes", { count: videos.length })}</p>
            {nextUp && (
              <div className="cluster">
                <Link to={nextUp.route} className="btn btn-primary">
                  <span aria-hidden="true">▶</span>{" "}
                  {started
                    ? t("series.continue", { label: videoLabel(t, nextUp) })
                    : t(isManga ? "series.startReading" : "series.startWatching")}
                </Link>
              </div>
            )}
          </div>
        </div>

        <section className="mt-7" aria-labelledby="eps-title">
          <h2 id="eps-title" className={styles.listTitle}>
            {t(isManga ? "series.chapters" : "series.episodes")}
          </h2>
          {videos.length === 0 && <p className="card">{t("series.noVideos")}</p>}
          {seasons.map(([season, list]) => (
            <section key={season} className={styles.season} aria-labelledby={seasons.length > 1 ? `season-${season}` : undefined}>
              {seasons.length > 1 && (
                <h3 id={`season-${season}`} className={styles.seasonTitle}>
                  {t("common.season", { n: season })}
                </h3>
              )}
              <ol className={styles.list} role="list">
                {list.map((v, i) => {
                  const p = progress[v.youtubeVideoId];
                  const done = entryCompleted(p);
                  const pct = p?.d > 0 ? Math.min(100, Math.round((p.t / p.d) * 100)) : 0;
                  const unavailable = v.availability === "unavailable";
                  const label = videoLabel(t, v);
                  const content = (
                    <>
                      <span className={styles.thumb}>
                        <LazyImage src={v.thumbnailUrl} alt="" ratio="16 / 9" width={160} height={90} />
                        {pct > 0 && !done && <span className={styles.bar} style={{ "--p": `${pct}%` }} />}
                      </span>
                      <span className={styles.text}>
                        <span className={styles.epLabel}>
                          {label}
                          {v.isNew && <span className="badge badge-new">{t("common.new")}</span>}
                        </span>
                        <span className={styles.epTitle}>{v.title}</span>
                        {unavailable ? (
                          <span className={styles.unavail}>{t("common.unavailable")}</span>
                        ) : (
                          p && !done && resumePosition(p) > 0 && <span className="hint">{t("watch.resumeAt", { time: formatTime(p.t) })}</span>
                        )}
                      </span>
                      <span className={styles.state}>
                        {done ? (
                          <span className={styles.check} title={t("common.watched")}>
                            <span aria-hidden="true">✓</span>
                            <span className="visually-hidden">{t("common.watched")}</span>
                          </span>
                        ) : null}
                      </span>
                    </>
                  );
                  return (
                    <Reveal as="li" key={v.id} index={i % 8} data-unavailable={unavailable || undefined} data-done={done || undefined}>
                      {unavailable || !v.route ? (
                        <div className={`${styles.item} ${styles.disabled}`} aria-disabled="true">
                          {content}
                        </div>
                      ) : (
                        <Link to={v.route} className={styles.item}>
                          {content}
                        </Link>
                      )}
                    </Reveal>
                  );
                })}
              </ol>
            </section>
          ))}
        </section>
      </div>
    </div>
  );
}

export function Component() {
  const { section, data } = useLoaderData();
  return (
    <AsyncView resolve={data} fallback={<SeriesSkeleton />}>
      {({ series, videos }) => <SeriesView section={section} series={series} videos={videos} />}
    </AsyncView>
  );
}
