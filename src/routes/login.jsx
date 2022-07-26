import { signInWithGooglePopup } from "../utils/firebase/firebase.utils";
const Login = () => {
  const logGoogleUser = async () => {
    const response = await signInWithGooglePopup();
    console.log(response);
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
      </section>
    </>
  );
};

export default Login;
