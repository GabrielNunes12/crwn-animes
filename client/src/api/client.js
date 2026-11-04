// The one fetch wrapper for /api (see docs/API.md). JSON in/out, cookie auth.

export class ApiError extends Error {
  constructor({ status = 0, code = "HTTP_ERROR", message = "Request failed", details = {} } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details ?? {};
  }
}

const BASE = "/api";

function buildQuery(params) {
  if (!params) return "";
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * apiFetch("/auth/me") / apiFetch("/auth/login", { method: "POST", body: {...} })
 * Resolves with the parsed JSON (null for 204). Throws ApiError otherwise.
 */
export async function apiFetch(path, { method = "GET", body, query, signal, cache } = {}) {
  const headers = { Accept: "application/json" };
  const init = { method, credentials: "include", headers, signal };
  // e.g. "no-cache": revalidate a public (max-age=60) catalog response the admin just changed.
  if (cache) init.cache = cache;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}${buildQuery(query)}`, init);
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ApiError({ status: 0, code: "NETWORK_ERROR", message: "Could not reach the server." });
  }

  if (res.status === 204) return null;
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError({
      status: res.status,
      code: e.code ?? "HTTP_ERROR",
      message: e.message ?? `Request failed (${res.status})`,
      details: e.details ?? {},
    });
  }
  return data;
}

const enc = encodeURIComponent;
const post = (path, body) => apiFetch(path, { method: "POST", body: body ?? {} });

// ---------------------------------------------------------------- auth
export const authApi = {
  me: () => apiFetch("/auth/me"),
  login: (email, password) => post("/auth/login", { email, password }),
  logout: () => apiFetch("/auth/logout", { method: "POST" }),
  logoutAll: () => apiFetch("/auth/logout-all", { method: "POST" }),
  register: ({ email, password, displayName, locale }) =>
    post("/auth/register", { email, password, displayName, acceptPrivacy: true, locale }),
  verifyEmail: (token, password) => post("/auth/verify-email", { token, password }),
  resendVerification: (email, locale) => post("/auth/resend-verification", { email, locale }),
  forgotPassword: (email, locale) => post("/auth/forgot-password", { email, locale }),
  resetPassword: (token, password, locale) => post("/auth/reset-password", { token, password, locale }),
};

// ------------------------------------------------------- your data (me)
export const meApi = {
  exportUrl: `${BASE}/me/export`,
  update: (displayName) => apiFetch("/me", { method: "PATCH", body: { displayName } }),
  changePassword: (currentPassword, newPassword, locale) => post("/me/password", { currentPassword, newPassword, locale }),
  remove: (password) => apiFetch("/me", { method: "DELETE", body: { password } }),
};

// -------------------------------------------------------------- catalog
export const catalogApi = {
  sections: (opts) => apiFetch("/sections", opts),
  genres: (opts) => apiFetch("/genres", opts),
  /**
   * GET /api/latest → Video[]. `latest({ limit, offset, section })`; a bare number is
   * still accepted as the limit (`latest(24)`).
   */
  latest: (params = {}, opts) => {
    const { limit = 12, offset, section } = typeof params === "number" ? { limit: params } : (params ?? {});
    return apiFetch("/latest", { ...opts, query: { limit, offset: offset || undefined, section } });
  },
  topRated: (section, limit = 12, opts) => apiFetch("/top-rated", { ...opts, query: { section, limit } }),
  trending: (section, limit = 12, opts) => apiFetch("/trending", { ...opts, query: { section, limit } }),
  random: (section) => apiFetch("/random", { query: { section } }),
  seriesList: (section, { genre, q } = {}, opts) =>
    apiFetch(`/${enc(section)}/series`, { ...opts, query: { genre, q } }),
  /** `{ series, videos, seasons }`; `season` narrows `videos` to that season (omit it for all). */
  series: (section, slug, opts, { season } = {}) =>
    apiFetch(`/${enc(section)}/series/${enc(slug)}`, { ...opts, query: { season } }),
  video: (id, opts) => apiFetch(`/videos/${enc(id)}`, opts),
  /** GET /api/search → { items: SearchItem[], total }. Empty params are omitted. */
  search: ({ q, section, genre, sort, limit, offset } = {}, opts) =>
    apiFetch("/search", { ...opts, query: { q: q?.trim() || undefined, section, genre, sort, limit, offset } }),
};

// -------------------------------------------------------------- ratings
export const ratingsApi = {
  get: (videoId, opts) => apiFetch(`/videos/${enc(videoId)}/rating`, opts),
  put: (videoId, score, reaction = null) =>
    apiFetch(`/videos/${enc(videoId)}/rating`, { method: "PUT", body: { score, reaction } }),
  remove: (videoId) => apiFetch(`/videos/${enc(videoId)}/rating`, { method: "DELETE" }),
};

// ---------------------------------------------------------------- admin
/** Admin lists are `{ items, total }` (v1.3). A bare array (older server) is treated as one page. */
export function toPage(data) {
  if (Array.isArray(data)) return { items: data, total: data.length };
  const items = Array.isArray(data?.items) ? data.items : [];
  const total = Number.isFinite(Number(data?.total)) ? Number(data.total) : items.length;
  return { items, total };
}

export const ADMIN_PAGE_MAX = 100;

export const adminApi = {
  /** GET /api/admin/series?q=&limit=&offset= → { items, total } */
  series: ({ q, limit, offset } = {}, opts) =>
    apiFetch("/admin/series", { ...opts, query: { q: q?.trim() || undefined, limit, offset: offset || undefined } }).then(toPage),
  /** Every series (pages through the list 100 at a time) — for the series pickers. */
  allSeries: async (opts) => {
    const all = [];
    for (let offset = 0; ; offset += ADMIN_PAGE_MAX) {
      const { items, total } = await adminApi.series({ limit: ADMIN_PAGE_MAX, offset }, opts);
      all.push(...items);
      if (!items.length || all.length >= total || items.length > ADMIN_PAGE_MAX) return all;
    }
  },
  createSeries: (data) => post("/admin/series", data),
  updateSeries: (id, data) => apiFetch(`/admin/series/${enc(id)}`, { method: "PATCH", body: data }),
  deleteSeries: (id) => apiFetch(`/admin/series/${enc(id)}`, { method: "DELETE" }),
  /** GET /api/admin/videos?status=&availability=&q=&limit=&offset= → { items, total } */
  videos: ({ q, offset, ...query } = {}, opts) =>
    apiFetch("/admin/videos", { ...opts, query: { ...query, q: q?.trim() || undefined, offset: offset || undefined } }).then(toPage),
  addVideo: (data) => post("/admin/videos", data),
  bulk: (data) => post("/admin/videos/bulk", data),
  healthCheck: () => post("/admin/videos/health-check"),
  updateVideo: (id, data) => apiFetch(`/admin/videos/${enc(id)}`, { method: "PATCH", body: data }),
  /** v1.4: moves the video to the 7-day trash (204). */
  deleteVideo: (id) => apiFetch(`/admin/videos/${enc(id)}`, { method: "DELETE" }),

  // v1.4 — series board, trash, draft preview
  /**
   * One series by id, with `videoCounts` (there is no GET /admin/series/:id: pages through the
   * list and stops at the page that has it). Rejects with a 404 ApiError when it isn't there
   * (unknown, or in the trash).
   */
  findSeries: async (id, opts) => {
    const want = Number(id);
    let seen = 0;
    for (let offset = 0; ; offset += ADMIN_PAGE_MAX) {
      const { items, total } = await adminApi.series({ limit: ADMIN_PAGE_MAX, offset }, opts);
      const hit = items.find((s) => Number(s.id) === want);
      if (hit) return hit;
      seen += items.length;
      if (!items.length || seen >= total || items.length > ADMIN_PAGE_MAX) {
        throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Series not found" });
      }
    }
  },
  /** PUT /api/admin/series/:id/order → { videos } (numbers become 1..n in this order). */
  reorder: (seriesId, { section, season, videoIds }) =>
    apiFetch(`/admin/series/${enc(seriesId)}/order`, {
      method: "PUT",
      body: { section, season: section === "manga" ? 1 : Number(season), videoIds },
    }),
  /** GET /api/admin/videos/:id/preview → { video, series } (pending and trashed included). */
  preview: (videoId, opts) => apiFetch(`/admin/videos/${enc(videoId)}/preview`, opts),
  /** GET /api/admin/trash → { series: TrashedSeries[], videos: TrashedVideo[] } */
  trash: (opts) => apiFetch("/admin/trash", opts),
  /** → { series, published, pending } */
  restoreSeries: (id) => post(`/admin/trash/series/${enc(id)}/restore`),
  /** → { video }; 409 CONFLICT while its series is still in the trash. */
  restoreVideo: (id) => post(`/admin/trash/videos/${enc(id)}/restore`),
  /** Delete forever (204), ratings included. */
  purgeSeries: (id) => apiFetch(`/admin/trash/series/${enc(id)}`, { method: "DELETE" }),
  purgeVideo: (id) => apiFetch(`/admin/trash/videos/${enc(id)}`, { method: "DELETE" }),
};
