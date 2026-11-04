import { useId, useState } from "react";
import { Link } from "react-router";
import { adminApi } from "../../api/client.js";
import { useT } from "../../i18n/useT.js";
import { numOrUndef } from "../../lib/numbers.js";
import { ErrorText, SectionSelect, SeriesSelect } from "./shared.jsx";
import styles from "./Admin.module.css";

function rowRoute(row) {
  return row.video?.route ?? row.preview?.route ?? null;
}

export function BulkResults({ results, preview }) {
  const { t, locale } = useT();
  return (
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={preview ? t("admin.bulk.previewCaption") : t("admin.bulk.resultCaption")}>
      <table className={styles.table}>
        <caption className="visually-hidden">{preview ? t("admin.bulk.previewCaption") : t("admin.bulk.resultCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("admin.bulk.input")}</th>
            <th scope="col">{t("admin.bulk.outcome")}</th>
            <th scope="col">{t("admin.bulk.placement")}</th>
            <th scope="col">{t("admin.bulk.details")}</th>
          </tr>
        </thead>
        <tbody>
          {results.map((row, i) => {
            const p = row.preview ?? row.video ?? {};
            const route = rowRoute(row);
            const trashed = row.outcome === "duplicate" && Boolean(row.video?.deletedAt);
            return (
              <tr key={`${row.input}-${i}`} data-outcome={row.outcome}>
                <td className={styles.inputCell}>
                  <code>{row.youtubeVideoId ?? row.input}</code>
                </td>
                <td>
                  <span className={`badge ${styles[`outcome-${row.outcome}`] ?? ""}`}>{t(`admin.bulk.outcomes.${row.outcome}`)}</span>
                  {trashed && (
                    <>
                      {" "}
                      <span className={`badge ${styles.trashed}`}>{t("admin.preview.trashed")}</span>
                    </>
                  )}
                </td>
                <td>
                  {p.section ? (
                    <>
                      {t(`common.${p.section}`)}
                      {p.seriesSlug ? ` · ${p.seriesSlug}` : ""}
                      {p.season > 1 ? ` · S${p.season}` : ""}
                      {p.number != null ? ` · #${p.number}` : ""}
                      {p.status && !trashed && <span className="hint"> ({t(`admin.status.${p.status}`)})</span>}
                    </>
                  ) : (
                    <span className="hint">—</span>
                  )}
                  {route && (
                    <div>
                      <Link to={route}>{route}</Link>
                    </div>
                  )}
                </td>
                <td>
                  {row.message && locale === "en" && <p>{row.message}</p>}
                  {row.preview?.reasons?.length > 0 && <p className="hint">{row.preview.reasons.join("; ")}</p>}
                  {row.video?.title && <p className="hint">{row.video.title}</p>}
                  {trashed && (
                    <p>
                      {t("admin.bulk.trashed")} <Link to="/admin?tab=trash">{t("admin.add.openTrash")}</Link>
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function BulkTab({ series }) {
  const { t } = useT();
  const id = useId();
  const [text, setText] = useState("");
  const [defaults, setDefaults] = useState({ section: "", seriesSlug: "", season: "" });
  const [state, setState] = useState({ busy: false, error: null, results: null, preview: false });
  const setD = (k) => (v) => setDefaults((d) => ({ ...d, [k]: v }));

  function body(dryRun) {
    const d = {};
    if (defaults.section) d.section = defaults.section;
    if (defaults.seriesSlug) d.seriesSlug = defaults.seriesSlug;
    if (numOrUndef(defaults.season) != null) d.season = numOrUndef(defaults.season);
    return { text, defaults: d, dryRun };
  }

  async function run(dryRun) {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const { results } = await adminApi.bulk(body(dryRun));
      setState({ busy: false, error: null, results, preview: dryRun });
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: err }));
    }
  }

  const creatable = state.preview ? (state.results ?? []).filter((r) => r.outcome === "would-create").length : 0;

  return (
    <div className="stack" style={{ "--stack-gap": "var(--space-5)" }}>
      <form
        className="card stack"
        aria-labelledby={`${id}-title`}
        onSubmit={(e) => {
          e.preventDefault();
          run(true);
        }}
      >
        <h2 id={`${id}-title`}>{t("admin.bulk.title")}</h2>
        <div className="field">
          <label htmlFor={`${id}-text`}>{t("admin.bulk.links")}</label>
          <textarea
            id={`${id}-text`}
            className="textarea"
            rows={7}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (state.preview) setState((s) => ({ ...s, results: null, preview: false }));
            }}
            placeholder={"https://youtu.be/…\nhttps://www.youtube.com/watch?v=…"}
            aria-describedby={`${id}-hint`}
          />
          <p id={`${id}-hint`} className="hint">
            {t("admin.bulk.hint")}
          </p>
        </div>
        <fieldset className={styles.overrides}>
          <legend>{t("admin.bulk.defaults")}</legend>
          <div className={styles.fieldGrid}>
            <div className="field">
              <label htmlFor={`${id}-section`}>{t("admin.fields.section")}</label>
              <SectionSelect id={`${id}-section`} value={defaults.section} onChange={setD("section")} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-series`}>{t("admin.fields.series")}</label>
              <SeriesSelect id={`${id}-series`} value={defaults.seriesSlug} onChange={setD("seriesSlug")} series={series} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-season`}>{t("admin.fields.season")}</label>
              <input id={`${id}-season`} className="input" type="number" min="1" value={defaults.season} onChange={(e) => setD("season")(e.target.value)} />
            </div>
          </div>
        </fieldset>
        <ErrorText error={state.error} />
        <div className="cluster">
          <button type="submit" className="btn" disabled={state.busy || !text.trim()}>
            {state.busy ? t("common.working") : t("admin.bulk.preview")}
          </button>
          {state.preview && (
            <button type="button" className="btn btn-primary" disabled={state.busy || creatable === 0} onClick={() => run(false)}>
              {t("admin.bulk.confirm", { count: creatable })}
            </button>
          )}
        </div>
      </form>

      <section aria-live="polite" aria-labelledby={`${id}-results`}>
        {state.results && (
          <>
            <h2 id={`${id}-results`} style={{ marginBlockEnd: "var(--space-3)" }}>
              {state.preview ? t("admin.bulk.previewTitle", { count: state.results.length }) : t("admin.bulk.resultTitle", { count: state.results.length })}
            </h2>
            {state.results.length === 0 ? <p className="muted">{t("admin.bulk.noLinks")}</p> : <BulkResults results={state.results} preview={state.preview} />}
          </>
        )}
      </section>
    </div>
  );
}
