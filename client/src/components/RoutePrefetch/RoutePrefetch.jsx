import { useAuth } from "../../auth/useAuth.js";
import { useRoutePrefetch } from "../../hooks/useRoutePrefetch.js";

/** Hover/focus prefetch of lazy route modules for every link on the page (admin pages for admins only). */
export function RoutePrefetch({ routes }) {
  const { isAdmin } = useAuth();
  useRoutePrefetch(routes, { isAdmin });
  return null;
}
