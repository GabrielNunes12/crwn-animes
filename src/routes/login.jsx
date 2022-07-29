import { getRedirectResult } from "firebase/auth";
import { useEffect } from "react";
import { signInWithGooglePopup } from "../utils/firebase/firebase.utils";
import {
  createUserDocumentFromAuth,
  signInWithGoogleRedirect,
  auth,
} from "../utils/firebase/firebase.utils";

import SignUpForm from "../components/sign-up-form/sign-up-form";

const Login = () => {
  useEffect(() => {
    const fetchData = async () => {
      const response = await getRedirectResult(auth);
      if (response) {
        const userRefDoc = await createUserDocumentFromAuth(response.user);
      }
    };
    fetchData();
  }, []);
  const logGoogleUser = async () => {
    const response = await signInWithGooglePopup();
    await createUserDocumentFromAuth(response);
  };
  return (
    <>
      <section className="login-form">
        <div className="username-info">
          <label>Username</label>
          <input type="text" name="username" placeholder="Your username" />
        </div>
        <div className="password-info">
          <label>Password</label>
          <input type="password" name="Password" placeholder="Your password" />
        </div>
        <div className="log-in-with-google">
          <button onClick={logGoogleUser}> Log in with GOOGLE </button>
        </div>
        <div className="log-in-with-google">
          <button onClick={signInWithGoogleRedirect}>
            {" "}
            Log in with Redirect google{" "}
          </button>
        </div>
        <SignUpForm />
      </section>
    </>
  );
};

export default Login;
