import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { adminApi } from "../../api/client.js";
import { ConfirmDialog } from "../../components/ConfirmDialog/ConfirmDialog.jsx";
import { CardGridSkeleton } from "../../components/Skeleton/Skeleton.jsx";
import { useT } from "../../i18n/useT.js";
import { videoLabel } from "../../lib/format.js";
import { daysUntil } from "../../lib/order.js";
import { ErrorText } from "./shared.jsx";
import styles from "./Admin.module.css";

/** "Moved to trash 2 days ago · Deleted forever in 5 days" */
export function TrashDates({ item }) {
  const { t, formatRelative, formatDate } = useT();
  const days = daysUntil(item.purgeAt);
  return (
    <p className="hint">
      {item.deletedAt && (
        <time dateTime={item.deletedAt} title={formatDate(item.deletedAt)}>
          {t("admin.trash.removed", { when: formatRelative(item.deletedAt) })}
        </time>
      )}
      {item.deletedAt && days != null && " · "}
      {days != null && (
        <time dateTime={item.purgeAt} title={formatDate(item.purgeAt)}>
          {days === 0 ? t("admin.trash.purgeSoon") : t("admin.trash.purgeIn", { count: days })}
        </time>
      )}
    </p>
  );
}

export function TrashTab({ reloadSeries }) {
  const { t, errorMessage } = useT();
  const [state, setState] = useState({ loaded: false, series: [], videos: [], error: null });
  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState("");
  const [busyKey, setBusyKey] = useState(null);
  const [rowError, setRowError] = useState(null); // { key, text }
  const [toPurge, setToPurge] = useState(null); // { kind: "series" | "video", item }
  const [purgeState, setPurgeState] = useState({ busy: false, error: null });
  const seriesHeading = useRef(null);
  const videoHeading = useRef(null);
  const focusAfter = useRef(null);

  useEffect(() => {
    const ctrl = new AbortController();
    adminApi
      .trash({ signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setState({ loaded: true, series: res?.series ?? [], videos: res?.videos ?? [], error: null });
      })
      .catch((error) => {
        if (ctrl.signal.aborted || error?.name === "AbortError") return;
        setState((s) => ({ ...s, loaded: true, error }));
      });
    return () => ctrl.abort();
  }, [version]);

  // The row that had focus is gone: continue from its list's heading. A passive effect,
  // so it runs after the confirm dialog has closed and the page is interactive again.
  useEffect(() => {
    const kind = focusAfter.current;
    if (!kind) return;
    focusAfter.current = null;
    (kind === "series" ? seriesHeading : videoHeading).current?.focus();
  });

  const listKey = (kind) => (kind === "series" ? "series" : "videos");
  const drop = (kind, id) => setState((s) => ({ ...s, [listKey(kind)]: s[listKey(kind)].filter((x) => x.id !== id) }));

  async function restore(kind, item) {
    const key = `${kind}:${item.id}`;
    if (busyKey) return;
    setBusyKey(key);
    setRowError(null);
    setMessage("");
    try {
      if (kind === "series") {
        const res = await adminApi.restoreSeries(item.id);
        const pending = res?.pending?.length ?? 0;
        const name = res?.series?.name ?? item.name;
        setMessage(`${t("admin.trash.restoredSeries", { name })}${pending ? ` ${t("admin.trash.restoredSeriesPending", { count: pending })}` : ""}`);
        reloadSeries?.();
        // Videos trashed with the series came back too; refresh the rest of the list.
        setVersion((v) => v + 1);
      } else {
        const res = await adminApi.restoreVideo(item.id);
        const video = res?.video ?? item;
        setMessage(video.status === "pending" ? t("admin.trash.restoredVideoPending", { title: video.title }) : t("admin.trash.restoredVideo", { title: video.title }));
      }
      drop(kind, item.id);
      focusAfter.current = kind;
    } catch (error) {
      let text = errorMessage(error);
      if (kind === "video" && error?.code === "CONFLICT") {
        text = item.seriesName ? t("admin.trash.restoreConflict", { series: item.seriesName }) : t("admin.trash.restoreConflictNoName");
      }
      setRowError({ key, text });
    } finally {
      setBusyKey(null);
    }
  }

  async function purge() {
    const { kind, item } = toPurge;
    setPurgeState({ busy: true, error: null });
    try {
      if (kind === "series") await adminApi.purgeSeries(item.id);
      else await adminApi.purgeVideo(item.id);
      drop(kind, item.id);
      setToPurge(null);
      setPurgeState({ busy: false, error: null });
      setRowError(null);
      setMessage(t("admin.trash.purged", { name: kind === "series" ? item.name : item.title }));
      focusAfter.current = kind;
      if (kind === "series") setVersion((v) => v + 1);
    } catch (error) {
      setPurgeState({ busy: false, error });
    }
  }

  // Plain render helpers (not components): rows must keep their DOM, and focus, across renders.
  function actions(kind, item, describedBy) {
    const key = `${kind}:${item.id}`;
    const busy = busyKey === key;
    return (
      <div className="cluster">
        {kind === "video" && (
          <Link className="btn btn-sm btn-ghost" to={`/admin/preview/${item.id}`} aria-describedby={describedBy}>
            {t("admin.previewLink")}
          </Link>
        )}
        <button type="button" className="btn btn-sm" aria-describedby={describedBy} aria-disabled={Boolean(busyKey) || undefined} onClick={() => restore(kind, item)}>
          {busy ? t("admin.trash.restoring") : t("admin.trash.restore")}
        </button>
        <button type="button" className="btn btn-sm btn-danger" aria-describedby={describedBy} onClick={() => setToPurge({ kind, item })}>
          {t("admin.trash.deleteForever")}
        </button>
      </div>
    );
  }

  function rowAlert(kind, item) {
    if (rowError?.key !== `${kind}:${item.id}`) return null;
    return (
      <p className={`alert alert-error ${styles.rowAlert}`} role="alert">
        {rowError.text}
      </p>
    );
  }

  const { series, videos } = state;
  const empty = state.loaded && !state.error && series.length === 0 && videos.length === 0;

  return (
    <section className="stack" aria-labelledby="trash-title">
      <div className="section-head">
        <h2 id="trash-title">{t("admin.trash.title")}</h2>
        <button type="button" className="btn btn-sm" onClick={() => setVersion((v) => v + 1)}>
          {t("admin.refresh")}
        </button>
      </div>
      <p className="hint">{t("admin.trash.hint")}</p>
      <p role="status" aria-live="polite" className={message ? "alert alert-success" : "visually-hidden"}>
        {message}
      </p>
      <ErrorText error={state.error} />
      {!state.loaded && <CardGridSkeleton count={2} />}
      {empty && <p className="card muted">{t("admin.trash.empty")}</p>}

      {state.loaded && !empty && (
        <>
          <section className="stack" aria-labelledby="trash-series-title">
            <h3 id="trash-series-title" ref={seriesHeading} tabIndex={-1}>
              {t("admin.trash.seriesTitle", { count: series.length })}
            </h3>
            {series.length === 0 ? (
              <p className="hint">{t("admin.trash.seriesEmpty")}</p>
            ) : (
              <ul className={styles.rows} role="list">
                {series.map((s) => (
                  <li key={s.id} className={styles.row}>
                    <div className={styles.rowMain}>
                      <p className={styles.videoTitle} id={`trash-series-${s.id}`}>
                        {s.name} <span className={`badge ${styles.trashed}`}>{t("admin.preview.trashed")}</span>
                      </p>
                      <p className="hint">
                        <code>{s.slug}</code> · {t("common.videoCount", { count: s.videoCount ?? 0 })}
                      </p>
                      <TrashDates item={s} />
                    </div>
                    {actions("series", s, `trash-series-${s.id}`)}
                    {rowAlert("series", s)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="stack" aria-labelledby="trash-videos-title">
            <h3 id="trash-videos-title" ref={videoHeading} tabIndex={-1}>
              {t("admin.trash.videosTitle", { count: videos.length })}
            </h3>
            {videos.length === 0 ? (
              <p className="hint">{t("admin.trash.videosEmpty")}</p>
            ) : (
              <ul className={styles.rows} role="list">
                {videos.map((v) => (
                  <li key={v.id} className={styles.row}>
                    <div className={styles.summary} style={{ flex: "1 1 20rem" }}>
                      <img src={v.thumbnailUrl} alt="" width="160" height="90" loading="lazy" decoding="async" className={styles.thumb} />
                      <div className="stack" style={{ "--stack-gap": "0.3rem", minInlineSize: 0, flex: "1 1 14rem" }}>
                        <p className={styles.videoTitle} id={`trash-video-${v.id}`}>
                          {v.title}
                        </p>
                        <p className="hint">
                          {[v.section && t(`common.${v.section}`), v.seriesName, v.number != null && videoLabel(t, v)].filter(Boolean).join(" · ") || t("admin.unclassified")}
                        </p>
                        <TrashDates item={v} />
                      </div>
                    </div>
                    {actions("video", v, `trash-video-${v.id}`)}
                    {rowAlert("video", v)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <ConfirmDialog
        open={Boolean(toPurge)}
        title={t("admin.trash.purgeTitle", { name: toPurge ? (toPurge.kind === "series" ? toPurge.item.name : toPurge.item.title) : "" })}
        confirmLabel={t("admin.trash.deleteForever")}
        busy={purgeState.busy}
        onConfirm={purge}
        onClose={() => {
          setToPurge(null);
          setPurgeState({ busy: false, error: null });
        }}
      >
        <p>{toPurge?.kind === "series" ? t("admin.trash.purgeSeriesText", { count: toPurge.item.videoCount ?? 0 }) : t("admin.trash.purgeVideoText")}</p>
        <ErrorText error={purgeState.error} />
      </ConfirmDialog>
    </section>
  );
}
