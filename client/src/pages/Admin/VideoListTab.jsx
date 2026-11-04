import { useCallback, useRef, useState } from "react";
import { Link } from "react-router";
import { adminApi } from "../../api/client.js";
import { ConfirmDialog } from "../../components/ConfirmDialog/ConfirmDialog.jsx";
import { CardGridSkeleton } from "../../components/Skeleton/Skeleton.jsx";
import { useT } from "../../i18n/useT.js";
import { Reasons, StatusBadge, ErrorText } from "./shared.jsx";
import { VideoEditForm } from "./VideoEditForm.jsx";
import { ListEmpty, ListHeading, ListSearch, Pager } from "./ListControls.jsx";
import { useAdminList } from "./useAdminList.js";
import { videoLabel } from "../../lib/format.js";
import { LazyImage } from "../../components/LazyImage/LazyImage.jsx";
import styles from "./Admin.module.css";

export function VideoListTab({ status, series }) {
  const { t } = useT();
  const fetchPage = useCallback((params, opts) => adminApi.videos({ ...params, status }, opts), [status]);
  const headingRef = useRef(null);
  const list = useAdminList(fetchPage, { focusRef: headingRef });
  const [message, setMessage] = useState("");
  const [toDelete, setToDelete] = useState(null);
  const [deleteState, setDeleteState] = useState({ busy: false, error: null });

  function onSaved(updated) {
    if (updated.status !== status) {
      list.removeItem(updated.id);
      setMessage(
        updated.status === "published" ? t("admin.videos.nowPublished", { title: updated.title, route: updated.route ?? "" }) : t("admin.videos.nowPending", { title: updated.title }),
      );
    } else {
      list.replaceItem(updated);
      setMessage(t("admin.videos.saved", { title: updated.title }));
    }
  }

  async function onDelete() {
    setDeleteState({ busy: true, error: null });
    try {
      await adminApi.deleteVideo(toDelete.id);
      list.removeItem(toDelete.id);
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
        <ListHeading list={list} id={`${status}-title`} ref={headingRef}>
          {t(`admin.videos.${status}Title`, { count: list.total })}
        </ListHeading>
        <button type="button" className="btn btn-sm" onClick={list.reload}>
          {t("admin.refresh")}
        </button>
      </div>
      <p className="hint">{t(`admin.videos.${status}Hint`)}</p>
      <p role="status" aria-live="polite" className={message ? "alert alert-success" : "visually-hidden"}>
        {message}
      </p>
      <ListSearch list={list} label={t("admin.list.searchVideos")} />
      <ErrorText error={list.error} />
      {!list.loaded && !list.error && <CardGridSkeleton count={3} />}
      <ListEmpty list={list}>{t(`admin.videos.${status}Empty`)}</ListEmpty>
      <ul className={styles.rows} role="list" aria-busy={list.loading || undefined} data-stale={(list.loading && list.loaded) || undefined}>
        {list.items.map((v) => (
          <li key={v.id} className={styles.videoRow}>
            <div className={styles.videoHead}>
              <span className={styles.thumb}>
                <LazyImage src={v.thumbnailUrl} alt="" width={160} height={90} fallbackLabel={v.seriesName ?? v.title} />
              </span>
              <div className="stack" style={{ "--stack-gap": "0.3rem", minInlineSize: 0 }}>
                <StatusBadge status={v.status} availability={v.availability} />
                <p className={styles.videoTitle}>{v.title}</p>
                <p className="hint">
                  {[v.channel, v.section && t(`common.${v.section}`), v.seriesName, v.number != null && videoLabel(t, v)].filter(Boolean).join(" · ")}
                </p>
                {v.route && <Link to={v.route}>{v.route}</Link>}
              </div>
              <div className="cluster" style={{ alignSelf: "start", justifyContent: "flex-end" }}>
                <Link className="btn btn-sm btn-ghost" to={`/admin/preview/${v.id}`}>
                  {t("admin.previewLink")}
                </Link>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setToDelete(v)}>
                  {t("admin.moveToTrash")}
                </button>
              </div>
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
      <Pager list={list} />
      <ConfirmDialog
        open={Boolean(toDelete)}
        title={t("admin.videos.deleteTitle")}
        confirmLabel={t("admin.moveToTrash")}
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
