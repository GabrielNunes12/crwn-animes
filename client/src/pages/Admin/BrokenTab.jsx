import { useId, useRef, useState } from "react";
import { adminApi } from "../../api/client.js";
import { CardGridSkeleton } from "../../components/Skeleton/Skeleton.jsx";
import { useT } from "../../i18n/useT.js";
import { ErrorText, VideoSummary } from "./shared.jsx";
import { ListEmpty, ListHeading, ListSearch, Pager } from "./ListControls.jsx";
import { useAdminList } from "./useAdminList.js";
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

const fetchBroken = (params, opts) => adminApi.videos({ ...params, availability: "unavailable" }, opts);

export function BrokenTab() {
  const { t } = useT();
  const headingRef = useRef(null);
  const list = useAdminList(fetchBroken, { focusRef: headingRef });
  const [check, setCheck] = useState({ busy: false, message: "", error: null });

  async function runCheck() {
    setCheck({ busy: true, message: "", error: null });
    try {
      const { checked, unavailable } = await adminApi.healthCheck();
      // The check returns every unavailable video; re-read the current page.
      list.reload();
      setCheck({ busy: false, message: t("admin.broken.checked", { checked, count: unavailable?.length ?? 0 }), error: null });
    } catch (err) {
      setCheck({ busy: false, message: "", error: err });
    }
  }

  return (
    <section className="stack" aria-labelledby="broken-title">
      <div className="section-head">
        <ListHeading list={list} id="broken-title" ref={headingRef}>
          {t("admin.broken.title", { count: list.total })}
        </ListHeading>
        <button type="button" className="btn" onClick={runCheck} disabled={check.busy}>
          {check.busy ? t("admin.broken.checking") : t("admin.broken.run")}
        </button>
      </div>
      <p className="hint">{t("admin.broken.hint")}</p>
      <p role="status" aria-live="polite" className={check.message ? "alert alert-info" : "visually-hidden"}>
        {check.message}
      </p>
      <ListSearch list={list} label={t("admin.list.searchVideos")} />
      <ErrorText error={check.error || list.error} />
      {!list.loaded && !list.error && <CardGridSkeleton count={2} />}
      <ListEmpty list={list}>{t("admin.broken.none")}</ListEmpty>
      <ul className={styles.rows} role="list" aria-busy={list.loading || undefined} data-stale={(list.loading && list.loaded) || undefined}>
        {list.items.map((v) => (
          <li key={v.id} className={styles.videoRow}>
            <VideoSummary video={v} />
            <ReplaceForm
              video={v}
              onReplaced={(updated) => {
                list.removeItem(updated.id);
                setCheck({ busy: false, message: t("admin.broken.replaced", { title: updated.title }), error: null });
              }}
            />
          </li>
        ))}
      </ul>
      <Pager list={list} />
    </section>
  );
}
