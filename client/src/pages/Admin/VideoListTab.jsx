import { useEffect, useState } from "react";
import { Link } from "react-router";
import { adminApi } from "../../api/client.js";
import { ConfirmDialog } from "../../components/ConfirmDialog/ConfirmDialog.jsx";
import { CardGridSkeleton } from "../../components/Skeleton/Skeleton.jsx";
import { useT } from "../../i18n/useT.js";
import { Reasons, StatusBadge, ErrorText } from "./shared.jsx";
import { VideoEditForm } from "./VideoEditForm.jsx";
import { videoLabel } from "../../lib/format.js";
import styles from "./Admin.module.css";

export function VideoListTab({ status, series }) {
  const { t } = useT();
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");
  const [toDelete, setToDelete] = useState(null);
  const [deleteState, setDeleteState] = useState({ busy: false, error: null });

  const [version, setVersion] = useState(0);
  const load = () => setVersion((v) => v + 1);

  useEffect(() => {
    let alive = true;
    adminApi
      .videos({ status })
      .then((list) => {
        if (!alive) return;
        setVideos(list);
        setError(null);
      })
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
    };
  }, [status, version]);

  function onSaved(updated) {
    if (updated.status !== status) {
      setVideos((list) => list.filter((v) => v.id !== updated.id));
      setMessage(
        updated.status === "published" ? t("admin.videos.nowPublished", { title: updated.title, route: updated.route ?? "" }) : t("admin.videos.nowPending", { title: updated.title }),
      );
    } else {
      setVideos((list) => list.map((v) => (v.id === updated.id ? updated : v)));
      setMessage(t("admin.videos.saved", { title: updated.title }));
    }
  }

  async function onDelete() {
    setDeleteState({ busy: true, error: null });
    try {
      await adminApi.deleteVideo(toDelete.id);
      setVideos((list) => list.filter((v) => v.id !== toDelete.id));
      setMessage(t("admin.videos.deleted", { title: toDelete.title }));
      setToDelete(null);
      setDeleteState({ busy: false, error: null });
    } catch (err) {
      setDeleteState({ busy: false, error: err });
    }
  }

  return (
    <section className="stack" aria-labelledby={`${status}-title`}>
      <div className="section-head">
        <h2 id={`${status}-title`}>{t(`admin.videos.${status}Title`, { count: videos?.length ?? 0 })}</h2>
        <button type="button" className="btn btn-sm" onClick={load}>
          {t("admin.refresh")}
        </button>
      </div>
      <p className="hint">{t(`admin.videos.${status}Hint`)}</p>
      <p role="status" aria-live="polite" className={message ? "alert alert-success" : "visually-hidden"}>
        {message}
      </p>
      <ErrorText error={error} />
      {!videos && !error && <CardGridSkeleton count={3} />}
      {videos?.length === 0 && <p className="card muted">{t(`admin.videos.${status}Empty`)}</p>}
      <ul className={styles.rows} role="list">
        {videos?.map((v) => (
          <li key={v.id} className={styles.videoRow}>
            <div className={styles.videoHead}>
              <img src={v.thumbnailUrl} alt="" width="160" height="90" loading="lazy" decoding="async" className={styles.thumb} />
              <div className="stack" style={{ "--stack-gap": "0.3rem", minInlineSize: 0 }}>
                <StatusBadge status={v.status} availability={v.availability} />
                <p className={styles.videoTitle}>{v.title}</p>
                <p className="hint">
                  {[v.channel, v.section && t(`common.${v.section}`), v.seriesName, v.number != null && videoLabel(t, v)].filter(Boolean).join(" · ")}
                </p>
                {v.route && <Link to={v.route}>{v.route}</Link>}
              </div>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setToDelete(v)} style={{ alignSelf: "start" }}>
                {t("common.delete")}
              </button>
            </div>
            {status === "pending" ? (
              <>
                <Reasons classification={v.classification} />
                <VideoEditForm video={v} series={series} onSaved={onSaved} />
              </>
            ) : (
              <details className={styles.details}>
                <summary>{t("common.edit")}</summary>
                <Reasons classification={v.classification} />
                <VideoEditForm video={v} series={series} onSaved={onSaved} />
              </details>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(toDelete)}
        title={t("admin.videos.deleteTitle")}
        busy={deleteState.busy}
        onConfirm={onDelete}
        onClose={() => {
          setToDelete(null);
          setDeleteState({ busy: false, error: null });
        }}
      >
        <p>{t("admin.videos.deleteText", { title: toDelete?.title ?? "" })}</p>
        <ErrorText error={deleteState.error} />
      </ConfirmDialog>
    </section>
  );
}
