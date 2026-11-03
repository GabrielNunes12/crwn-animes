import { useEffect, useId, useState } from "react";
import { adminApi } from "../../api/client.js";
import { CardGridSkeleton } from "../../components/Skeleton/Skeleton.jsx";
import { useT } from "../../i18n/useT.js";
import { ErrorText, VideoSummary } from "./shared.jsx";
import styles from "./Admin.module.css";

function ReplaceForm({ video, onReplaced }) {
  const { t } = useT();
  const id = useId();
  const [url, setUrl] = useState("");
  const [state, setState] = useState({ busy: false, error: null });
  async function onSubmit(e) {
    e.preventDefault();
    setState({ busy: true, error: null });
    try {
      const { video: updated } = await adminApi.updateVideo(video.id, { url: url.trim() });
      onReplaced(updated);
    } catch (err) {
      setState({ busy: false, error: err });
    }
  }
  return (
    <form className={styles.replaceForm} onSubmit={onSubmit}>
      <div className="field" style={{ flex: "1 1 16rem" }}>
        <label htmlFor={`${id}-url`}>{t("admin.broken.newUrl")}</label>
        <input id={`${id}-url`} className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://youtu.be/…" required />
      </div>
      <button type="submit" className="btn btn-primary" disabled={state.busy || !url.trim()}>
        {state.busy ? t("common.saving") : t("admin.broken.replace")}
      </button>
      <div style={{ flexBasis: "100%" }}>
        <ErrorText error={state.error} />
      </div>
    </form>
  );
}

export function BrokenTab() {
  const { t } = useT();
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState(null);
  const [check, setCheck] = useState({ busy: false, message: "", error: null });

  useEffect(() => {
    let alive = true;
    adminApi
      .videos({ availability: "unavailable" })
      .then((list) => alive && setVideos(list))
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
    };
  }, []);

  async function runCheck() {
    setCheck({ busy: true, message: "", error: null });
    try {
      const { checked, unavailable } = await adminApi.healthCheck();
      setVideos(unavailable);
      setCheck({ busy: false, message: t("admin.broken.checked", { checked, count: unavailable.length }), error: null });
    } catch (err) {
      setCheck({ busy: false, message: "", error: err });
    }
  }

  return (
    <section className="stack" aria-labelledby="broken-title">
      <div className="section-head">
        <h2 id="broken-title">{t("admin.broken.title", { count: videos?.length ?? 0 })}</h2>
        <button type="button" className="btn" onClick={runCheck} disabled={check.busy}>
          {check.busy ? t("admin.broken.checking") : t("admin.broken.run")}
        </button>
      </div>
      <p className="hint">{t("admin.broken.hint")}</p>
      <p role="status" aria-live="polite" className={check.message ? "alert alert-info" : "visually-hidden"}>
        {check.message}
      </p>
      <ErrorText error={check.error || error} />
      {!videos && !error && <CardGridSkeleton count={2} />}
      {videos?.length === 0 && <p className="card muted">{t("admin.broken.none")}</p>}
      <ul className={styles.rows} role="list">
        {videos?.map((v) => (
          <li key={v.id} className={styles.videoRow}>
            <VideoSummary video={v} />
            <ReplaceForm
              video={v}
              onReplaced={(updated) => {
                setVideos((list) => list.filter((x) => x.id !== updated.id));
                setCheck({ busy: false, message: t("admin.broken.replaced", { title: updated.title }), error: null });
              }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
