import { Link, useLoaderData, useSearchParams } from "react-router";
import { catalogApi } from "../../api/client.js";
import { AsyncView } from "../../components/Await/AsyncView.jsx";
import { Skeleton } from "../../components/Skeleton/Skeleton.jsx";
import { LazyImage } from "../../components/LazyImage/LazyImage.jsx";
import { Reveal } from "../../components/Reveal/Reveal.jsx";
import { useProgressMap } from "../../hooks/useProgress.js";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { truncateWords, videoLabel } from "../../lib/format.js";
import { genreHref } from "../../lib/search.js";
import { entryCompleted, formatTime, resumePosition, seriesProgress } from "../../lib/progress.js";
import { pickSeason, seasonsOf } from "../../lib/seasons.js";
import styles from "./Series.module.css";

export function loader({ params, request, section }) {
  // Every season at once: "watched N of M" and the Continue target span the whole
  // series, and switching seasons (?season=) then needs no request.
  return { section, data: catalogApi.series(section, params.slug, { signal: request.signal }) };
}

/** Changing only `?season=` filters what is already loaded — don't refetch. */
export function shouldRevalidate({ currentUrl, nextUrl, defaultShouldRevalidate }) {
  if (currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  const strip = (url) => {
    const p = new URLSearchParams(url.search);
    p.delete("season");
    return p.toString();
  };
  return strip(currentUrl) === strip(nextUrl) ? false : defaultShouldRevalidate;
}

/** Rows past this index skip the reveal animation (one observer per row adds up on long lists). */
const REVEAL_ROWS = 12;

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

function EpisodeRow({ video: v, entry: p, index }) {
  const { t } = useT();
  const done = entryCompleted(p);
  const pct = p?.d > 0 ? Math.min(100, Math.round((p.t / p.d) * 100)) : 0;
  const unavailable = v.availability === "unavailable";
  const content = (
    <>
      <span className={styles.thumb}>
        <LazyImage src={v.thumbnailUrl} alt="" ratio="16 / 9" width={160} height={90} />
        {pct > 0 && !done && <span className={styles.bar} style={{ "--p": `${pct}%` }} />}
      </span>
      <span className={styles.text}>
        <span className={styles.epLabel}>
          {videoLabel(t, v)}
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
  const Row = index < REVEAL_ROWS ? Reveal : "li";
  const revealProps = index < REVEAL_ROWS ? { as: "li", index: index % 8 } : {};
  return (
    <Row {...revealProps} className={styles.row} data-unavailable={unavailable || undefined} data-done={done || undefined}>
      {unavailable || !v.route ? (
        <div className={`${styles.item} ${styles.disabled}`} aria-disabled="true">
          {content}
        </div>
      ) : (
        <Link to={v.route} className={styles.item}>
          {content}
        </Link>
      )}
    </Row>
  );
}

function SeasonNav({ seasons, active }) {
  const { t } = useT();
  const [params] = useSearchParams();
  const href = (n) => {
    const p = new URLSearchParams(params);
    p.set("season", String(n));
    return `?${p}`;
  };
  return (
    <nav aria-label={t("series.seasons")} className={styles.seasonNav}>
      <ul role="list">
        {seasons.map((n) => (
          <li key={n}>
            <Link to={href(n)} replace preventScrollReset aria-current={n === active ? "true" : undefined}>
              {t("common.season", { n: String(n) })}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SeriesView({ section, series, videos, seasons: apiSeasons }) {
  const { t } = useT();
  const progress = useProgressMap();
  const [params] = useSearchParams();
  useTitle(
    t("meta.series.title", { name: series.name, section: t(`common.${section}`) }),
    truncateWords(series.synopsis || t(`meta.series.fallback.${section}`, { name: series.name })),
  );
  const isManga = section === "manga";
  const sp = seriesProgress(videos, progress);
  const seasons = seasonsOf(apiSeasons, videos);
  const multi = seasons.length > 1;
  const season = pickSeason(seasons, params.get("season"), sp.target);
  const shown = multi ? videos.filter((v) => (v.season ?? 1) === season) : videos;
  const pct = sp.total ? Math.round((sp.watched / sp.total) * 100) : 0;

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
                    <Link className="chip" to={genreHref(g)}>
                      {g}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {series.synopsis && <p className={styles.synopsis}>{series.synopsis}</p>}
            <p className="muted">{t(isManga ? "common.chapters" : "common.episodes", { count: videos.length })}</p>
            {sp.touched && sp.total > 0 && (
              <div className={styles.watchedOf}>
                <p>{t(isManga ? "series.readOf" : "series.watchedOf", { watched: sp.watched, total: sp.total })}</p>
                <span className={styles.meter} style={{ "--p": `${pct}%` }} aria-hidden="true" />
              </div>
            )}
            {sp.allWatched ? (
              <p className={styles.allDone}>
                {t(isManga ? "series.allRead" : "series.allWatched")} <span aria-hidden="true">✓</span>
              </p>
            ) : (
              sp.target && (
                <div className="cluster">
                  <Link to={sp.target.route} className="btn btn-primary" data-resume={sp.resume || undefined}>
                    <span aria-hidden="true">▶</span>{" "}
                    {sp.touched
                      ? t("series.continue", { label: videoLabel(t, sp.target) })
                      : t(isManga ? "series.startReading" : "series.startWatching")}
                  </Link>
                </div>
              )
            )}
          </div>
        </div>

        <section className="mt-7" aria-labelledby="eps-title">
          <h2 id="eps-title" className={styles.listTitle}>
            {t(isManga ? "series.chapters" : "series.episodes")}
          </h2>
          {videos.length === 0 && <p className="card">{t("series.noVideos")}</p>}
          {multi && <SeasonNav seasons={seasons} active={season} />}
          {videos.length > 0 && (
            <section className={styles.season} aria-labelledby={multi ? "season-title" : undefined}>
              {multi && (
                <h3 id="season-title" className={styles.seasonTitle}>
                  {t("common.season", { n: String(season) })}
                </h3>
              )}
              {shown.length === 0 ? (
                <p className="card">{t("series.noVideos")}</p>
              ) : (
                <ol className={styles.list} role="list">
                  {shown.map((v, i) => (
                    <EpisodeRow key={v.id} video={v} entry={progress[v.youtubeVideoId]} index={i} />
                  ))}
                </ol>
              )}
            </section>
          )}
        </section>
      </div>
    </div>
  );
}

export function Component() {
  const { section, data } = useLoaderData();
  return (
    <AsyncView resolve={data} fallback={<SeriesSkeleton />}>
      {({ series, videos, seasons }) => <SeriesView section={section} series={series} videos={videos ?? []} seasons={seasons} />}
    </AsyncView>
  );
}
