import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  setPersistence,
  browserLocalPersistence,
} from "firebase/auth";
import { auth } from "./firebase";

export async function initAuthPersistence() {
  // 새로고침/브라우저 재실행에도 유지
  await setPersistence(auth, browserLocalPersistence);
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return await signInWithPopup(auth, provider);
}

export async function logout() {
  return await signOut(auth);
}
