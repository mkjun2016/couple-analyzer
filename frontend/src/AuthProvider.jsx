import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./utils/firebase";
import { initAuthPersistence } from "./utils/authService";
import { upsertUserProfile } from "./utils/userService";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let unsub = null;

    (async () => {
      await initAuthPersistence();

      unsub = onAuthStateChanged(auth, async (u) => {
        setUser(u);

        if (u) {
          // 로그인 직후 / 자동로그인 복구 시마다 문서 upsert
          await upsertUserProfile(u);
        }

        setInitializing(false);
      });
    })();

    return () => {
      if (unsub) unsub();
    };
  }, []);

  const value = useMemo(() => ({ user, initializing }), [user, initializing]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const v = useContext(AuthCtx);
  if (!v) throw new Error("useAuth must be used within AuthProvider");
  return v;
}
