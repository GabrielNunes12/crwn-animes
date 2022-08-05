import { useState } from "react";
import {
  createAuthUserWithEmailAndPassword,
  createUserDocumentFromAuth,
} from "../../utils/firebase/firebase.utils";
import { formFieldRequired } from "../../helper/fieldsForm";
import FormInput from "../form-input/form-input";
import "./sign-up-form.scss";
import Button from "../button-component/button";

const SignUpForm = () => {
  const [defaultField, setDefaultField] = useState(formFieldRequired);
  const { displayName, email, password, confirmPassword } = defaultField;
  // sign up with email and password
  const handleSubmit = async (event) => {
    event.preventDefault();
    //checking if the password is equal to confirmPassword
    if (password === confirmPassword) {
      //creating a user
      try {
        const { user } = await createAuthUserWithEmailAndPassword(
          email,
          password
        );
        await createUserDocumentFromAuth(user, { displayName });
      } catch (error) {
        if (error.code === "auth/email-already-in-use") {
          alert("Cannot create user, Email already in use");
        } else {
          console.error(`user creation encountered an error: ${error}`);
        }
      }
    } else {
      alert("Passwords does not match");
      return;
    }
    resetFormFields();
  };

  const resetFormFields = () => {
    setDefaultField(formFieldRequired);
  };
  const handleChange = (event) => {
    const { name, value } = event.target;
    setDefaultField({ ...defaultField, [name]: value });
  };
  return (
    <div className="sign-up-container">
      <h2> Don't have an account ?</h2>
      <span>Sign up with your email and password</span>
      <form onSubmit={handleSubmit}>
        <FormInput
          type="text"
          label="Display name:"
          required
          onChange={handleChange}
          name="displayName"
          value={displayName}
        />
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
        <FormInput
          type="password"
          required
          label="Confirm password:"
          onChange={handleChange}
          name="confirmPassword"
          value={confirmPassword}
        />
        <Button type="submit">Sign up</Button>
      </form>
    </div>
  );
};
export default SignUpForm;
