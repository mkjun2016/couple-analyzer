import React, { useMemo, useState } from "react";
import { logout } from "../utils/authService";
import { useAuth } from "../AuthProvider";
import { postAnalyze } from "../utils/api";

// --------------------
// 기존 App.jsx 내용 시작
// --------------------

const MOCK_RESULT = {
  summary_1line: "전반적으로 따뜻한 톤이 많지만, 특정 구간에서 방어적 표현이 반복됨.",
  confidence: "medium",
  metrics: {
    initiative: { me: 62, partner: 38 },
    responsiveness: { me: 55, partner: 61 },
    warmth: { me: 58, partner: 64 },
    repair: { me: 46, partner: 52 },
    balance_index: 57,
  },
  highlights: [
    { type: "green", message_id: "m3", reason: "상대 감정을 확인하고 공감하는 문장" },
    { type: "red", message_id: "m7", reason: "상대 입장에서 ‘비난’으로 해석될 수 있는 단정 표현" },
  ],
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function scoreBar(v) {
  const p = clamp(v, 0, 100);
  return { width: `${p}%` };
}

function parseChatText(raw) {
  const lines = raw.split(/\r?\n/);
  const msgs = [];
  let cur = null;

  const pushCur = () => {
    if (!cur) return;
    cur.text = cur.text.trim();
    if (cur.text) msgs.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const mMe = trimmed.match(/^Me:\s*(.*)$/i);
    const mPa = trimmed.match(/^Partner:\s*(.*)$/i);

    if (mMe) {
      pushCur();
      cur = { id: `m${msgs.length + 1}`, speaker: "me", ts: null, text: mMe[1] };
      continue;
    }
    if (mPa) {
      pushCur();
      cur = { id: `m${msgs.length + 1}`, speaker: "partner", ts: null, text: mPa[1] };
      continue;
    }

    if (!cur) cur = { id: `m${msgs.length + 1}`, speaker: "me", ts: null, text: trimmed };
    else cur.text += "\n" + trimmed;
  }

  pushCur();
  return msgs;
}

function KpiCard({ label, value, leftLabel = "Me", rightLabel = "Partner" }) {
  const me = value?.me ?? 0;
  const partner = value?.partner ?? 0;
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="pill">{leftLabel}: {me}</span>
        <span className="pill">{rightLabel}: {partner}</span>
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ height: 10, borderRadius: 999, background: "rgba(148,163,184,0.18)", overflow: "hidden" }}>
          <div style={{ height: "100%", ...scoreBar(me), background: "rgba(56,189,248,0.55)" }} />
        </div>
        <div style={{ height: 6 }} />
        <div style={{ height: 10, borderRadius: 999, background: "rgba(148,163,184,0.18)", overflow: "hidden" }}>
          <div style={{ height: "100%", ...scoreBar(partner), background: "rgba(34,197,94,0.55)" }} />
        </div>
      </div>
    </div>
  );
}

// --------------------
// 기존 App.jsx 내용 끝
// --------------------

