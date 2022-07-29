import { useState } from "react";
import {
  createAuthUserWithEmailAndPassword,
  createUserDocumentFromAuth,
} from "../../utils/firebase/firebase.utils";
import { formFieldRequired } from "../../helper/fieldsForm";

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
    <>
      <h1>Sign up with your email and password</h1>
      <form onSubmit={handleSubmit}>
        <label>Display name: </label>
        <input
          type="text"
          required
          onChange={handleChange}
          name="displayName"
          value={displayName}
        />
        <label>Email: </label>
        <input
          type="email"
          required
          onChange={handleChange}
          name="email"
          value={email}
        />
        <label>Password: </label>
        <input
          type="password"
          required
          onChange={handleChange}
          name="password"
          value={password}
        />
        <label>Confirm password: </label>
        <input
          type="password"
          required
          onChange={handleChange}
          name="confirmPassword"
          value={confirmPassword}
        />
        <button type="submit">Submit</button>
      </form>
    </>
  );
};
export default SignUpForm;
