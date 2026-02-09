import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyDIOYwUf3VzYYYbBc9vFY4vPLu7dUah_zs",
  authDomain: "couple-analysis.firebaseapp.com",
  projectId: "couple-analysis",
  storageBucket: "couple-analysis.firebasestorage.app",
  messagingSenderId: "336103996430",
  appId: "1:336103996430:web:b7a866a30553bd42cc105f",
  measurementId: "G-MGG2LPLZXD",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const analytics = getAnalytics(app);
