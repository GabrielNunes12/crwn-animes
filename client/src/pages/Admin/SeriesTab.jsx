import { useRef, useState } from "react";
import { Link } from "react-router";
import { adminApi } from "../../api/client.js";
import { ChipsInput } from "../../components/ChipsInput/ChipsInput.jsx";
import { ConfirmDialog } from "../../components/ConfirmDialog/ConfirmDialog.jsx";
import { TextField } from "../../components/Form/TextField.jsx";
import { useT } from "../../i18n/useT.js";
import { ErrorText } from "./shared.jsx";
import { ListEmpty, ListHeading, ListSearch, Pager } from "./ListControls.jsx";
import { useAdminList } from "./useAdminList.js";
import { LazyImage } from "../../components/LazyImage/LazyImage.jsx";
import styles from "./Admin.module.css";

// `coverUrl` here is the SOURCE address the admin types (admin responses: `coverSourceUrl`); it is
// sent back as `coverUrl` on create/patch. The browser never loads it: covers are only shown
// through our own server (`series.coverUrl` = /api/covers/<id>.img?v=…), so the preview of a
// new or changed address appears after saving (docs/API.md v1.5).
const EMPTY = { name: "", slug: "", synopsis: "", genres: [], aliases: [], coverUrl: "" };

/** What the cover box shows: the saved, proxied cover, a "after saving" hint, or nothing. */
function coverPreviewOf(form, editing) {
  const typed = form.coverUrl.trim();
  if (!typed) return { kind: "none" };
  if (editing && editing.coverUrl && typed === (editing.coverSourceUrl ?? "").trim()) return { kind: "saved", src: editing.coverUrl };
  return { kind: "afterSave" };
}

export function SeriesTab({ genres, reloadSeries, reloadKey }) {
  const { t } = useT();
  const headingRef = useRef(null);
  const list = useAdminList(adminApi.series, { reloadKey, focusRef: headingRef });
  const [editing, setEditing] = useState(null); // series being edited, or null for "new"
  const [form, setForm] = useState(EMPTY);
  const [state, setState] = useState({ busy: false, error: null, message: "", saved: null });
  const [toDelete, setToDelete] = useState(null);
  const [deleteState, setDeleteState] = useState({ busy: false, error: null });

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const cover = coverPreviewOf(form, editing);

  function startEdit(s) {
    setEditing(s);
    setForm({ name: s.name, slug: s.slug, synopsis: s.synopsis ?? "", genres: s.genres ?? [], aliases: s.aliases ?? [], coverUrl: s.coverSourceUrl ?? "" });
    setState({ busy: false, error: null, message: "", saved: null });
    document.getElementById("series-form")?.scrollIntoView({ block: "start" });
  }

  function reset() {
    setEditing(null);
    setForm(EMPTY);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) {
      setState({ busy: false, error: { message: t("admin.series.nameRequired") }, message: "", saved: null });
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
    setState({ busy: true, error: null, message: "", saved: null });
    try {
      const res = editing ? await adminApi.updateSeries(editing.id, body) : await adminApi.createSeries(body);
      const published = res.published ?? [];
      const message =
        (editing ? t("admin.series.updated", { name: res.series.name }) : t("admin.series.created", { name: res.series.name })) +
        (published.length ? ` ${t("admin.series.published", { count: published.length })}` : "");
      // The proxied cover can only be previewed now that the server knows the new address.
      setState({ busy: false, error: null, message, saved: res.series.coverUrl ? { name: res.series.name, coverUrl: res.series.coverUrl } : null });
      reset();
      reloadSeries();
    } catch (err) {
      setState({ busy: false, error: err, message: "", saved: null });
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
      setState({ busy: false, error: null, message: t("admin.series.deleted", { name: toDelete.name }), saved: null });
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
        <TextField label={t("admin.series.cover")} type="url" value={form.coverUrl} onChange={set("coverUrl")} placeholder="https://…" hint={t("admin.series.coverHint")} />
        <div className={styles.coverPreview} data-kind={cover.kind} aria-live="polite">
          {cover.kind === "saved" ? (
            <LazyImage src={cover.src} alt={t("admin.series.coverPreview")} ratio="2 / 3" width={120} height={180} fallbackLabel={editing.name} />
          ) : (
            <span className="hint">{t(cover.kind === "afterSave" ? "admin.series.coverAfterSave" : "admin.series.coverNone")}</span>
          )}
        </div>
        <ErrorText error={state.error} />
        <p role="status" aria-live="polite" className={state.message ? "alert alert-success" : "visually-hidden"}>
          {state.message}
        </p>
        {state.saved && (
          <div className={styles.coverPreview} data-kind="saved">
            <LazyImage src={state.saved.coverUrl} alt={t("admin.series.coverSaved", { name: state.saved.name })} ratio="2 / 3" width={120} height={180} fallbackLabel={state.saved.name} />
          </div>
        )}
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
                <SeriesCounts counts={s.videoCounts} />
              </div>
              <div className="cluster">
                <Link className="btn btn-sm btn-primary" to={`/admin/series/${s.id}`}>
                  {t("admin.series.openBoard")}
                </Link>
                <button type="button" className="btn btn-sm" onClick={() => startEdit(s)}>
                  {t("common.edit")}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setToDelete(s)}>
                  {t("admin.moveToTrash")}
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
        confirmLabel={t("admin.moveToTrash")}
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

/**
 * Published counts per section. A series only appears on the site (home, Anime/Manga pages)
 * once it has a published video, so series without any are flagged for the admin.
 */
function SeriesCounts({ counts }) {
  const { t } = useT();
  if (!counts) return null;
  const { anime = 0, manga = 0 } = counts;
  if (!anime && !manga) {
    return <p className="hint"><span className="badge badge-warn">{t("admin.series.hidden")}</span></p>;
  }
  const parts = [];
  if (anime) parts.push(t("admin.series.episodes", { count: anime }));
  if (manga) parts.push(t("admin.series.chapters", { count: manga }));
  return <p className="hint">{parts.join(" · ")}</p>;
}
