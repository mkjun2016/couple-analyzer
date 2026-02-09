import React from "react";
import { useAuth } from "./AuthProvider.jsx";
import LoginScreen from "./pages/LoginScreen.jsx";
import DashboardScreen from "./pages/DashboardScreen.jsx";

export default function App() {
  const { user, initializing } = useAuth();

  if (initializing) {
    return (
      <div className="page">
        <div className="container" style={{ maxWidth: 720 }}>
          <div className="card">
            <h3>Loading</h3>
            <p className="hint">세션 확인 중…</p>
          </div>
        </div>
      </div>
    );
  }

  // ✅ 로그인 전: 로그인 화면
  if (!user) return <LoginScreen />;

  // ✅ 로그인 후: 대시보드 화면
  return <DashboardScreen />;
}
