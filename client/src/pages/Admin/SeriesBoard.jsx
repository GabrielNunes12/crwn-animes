import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Link, useBlocker, useLocation, useParams, useSearchParams } from "react-router";
import { adminApi, catalogApi } from "../../api/client.js";
import { ConfirmDialog } from "../../components/ConfirmDialog/ConfirmDialog.jsx";
import { Skeleton } from "../../components/Skeleton/Skeleton.jsx";
import { Tabs } from "../../components/Tabs/Tabs.jsx";
import { useNoIndex } from "../../hooks/useNoIndex.js";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { moveTo, reconcileOrder, sameOrder } from "../../lib/order.js";
import { pickSeason, seasonsOf } from "../../lib/seasons.js";
import { ErrorText } from "./shared.jsx";
import { VideoEditForm } from "./VideoEditForm.jsx";
import styles from "./SeriesBoard.module.css";

const SECTIONS = ["anime", "manga"];
/** Rows this close (px) to the top/bottom of the viewport scroll the page while dragging. */
const EDGE = 64;

/** "Episode 3" / "Chapter 3" — the season is already picked by the tabs. */
function itemLabel(t, video, section) {
  const n = video?.number == null ? null : String(video.number);
  if (section === "manga") return n == null ? t("common.chapterUnknown") : t("common.chapter", { n });
  return n == null ? t("common.episodeUnknown") : t("common.episode", { n });
}

const seasonOf = (v) => v.season ?? 1;
const draftKey = (section, season) => `${section}:${season}`;

/** Drafts of `section` re-checked against freshly loaded videos (dropped once they match). */
function pruneDrafts(drafts, section, videos) {
  let changed = false;
  const next = {};
  for (const [key, ids] of Object.entries(drafts)) {
    const [s, n] = key.split(":");
    if (s !== section) {
      next[key] = ids;
      continue;
    }
    const server = videos.filter((v) => String(seasonOf(v)) === n).map((v) => v.id);
    const reconciled = reconcileOrder(ids, server);
    if (server.length && !sameOrder(reconciled, server)) next[key] = reconciled;
    if (!sameOrder(reconciled, ids) || !next[key]) changed = true;
  }
  return changed ? next : drafts;
}

function byPlace(a, b) {
  return seasonOf(a) - seasonOf(b) || (a.number ?? Infinity) - (b.number ?? Infinity) || a.id - b.id;
}

function UnsavedMark() {
  const { t } = useT();
  return (
    <>
      <span className={styles.dot} aria-hidden="true" />
      <span className="visually-hidden"> ({t("admin.board.unsaved")})</span>
    </>
  );
}

export function Component() {
  const { id } = useParams();
  // A fresh board per series (drafts never leak from one series to another).
  return <SeriesBoardPage key={id} seriesId={Number(id)} />;
}

function SeriesBoardPage({ seriesId }) {
  const { t } = useT();
  const location = useLocation();
  useNoIndex();
  // The Series tab passes the row it was opened from, so the board can draw at once.
  const fromState = location.state?.series;
  const [state, setState] = useState(() => ({ series: fromState && Number(fromState.id) === seriesId ? fromState : null, error: null }));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    adminApi
      .findSeries(seriesId, { signal: ctrl.signal })
      .then((series) => !ctrl.signal.aborted && setState({ series, error: null }))
      .catch((error) => {
        if (ctrl.signal.aborted || error?.name === "AbortError") return;
        setState((s) => ({ series: error?.status === 404 ? null : s.series, error }));
      });
    return () => ctrl.abort();
  }, [seriesId, tick]);

  useTitle(state.series ? t("admin.board.docTitle", { name: state.series.name }) : t("admin.title"));

  const back = (
    <Link to="/admin?tab=series" className={styles.back}>
      <span aria-hidden="true">←</span> {t("admin.board.back")}
    </Link>
  );

  if (!state.series) {
    return (
      <div className="container stack" style={{ paddingBlock: "var(--space-6)" }}>
        {back}
        {state.error?.status === 404 ? (
          <div className="card stack">
            <h1>{t("notFound.title")}</h1>
            <p className="muted">{t("admin.board.notFound")}</p>
          </div>
        ) : state.error ? (
          <ErrorText error={state.error} />
        ) : (
          <div role="status" aria-label={t("common.loading")} className="stack">
            <Skeleton style={{ blockSize: "2.6rem", inlineSize: "50%" }} />
            <Skeleton style={{ blockSize: "1rem", inlineSize: "30%" }} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingBlock: "var(--space-6)" }}>
      {back}
      <Board series={state.series} seriesError={state.error} reloadSeries={() => setTick((n) => n + 1)} />
    </div>
  );
}

