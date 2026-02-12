import React, { useMemo, useState, useEffect } from "react";
import Papa from "papaparse";
import { logout } from "../utils/authService";
import { useAuth } from "../AuthProvider";
import { postAnalyze, saveCharacter, getCharacters, getCharacter, deleteCharacter, analyzeWithCharacter } from "../utils/api";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";

/**
 * ✅ 해야 할 것
 * 1) recharts 설치:
 *    npm i recharts
 *
 * 2) 백엔드 응답에 liking_index + timeline_points가 포함되어야 함.
 *    (방금 준 FastAPI 코드 기준)
 */

// --------------------
// Mock result (타임라인/liking 포함)
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
  liking_index: {
    score: 48,
    winner: "partner",
    confidence: "medium",
    rationale_1line: "상대의 공감/따뜻한 반응 비중이 조금 더 커 보임.",
  },
  timeline_points: Array.from({ length: 120 }).map((_, i) => ({
    message_id: `m${i + 1}`,
    i,
    speaker: i % 2 === 0 ? "me" : "partner",
    mood: Math.max(0, Math.min(100, 55 + Math.sin(i / 7) * 18)),
    tension: Math.max(0, Math.min(100, 35 + Math.cos(i / 9) * 22)),
    repair: Math.max(0, Math.min(100, 30 + Math.sin(i / 10) * 15)),
  })),
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function scoreBar(v) {
  const p = clamp(v, 0, 100);
  return { width: `${p}%` };
}

function stripQuotes(s) {
  const t = String(s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function looksLikeCsv(raw) {
  // 스샷처럼: 2025-10-03 11:51:36,"name","msg"
  return raw.includes('","') || /,\s*".+"\s*,\s*".+/.test(raw);
}

function isSystemLikeText(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  const lower = t.toLowerCase();

  if (lower === "photo" || lower === "video") return true;
  if (t.includes("님이") && (t.includes("나갔습니다") || t.includes("초대했습니다"))) return true;

  return false;
}

/**
 * CSV (헤더 없음) 가정:
 * [0]=timestamp, [1]=sender, [2..]=text(콤마 포함 가능)
 */
function parseKakaoCsvRaw(raw) {
  const res = Papa.parse(raw, { header: false, skipEmptyLines: true });
  const rows = res.data || [];

  const msgs = [];
  let i = 1;

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) continue;

    const ts = stripQuotes(row[0]);
    const sender = stripQuotes(row[1]);
    const text = stripQuotes(row.slice(2).join(","));

    if (isSystemLikeText(text)) continue;

    msgs.push({
      id: `m${i++}`,
      speaker: sender, // 아직 이름 그대로. 매핑 단계에서 me/partner로 바꿈
      ts: ts || null,
      text,
    });
  }
  return msgs;
}

/**
 * 기존 Me:/Partner: 포맷용 파서
 */
