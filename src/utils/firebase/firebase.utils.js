//setting up firebase auth
import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithRedirect,
  signInWithPopup,
  GoogleAuthProvider,
} from "firebase/auth";

import { doc, getFirestore, getDoc, setDoc } from "firebase/firestore";

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

//instantiate the database
export const db = getFirestore();
export const createUserDocumentFromAuth = async (userAuth) => {
  const { user } = userAuth;
  const userDocRef = doc(db, "users", user.uid);
  const userSnapshot = await getDoc(userDocRef);

  if (!userSnapshot.exists()) {
    const { displayName, email } = user;
    const createdAt = new Date();
    const updatedAt = new Date();
    try {
      await setDoc(userDocRef, { displayName, email, createdAt, updatedAt });
    } catch ({ message }) {
      console.error(message);
    }
  }
  return userDocRef;
};
