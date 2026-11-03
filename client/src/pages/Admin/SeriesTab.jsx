import { useRef, useState } from "react";
import { adminApi } from "../../api/client.js";
import { ChipsInput } from "../../components/ChipsInput/ChipsInput.jsx";
import { ConfirmDialog } from "../../components/ConfirmDialog/ConfirmDialog.jsx";
import { TextField } from "../../components/Form/TextField.jsx";
import { useT } from "../../i18n/useT.js";
import { ErrorText } from "./shared.jsx";
import { ListEmpty, ListHeading, ListSearch, Pager } from "./ListControls.jsx";
import { useAdminList } from "./useAdminList.js";
import styles from "./Admin.module.css";

const EMPTY = { name: "", slug: "", synopsis: "", genres: [], aliases: [], coverUrl: "" };

function isHttpUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function SeriesTab({ genres, reloadSeries, reloadKey }) {
  const { t } = useT();
  const headingRef = useRef(null);
  const list = useAdminList(adminApi.series, { reloadKey, focusRef: headingRef });
  const [editing, setEditing] = useState(null); // series being edited, or null for "new"
  const [form, setForm] = useState(EMPTY);
  const [state, setState] = useState({ busy: false, error: null, message: "" });
  const [toDelete, setToDelete] = useState(null);
  const [deleteState, setDeleteState] = useState({ busy: false, error: null });

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  function startEdit(s) {
    setEditing(s);
    setForm({ name: s.name, slug: s.slug, synopsis: s.synopsis ?? "", genres: s.genres ?? [], aliases: s.aliases ?? [], coverUrl: s.coverUrl ?? "" });
    setState({ busy: false, error: null, message: "" });
    document.getElementById("series-form")?.scrollIntoView({ block: "start" });
  }

  function reset() {
    setEditing(null);
    setForm(EMPTY);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) {
      setState({ busy: false, error: { message: t("admin.series.nameRequired") }, message: "" });
      return;
    }
    const body = {
      name: form.name.trim(),
      synopsis: form.synopsis.trim() || null,
      genres: form.genres,
      aliases: form.aliases,
      coverUrl: form.coverUrl.trim() || null,
    };
    if (form.slug.trim()) body.slug = form.slug.trim();
    setState({ busy: true, error: null, message: "" });
    try {
      const res = editing ? await adminApi.updateSeries(editing.id, body) : await adminApi.createSeries(body);
      const published = res.published ?? [];
      const message =
        (editing ? t("admin.series.updated", { name: res.series.name }) : t("admin.series.created", { name: res.series.name })) +
        (published.length ? ` ${t("admin.series.published", { count: published.length })}` : "");
      setState({ busy: false, error: null, message });
      reset();
      reloadSeries();
    } catch (err) {
      setState({ busy: false, error: err, message: "" });
    }
  }

  async function onDelete() {
    setDeleteState({ busy: true, error: null });
    try {
      await adminApi.deleteSeries(toDelete.id);
      if (editing?.id === toDelete.id) reset();
      list.removeItem(toDelete.id);
      setToDelete(null);
      setDeleteState({ busy: false, error: null });
      setState({ busy: false, error: null, message: t("admin.series.deleted", { name: toDelete.name }) });
      reloadSeries();
    } catch (err) {
      setDeleteState({ busy: false, error: err });
    }
  }

  return (
    <div className={styles.split}>
      <form id="series-form" className="card stack" onSubmit={onSubmit} aria-labelledby="series-form-title">
        <h2 id="series-form-title">{editing ? t("admin.series.editTitle", { name: editing.name }) : t("admin.series.newTitle")}</h2>
        <TextField label={t("admin.series.name")} value={form.name} onChange={set("name")} required />
        <TextField label={`${t("admin.series.slug")} (${t("common.optional")})`} value={form.slug} onChange={set("slug")} hint={t("admin.series.slugHint")} pattern="[a-z0-9-]*" />
        <div className="field">
          <label htmlFor="synopsis">{t("admin.series.synopsis")}</label>
          <textarea id="synopsis" className="textarea" value={form.synopsis} onChange={(e) => set("synopsis")(e.target.value)} rows={4} />
        </div>
        <ChipsInput label={t("common.genres")} value={form.genres} onChange={set("genres")} suggestions={genres} />
        <ChipsInput label={t("admin.series.aliases")} value={form.aliases} onChange={set("aliases")} />
        <TextField label={t("admin.series.cover")} type="url" value={form.coverUrl} onChange={set("coverUrl")} placeholder="https://…" />
        <div className={styles.coverPreview} aria-live="polite">
          {isHttpUrl(form.coverUrl) ? <img src={form.coverUrl} alt={t("admin.series.coverPreview")} width="120" height="180" /> : <span className="hint">{t("admin.series.coverNone")}</span>}
        </div>
        <ErrorText error={state.error} />
        <p role="status" aria-live="polite" className={state.message ? "alert alert-success" : "visually-hidden"}>
          {state.message}
        </p>
        <div className="cluster">
          <button type="submit" className="btn btn-primary" disabled={state.busy}>
            {state.busy ? t("common.saving") : editing ? t("common.save") : t("admin.series.create")}
          </button>
          {editing && (
            <button type="button" className="btn btn-ghost" onClick={reset}>
              {t("common.cancel")}
            </button>
          )}
        </div>
      </form>

      <section aria-labelledby="series-list-title" className="stack">
        <ListHeading list={list} id="series-list-title" ref={headingRef}>
          {t("admin.series.all", { count: list.total })}
        </ListHeading>
        <ListSearch list={list} label={t("admin.list.searchSeries")} />
        <ErrorText error={list.error} />
        <ListEmpty list={list}>{t("admin.series.none")}</ListEmpty>
        <ul className={styles.rows} role="list" aria-busy={list.loading || undefined} data-stale={(list.loading && list.loaded) || undefined}>
          {list.items.map((s) => (
            <li key={s.id} className={styles.row}>
              <div className={styles.rowMain}>
                <p className={styles.videoTitle}>{s.name}</p>
                <p className="hint">
                  <code>{s.slug}</code>
                  {s.genres?.length ? ` · ${s.genres.join(", ")}` : ""}
                </p>
              </div>
              <div className="cluster">
                <button type="button" className="btn btn-sm" onClick={() => startEdit(s)}>
                  {t("common.edit")}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setToDelete(s)}>
                  {t("common.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
        <Pager list={list} />
      </section>

      <ConfirmDialog
        open={Boolean(toDelete)}
        title={t("admin.series.deleteTitle", { name: toDelete?.name ?? "" })}
        busy={deleteState.busy}
        onConfirm={onDelete}
        onClose={() => {
          setToDelete(null);
          setDeleteState({ busy: false, error: null });
        }}
      >
        <p>{t("admin.series.deleteText")}</p>
        <ErrorText error={deleteState.error} />
      </ConfirmDialog>
    </div>
  );
}
