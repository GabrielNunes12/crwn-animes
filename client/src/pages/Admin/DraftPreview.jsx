import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { adminApi } from "../../api/client.js";
import { Player } from "../../components/Player/Player.jsx";
import { Skeleton } from "../../components/Skeleton/Skeleton.jsx";
import { useNoIndex } from "../../hooks/useNoIndex.js";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { videoLabel } from "../../lib/format.js";
import { ErrorText, Reasons, StatusBadge } from "./shared.jsx";
import { TrashDates } from "./TrashTab.jsx";
import adminStyles from "./Admin.module.css";
import styles from "./DraftPreview.module.css";

export function Component() {
  const { id } = useParams();
  return <DraftPreview key={id} id={id} />;
}

function DraftPreview({ id }) {
  const { t } = useT();
  useNoIndex();
  const [state, setState] = useState({ data: null, error: null });

  useEffect(() => {
    const ctrl = new AbortController();
    adminApi
      .preview(id, { signal: ctrl.signal })
      .then((data) => !ctrl.signal.aborted && setState({ data, error: null }))
      .catch((error) => {
        if (ctrl.signal.aborted || error?.name === "AbortError") return;
        setState({ data: null, error });
      });
    return () => ctrl.abort();
  }, [id]);

  const video = state.data?.video;
  useTitle(t("admin.preview.docTitle", { title: video?.title ?? "" }));

  if (state.error) {
    return (
      <div className="container stack" style={{ paddingBlock: "var(--space-6)" }}>
        <Link to="/admin" className={styles.back}>
          <span aria-hidden="true">←</span> {t("admin.board.back")}
        </Link>
        {state.error.status === 404 ? (
          <div className="card stack">
            <h1>{t("notFound.title")}</h1>
            <p className="muted">{t("notFound.text")}</p>
          </div>
        ) : (
          <ErrorText error={state.error} />
        )}
      </div>
    );
  }

  if (!video) {
    return (
      <div className="container stack" style={{ paddingBlock: "var(--space-6)" }} role="status" aria-label={t("common.loading")}>
        <Skeleton style={{ blockSize: "5rem", borderRadius: "var(--radius-lg)" }} />
        <Skeleton style={{ aspectRatio: "16 / 9", borderRadius: "var(--radius-lg)" }} />
      </div>
    );
  }

  return <PreviewView video={video} series={state.data.series ?? null} />;
}

function PreviewView({ video, series }) {
  const { t, formatDate } = useT();
  const trashed = Boolean(video.deletedAt || series?.deletedAt);
  const pending = video.status !== "published";
  const seriesName = series?.name ?? video.seriesName;
  const seriesId = series?.id ?? video.seriesId;
  const label = video.number != null || video.section ? videoLabel(t, video) : null;

  let boardHref = null;
  if (seriesId != null) {
    const q = new URLSearchParams();
    if (video.section) q.set("section", video.section);
    if (video.section === "anime" && video.season) q.set("season", String(video.season));
    const qs = q.toString();
    boardHref = `/admin/series/${seriesId}${qs ? `?${qs}` : ""}`;
  }

  const rows = [
    [t("admin.fields.section"), video.section ? t(`common.${video.section}`) : t("admin.unclassified")],
    [t("admin.fields.series"), seriesName ?? t("admin.preview.none")],
    [t("admin.fields.season"), video.section === "manga" ? t("admin.preview.none") : String(video.season ?? 1)],
    [t("admin.fields.number"), video.number != null ? String(video.number) : t("admin.preview.none")],
    [t("admin.preview.channel"), video.channel || t("admin.preview.none")],
    [t("admin.preview.youtubeId"), <code key="yt">{video.youtubeVideoId}</code>],
    [
      t("admin.preview.route"),
      video.route && !trashed && !pending ? (
        <Link key="route" to={video.route}>
          <code>{video.route}</code>
        </Link>
      ) : (
        t("admin.preview.noRoute")
      ),
    ],
    [t("admin.preview.availability"), video.availability === "unavailable" ? t("common.unavailable") : t("admin.preview.available")],
    [t("admin.preview.added"), video.createdAt ? formatDate(video.createdAt) : t("admin.preview.none")],
    [t("admin.preview.updated"), video.updatedAt ? formatDate(video.updatedAt) : t("admin.preview.none")],
  ];

  return (
    <div className="container" style={{ paddingBlock: "var(--space-5)" }}>
      <section className={styles.banner} aria-labelledby="draft-banner-title" data-trashed={trashed || undefined} data-pending={pending || undefined}>
        <div className={styles.bannerHead}>
          <p id="draft-banner-title" className={styles.bannerTitle}>
            <span aria-hidden="true">◐ </span>
            {t("admin.preview.banner")}
          </p>
          <div className="cluster" style={{ "--cluster-gap": "0.3rem" }}>
            <StatusBadge status={video.status} availability={video.availability} />
            {trashed && <span className={`badge ${adminStyles.trashed}`}>{t("admin.preview.trashed")}</span>}
          </div>
        </div>
        <p className="hint">{t("admin.preview.note")}</p>
        {trashed && <TrashDates item={video.deletedAt ? video : series} />}
        {pending && video.classification && (
          <div className="stack" style={{ "--stack-gap": "var(--space-2)" }}>
            <p className={styles.why}>{t("admin.preview.pendingWhy")}</p>
            <Reasons classification={video.classification} />
          </div>
        )}
        <div className="cluster">
          {boardHref && (
            <Link className="btn btn-sm" to={boardHref}>
              <span aria-hidden="true">←</span> {t("admin.preview.backToBoard")}
            </Link>
          )}
          {trashed ? (
            <Link className="btn btn-sm btn-ghost" to="/admin?tab=trash">
              {t("admin.preview.backToTrash")}
            </Link>
          ) : (
            pending && (
              <Link className="btn btn-sm btn-ghost" to="/admin?tab=pending">
                {t("admin.preview.backToPending")}
              </Link>
            )
          )}
        </div>
      </section>

      <div className={styles.player}>
        <Player key={video.youtubeVideoId} video={video} persist={false} />
      </div>

      <header className={styles.headline}>
        {seriesName && <p className={styles.kicker}>{seriesName}</p>}
        <h1 className={styles.title}>{label ?? video.title}</h1>
        {label && <p className="muted">{video.title}</p>}
      </header>

      <section aria-labelledby="draft-details-title" className={styles.details}>
        <h2 id="draft-details-title">{t("admin.preview.details")}</h2>
        <dl className={styles.dl}>
          {rows.map(([term, value]) => (
            <div key={term} className={styles.dlRow}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
