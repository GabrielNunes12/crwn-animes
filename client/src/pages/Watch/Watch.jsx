import { useEffect, useState } from "react";
import { Link, Navigate, useLoaderData, useLocation, useNavigate } from "react-router";
import { AsyncView } from "../../components/Await/AsyncView.jsx";
import { Skeleton } from "../../components/Skeleton/Skeleton.jsx";
import { Player } from "../../components/Player/Player.jsx";
import { AutoNext } from "../../components/Player/AutoNext.jsx";
import { RatingPanel } from "../../components/RatingPanel/RatingPanel.jsx";
import { LazyImage } from "../../components/LazyImage/LazyImage.jsx";
import { useProgressMap } from "../../hooks/useProgress.js";
import { useShortcuts } from "../../hooks/useShortcuts.js";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { videoLabel } from "../../lib/format.js";
import { THUMB_SIZES } from "../../lib/images.js";
import { watchMeta } from "../../lib/meta.js";
import { AUTOPLAY_KEY, getBool, setBool } from "../../lib/prefs.js";
import { entryCompleted, pruneSeriesProgress } from "../../lib/progress.js";
import styles from "./Watch.module.css";

export { loader } from "./loader.js";

function WatchSkeleton() {
  return (
    <div className="container" style={{ paddingBlock: "var(--space-5)" }} role="status" aria-busy="true">
      <Skeleton style={{ aspectRatio: "16 / 9", borderRadius: "var(--radius-lg)" }} />
      <Skeleton style={{ blockSize: "2rem", inlineSize: "60%", marginBlock: "var(--space-4) var(--space-2)" }} />
      <Skeleton style={{ blockSize: "1rem", inlineSize: "35%" }} />
    </div>
  );
}

function WatchView({ section, video, series, prev, next, videos }) {
  const { t } = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const progress = useProgressMap();
  const [theatre, setTheatre] = useState(false);
  const [autoplay, setAutoplay] = useState(() => getBool(AUTOPLAY_KEY, true));
  const [showAutoNext, setShowAutoNext] = useState(false);
  const isManga = section === "manga";
  const label = videoLabel(t, video);
  useTitle(...watchMeta(t, video, series));
  // `videos` is the series' whole published list: stored routes follow renumbered episodes
  // (progress is keyed by YouTube ID; routes only feed the cards and "Continue watching").
  const seriesSlug = series?.slug ?? video.seriesSlug;
  useEffect(() => {
    pruneSeriesProgress(section, seriesSlug, videos);
  }, [section, seriesSlug, videos]);

  const goNext = () => next?.route && navigate(next.route, { state: { autoplay: true } });
  const goPrev = () => prev?.route && navigate(prev.route);

  useShortcuts({
    "shift+n": goNext,
    "shift+p": goPrev,
    t: () => setTheatre((v) => !v),
  });

  const seriesRoute = `/${section}/${series?.slug ?? video.seriesSlug}`;
  const nextLabel = next ? `${t(isManga ? "watch.nextChapter" : "watch.nextEpisode")}` : null;

  return (
    <div className={styles.page} data-theatre={theatre || undefined}>
      <div className={`container ${styles.layout}`}>
        <div className={styles.main}>
          <Player
            key={video.youtubeVideoId}
            video={video}
            autoStart={Boolean(location.state?.autoplay)}
            next={next}
            nextLabel={nextLabel}
            onEnded={() => {
              if (autoplay && next?.route) setShowAutoNext(true);
            }}
          />

          {showAutoNext && next && (
            <AutoNext title={`${videoLabel(t, next)} — ${next.title}`} onPlay={goNext} onCancel={() => setShowAutoNext(false)} />
          )}

          <div className={styles.headline}>
            <div className={styles.titles}>
              <p className={styles.kicker}>
                <Link to={seriesRoute}>{series?.name ?? video.seriesName}</Link>
              </p>
              <h1 className={styles.title}>{label}</h1>
              <p className="muted">{video.title}</p>
              {video.channel && <p className="hint">{t("watch.channel", { name: video.channel })}</p>}
            </div>
            <div className={styles.tools}>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={autoplay}
                  onChange={(e) => {
                    setAutoplay(e.target.checked);
                    setBool(AUTOPLAY_KEY, e.target.checked);
                    if (!e.target.checked) setShowAutoNext(false);
                  }}
                />
                <span>{t("watch.autoplay")}</span>
              </label>
              <button type="button" className="btn btn-sm" aria-pressed={theatre} onClick={() => setTheatre((v) => !v)}>
                {t("watch.theatre")} <kbd aria-hidden="true">T</kbd>
              </button>
            </div>
          </div>

          <nav className={styles.prevNext} aria-label={t("watch.episodeNav")}>
            {prev?.route ? (
              <Link className="btn" to={prev.route} rel="prev">
                <span aria-hidden="true">←</span> {t("watch.prev")}
                <span className={styles.pnLabel}>{videoLabel(t, prev)}</span>
              </Link>
            ) : (
              <span />
            )}
            <Link className="btn btn-ghost" to={seriesRoute}>
              {t(isManga ? "watch.allChapters" : "watch.allEpisodes")}
            </Link>
            {next?.route ? (
              <Link className="btn btn-primary" to={next.route} rel="next">
                {t("watch.next")}
                <span className={styles.pnLabel}>{videoLabel(t, next)}</span> <span aria-hidden="true">→</span>
              </Link>
            ) : (
              <span />
            )}
          </nav>
          <p className="hint">{t("watch.shortcutsHint")}</p>

          <RatingPanel videoId={video.id} />
        </div>

        <aside className={styles.side} aria-labelledby="more-title">
          <h2 id="more-title" className={styles.sideTitle}>
            {t(isManga ? "series.chapters" : "series.episodes")}
          </h2>
          <ol className={styles.sideList} role="list">
            {videos.map((v) => {
              const current = v.id === video.id;
              const done = entryCompleted(progress[v.youtubeVideoId]);
              const unavailable = v.availability === "unavailable";
              return (
                <li key={v.id} data-unavailable={unavailable || undefined}>
                  <Link to={v.route} className={styles.sideItem} aria-current={current ? "page" : undefined}>
                    <span className={styles.sideThumb}>
                      <LazyImage src={v.thumbnailUrl} srcSet={v.thumbnailSrcSet} sizes={THUMB_SIZES.side} alt="" ratio="16 / 9" width={120} height={68} />
                    </span>
                    <span className={styles.sideText}>
                      <span className={styles.sideLabel}>{videoLabel(t, v)}</span>
                      <span className={styles.sideSub}>{unavailable ? t("common.unavailable") : v.title}</span>
                    </span>
                    {done && (
                      <span className={styles.sideCheck} title={t("common.watched")}>
                        <span aria-hidden="true">✓</span>
                        <span className="visually-hidden">{t("common.watched")}</span>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ol>
        </aside>
      </div>
    </div>
  );
}

/** /season/1/episode/2, /episode/01, /episode/1.0 … → replace with the canonical video.route. */
function CanonicalWatch({ section, data }) {
  const location = useLocation();
  const route = data.video.route;
  if (route && decodeURI(location.pathname) !== route) {
    return <Navigate to={{ pathname: route, search: location.search }} replace state={location.state} />;
  }
  return <WatchView key={data.video.id} section={section} {...data} />;
}

export function Component() {
  const { section, data } = useLoaderData();
  return (
    <AsyncView resolve={data} fallback={<WatchSkeleton />}>
      {(d) => <CanonicalWatch section={section} data={d} />}
    </AsyncView>
  );
}
