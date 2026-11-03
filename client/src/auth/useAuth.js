import { useContext } from "react";
import { AuthContext } from "./context.js";

/** { user, status: "loading" | "ready", isAdmin, login, logout, refresh, setUser } */
export function useAuth() {
  const ctx = useContext(AuthContext);
  return { ...ctx, isAdmin: ctx.user?.role === "admin" };
}
