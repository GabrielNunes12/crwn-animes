//setting up firebase auth
import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithRedirect,
  signInWithPopup,
  GoogleAuthProvider,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBMeXelKRGlEBXgQZfcYOFdDF5GbqqE2TI",
  authDomain: "crwn-anime-db.firebaseapp.com",
  projectId: "crwn-anime-db",
  storageBucket: "crwn-anime-db.appspot.com",
  messagingSenderId: "139057223193",
  appId: "1:139057223193:web:43d80a2296ca0a789c3c88",
};

const firebaseApp = initializeApp(firebaseConfig);

const provider = new GoogleAuthProvider();

// Google Authentication
provider.setCustomParameters({
  prompt: "select_account",
});

export const auth = getAuth();
export const signInWithGooglePopup = () => signInWithPopup(auth, provider);
