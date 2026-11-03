import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthContext } from "./context.js";
import { authApi } from "../api/client.js";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState("loading");

  const refresh = useCallback(async () => {
    try {
      const { user: me } = await authApi.me();
      setUser(me ?? null);
      return me ?? null;
    } catch {
      setUser(null);
      return null;
    } finally {
      setStatus("ready");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email, password) => {
    const { user: me } = await authApi.login(email, password);
    setUser(me);
    setStatus("ready");
    return me;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, status, login, logout, refresh, setUser }),
    [user, status, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
