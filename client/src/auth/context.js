import { createContext } from "react";

export const AuthContext = createContext({
  user: null,
  status: "loading",
  login: async () => null,
  logout: async () => {},
  refresh: async () => null,
  setUser: () => {},
});
