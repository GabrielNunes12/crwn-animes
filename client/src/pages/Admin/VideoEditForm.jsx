import { useId, useState } from "react";
import { adminApi } from "../../api/client.js";
import { useT } from "../../i18n/useT.js";
import { ErrorText, SectionSelect, SeriesSelect } from "./shared.jsx";
import styles from "./Admin.module.css";

const str = (v) => (v == null ? "" : String(v));

/** Values the video currently has (what "unchanged" means). */
function baseOf(video) {
  return { section: str(video.section), seriesSlug: str(video.seriesSlug), season: str(video.season ?? 1), number: str(video.number) };
}

/**
 * Inline fix form for one video. Pending rows are prefilled with the
 * classifier's suggested number. Only changed fields are sent; a cleared
 * field is sent as null (= remove the manual override, let the server decide).
 */
export function VideoEditForm({ video, series, onSaved }) {
  const { t } = useT();
  const id = useId();
  const base = baseOf(video);
  const [form, setForm] = useState(() => ({
    ...base,
    number: str(video.number ?? video.overrides?.number ?? video.classification?.suggestedNumber),
  }));
  const [state, setState] = useState({ busy: false, error: null });
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const changes = {};
  for (const k of Object.keys(base)) {
    if (form[k] !== base[k]) {
      if (form[k] === "") changes[k] = null;
      else changes[k] = k === "season" || k === "number" ? Number(form[k]) : form[k];
    }
  }
  const dirty = Object.keys(changes).length > 0;

  async function onSubmit(e) {
    e.preventDefault();
    if (!dirty) return;
    setState({ busy: true, error: null });
    try {
      const { video: updated } = await adminApi.updateVideo(video.id, changes);
      setState({ busy: false, error: null });
      onSaved(updated);
    } catch (err) {
      setState({ busy: false, error: err });
    }
  }

  return (
    <form className={styles.editForm} onSubmit={onSubmit} aria-label={t("admin.videos.editLabel", { title: video.title })}>
      <div className="field">
        <label htmlFor={`${id}-section`}>{t("admin.fields.section")}</label>
        <SectionSelect id={`${id}-section`} value={form.section} onChange={set("section")} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-series`}>{t("admin.fields.series")}</label>
        <SeriesSelect id={`${id}-series`} value={form.seriesSlug} onChange={set("seriesSlug")} series={series} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-season`}>{t("admin.fields.season")}</label>
        <input id={`${id}-season`} className="input" type="number" min="1" step="1" inputMode="numeric" value={form.season} onChange={(e) => set("season")(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-number`}>{t("admin.fields.number")}</label>
        <input id={`${id}-number`} className="input" type="number" min="0" step="any" inputMode="decimal" value={form.number} onChange={(e) => set("number")(e.target.value)} />
      </div>
      <div className={styles.editActions}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty || state.busy}>
          {state.busy ? t("common.saving") : t("admin.videos.saveFix")}
        </button>
      </div>
      <div className={styles.editError}>
        <ErrorText error={state.error} />
      </div>
    </form>
  );
}
