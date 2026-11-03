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
export async function apiFetch(path, { method = "GET", body, query, signal } = {}) {
  const headers = { Accept: "application/json" };
  const init = { method, credentials: "include", headers, signal };
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
  latest: (limit = 12, opts) => apiFetch("/latest", { ...opts, query: { limit } }),
  topRated: (section, limit = 12, opts) => apiFetch("/top-rated", { ...opts, query: { section, limit } }),
  trending: (section, limit = 12, opts) => apiFetch("/trending", { ...opts, query: { section, limit } }),
  random: (section) => apiFetch("/random", { query: { section } }),
  seriesList: (section, { genre, q } = {}, opts) =>
    apiFetch(`/${enc(section)}/series`, { ...opts, query: { genre, q } }),
  series: (section, slug, opts) => apiFetch(`/${enc(section)}/series/${enc(slug)}`, opts),
  video: (id, opts) => apiFetch(`/videos/${enc(id)}`, opts),
};

// -------------------------------------------------------------- ratings
export const ratingsApi = {
  get: (videoId, opts) => apiFetch(`/videos/${enc(videoId)}/rating`, opts),
  put: (videoId, score, reaction = null) =>
    apiFetch(`/videos/${enc(videoId)}/rating`, { method: "PUT", body: { score, reaction } }),
  remove: (videoId) => apiFetch(`/videos/${enc(videoId)}/rating`, { method: "DELETE" }),
};

// ---------------------------------------------------------------- admin
export const adminApi = {
  series: () => apiFetch("/admin/series"),
  createSeries: (data) => post("/admin/series", data),
  updateSeries: (id, data) => apiFetch(`/admin/series/${enc(id)}`, { method: "PATCH", body: data }),
  deleteSeries: (id) => apiFetch(`/admin/series/${enc(id)}`, { method: "DELETE" }),
  videos: (query) => apiFetch("/admin/videos", { query }),
  addVideo: (data) => post("/admin/videos", data),
  bulk: (data) => post("/admin/videos/bulk", data),
  healthCheck: () => post("/admin/videos/health-check"),
  updateVideo: (id, data) => apiFetch(`/admin/videos/${enc(id)}`, { method: "PATCH", body: data }),
  deleteVideo: (id) => apiFetch(`/admin/videos/${enc(id)}`, { method: "DELETE" }),
};
