import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "./useAuth.js";
import { PageSkeleton } from "../components/Skeleton/Skeleton.jsx";

function loginPath(location) {
  return `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

/** Admin-only routes: logged out → /login, logged-in non-admin → home. */
export function RequireAdmin() {
  const { user, status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <PageSkeleton />;
  if (!user) return <Navigate to={loginPath(location)} replace />;
  if (user.role !== "admin") return <Navigate to="/" replace state={{ notice: "adminOnly" }} />;
  return <Outlet />;
}
