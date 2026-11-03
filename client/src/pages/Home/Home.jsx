import { useState } from "react";
import { Link, useLoaderData, useNavigate } from "react-router";
import { catalogApi } from "../../api/client.js";
import { AsyncView } from "../../components/Await/AsyncView.jsx";
import { CardGridSkeleton, Skeleton } from "../../components/Skeleton/Skeleton.jsx";
import { Reveal } from "../../components/Reveal/Reveal.jsx";
import { VideoCard } from "../../components/Cards/VideoCard.jsx";
import { ContinueCard } from "../../components/Cards/ContinueCard.jsx";
import { useProgressMap } from "../../hooks/useProgress.js";
import { SITE_NAME, useMeta } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { continueWatching, removeProgress } from "../../lib/progress.js";
import { genreHref } from "../../lib/search.js";
import styles from "./Home.module.css";

/** Rows fail soft: a broken row is hidden instead of breaking the page. */
const soft = (p, fallback = []) => p.catch(() => fallback);

export function loader() {
  return {
    sections: soft(catalogApi.sections(), null),
    genres: soft(catalogApi.genres()),
    latest: soft(catalogApi.latest({ limit: 24 })),
    trending: soft(catalogApi.trending(undefined, 12)),
    topAnime: soft(catalogApi.topRated("anime", 12)),
    topManga: soft(catalogApi.topRated("manga", 12)),
  };
}

function VideoRow({ id, title, videos, progress, more }) {
  if (!videos?.length) return null;
  return (
    <section className="container mt-7" aria-labelledby={id}>
      <Reveal variant="scroll" className="section-head">
        <h2 id={id}>{title}</h2>
        {more}
      </Reveal>
      <ul className="row-scroll" role="list">
        {videos.map((v, i) => (
          <Reveal as="li" key={v.id} index={i}>
            <VideoCard video={v} progress={progress[v.youtubeVideoId]} />
          </Reveal>
        ))}
      </ul>
    </section>
  );
}

function RowSkeleton() {
  return (
    <div className="container mt-7">
      <Skeleton style={{ blockSize: "1.8rem", inlineSize: "14rem", marginBlockEnd: "var(--space-4)" }} />
      <CardGridSkeleton count={4} row />
    </div>
  );
}

function ContinueRow() {
  const { t } = useT();
  const progress = useProgressMap();
  // Recomputed whenever local progress changes.
  const items = progress ? continueWatching(12) : [];
  if (!items.length) return null;
  return (
    <section className="container mt-7" aria-labelledby="continue-title">
      <div className="section-head">
        <h2 id="continue-title">{t("home.continue")}</h2>
        <span className="hint">{t("home.continueHint")}</span>
      </div>
      <ul className="row-scroll" role="list">
        {items.map((e, i) => (
          <Reveal as="li" key={e.youtubeVideoId} index={i}>
            <ContinueCard entry={e} onRemove={removeProgress} />
          </Reveal>
        ))}
      </ul>
    </section>
  );
}

function SurpriseButton() {
  const { t, errorMessage } = useT();
  const navigate = useNavigate();
  const [state, setState] = useState({ busy: false, error: "" });
  async function go() {
    setState({ busy: true, error: "" });
    try {
      const { video } = await catalogApi.random();
      navigate(video.route);
    } catch (err) {
      setState({ busy: false, error: err.status === 404 ? t("home.surpriseNone") : errorMessage(err) });
    }
  }
  return (
    <>
      <button type="button" className="btn" onClick={go} disabled={state.busy} aria-describedby="surprise-msg">
        <span aria-hidden="true">🎲</span> {state.busy ? t("common.working") : t("home.surprise")}
      </button>
      <p id="surprise-msg" role="status" className={styles.surpriseMsg}>
        {state.error}
      </p>
    </>
  );
}