export default function DashboardScreen() {
  const { user } = useAuth();

  const [raw, setRaw] = useState(
`Me: 오늘 좀 힘들었어
Partner: 무슨 일 있었어?
Me: 그냥 여러 가지…
Partner: 말해줘. 듣고 싶어
Me: 고마워. 사실은...
Partner: 응응`
  );
  const [useMock, setUseMock] = useState(true);
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const parsedPreview = useMemo(() => parseChatText(raw), [raw]);

  async function onUploadFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRaw(text);
  }

  function onParse() {
    setError("");
    const msgs = parseChatText(raw);
    setMessages(msgs);
    setResult(null);
    if (msgs.length < 2) setError("메시지가 너무 적어. 최소 2개 이상 필요해.");
  }

  async function onAnalyze() {
    setError("");
    const msgs = messages.length ? messages : parseChatText(raw);
    setMessages(msgs);

    if (msgs.length < 2) {
      setError("먼저 대화를 파싱해줘. (Parse 버튼)");
      return;
    }

    setLoading(true);
    setResult(null);
    try {
      if (useMock) {
        await new Promise((r) => setTimeout(r, 650));
        setResult(MOCK_RESULT);
        return;
      }

      const data = await postAnalyze({
        messages: msgs,
        options: { language: "ko", wantHighlights: true, wantMetrics: true },
      });
      setResult(data);
    } catch (err) {
      setError(err?.message || "분석 요청 실패");
    } finally {
      setLoading(false);
    }
  }

  const highlightMessageMap = useMemo(() => {
    const map = new Map();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  return (
    <div className="page">
      <div className="container">
        {/* 상단 유저바 */}
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row" style={{ gap: 10 }}>
              {user?.photoURL ? (
                <img
                  src={user.photoURL}
                  alt=""
                  width={34}
                  height={34}
                  style={{ borderRadius: 999, border: "1px solid rgba(148,163,184,0.2)" }}
                />
              ) : null}
              <div>
                <div style={{ color: "#e2e8f0", fontWeight: 800, fontSize: 13 }}>
                  {user?.displayName ?? "Signed in"}
                </div>
                <div style={{ color: "#94a3b8", fontSize: 12 }}>
                  {user?.email ?? ""}
                </div>
              </div>
            </div>

            <button className="btn" onClick={logout}>Logout</button>
          </div>
        </div>

        {/* 기존 화면 */}
        <div className="header">
          <div>
            <div className="title">Couple Chat Analyzer (MVP UI)</div>
            <div className="subtitle">
              대화 업로드/복붙 → GPT 분석 → 결과를 대시보드로 시각화하는 기본 프론트.
            </div>
          </div>
          <span className="badge">React UI • JSON-first</span>
        </div>

        <div className="grid">
          <div className="card">
            <h3>Input</h3>

            <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <div className="row">
                <label className="btn" style={{ padding: 0 }}>
                  <input
                    className="input"
                    type="file"
                    accept=".txt,.csv,.log,.md"
                    onChange={onUploadFile}
                    style={{ display: "none" }}
                  />
                  <span className="btn">Upload .txt</span>
                </label>
                <button className="btn" onClick={() => setRaw("")}>Clear</button>
              </div>

              <div className="row">
                <select
                  className="select"
                  value={useMock ? "mock" : "api"}
                  onChange={(e) => setUseMock(e.target.value === "mock")}
                >
                  <option value="mock">Use Mock Result</option>
                  <option value="api">Call /api/analyze</option>
                </select>
              </div>
            </div>

            <textarea
              className="textarea"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={`Example format:
Me: ...
Partner: ...`}
            />

            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={onParse}>Parse</button>
              <button className="btn primary" onClick={onAnalyze} disabled={loading}>
                {loading ? "Analyzing..." : "Analyze"}
              </button>
              <span className="hint">현재 파서는 임시. 나중에 카톡 포맷 파서로 교체하면 됨.</span>
            </div>

            {error && (
              <>
                <div className="hr" />
                <p style={{ color: "#fca5a5", fontSize: 13 }}>{error}</p>
              </>
            )}

            <div className="hr" />
            <h3>Parsed Preview ({parsedPreview.length})</h3>
            <div className="list" style={{ maxHeight: 240, overflow: "auto", paddingRight: 4 }}>
              {parsedPreview.slice(0, 12).map((m) => (
                <div key={m.id} className="item">
                  <div className="top">
                    <div className="who">{m.speaker === "me" ? "Me" : "Partner"}</div>
                    <div className="meta">{m.id}</div>
                  </div>
                  <div className="text">{m.text}</div>
                </div>
              ))}
              {parsedPreview.length > 12 && <p className="hint">… {parsedPreview.length - 12} more</p>}
            </div>

            <div className="footerNote">
              Tip: 실제 카톡 내보내기(txt) 지원은 다음 단계에서 “포맷별 파서”만 추가하면 됨.
            </div>
          </div>

          <div className="card">
            <h3>Dashboard</h3>
            {!result ? (
              <p className="hint">Analyze를 누르면 결과 JSON이 들어오고, 여기서 시각화가 시작됨.</p>
            ) : (
              <>
                <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                  <span className="badge">Confidence: {result.confidence ?? "unknown"}</span>
                  <span className="badge">Balance: {result.metrics?.balance_index ?? "-"}</span>
                </div>

                <div className="item" style={{ marginBottom: 12 }}>
                  <div className="top">
                    <div className="who">One-line Insight</div>
                    <div className="meta">summary_1line</div>
                  </div>
                  <div className="text">{result.summary_1line}</div>
                </div>

                <div className="kpiGrid">
                  <KpiCard label="Initiative" value={result.metrics?.initiative} />
                  <KpiCard label="Responsiveness" value={result.metrics?.responsiveness} />
                  <KpiCard label="Warmth" value={result.metrics?.warmth} />
                  <KpiCard label="Repair" value={result.metrics?.repair} />
                </div>

                <div className="hr" />
                <h3>Highlights</h3>

                <div className="list">
                  {(result.highlights ?? []).map((h, idx) => {
                    const msg = highlightMessageMap.get(h.message_id);
                    const label = h.type === "green" ? "Good" : "Risk";
                    return (
                      <div key={idx} className="item">
                        <div className="top">
                          <div className="row" style={{ gap: 8 }}>
                            <span className="pill">{label}</span>
                            <span className="pill">#{h.message_id}</span>
                          </div>
                          <div className="meta">{msg ? (msg.speaker === "me" ? "Me" : "Partner") : "—"}</div>
                        </div>
                        <div className="text">{msg ? msg.text : "(해당 메시지 없음)"} </div>
                        <div className="why">Why: {h.reason}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="footerNote">
                  다음 단계: 타임라인 차트(감정/갈등확률), 세그먼트(갈등/회복) 추가하면 “제품 느낌” 확 살아남.
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ marginTop: 16 }} className="card">
          <h3>Next: Backend Contract</h3>
          <p className="hint">
            프론트는 <span className="pill">POST /api/analyze</span>로 메시지 배열을 보내고,
            JSON 결과를 그대로 렌더링하는 구조야.
          </p>
        </div>
      </div>
    </div>
  );
}
