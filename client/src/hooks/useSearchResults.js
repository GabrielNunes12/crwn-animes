import { useCallback, useEffect, useRef, useState } from "react";
import { catalogApi } from "../api/client.js";

export const PAGE_SIZE = 20;

/** A series published in both sections comes back twice, so the key includes the section. */
export const resultKey = (item) => `${item.section}:${item.id}`;

/**
 * Results of GET /api/search for `params` ({ q, section, genre, sort }).
 * The newest params always win: a change aborts the in-flight request, and a
 * response that arrives for older params is never applied. While new results
 * load, the previous ones stay available (`loading` is true) so the page can dim
 * them instead of flashing a skeleton. `loadMore()` appends the next page.
 */
export function useSearchResults(params, { pageSize = PAGE_SIZE, enabled = true } = {}) {
  const key = JSON.stringify(params);
  const [state, setState] = useState({ key: null, items: [], total: 0, error: null });
  const [more, setMore] = useState({ key: null, loading: false, error: null });
  const moreCtrl = useRef(null);

  useEffect(() => {
    // A pending "load more" belongs to the old params.
    moreCtrl.current?.abort();
    if (!enabled) return undefined;
    const ctrl = new AbortController();
    catalogApi
      .search({ ...JSON.parse(key), limit: pageSize, offset: 0 }, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setState({ key, items: res?.items ?? [], total: res?.total ?? 0, error: null });
      })
      .catch((error) => {
        if (ctrl.signal.aborted || error?.name === "AbortError") return;
        setState({ key, items: [], total: 0, error });
      });
    return () => ctrl.abort();
  }, [key, pageSize, enabled]);

  const current = state.key === key;
  const loadingMore = more.loading && more.key === key;

  /**
   * Fetches the next page. Resolves with `{ items, done }`: the newly added items
   * (none if stale or failed) and whether that was the last page.
   */
  const loadMore = useCallback(async () => {
    const none = { items: [], done: false };
    if (state.key !== key || state.items.length >= state.total) return none;
    moreCtrl.current?.abort();
    const ctrl = new AbortController();
    moreCtrl.current = ctrl;
    setMore({ key, loading: true, error: null });
    try {
      const res = await catalogApi.search({ ...JSON.parse(key), limit: pageSize, offset: state.items.length }, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return none;
      const seen = new Set(state.items.map(resultKey));
      const fresh = (res?.items ?? []).filter((item) => !seen.has(resultKey(item)));
      const count = state.items.length + fresh.length;
      // Nothing new (the catalogue changed under us): stop offering "load more".
      const total = fresh.length ? Math.max(res?.total ?? 0, count) : count;
      setState((prev) => (prev.key === key ? { ...prev, items: [...prev.items, ...fresh], total } : prev));
      setMore({ key, loading: false, error: null });
      return { items: fresh, done: count >= total };
    } catch (error) {
      if (ctrl.signal.aborted || error?.name === "AbortError") return none;
      setMore({ key, loading: false, error });
      return none;
    }
  }, [key, pageSize, state]);

  return {
    key,
    items: state.items,
    total: state.total,
    error: current ? state.error : null,
    /** No response for the current params yet. */
    loading: enabled && !current,
    /** Showing results for older params while the current ones load. */
    stale: !current && state.key !== null,
    loaded: state.key !== null,
    hasMore: current && state.items.length < state.total,
    loadingMore,
    moreError: more.key === key ? more.error : null,
    loadMore,
  };
}
