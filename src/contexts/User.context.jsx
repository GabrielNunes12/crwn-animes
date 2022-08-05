import { createContext, useState, useEffect } from "react";
import {
  createUserDocumentFromAuth,
  onAuthStateChangeListener,
} from "../utils/firebase/firebase.utils";

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
  useEffect(() => {
    const unsubscribe = onAuthStateChangeListener((user) => {
      if (user) {
        createUserDocumentFromAuth(user);
      }
      setUser(user);
    });
    return unsubscribe;
  }, []);
  return <UserContext.Provider value={value}> {children}</UserContext.Provider>;
};
