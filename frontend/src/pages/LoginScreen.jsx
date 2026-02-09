import React, { useState } from "react";
import { signInWithGoogle } from "../utils/authService";

export default function LoginScreen() {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function onGoogle() {
    setErr("");
    setLoading(true);
    try {
      await signInWithGoogle();
      // 성공하면 AuthProvider의 user가 갱신되면서 자동으로 Dashboard로 전환됨
    } catch (e) {
      setErr(e?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <div className="container" style={{ maxWidth: 720 }}>
        <div className="header">
          <div>
            <div className="title">Couple Chat Analyzer</div>
            <div className="subtitle">Google 로그인 후 대화 분석 대시보드로 이동합니다.</div>
          </div>
          <span className="badge">Firebase Auth</span>
        </div>

        <div className="card">
          <h3>Sign in</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            민감한 데이터 특성상, 로그인된 사용자만 리포트 저장/열람이 가능하도록 설계합니다.
          </p>

          <div className="row">
            <button className="btn primary" onClick={onGoogle} disabled={loading}>
              {loading ? "Opening Google..." : "Continue with Google"}
            </button>
          </div>

          {err && (
            <>
              <div className="hr" />
              <p style={{ color: "#fca5a5", fontSize: 13 }}>{err}</p>
            </>
          )}

          <div className="footerNote">
            로그인 후 새로고침해도 유지되면(자동로그인) 정상입니다.
          </div>
        </div>
      </div>
    </div>
  );
}