function parseSimpleChat(raw) {
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

/**
 * 통합 파서:
 * - CSV로 보이면 CSV 파싱
 * - 아니면 기존 simple 파싱
 */
function parseChatAny(raw) {
  if (looksLikeCsv(raw)) return parseKakaoCsvRaw(raw);
  return parseSimpleChat(raw);
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

function winnerLabel(w) {
  if (w === "me") return "내가 더 좋아함";
  if (w === "partner") return "상대가 더 좋아함";
  return "비슷함";
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload?.[0]?.payload;
  return (
    <div
      style={{
        background: "rgba(15,23,42,0.95)",
        border: "1px solid rgba(148,163,184,0.18)",
        padding: 10,
        borderRadius: 12,
        maxWidth: 340,
      }}
    >
      <div style={{ color: "#e2e8f0", fontWeight: 800, fontSize: 12, marginBottom: 6 }}>
        i: {label} · {row?.speaker === "me" ? "Me" : "Partner"} · {row?.message_id}
      </div>
      <div style={{ color: "#94a3b8", fontSize: 12, lineHeight: 1.4 }}>
        mood: {Math.round(row?.mood ?? 0)} · tension: {Math.round(row?.tension ?? 0)} · repair:{" "}
        {Math.round(row?.repair ?? 0)}
      </div>
    </div>
  );
}

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

  // parsed messages (speaker can be "me/partner" OR sender names if CSV)
  const [messages, setMessages] = useState([]);

  // CSV speaker mapping
  const [meName, setMeName] = useState("");
  const [partnerName, setPartnerName] = useState("");

  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  // 캐릭터 관리
  const [characters, setCharacters] = useState([]);
  const [showCharacterModal, setShowCharacterModal] = useState(false);
  const [showCharacterListModal, setShowCharacterListModal] = useState(false);
  const [characterName, setCharacterName] = useState("");
  const [selectedEmoji, setSelectedEmoji] = useState("👤");
  const [savingCharacter, setSavingCharacter] = useState(false);
  const [loadingCharacters, setLoadingCharacters] = useState(false);

  // 캐릭터 기반 분석
  const [characterAnalysisResult, setCharacterAnalysisResult] = useState(null);
  const [showCharacterAnalysisModal, setShowCharacterAnalysisModal] = useState(false);
  const [selectedCharacter, setSelectedCharacter] = useState(null); // 현재 선택된 캐릭터

  const availableEmojis = ["👨", "👩", "🧑", "👦", "👧", "👴", "👵", "🧔", "👱", "👨‍🦰", "👩‍🦰", "🧑‍🦱", "👨‍🦱", "👩‍🦱", "🤵"];

  // 캐릭터 목록 불러오기
  useEffect(() => {
    loadCharacters();
  }, []);

  async function loadCharacters() {
    try {
      setLoadingCharacters(true);
      const data = await getCharacters();
      setCharacters(data);
    } catch (err) {
      console.error("Failed to load characters:", err);
    } finally {
      setLoadingCharacters(false);
    }
  }

  async function onSaveCharacter() {
    if (!characterName.trim()) {
      setError("캐릭터 이름을 입력해주세요.");
      return;
    }
    
    if (messages.length < 2) {
      setError("저장할 메시지가 너무 적어요. Parse 후 다시 시도해주세요.");
      return;
    }

    try {
      setSavingCharacter(true);
      await saveCharacter(characterName, messages, selectedEmoji);
      setShowCharacterModal(false);
      setCharacterName("");
      setSelectedEmoji("👤");
      await loadCharacters();
      setError("");
    } catch (err) {
      setError(err?.message || "캐릭터 저장 실패");
    } finally {
      setSavingCharacter(false);
    }
  }

  async function onLoadCharacter(characterId) {
    try {
      setLoading(true);
      setShowCharacterListModal(false);
      const character = await getCharacter(characterId);
      
      // 메시지를 텍스트로 변환
      const chatText = character.messages
        .map((m) => `${m.speaker === "me" ? "Me" : "Partner"}: ${m.text}`)
        .join("\n");
      
      setRaw(chatText);
      setMessages(character.messages);
      setResult(null);
      setError("");
      setMeName("");
      setPartnerName("");
      setSelectedCharacter(character); // 선택된 캐릭터 저장
    } catch (err) {
      setError(err?.message || "캐릭터 로드 실패");
    } finally {
      setLoading(false);
    }
  }

  async function onDeleteCharacter(characterId) {
    if (!confirm("정말 이 캐릭터를 삭제하시겠어요?")) return;
    
    try {
      await deleteCharacter(characterId);
      await loadCharacters();
    } catch (err) {
      setError(err?.message || "캐릭터 삭제 실패");
    }
  }

  const parsedPreview = useMemo(() => parseChatAny(raw), [raw]);
  const isCsvInput = useMemo(() => looksLikeCsv(raw), [raw]);

  const uniqueSpeakers = useMemo(() => {
    const set = new Set();
    for (const m of parsedPreview) {
      const s = String(m.speaker ?? "").trim();
      if (!s) continue;
      if (s === "me" || s === "partner") continue;
      set.add(s);
    }
    return Array.from(set);
  }, [parsedPreview]);

  function autoAssignIfTwo() {
    if (uniqueSpeakers.length === 2) {
      setMeName(uniqueSpeakers[0]);
      setPartnerName(uniqueSpeakers[1]);
    }
  }

  function applySpeakerMapping(msgs) {
    if (!isCsvInput) return msgs;

    if (!meName || !partnerName) {
      throw new Error("CSV 입력은 먼저 Me/Partner 이름 매핑을 해줘야 해.");
    }
    if (meName === partnerName) {
      throw new Error("Me/Partner는 서로 다른 이름이어야 해.");
    }

    const mapped = [];
    let i = 1;

    for (const m of msgs) {
      const s = String(m.speaker ?? "").trim();
      let speaker = null;
      if (s === meName) speaker = "me";
      else if (s === partnerName) speaker = "partner";
      else continue; // 2인 대화만 MVP로 처리

      mapped.push({ ...m, id: `m${i++}`, speaker });
    }
    return mapped;
  }

  async function onUploadFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRaw(text);
    setMessages([]);
    setResult(null);
    setError("");
    setMeName("");
    setPartnerName("");
  }

  function onParse() {
    setError("");
    setResult(null);

    const parsed = parseChatAny(raw);

    try {
      const normalized = applySpeakerMapping(parsed);
      setMessages(normalized);

      if (normalized.length < 2) {
        setError("메시지가 너무 적어. (매핑/필터 때문에 줄었을 수 있음)");
      }
    } catch (e) {
      setMessages(parsed); // 파싱 결과만이라도 보여주기
      setError(e?.message || "파싱 실패");
    }
  }

  async function onAnalyze() {
    setError("");

    const parsed = parseChatAny(raw);

    let msgs = parsed;
    try {
      msgs = applySpeakerMapping(parsed);
    } catch (e) {
      setError(e?.message || "Me/Partner 매핑이 필요해.");
      return;
    }

    setMessages(msgs);

    if (msgs.length < 2) {
      setError("메시지가 너무 적어. Parse 후 다시 확인해줘.");
      return;
    }

    setLoading(true);
    setResult(null);
    setCharacterAnalysisResult(null);

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

  async function onAnalyzeWithCharacter(characterId) {
    setError("");

    const parsed = parseChatAny(raw);

    let msgs = parsed;
    try {
      msgs = applySpeakerMapping(parsed);
    } catch (e) {
      setError(e?.message || "Me/Partner 매핑이 필요해.");
      return;
    }

    setMessages(msgs);

    if (msgs.length < 1) {
      setError("분석할 새 메시지가 없어.");
      return;
    }

    setLoading(true);
    setResult(null);
    setCharacterAnalysisResult(null);
    setShowCharacterListModal(false);

    try {
      if (useMock) {
        setError("캐릭터 기반 분석은 Mock 모드에서 지원하지 않아. API 모드로 전환해줘.");
        setLoading(false);
        return;
      }

      const data = await analyzeWithCharacter(characterId, {
        messages: msgs,
        options: { language: "ko", wantHighlights: true, wantMetrics: true },
      });

      setCharacterAnalysisResult(data);
      setResult(data.standard_analysis);
      setShowCharacterAnalysisModal(true);
    } catch (err) {
      setError(err?.message || "캐릭터 기반 분석 실패");
    } finally {
      setLoading(false);
    }
  }

  const highlightMessageMap = useMemo(() => {
    const map = new Map();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  const timeline = useMemo(() => {
    const pts = result?.timeline_points ?? [];
    // 라인차트 안정성: i 기준 정렬 + 숫자화
    const sorted = [...pts].sort((a, b) => (a?.i ?? 0) - (b?.i ?? 0));
    return sorted.map((p, idx) => ({
      ...p,
      i: typeof p.i === "number" ? p.i : idx,
      mood: Number(p.mood ?? 0),
      tension: Number(p.tension ?? 0),
      repair: Number(p.repair ?? 0),
    }));
  }, [result]);

  const timelineStats = useMemo(() => {
    if (!timeline.length) return null;
    const avg = (key) => {
      const s = timeline.reduce((acc, x) => acc + (Number(x[key]) || 0), 0);
      return Math.round(s / timeline.length);
    };
    return {
      points: timeline.length,
      moodAvg: avg("mood"),
      tensionAvg: avg("tension"),
      repairAvg: avg("repair"),
    };
  }, [timeline]);

  return (
    <div className="page">
      <div className="container">
        {/* Top user bar */}
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

        {/* Header */}
        <div className="header">
          <div>
            <div className="title">Couple Chat Analyzer (MVP UI)</div>
            <div className="subtitle">
              업로드/복붙 → (CSV면 매핑) → GPT 분석 → 결과 시각화 (Liking + Timeline)
            </div>
          </div>
          <span className="badge">React UI • JSON-first</span>
        </div>

        <div className="grid">
          {/* LEFT */}
          <div className="card">
            <h3>Input</h3>

            {/* 선택된 캐릭터 표시 */}
            {selectedCharacter && (
              <div style={{
                background: "rgba(56, 189, 248, 0.1)",
                border: "1px solid rgba(56, 189, 248, 0.3)",
                borderRadius: 8,
                padding: 10,
                marginBottom: 12,
              }}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 24 }}>{selectedCharacter.emoji || "👤"}</span>
                    <div>
                      <div style={{ color: "#38bdf8", fontWeight: 700, fontSize: 13 }}>
                        📋 선택된 캐릭터
                      </div>
                      <div style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600 }}>
                        {selectedCharacter.name}
                      </div>
                    </div>
                  </div>
                  <button 
                    className="btn" 
                    onClick={() => setSelectedCharacter(null)}
                    style={{ 
                      fontSize: 11, 
                      padding: "4px 8px",
                      background: "rgba(239, 68, 68, 0.1)",
                      color: "#f87171"
                    }}
                  >
                    ✕ 해제
                  </button>
                </div>
              </div>
            )}

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
                  <span className="btn">Upload .txt / .csv</span>
                </label>

                <button
                  className="btn"
                  onClick={() => {
                    setRaw("");
                    setMessages([]);
                    setResult(null);
                    setError("");
                    setMeName("");
                    setPartnerName("");
                    setSelectedCharacter(null);
                  }}
                >
                  Clear
                </button>
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

            {/* 저장된 캐릭터 목록 */}
            <div className="hr" />
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <h3>Saved Characters ({characters.length})</h3>
              <button 
                className="btn primary" 
                onClick={() => setShowCharacterListModal(true)}
                style={{ fontSize: 12, padding: "6px 12px" }}
              >
                📋 Browse All
              </button>
            </div>
            
            {loadingCharacters ? (
              <p className="hint" style={{ marginBottom: 12 }}>Loading...</p>
            ) : characters.length > 0 ? (
              <p className="hint" style={{ marginBottom: 12 }}>
                {characters.slice(0, 3).map(c => c.emoji || "👤").join(" ")} 
                {characters.length > 3 && ` +${characters.length - 3} more`}
                {" · "}
                Click "Browse All" to see your characters
              </p>
            ) : (
              <p className="hint" style={{ marginBottom: 12 }}>
                저장된 캐릭터가 없습니다. Parse 후 💾 Save Character 버튼을 눌러 저장하세요.
              </p>
            )}

            <textarea
              className="textarea"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={`Example format:
Me: ...
Partner: ...

또는 CSV:
timestamp,"name","message"`}
            />

            {/* CSV mapping */}
            {isCsvInput ? (
              <>
                <div className="hr" />
                <h3>CSV Speaker Mapping</h3>

                <div className="hint" style={{ marginBottom: 10 }}>
                  CSV는 speaker가 이름으로 들어오므로, 분석 전에 Me/Partner로 매핑해야 해.
                </div>

                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {uniqueSpeakers.slice(0, 10).map((s) => (
                    <span key={s} className="pill">{s}</span>
                  ))}
                  {uniqueSpeakers.length === 0 ? (
                    <span className="hint">sender 이름 후보가 안 보이면 CSV 컬럼 형식을 확인해줘</span>
                  ) : null}
                </div>

                <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 10, alignItems: "end" }}>
                  <button className="btn" onClick={autoAssignIfTwo} disabled={uniqueSpeakers.length !== 2}>
                    Auto-assign (if 2)
                  </button>

                  <div style={{ minWidth: 220 }}>
                    <div className="hint">Me =</div>
                    <select className="select" value={meName} onChange={(e) => setMeName(e.target.value)}>
                      <option value="">(select)</option>
                      {uniqueSpeakers.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>

                  <div style={{ minWidth: 220 }}>
                    <div className="hint">Partner =</div>
                    <select className="select" value={partnerName} onChange={(e) => setPartnerName(e.target.value)}>
                      <option value="">(select)</option>
                      {uniqueSpeakers.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="hint" style={{ marginTop: 8 }}>
                  매핑 후 <span className="pill">Parse</span> 또는 <span className="pill">Analyze</span>.
                </div>
              </>
            ) : null}

            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={onParse}>Parse</button>
              <button className="btn primary" onClick={onAnalyze} disabled={loading}>
                {loading ? "Analyzing..." : "Analyze"}
              </button>
              {messages.length >= 2 && (
                <button 
                  className="btn" 
                  onClick={() => setShowCharacterModal(true)}
                  style={{ marginLeft: "auto" }}
                >
                  💾 Save Character
                </button>
              )}
              <span className="hint">CSV면 매핑 → Analyze. (2인 대화 기준)</span>
            </div>

            {error ? (
              <>
                <div className="hr" />
                <p style={{ color: "#fca5a5", fontSize: 13 }}>{error}</p>
              </>
            ) : null}

            <div className="hr" />
            <h3>Parsed Preview ({parsedPreview.length})</h3>
            <div className="list" style={{ maxHeight: 240, overflow: "auto", paddingRight: 4 }}>
              {parsedPreview.slice(0, 12).map((m) => (
                <div key={m.id} className="item">
                  <div className="top">
                    <div className="who">{String(m.speaker)}</div>
                    <div className="meta">{m.ts ? String(m.ts) : m.id}</div>
                  </div>
                  <div className="text">{m.text}</div>
                </div>
              ))}
              {parsedPreview.length > 12 ? (
                <p className="hint">… {parsedPreview.length - 12} more</p>
              ) : null}
            </div>

            <div className="footerNote">
              다음: (1) CSV 포맷 다양성 대응 (2) 시스템 메시지 필터 강화 (3) 캐릭터 선택/기억 연결
            </div>
          </div>

          {/* RIGHT */}
          <div className="card">
            <h3>Dashboard</h3>

            {!result ? (
              <p className="hint">Analyze를 누르면 결과 JSON이 들어오고, 여기서 시각화가 시작됨.</p>
            ) : (
              <>
                {/* Top badges */}
                <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                  <span className="badge">Confidence: {result.confidence ?? "unknown"}</span>
                  <span className="badge">Balance: {result.metrics?.balance_index ?? "-"}</span>
                </div>

                {/* One-line */}
                <div className="item" style={{ marginBottom: 12 }}>
                  <div className="top">
                    <div className="who">One-line Insight</div>
                    <div className="meta">summary_1line</div>
                  </div>
                  <div className="text">{result.summary_1line}</div>
                </div>

                {/* Liking Index */}
                {result?.liking_index ? (
                  <div className="item" style={{ marginBottom: 12 }}>
                    <div className="top">
                      <div className="who">Liking Index</div>
                      <div className="meta">{result.liking_index.confidence}</div>
                    </div>
                    <div className="text">
                      Score: <span className="pill">{result.liking_index.score}</span>{" "}
                      <span className="pill">{winnerLabel(result.liking_index.winner)}</span>
                    </div>
                    <div className="why">Why: {result.liking_index.rationale_1line}</div>
                  </div>
                ) : null}

                {/* KPI */}
                <div className="kpiGrid">
                  <KpiCard label="Initiative" value={result.metrics?.initiative} />
                  <KpiCard label="Responsiveness" value={result.metrics?.responsiveness} />
                  <KpiCard label="Warmth" value={result.metrics?.warmth} />
                  <KpiCard label="Repair" value={result.metrics?.repair} />
                </div>

                {/* Timeline */}
                {timeline?.length ? (
                  <>
                    <div className="hr" />
                    <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                      <h3 style={{ margin: 0 }}>Timeline</h3>
                      {timelineStats ? (
                        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                          <span className="badge">Points: {timelineStats.points}</span>
                          <span className="badge">Mood avg: {timelineStats.moodAvg}</span>
                          <span className="badge">Tension avg: {timelineStats.tensionAvg}</span>
                          <span className="badge">Repair avg: {timelineStats.repairAvg}</span>
                        </div>
                      ) : null}
                    </div>

                    <div className="item" style={{ marginTop: 10 }}>
                      <div className="hint" style={{ marginBottom: 10 }}>
                        mood(↑좋음) / tension(↑갈등) / repair(↑회복) 흐름 (툴팁에서 speaker/message_id 확인)
                      </div>
                      <div style={{ width: "100%", height: 280 }}>
                        <ResponsiveContainer>
                          <LineChart data={timeline}>
                            <XAxis dataKey="i" tick={{ fontSize: 12 }} />
                            <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                            <Tooltip content={<CustomTooltip />} />
                            <Legend />
                            <Line type="monotone" dataKey="mood" dot={false} />
                            <Line type="monotone" dataKey="tension" dot={false} />
                            <Line type="monotone" dataKey="repair" dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </>
                ) : null}

                {/* Highlights */}
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
                          <div className="meta">
                            {msg ? (msg.speaker === "me" ? "Me" : "Partner") : "—"}
                          </div>
                        </div>
                        <div className="text">{msg ? msg.text : "(해당 메시지 없음)"} </div>
                        <div className="why">Why: {h.reason}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="footerNote">
                  다음 단계: 타임라인에서 tension 높은 구간 자동 세그먼트 + “회복 성공 구간” 추천 멘트까지 만들면 제품감이 폭발함.
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ marginTop: 16 }} className="card">
          <h3>Next</h3>
          <p className="hint">
            지금 흐름: CSV 업로드 → speaker 매핑 → <span className="pill">POST /api/analyze</span> →
            결과 렌더. 캐릭터 저장 기능으로 저장된 대화 패턴을 재사용할 수 있습니다.
          </p>
        </div>
      </div>

      {/* 캐릭터 저장 모달 */}
      {showCharacterModal && (
        <div 
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setShowCharacterModal(false)}
        >
          <div 
            className="card" 
            style={{ 
              width: "90%", 
              maxWidth: 500,
              margin: 20,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Save Character</h3>
            <p className="hint" style={{ marginBottom: 16 }}>
              현재 파싱된 대화를 캐릭터로 저장하면 나중에 다시 불러올 수 있어요.
            </p>

            <div style={{ marginBottom: 16 }}>
              <div className="hint" style={{ marginBottom: 6 }}>이모지 선택</div>
              <div style={{ 
                display: "grid", 
                gridTemplateColumns: "repeat(5, 1fr)", 
                gap: 8,
                marginBottom: 16,
              }}>
                {availableEmojis.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => setSelectedEmoji(emoji)}
                    style={{
                      padding: 12,
                      fontSize: 28,
                      background: selectedEmoji === emoji 
                        ? "rgba(56, 189, 248, 0.2)" 
                        : "rgba(15, 23, 42, 0.4)",
                      border: selectedEmoji === emoji 
                        ? "2px solid rgba(56, 189, 248, 0.6)" 
                        : "1px solid rgba(148, 163, 184, 0.18)",
                      borderRadius: 12,
                      cursor: "pointer",
                      transition: "all 0.2s",
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div className="hint" style={{ marginBottom: 6 }}>캐릭터 이름</div>
              <input
                className="input"
                type="text"
                value={characterName}
                onChange={(e) => setCharacterName(e.target.value)}
                placeholder="예: 우리 첫 대화"
                style={{
                  width: "100%",
                  padding: 10,
                  background: "rgba(15, 23, 42, 0.6)",
                  border: "1px solid rgba(148, 163, 184, 0.18)",
                  borderRadius: 8,
                  color: "#e2e8f0",
                  fontSize: 14,
                }}
              />
            </div>

            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button 
                className="btn" 
                onClick={() => {
                  setShowCharacterModal(false);
                  setCharacterName("");
                  setSelectedEmoji("👤");
                }}
                disabled={savingCharacter}
              >
                Cancel
              </button>
              <button 
                className="btn primary" 
                onClick={onSaveCharacter}
                disabled={savingCharacter || !characterName.trim()}
              >
                {savingCharacter ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 캐릭터 목록 모달 */}
      {showCharacterListModal && (
        <div 
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.8)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 20,
          }}
          onClick={() => setShowCharacterListModal(false)}
        >
          <div 
            className="card" 
            style={{ 
              width: "100%", 
              maxWidth: 700,
              maxHeight: "80vh",
              overflow: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>📋 Saved Characters ({characters.length})</h3>
              <button 
                className="btn"
                onClick={() => setShowCharacterListModal(false)}
                style={{ fontSize: 20, padding: "4px 12px" }}
              >
                ✕
              </button>
            </div>

            <p className="hint" style={{ marginBottom: 16 }}>
              💡 <strong>Load</strong>: 캐릭터 대화를 불러오기 | <strong>🧠 Analyze</strong>: 캐릭터 인격을 바탕으로 현재 채팅의 심리 분석
            </p>

            {loadingCharacters ? (
              <p className="hint">Loading characters...</p>
            ) : characters.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
                {characters.map((char) => (
                  <div 
                    key={char.id} 
                    style={{
                      background: "rgba(15, 23, 42, 0.6)",
                      border: "1px solid rgba(148, 163, 184, 0.18)",
                      borderRadius: 12,
                      padding: 16,
                      cursor: "pointer",
                      transition: "all 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "rgba(56, 189, 248, 0.1)";
                      e.currentTarget.style.borderColor = "rgba(56, 189, 248, 0.4)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "rgba(15, 23, 42, 0.6)";
                      e.currentTarget.style.borderColor = "rgba(148, 163, 184, 0.18)";
                    }}
                  >
                    <div style={{ 
                      fontSize: 48, 
                      textAlign: "center", 
                      marginBottom: 8,
                    }}>
                      {char.emoji || "👤"}
                    </div>
                    <div style={{ 
                      color: "#e2e8f0", 
                      fontWeight: 700, 
                      fontSize: 14,
                      marginBottom: 4,
                      textAlign: "center",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {char.name}
                    </div>
                    <div style={{ 
                      color: "#94a3b8", 
                      fontSize: 12,
                      textAlign: "center",
                      marginBottom: 12,
                    }}>
                      {char.messageCount} messages
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button 
                        className="btn primary" 
                        onClick={() => onLoadCharacter(char.id)}
                        style={{ 
                          flex: 1,
                          fontSize: 11, 
                          padding: "6px 8px",
                        }}
                      >
                        Load
                      </button>
                      <button 
                        className="btn" 
                        onClick={(e) => {
                          e.stopPropagation();
                          onAnalyzeWithCharacter(char.id);
                        }}
                        style={{ 
                          flex: 1,
                          fontSize: 11, 
                          padding: "6px 8px",
                          background: "rgba(34, 197, 94, 0.1)", 
                          color: "#4ade80" 
                        }}
                        title="이 캐릭터의 인격을 바탕으로 현재 채팅 분석"
                      >
                        🧠 Analyze
                      </button>
                      <button 
                        className="btn" 
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteCharacter(char.id);
                        }}
                        style={{ 
                          fontSize: 11, 
                          padding: "6px 8px", 
                          background: "rgba(239, 68, 68, 0.1)", 
                          color: "#f87171" 
                        }}
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">저장된 캐릭터가 없습니다.</p>
            )}
          </div>
        </div>
      )}

      {/* 캐릭터 심리 분석 결과 모달 */}
      {showCharacterAnalysisModal && characterAnalysisResult && (
        <div 
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1001,
            padding: 20,
          }}
          onClick={() => setShowCharacterAnalysisModal(false)}
        >
          <div 
            className="card" 
            style={{ 
              width: "100%", 
              maxWidth: 900,
              maxHeight: "85vh",
              overflow: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>🧠 심리 분석: {characterAnalysisResult.character_name}</h3>
              <button 
                className="btn"
                onClick={() => setShowCharacterAnalysisModal(false)}
                style={{ fontSize: 20, padding: "4px 12px" }}
              >
                ✕
              </button>
            </div>

            {/* 인격 분석 */}
            <div style={{ marginBottom: 24 }}>
              <h3 style={{ 
                color: "#38bdf8", 
                fontSize: 16, 
                marginBottom: 12,
                borderBottom: "2px solid rgba(56, 189, 248, 0.3)",
                paddingBottom: 8,
              }}>
                👤 캐릭터 인격 분석 (기존 대화 기반)
              </h3>
              
              <div style={{ 
                background: "rgba(56, 189, 248, 0.05)",
                border: "1px solid rgba(56, 189, 248, 0.2)",
                borderRadius: 12,
                padding: 16,
                marginBottom: 12,
              }}>
                <div style={{ marginBottom: 12 }}>
                  <div className="hint" style={{ marginBottom: 4, fontWeight: 700, color: "#38bdf8" }}>
                    💬 대화 스타일
                  </div>
                  <div style={{ color: "#e2e8f0", fontSize: 14, lineHeight: 1.6 }}>
                    {characterAnalysisResult.personality_insight.communication_style}
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div className="hint" style={{ marginBottom: 4, fontWeight: 700, color: "#38bdf8" }}>
                    ❤️ 감정 패턴
                  </div>
                  <div style={{ color: "#e2e8f0", fontSize: 14, lineHeight: 1.6 }}>
                    {characterAnalysisResult.personality_insight.emotional_patterns}
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div className="hint" style={{ marginBottom: 4, fontWeight: 700, color: "#38bdf8" }}>
                    🔄 반응 경향
                  </div>
                  <div style={{ color: "#e2e8f0", fontSize: 14, lineHeight: 1.6 }}>
                    {characterAnalysisResult.personality_insight.response_tendencies}
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div className="hint" style={{ marginBottom: 4, fontWeight: 700, color: "#38bdf8" }}>
                    📝 특징적 표현들
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {characterAnalysisResult.personality_insight.key_phrases.map((phrase, idx) => (
                      <span key={idx} className="pill" style={{ 
                        background: "rgba(56, 189, 248, 0.15)",
                        color: "#38bdf8",
                        border: "1px solid rgba(56, 189, 248, 0.3)"
                      }}>
                        "{phrase}"
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="hint" style={{ marginBottom: 4, fontWeight: 700, color: "#38bdf8" }}>
                    🎭 종합 인격
                  </div>
                  <div style={{ 
                    color: "#e2e8f0", 
                    fontSize: 14, 
                    lineHeight: 1.6,
                    background: "rgba(15, 23, 42, 0.4)",
                    padding: 12,
                    borderRadius: 8,
                    fontStyle: "italic",
                  }}>
                    {characterAnalysisResult.personality_insight.overall_personality}
                  </div>
                </div>
              </div>
            </div>

            {/* 새 채팅 심리 분석 */}
            <div>
              <h3 style={{ 
                color: "#4ade80", 
                fontSize: 16, 
                marginBottom: 12,
                borderBottom: "2px solid rgba(74, 222, 128, 0.3)",
                paddingBottom: 8,
              }}>
                🔍 새 채팅 심리 분석 (인격 기반)
              </h3>
              
              <div style={{ 
                background: "rgba(34, 197, 94, 0.05)",
                border: "1px solid rgba(74, 222, 128, 0.2)",
                borderRadius: 12,
                padding: 16,
                marginBottom: 12,
              }}>
                <div style={{ marginBottom: 12 }}>
                  <div className="hint" style={{ marginBottom: 4, fontWeight: 700, color: "#4ade80" }}>
                    💭 숨겨진 감정
                  </div>
                  <div style={{ color: "#e2e8f0", fontSize: 14, lineHeight: 1.6 }}>
                    {characterAnalysisResult.new_chat_psychology.underlying_emotions}
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div className="hint" style={{ marginBottom: 4, fontWeight: 700, color: "#4ade80" }}>
                    🎯 동기
                  </div>
                  <div style={{ color: "#e2e8f0", fontSize: 14, lineHeight: 1.6 }}>
                    {characterAnalysisResult.new_chat_psychology.motivation}
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div className="hint" style={{ marginBottom: 4, fontWeight: 700, color: "#4ade80" }}>
                    💬 의사소통 의도
                  </div>
                  <div style={{ color: "#e2e8f0", fontSize: 14, lineHeight: 1.6 }}>
                    {characterAnalysisResult.new_chat_psychology.communication_intent}
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div className="hint" style={{ marginBottom: 4, fontWeight: 700, color: "#4ade80" }}>
                    🔄 인격 일관성
                  </div>
                  <div style={{ color: "#e2e8f0", fontSize: 14, lineHeight: 1.6 }}>
                    {characterAnalysisResult.new_chat_psychology.personality_consistency}
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div className="hint" style={{ marginBottom: 4, fontWeight: 700, color: "#4ade80" }}>
                    🧠 심리 상태
                  </div>
                  <div style={{ 
                    color: "#e2e8f0", 
                    fontSize: 14, 
                    lineHeight: 1.6,
                    background: "rgba(15, 23, 42, 0.4)",
                    padding: 12,
                    borderRadius: 8,
                  }}>
                    {characterAnalysisResult.new_chat_psychology.psychological_state}
                  </div>
                </div>

                <div>
                  <div className="hint" style={{ marginBottom: 4, fontWeight: 700, color: "#4ade80" }}>
                    💡 대응 추천
                  </div>
                  <div style={{ 
                    background: "rgba(15, 23, 42, 0.4)",
                    padding: 12,
                    borderRadius: 8,
                  }}>
                    {characterAnalysisResult.new_chat_psychology.recommendations.map((rec, idx) => (
                      <div key={idx} style={{ 
                        color: "#e2e8f0", 
                        fontSize: 13, 
                        lineHeight: 1.6,
                        marginBottom: idx < characterAnalysisResult.new_chat_psychology.recommendations.length - 1 ? 8 : 0,
                        paddingLeft: 16,
                        position: "relative",
                      }}>
                        <span style={{ 
                          position: "absolute", 
                          left: 0, 
                          color: "#4ade80",
                          fontWeight: 700,
                        }}>
                          {idx + 1}.
                        </span>
                        {rec}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button 
                className="btn primary" 
                onClick={() => setShowCharacterAnalysisModal(false)}
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