function Board({ series, seriesError, reloadSeries }) {
  const { t } = useT();
  const base = useId();
  const [params, setParams] = useSearchParams();
  const headingRef = useRef(null);
  const listRef = useRef(null);

  // ---- sections: only the ones with published videos can be picked
  const [loadedCounts, setLoadedCounts] = useState({});
  const counts = { anime: 0, manga: 0, ...(series.videoCounts ?? {}), ...loadedCounts };
  const available = SECTIONS.filter((s) => counts[s] > 0);
  const section = available.includes(params.get("section")) ? params.get("section") : (available[0] ?? null);

  // ---- the section's published videos (every season at once)
  const [data, setData] = useState({ key: null, section: null, videos: [], seasons: [], error: null });
  const [tick, setTick] = useState(0);
  const dataKey = `${section}\u0000${tick}`;
  const [drafts, setDrafts] = useState({});

  useEffect(() => {
    if (!section) return undefined;
    const ctrl = new AbortController();
    const key = `${section}\u0000${tick}`;
    // no-cache: these are public (max-age=60) responses and the admin just changed them.
    catalogApi
      .series(section, series.slug, { signal: ctrl.signal, cache: "no-cache" })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        const videos = Array.isArray(res?.videos) ? res.videos : [];
        setData({ key, section, videos, seasons: seasonsOf(res?.seasons, videos), error: null });
        setLoadedCounts((c) => (c[section] === videos.length ? c : { ...c, [section]: videos.length }));
        setDrafts((d) => pruneDrafts(d, section, videos));
      })
      .catch((error) => {
        if (ctrl.signal.aborted || error?.name === "AbortError") return;
        setData((d) => (d.section === section ? { ...d, key, error } : { key, section, videos: [], seasons: [], error }));
      });
    return () => ctrl.abort();
  }, [section, series.slug, tick]);

  const loading = Boolean(section) && data.key !== dataKey;
  // While reloading the same section, keep showing what we have (marked busy).
  const shown = data.section === section ? data : null;
  const seasons = shown?.seasons ?? [];
  const season = section === "manga" ? 1 : pickSeason(seasons, params.get("season"));
  const key = draftKey(section, season);
  const seasonVideos = shown ? shown.videos.filter((v) => seasonOf(v) === season) : [];
  const byId = new Map((shown?.videos ?? []).map((v) => [v.id, v]));
  const serverIds = seasonVideos.map((v) => v.id);
  const order = reconcileOrder(drafts[key], serverIds);
  const dirty = !sameOrder(order, serverIds);
  const anyDirty = Object.keys(drafts).length > 0;
  const labelOf = (id) => itemLabel(t, byId.get(id), section);

  // ---- messages: moves go to a quiet live region; results to the visible status line
  const [announce, setAnnounce] = useState("");
  const say = (text) => setAnnounce((prev) => (prev === text ? `${text}\u00A0` : text));
  const [message, setMessage] = useState({ text: "", tone: "success" });
  const [saveState, setSaveState] = useState({ busy: false, error: null });

  function setOrder(next) {
    setDrafts((d) => {
      const copy = { ...d };
      if (sameOrder(next, serverIds)) delete copy[key];
      else copy[key] = next;
      return copy;
    });
  }

  // ---- focus follows the moved row (or a neighbour / the heading when a row leaves)
  const pendingFocus = useRef(null);
  // A passive effect (not layout): it runs after ConfirmDialog has closed, so the page is no longer inert.
  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    pendingFocus.current = null;
    const row = p.id == null ? null : listRef.current?.querySelector(`:scope > [data-id="${p.id}"]`);
    const el = row && p.focus !== "row" ? row.querySelector(`[data-action="${p.focus}"]`) : row;
    const target = el ?? headingRef.current;
    if (target && document.activeElement !== target) target.focus();
  });

  function move(id, delta, focus = "row") {
    const from = order.indexOf(id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= order.length) return;
    setOrder(moveTo(order, id, to));
    pendingFocus.current = { id, focus };
    say(t("admin.board.moved", { label: labelOf(id), position: String(to + 1), total: String(order.length) }));
  }

  function onRowKeyDown(e, id) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (e.target.closest("input, select, textarea, [contenteditable='true']")) return;
    e.preventDefault();
    const focus = e.target === e.currentTarget ? "row" : (e.target.closest("[data-action]")?.dataset.action ?? "row");
    move(id, e.key === "ArrowUp" ? -1 : 1, focus);
  }

  // ---- pointer drag-and-drop (mouse, touch, pen) by the row's handle
  const drag = useRef(null);
  const [draggingId, setDraggingId] = useState(null);

  function onHandlePointerDown(e, id) {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault(); // no text selection / native drag while we move rows
    drag.current = { id, pointerId: e.pointerId, from: order.indexOf(id), startOrder: order, order, y: e.clientY };
    setDraggingId(id);
  }

  /** The dragged row goes after every other row whose middle is above the pointer. */
  const placeDragged = useEffectEvent(() => {
    const d = drag.current;
    if (!d || !listRef.current) return;
    let index = 0;
    for (const row of listRef.current.children) {
      if (!row.dataset.id || row.dataset.id === String(d.id)) continue;
      const r = row.getBoundingClientRect();
      if (d.y > r.top + r.height / 2) index += 1;
    }
    if (d.order.indexOf(d.id) === index) return;
    d.order = moveTo(d.order, d.id, index);
    setOrder(d.order);
  });

  const endDrag = useEffectEvent((cancelled) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDraggingId(null);
    const total = String(d.order.length);
    if (cancelled) {
      setOrder(d.startOrder);
      say(t("admin.board.dragCancelled", { label: labelOf(d.id), position: String(d.from + 1), total }));
    } else {
      const to = d.order.indexOf(d.id);
      if (to !== d.from) say(t("admin.board.moved", { label: labelOf(d.id), position: String(to + 1), total }));
    }
    pendingFocus.current = { id: d.id, focus: "row" };
  });

  useEffect(() => {
    if (draggingId == null) return undefined;
    const mine = (e) => e.pointerId === drag.current?.pointerId;
    // Window listeners, not pointer capture: React moves the dragged <li> in the DOM, which drops capture.
    const onMove = (e) => {
      if (!mine(e)) return;
      drag.current.y = e.clientY;
      placeDragged();
    };
    const onUp = (e) => mine(e) && endDrag(false);
    const onCancel = (e) => mine(e) && endDrag(true);
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      endDrag(true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    // Long lists: holding the pointer near the top/bottom edge scrolls the page.
    let raf = 0;
    const scroll = () => {
      const d = drag.current;
      if (d) {
        const h = window.innerHeight;
        const step = d.y < EDGE ? -(EDGE - d.y) / 3 : d.y > h - EDGE ? (d.y - (h - EDGE)) / 3 : 0;
        if (step) {
          window.scrollBy(0, step);
          placeDragged();
        }
        raf = requestAnimationFrame(scroll);
      }
    };
    if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(scroll);
    const userSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      document.body.style.userSelect = userSelect;
    };
  }, [draggingId]);

  // ---- save / discard
  async function save() {
    if (!dirty || saveState.busy) return;
    setSaveState({ busy: true, error: null });
    setMessage({ text: "", tone: "success" });
    const videoIds = order;
    try {
      const res = await adminApi.reorder(series.id, { section, season, videoIds });
      const updated = new Map((Array.isArray(res?.videos) ? res.videos : []).map((v) => [v.id, v]));
      // Older/odd responses without videos: number them 1..n locally (the server did the same).
      const local = new Map(videoIds.map((id, i) => [id, i + 1]));
      setData((d) =>
        d.section !== section
          ? d
          : {
              ...d,
              videos: d.videos
                .map((v) => updated.get(v.id) ?? (updated.size === 0 && local.has(v.id) ? { ...v, number: local.get(v.id) } : v))
                .sort(byPlace),
            },
      );
      setDrafts((d) => {
        const copy = { ...d };
        delete copy[key];
        return copy;
      });
      setSaveState({ busy: false, error: null });
      setMessage({ text: t("admin.board.saved", { count: videoIds.length }), tone: "success" });
    } catch (err) {
      if (err?.code === "VALIDATION_ERROR") {
        // The set of videos changed under us: reload, keeping the local order for the ones still there.
        setSaveState({ busy: false, error: null });
        setMessage({ text: t("admin.board.stale"), tone: "info" });
        setTick((n) => n + 1);
      } else {
        setSaveState({ busy: false, error: err });
      }
    }
  }

  function discard() {
    if (!dirty) return;
    setDrafts((d) => {
      const copy = { ...d };
      delete copy[key];
      return copy;
    });
    setSaveState({ busy: false, error: null });
    setMessage({ text: t("admin.board.discarded"), tone: "success" });
  }

  // ---- leaving with unsaved changes
  const blocker = useBlocker(({ currentLocation, nextLocation }) => anyDirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!anyDirty) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty]);

  // ---- per-row edit (the shared video form) and move to trash
  const [editingId, setEditingId] = useState(null);
  const [allSeries, setAllSeries] = useState(null);
  const [allSeriesError, setAllSeriesError] = useState(null);
  useEffect(() => {
    if (editingId == null || allSeries) return undefined;
    let alive = true;
    adminApi
      .allSeries()
      .then((list) => alive && setAllSeries(list))
      .catch((err) => alive && setAllSeriesError(err));
    return () => {
      alive = false;
    };
  }, [editingId, allSeries]);

  /** Focus target once `id` leaves the list: the next row, else the previous one, else the heading. */
  function neighbourOf(id) {
    const i = order.indexOf(id);
    return order[i + 1] ?? order[i - 1] ?? null;
  }

  function onSaved(updated) {
    const stays =
      updated.status === "published" && updated.seriesId === series.id && updated.section === section && seasonOf(updated) === season;
    setData((d) => ({
      ...d,
      videos: stays ? d.videos.map((v) => (v.id === updated.id ? { ...v, ...updated } : v)).sort(byPlace) : d.videos.filter((v) => v.id !== updated.id),
    }));
    setEditingId(null);
    pendingFocus.current = stays ? { id: updated.id, focus: "edit" } : { id: neighbourOf(updated.id), focus: "row" };
    setMessage({
      text: updated.status === "published" ? t("admin.videos.saved", { title: updated.title }) : t("admin.videos.nowPending", { title: updated.title }),
      tone: "success",
    });
    setTick((n) => n + 1);
    reloadSeries();
  }

  const [toTrash, setToTrash] = useState(null);
  const [trashState, setTrashState] = useState({ busy: false, error: null });
  async function onTrash() {
    const video = toTrash;
    setTrashState({ busy: true, error: null });
    try {
      await adminApi.deleteVideo(video.id);
      pendingFocus.current = { id: neighbourOf(video.id), focus: "row" };
      setData((d) => ({ ...d, videos: d.videos.filter((v) => v.id !== video.id) }));
      if (editingId === video.id) setEditingId(null);
      setToTrash(null);
      setTrashState({ busy: false, error: null });
      setMessage({ text: t("admin.videos.deleted", { title: video.title }), tone: "success" });
      setTick((n) => n + 1);
      reloadSeries();
    } catch (err) {
      setTrashState({ busy: false, error: err });
    }
  }

  // ---- navigation between sections / seasons (drafts are kept per season)
  const selectSection = (s) => setParams({ section: s }, { replace: true, preventScrollReset: true });
  const selectSeason = (n) => setParams({ section, season: String(n) }, { replace: true, preventScrollReset: true });
  const hasDraftIn = (s) => Object.keys(drafts).some((k) => k.startsWith(`${s}:`));

  const hintId = `${base}-hint`;
  const listBlock = (
    <section className="stack" aria-labelledby={`${base}-list-title`} style={{ "--stack-gap": "var(--space-3)" }}>
      <div className="section-head" style={{ marginBlockEnd: 0 }}>
        <h2 id={`${base}-list-title`} ref={headingRef} tabIndex={-1}>
          {section === "anime" && seasons.length > 0 && `${t("common.season", { n: String(season) })} · `}
          {t(`admin.board.listTitle.${section}`, { count: order.length })}
        </h2>
      </div>
      <p id={hintId} className="hint">
        {t("admin.board.hint")}
      </p>
      <div className={styles.toolbar} data-dirty={dirty || undefined}>
        <p className={styles.dirtyNote}>{dirty ? t("admin.board.dirty") : ""}</p>
        <div className="cluster">
          <button type="button" className="btn btn-sm btn-ghost" aria-disabled={!dirty || saveState.busy || undefined} onClick={discard}>
            {t("admin.board.discard")}
          </button>
          <button type="button" className="btn btn-sm btn-primary" aria-disabled={!dirty || saveState.busy || undefined} onClick={save}>
            {saveState.busy ? t("common.saving") : t("admin.board.save")}
          </button>
        </div>
      </div>
      <ErrorText error={saveState.error} />
      {shown?.error && <ErrorText error={shown.error} />}
      {!shown && (
        <div className="stack" role="status" aria-label={t("common.loading")} style={{ "--stack-gap": "var(--space-2)" }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} style={{ blockSize: "4.5rem", borderRadius: "var(--radius)" }} />
          ))}
        </div>
      )}
      {shown && !shown.error && order.length === 0 && <p className="card muted">{t("admin.board.empty")}</p>}
      <ol ref={listRef} className={styles.list} role="list" aria-busy={loading || undefined} data-dragging={draggingId != null || undefined}>
        {order.map((id, i) => {
          const v = byId.get(id);
          if (!v) return null;
          const label = labelOf(id);
          const labelId = `${base}-label-${id}`;
          const editing = editingId === id;
          return (
            <li
              key={id}
              data-id={id}
              className={styles.row}
              tabIndex={0}
              aria-labelledby={labelId}
              aria-describedby={hintId}
              data-dragging={draggingId === id || undefined}
              data-unavailable={v.availability === "unavailable" || undefined}
              onKeyDown={(e) => onRowKeyDown(e, id)}
            >
              <div className={styles.rowMain}>
                <span className={styles.handle} aria-hidden="true" title={t("admin.board.hint")} onPointerDown={(e) => onHandlePointerDown(e, id)}>
                  ⠿
                </span>
                <span className={styles.pos} aria-hidden="true">
                  {i + 1}
                </span>
                <img src={v.thumbnailUrl} alt="" width="96" height="54" loading="lazy" decoding="async" className={styles.thumb} />
                <div className={styles.text}>
                  <p id={labelId} className={styles.label}>
                    {label}
                    <span className="visually-hidden"> — {t("admin.board.position", { position: String(i + 1) })}</span>
                  </p>
                  <p className={styles.title}>{v.title}</p>
                  {v.availability === "unavailable" && <span className="badge badge-warn">{t("common.unavailable")}</span>}
                </div>
                <div className={styles.actions}>
                  <button type="button" className="btn btn-sm" data-action="up" aria-disabled={i === 0 || undefined} aria-describedby={labelId} onClick={() => move(id, -1, "up")}>
                    <span aria-hidden="true">↑</span> {t("admin.board.moveUp")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    data-action="down"
                    aria-disabled={i === order.length - 1 || undefined}
                    aria-describedby={labelId}
                    onClick={() => move(id, 1, "down")}
                  >
                    <span aria-hidden="true">↓</span> {t("admin.board.moveDown")}
                  </button>
                  <Link className="btn btn-sm btn-ghost" data-action="preview" to={`/admin/preview/${id}`} aria-describedby={labelId}>
                    {t("admin.previewLink")}
                  </Link>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    data-action="edit"
                    aria-expanded={editing}
                    aria-controls={editing ? `${base}-edit-${id}` : undefined}
                    aria-describedby={labelId}
                    onClick={() => setEditingId(editing ? null : id)}
                  >
                    {t("common.edit")}
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" data-action="trash" aria-describedby={labelId} onClick={() => setToTrash(v)}>
                    {t("admin.moveToTrash")}
                  </button>
                </div>
              </div>
              {editing && (
                <div id={`${base}-edit-${id}`} className={styles.edit}>
                  {allSeries ? (
                    <VideoEditForm video={v} series={allSeries} onSaved={onSaved} />
                  ) : allSeriesError ? (
                    <ErrorText error={allSeriesError} />
                  ) : (
                    <p className="hint" role="status">
                      {t("common.loading")}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );

  return (
    <>
      <header className={styles.head}>
        <p className={styles.kicker}>{t("admin.board.kicker")}</p>
        <h1>{series.name}</h1>
        <p className="hint">
          <code>{series.slug}</code>
        </p>
        {section && (
          <Link to={`/${section}/${series.slug}`} className={styles.publicLink}>
            {t("admin.board.publicPage")} <span className="visually-hidden">({t(`common.${section}`)})</span>
            <span aria-hidden="true"> ↗</span>
          </Link>
        )}
      </header>
      <ErrorText error={seriesError} />

      <div className={styles.sectionBar}>
        <div role="group" aria-labelledby={`${base}-section`} aria-describedby={available.length ? undefined : `${base}-none`} className="cluster">
          <span id={`${base}-section`} className="label">
            {t("admin.board.section")}
          </span>
          {SECTIONS.map((s) => (
            <button key={s} type="button" className="chip" aria-pressed={s === section} disabled={!(counts[s] > 0)} onClick={() => s !== section && selectSection(s)}>
              {t(`common.${s}`)}
              {hasDraftIn(s) && <UnsavedMark />}
            </button>
          ))}
        </div>
      </div>
      {!available.length && (
        <p id={`${base}-none`} className="card muted">
          {t("admin.board.noVideos")}
        </p>
      )}

      <p role="status" aria-live="polite" className={message.text ? `alert alert-${message.tone}` : "visually-hidden"}>
        {message.text}
      </p>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="board-announcer">
        {announce}
      </div>

      {section &&
        (section === "anime" && seasons.length > 0 ? (
          <Tabs
            label={t("admin.board.seasons")}
            tabs={seasons.map((n) => ({
              id: String(n),
              label: (
                <>
                  {t("common.season", { n: String(n) })}
                  {drafts[draftKey(section, n)] && <UnsavedMark />}
                </>
              ),
            }))}
            active={String(season)}
            onChange={(id) => selectSeason(Number(id))}
          >
            {listBlock}
          </Tabs>
        ) : (
          <div className={styles.panel}>{listBlock}</div>
        ))}

      <ConfirmDialog
        open={Boolean(toTrash)}
        title={t("admin.videos.deleteTitle")}
        confirmLabel={t("admin.moveToTrash")}
        busy={trashState.busy}
        onConfirm={onTrash}
        onClose={() => {
          setToTrash(null);
          setTrashState({ busy: false, error: null });
        }}
      >
        <p>{t("admin.videos.deleteText", { title: toTrash?.title ?? "" })}</p>
        <ErrorText error={trashState.error} />
      </ConfirmDialog>

      <ConfirmDialog
        open={blocker.state === "blocked"}
        title={t("admin.board.leaveTitle")}
        confirmLabel={t("admin.board.leaveConfirm")}
        onConfirm={() => blocker.proceed?.()}
        onClose={() => blocker.reset?.()}
      >
        <p>{t("admin.board.leaveText")}</p>
      </ConfirmDialog>
    </>
  );
}
