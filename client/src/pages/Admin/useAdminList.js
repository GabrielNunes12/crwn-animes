import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedValue } from "../../hooks/useDebouncedValue.js";

export const ADMIN_PAGE_SIZE = 20;
export const SEARCH_DELAY = 300;

/**
 * One page of an admin list (`{ items, total }` endpoints) with a debounced search.
 * `fetchPage({ q, limit, offset }, { signal })` must be stable (useCallback).
 * The newest request always wins: a new query/page aborts the one in flight and a
 * late response for an older query is never applied. Typing a new query goes back
 * to the first page. After a Previous/Next, focus moves to `focusRef` (the list's
 * heading, owned by the caller) once the new page has loaded.
 */
export function useAdminList(fetchPage, { pageSize = ADMIN_PAGE_SIZE, delay = SEARCH_DELAY, reloadKey = 0, focusRef } = {}) {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), delay);
  const [page, setPage] = useState({ q: "", index: 0 });
  // A new query starts again from page 1 (state adjusted during render, no effect).
  if (page.q !== debounced) setPage({ q: debounced, index: 0 });
  const [version, setVersion] = useState(0);
  const [state, setState] = useState({ key: null, items: [], total: 0, error: null });
  const focusPending = useRef(false);

  const key = `${page.q}\u0000${page.index}\u0000${version}\u0000${reloadKey}`;

  useEffect(() => {
    const ctrl = new AbortController();
    const k = `${page.q}\u0000${page.index}\u0000${version}\u0000${reloadKey}`;
    fetchPage({ q: page.q, limit: pageSize, offset: page.index * pageSize }, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setState({ key: k, items: res?.items ?? [], total: res?.total ?? 0, error: null });
      })
      .catch((error) => {
        if (ctrl.signal.aborted || error?.name === "AbortError") return;
        setState((s) => ({ ...s, key: k, error }));
      });
    return () => ctrl.abort();
  }, [fetchPage, page.q, page.index, pageSize, version, reloadKey]);

  useEffect(() => {
    if (state.key !== key || !focusPending.current) return;
    focusPending.current = false;
    focusRef?.current?.focus();
  }, [state.key, key, focusRef]);

  const pageCount = Math.max(1, Math.ceil(state.total / pageSize));
  const loading = state.key !== key;

  const goTo = useCallback(
    (index) => {
      const next = Math.max(0, Math.min(index, pageCount - 1));
      if (next === page.index) return;
      focusPending.current = true;
      setPage((p) => ({ ...p, index: next }));
    },
    [page.index, pageCount],
  );

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  /** Remove one item locally (deleted / moved to another list); refills an emptied page. */
  const removeItem = useCallback(
    (id) => {
      const left = state.items.filter((it) => it.id !== id);
      if (left.length === state.items.length) return;
      setState((s) => ({ ...s, items: left, total: Math.max(0, s.total - 1) }));
      if (left.length === 0 && state.total - 1 > 0) {
        if (page.index > 0) setPage((p) => ({ ...p, index: p.index - 1 }));
        else setVersion((v) => v + 1);
      }
    },
    [state.items, state.total, page.index],
  );

  const replaceItem = useCallback((item) => {
    setState((s) => ({ ...s, items: s.items.map((it) => (it.id === item.id ? item : it)) }));
  }, []);

  return {
    query,
    setQuery,
    /** The query the shown results are for (trimmed, debounced). */
    q: page.q,
    items: state.items,
    total: state.total,
    error: loading ? null : state.error,
    loading,
    /** At least one response has arrived. */
    loaded: state.key !== null,
    page: page.index,
    pageCount,
    pageSize,
    goTo,
    reload,
    removeItem,
    replaceItem,
  };
}
