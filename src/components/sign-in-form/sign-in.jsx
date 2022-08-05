import { useState } from "react";
import {
  createUserDocumentFromAuth,
  signInWithGooglePopup,
  loginInUserWithEmailAndPassword,
} from "../../utils/firebase/firebase.utils";
import { formFieldLoginRequired } from "../../helper/fieldsForm";
import FormInput from "../form-input/form-input";
import "./sign-in-form.scss";
import Button from "../button-component/button";

const SignInForm = () => {
  const [defaultField, setDefaultField] = useState(formFieldLoginRequired);
  const { email, password } = defaultField;
  const logGoogleUser = async () => {
    await signInWithGooglePopup();
  };
  // sign in with email and password
  const handleSubmit = async (event) => {
    event.preventDefault();
    //login in a user
    try {
      const { user } = await loginInUserWithEmailAndPassword(email, password);
      createUserDocumentFromAuth(user);
    } catch (error) {
      switch (error.code) {
        case "auth/wrong-password":
          alert("Wrong password");
          return;
        case "auth/user-not-found":
          alert("No user associated with this email and password");
          return;
        default:
          console.log(error);
      }
    }
    resetFormFields();
  };

  const resetFormFields = () => {
    setDefaultField(formFieldLoginRequired);
  };
  const handleChange = (event) => {
    const { name, value } = event.target;
    setDefaultField({ ...defaultField, [name]: value });
  };
  return (
    <div className="sign-up-container">
      <h2> Already have an account ?</h2>
      <span>Sign in with your email and password</span>
      <form onSubmit={handleSubmit}>
        <FormInput
          type="email"
          label="Email:"
          required
          onChange={handleChange}
          name="email"
          value={email}
        />
        <FormInput
          type="password"
          required
          label="Password:"
          onChange={handleChange}
          name="password"
          value={password}
        />
        <div className="buttons-container">
          <Button type="submit">Sign in</Button>
          <Button type="button" onClick={logGoogleUser} buttonType="google">
            Google sign in
          </Button>
        </div>
      </form>
    </div>
  );
};
export default SignInForm;
