import { useState } from "react";
import { Link } from "react-router";
import { adminApi } from "../../api/client.js";
import { TextField } from "../../components/Form/TextField.jsx";
import { useT } from "../../i18n/useT.js";
import { numOrUndef } from "../../lib/numbers.js";
import { ErrorText, Reasons, SectionSelect, SeriesSelect, VideoSummary } from "./shared.jsx";
import styles from "./Admin.module.css";

const EMPTY = { url: "", title: "", section: "", seriesSlug: "", season: "", number: "" };

export function AddVideoTab({ series }) {
  const { t, locale } = useT();
  const [form, setForm] = useState(EMPTY);
  const [state, setState] = useState({ busy: false, error: null, result: null, duplicate: false, serverMessage: "" });
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  async function onSubmit(e) {
    e.preventDefault();
    if (!form.url.trim()) return;
    const body = { url: form.url.trim() };
    if (form.title.trim()) body.title = form.title.trim();
    if (form.section) body.section = form.section;
    if (form.seriesSlug) body.seriesSlug = form.seriesSlug;
    if (numOrUndef(form.season) != null) body.season = numOrUndef(form.season);
    if (numOrUndef(form.number) != null) body.number = numOrUndef(form.number);
    setState({ busy: true, error: null, result: null, duplicate: false, serverMessage: "" });
    try {
      const { video } = await adminApi.addVideo(body);
      setState({ busy: false, error: null, result: video, duplicate: false, serverMessage: "" });
      setForm(EMPTY);
    } catch (err) {
      if (err.code === "CONFLICT" && err.details?.video) setState({ busy: false, error: null, result: err.details.video, duplicate: true, serverMessage: err.message ?? "" });
      else setState({ busy: false, error: err, result: null, duplicate: false, serverMessage: "" });
    }
  }

  const r = state.result;
  // v1.4: adding a YouTube video that is in the trash → 409 with the trashed video ("restore it instead").
  const trashed = state.duplicate && Boolean(r?.deletedAt);
  return (
    <div className={styles.split}>
      <form className="card stack" onSubmit={onSubmit} aria-labelledby="add-title">
        <h2 id="add-title">{t("admin.add.title")}</h2>
        <TextField label={t("admin.add.url")} value={form.url} onChange={set("url")} required placeholder="https://youtu.be/…" hint={t("admin.add.urlHint")} autoComplete="off" />
        <fieldset className={styles.overrides}>
          <legend>{t("admin.add.overrides")}</legend>
          <p className="hint">{t("admin.add.overridesHint")}</p>
          <TextField label={`${t("admin.fields.title")} (${t("common.optional")})`} value={form.title} onChange={set("title")} />
          <div className={styles.fieldGrid}>
            <div className="field">
              <label htmlFor="add-section">{t("admin.fields.section")}</label>
              <SectionSelect id="add-section" value={form.section} onChange={set("section")} />
            </div>
            <div className="field">
              <label htmlFor="add-series">{t("admin.fields.series")}</label>
              <SeriesSelect id="add-series" value={form.seriesSlug} onChange={set("seriesSlug")} series={series} />
            </div>
            <TextField label={t("admin.fields.season")} type="number" min="1" value={form.season} onChange={set("season")} inputMode="numeric" />
            <TextField label={t("admin.fields.number")} type="number" min="0" step="any" value={form.number} onChange={set("number")} inputMode="decimal" />
          </div>
        </fieldset>
        <ErrorText error={state.error} />
        <div>
          <button type="submit" className="btn btn-primary" disabled={state.busy || !form.url.trim()}>
            {state.busy ? t("admin.add.adding") : t("admin.add.submit")}
          </button>
        </div>
      </form>

      <section aria-live="polite" aria-labelledby="add-result-title" className="stack">
        <h2 id="add-result-title">{t("admin.add.result")}</h2>
        {!r && <p className="muted">{t("admin.add.resultEmpty")}</p>}
        {r && (
          <div className={`card stack ${styles.resultCard}`} data-status={trashed ? "trashed" : r.status}>
            {trashed ? (
              <div className="alert alert-error stack" role="alert" style={{ "--stack-gap": "var(--space-2)" }}>
                <p className={styles.resultHeadline}>{t("admin.add.duplicateTrashed")}</p>
                {/* The server's own words only in English (the UI never shows English text in pt-BR). */}
                {locale === "en" && state.serverMessage && <p className="hint">{state.serverMessage}</p>}
                <Link to="/admin?tab=trash">{t("admin.add.openTrash")}</Link>
              </div>
            ) : (
              <>
                {state.duplicate && <p className="alert alert-info">{t("admin.add.duplicate")}</p>}
                <p className={styles.resultHeadline}>{r.status === "published" ? t("admin.add.publishedMsg") : t("admin.add.pendingMsg")}</p>
              </>
            )}
            <VideoSummary video={r} />
            <Reasons classification={r.classification} />
          </div>
        )}
      </section>
    </div>
  );
}
