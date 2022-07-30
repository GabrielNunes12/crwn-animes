import SignUpForm from "../components/sign-up-form/sign-up-form";
import SignInForm from "../components/sign-in-form/sign-in";
import "./auth-styling/auth.scss";
const Auth = () => {
  return (
    <div className="auth-container">
      <SignInForm />
      <SignUpForm />
    </div>
  );
};

export default Auth;