export function Component() {
  const data = useLoaderData();
  const { t } = useT();
  const progress = useProgressMap();
  useMeta({ title: `${SITE_NAME} · ${t("meta.homeTitle")}` });

  return (
    <>
      <section className={styles.hero}>
        <div className={`container ${styles.heroInner}`}>
          <p className={styles.eyebrow}>{t("home.eyebrow")}</p>
          <h1 className={styles.heroTitle}>
            {t("home.heroTitleA")} <span className="gradient-text">{t("home.heroTitleB")}</span>
          </h1>
          <p className={styles.heroText}>{t("home.heroText")}</p>
          <div className="cluster" style={{ "--cluster-gap": "var(--space-3)" }}>
            <Link to="/anime" className="btn btn-primary">
              {t("home.browseAnime")}
            </Link>
            <Link to="/manga" className="btn btn-secondary">
              {t("home.browseManga")}
            </Link>
            <SurpriseButton />
          </div>
        </div>
        <div className={styles.petals} aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} style={{ "--i": i }} />
          ))}
        </div>
      </section>

      <section className="container" aria-labelledby="sections-title">
        <h2 id="sections-title" className="visually-hidden">
          {t("home.sections")}
        </h2>
        <AsyncView
          resolve={data.sections}
          fallback={
            <div className={styles.sections}>
              <Skeleton style={{ blockSize: "8rem", borderRadius: "var(--radius-lg)" }} />
              <Skeleton style={{ blockSize: "8rem", borderRadius: "var(--radius-lg)" }} />
            </div>
          }
        >
          {(sections) =>
            sections?.length ? (
              <ul className={styles.sections} role="list">
                {sections.map((s, i) => (
                  <Reveal as="li" key={s.section} index={i}>
                    <Link to={s.route ?? `/${s.section}`} className={styles.sectionCard} data-section={s.section}>
                      <span className={styles.sectionName}>{t(`common.${s.section}`)}</span>
                      <span className={styles.sectionStats}>
                        {t("common.seriesCount", { count: s.seriesCount })} ·{" "}
                        {t(s.section === "manga" ? "common.chapters" : "common.episodes", { count: s.videoCount })}
                      </span>
                      <span className={styles.sectionArrow} aria-hidden="true">
                        →
                      </span>
                    </Link>
                  </Reveal>
                ))}
              </ul>
            ) : null
          }
        </AsyncView>
      </section>

      <ContinueRow />

      <AsyncView resolve={data.latest} fallback={<RowSkeleton />}>
        {(latest) => (
          <>
            <VideoRow id="new-title" title={t("home.new")} videos={latest.filter((v) => v.isNew).slice(0, 12)} progress={progress} />
            {latest.length > 0 && (
              <section className="container mt-7" aria-labelledby="latest-title">
                <Reveal variant="scroll" className="section-head">
                  <h2 id="latest-title">{t("home.latest")}</h2>
                  <span className="hint">{t("common.videoCount", { count: Math.min(latest.length, 12) })}</span>
                </Reveal>
                <ul className="grid-videos" role="list">
                  {latest.slice(0, 12).map((v, i) => (
                    <Reveal as="li" key={v.id} index={i % 4}>
                      <VideoCard video={v} progress={progress[v.youtubeVideoId]} />
                    </Reveal>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </AsyncView>

      <AsyncView resolve={data.trending} fallback={<RowSkeleton />}>
        {(videos) => <VideoRow id="trending-title" title={t("home.trending")} videos={videos} progress={progress} />}
      </AsyncView>
      <AsyncView resolve={data.topAnime} fallback={null}>
        {(videos) => (
          <VideoRow id="top-anime-title" title={t("home.topAnime")} videos={videos} progress={progress} more={<Link to="/anime">{t("common.seeAll")}</Link>} />
        )}
      </AsyncView>
      <AsyncView resolve={data.topManga} fallback={null}>
        {(videos) => (
          <VideoRow id="top-manga-title" title={t("home.topManga")} videos={videos} progress={progress} more={<Link to="/manga">{t("common.seeAll")}</Link>} />
        )}
      </AsyncView>

      <AsyncView resolve={data.genres} fallback={null}>
        {(genres) =>
          genres?.length ? (
            <section className="container mt-7" aria-labelledby="genres-title">
              <Reveal variant="scroll" className="section-head">
                <h2 id="genres-title">{t("home.genres")}</h2>
              </Reveal>
              <ul className="cluster" role="list">
                {genres.map((g, i) => (
                  <Reveal as="li" key={g} index={i}>
                    <Link className="chip" to={genreHref(g)}>
                      {g}
                    </Link>
                  </Reveal>
                ))}
              </ul>
            </section>
          ) : null
        }
      </AsyncView>

    </>
  );
}
