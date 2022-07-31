import { createContext, useState } from "react";

//as the actual value you want to access
export const UserContext = createContext({
  user: null,
  setUser: () => null,
});

//Actual component
// every context has a provider to wrap around with the children
export const UserProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const value = { user, setUser };
  return <UserContext.Provider value={value}> {children}</UserContext.Provider>;
};
