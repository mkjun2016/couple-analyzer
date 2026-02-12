from __future__ import annotations

import os
import json
from datetime import datetime, timezone
from typing import List, Optional, Literal

from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from openai import OpenAI

import firebase_admin
from firebase_admin import credentials, firestore, auth as fb_auth

load_dotenv()

Speaker = Literal["me", "partner"]

# ---- Limit ----
MAX_MESSAGES = 1000
MAX_TIMELINE_POINTS = 220
MIN_TIMELINE_POINTS = 60
TARGET_TIMELINE_POINTS = 120


class Message(BaseModel):
    id: str
    speaker: Speaker
    ts: Optional[str] = None
    text: str = Field(min_length=1)


class AnalyzeOptions(BaseModel):
    language: Literal["ko", "en"] = "ko"
    wantHighlights: bool = True
    wantMetrics: bool = True


class AnalyzeRequest(BaseModel):
    messages: List[Message] = Field(min_length=2)
    options: AnalyzeOptions = AnalyzeOptions()


class Highlight(BaseModel):
    type: Literal["green", "red"]
    message_id: str
    reason: str


class MetricsPair(BaseModel):
    me: int = Field(ge=0, le=100)
    partner: int = Field(ge=0, le=100)


class Metrics(BaseModel):
    initiative: MetricsPair
    responsiveness: MetricsPair
    warmth: MetricsPair
    repair: MetricsPair
    balance_index: int = Field(ge=0, le=100)


class LikingIndex(BaseModel):
    # 0~100, 50=비슷, >50=내가 더 좋아함, <50=상대가 더 좋아함
    score: int = Field(ge=0, le=100)
    winner: Literal["me", "partner", "tie"]
    rationale_1line: str
    confidence: Literal["low", "medium", "high"] = "medium"


class TimelinePoint(BaseModel):
    message_id: str
    i: int = Field(ge=0)
    speaker: Speaker
    mood: int = Field(ge=0, le=100)  # 0=차가움/부정, 100=따뜻/긍정
    tension: int = Field(ge=0, le=100)  # 0=갈등 없음, 100=갈등/방어 매우 큼
    repair: int = Field(ge=0, le=100)  # 0=회복 없음, 100=회복 시도 강함


class AnalyzeResponse(BaseModel):
    summary_1line: str
    confidence: Literal["low", "medium", "high"] = "medium"
    metrics: Optional[Metrics] = None
    highlights: List[Highlight] = []
    liking_index: Optional[LikingIndex] = None
    timeline_points: List[TimelinePoint] = []


app = FastAPI(title="Couple Chat Analyzer API", version="0.5.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ANALYSIS_MODE = os.getenv("ANALYSIS_MODE", "mock")  # "mock" | "openai"

# ---- OpenAI init ----
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
openai_client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None

# ---- Structured Output Schema (Responses API: text.format.schema) ----
ANALYZE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "summary_1line",
        "confidence",
        "metrics",
        "highlights",
        "liking_index",
        "timeline_points",
    ],
    "properties": {
        "summary_1line": {"type": "string"},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "metrics": {
            "anyOf": [
                {"type": "null"},
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "initiative",
                        "responsiveness",
                        "warmth",
                        "repair",
                        "balance_index",
                    ],
                    "properties": {
                        "initiative": {"$ref": "#/$defs/metricsPair"},
                        "responsiveness": {"$ref": "#/$defs/metricsPair"},
                        "warmth": {"$ref": "#/$defs/metricsPair"},
                        "repair": {"$ref": "#/$defs/metricsPair"},
                        "balance_index": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 100,
                        },
                    },
                },
            ]
        },
        "highlights": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["type", "message_id", "reason"],
                "properties": {
                    "type": {"type": "string", "enum": ["green", "red"]},
                    "message_id": {"type": "string"},
                    "reason": {"type": "string"},
                },
            },
        },
        "liking_index": {
            "anyOf": [
                {"type": "null"},
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["score", "winner", "rationale_1line", "confidence"],
                    "properties": {
                        "score": {"type": "integer", "minimum": 0, "maximum": 100},
                        "winner": {"type": "string", "enum": ["me", "partner", "tie"]},
                        "rationale_1line": {"type": "string"},
                        "confidence": {
                            "type": "string",
                            "enum": ["low", "medium", "high"],
                        },
                    },
                },
            ]
        },
        "timeline_points": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["message_id", "i", "speaker", "mood", "tension", "repair"],
                "properties": {
                    "message_id": {"type": "string"},
                    "i": {"type": "integer", "minimum": 0},
                    "speaker": {"type": "string", "enum": ["me", "partner"]},
                    "mood": {"type": "integer", "minimum": 0, "maximum": 100},
                    "tension": {"type": "integer", "minimum": 0, "maximum": 100},
                    "repair": {"type": "integer", "minimum": 0, "maximum": 100},
                },
            },
        },
    },
    "$defs": {
        "metricsPair": {
            "type": "object",
            "additionalProperties": False,
            "required": ["me", "partner"],
            "properties": {
                "me": {"type": "integer", "minimum": 0, "maximum": 100},
                "partner": {"type": "integer", "minimum": 0, "maximum": 100},
            },
        }
    },
}


# ---- Firebase Admin init ----
FIREBASE_CRED_PATH = os.getenv("FIREBASE_CRED_PATH")
db = None
if FIREBASE_CRED_PATH:
    cred = credentials.Certificate(FIREBASE_CRED_PATH)
    firebase_admin.initialize_app(cred)
    db = firestore.client()
else:
    db = None


def build_transcript(req: AnalyzeRequest) -> str:
    lines = []
    for m in req.messages:
        who = "ME" if m.speaker == "me" else "PARTNER"
        ts = f"[{m.ts}] " if m.ts else ""
        lines.append(f"{ts}{who}({m.id}): {m.text.strip()}")
    return "\n".join(lines)


def clamp01_100(x: int) -> int:
    return max(0, min(100, int(x)))


def sample_indices(n: int, target: int) -> List[int]:
    if n <= target:
        return list(range(n))
    # 균등 샘플링
    step = n / target
    idxs = [int(i * step) for i in range(target)]
    # 마지막 인덱스가 n-1이 아닐 수 있어 보정
    idxs[-1] = n - 1
    # 중복 제거(간혹 발생) + 정렬
    idxs = sorted(set(idxs))
    return idxs


def mock_timeline(req: AnalyzeRequest) -> List[TimelinePoint]:
    msgs = req.messages
    n = len(msgs)
    target = min(
        MAX_TIMELINE_POINTS, max(MIN_TIMELINE_POINTS, min(TARGET_TIMELINE_POINTS, n))
    )
    idxs = sample_indices(n, target)

    points: List[TimelinePoint] = []
    for k, idx in enumerate(idxs):
        m = msgs[idx]
        # 아주 단순한 패턴 기반(대충 움직이는 선)
        base = 55 if m.speaker == "partner" else 50
        mood = clamp01_100(base + (k % 7) * 3 - (k % 5) * 2)
        tension = clamp01_100(35 + (k % 9) * 4 - (k % 6) * 3)
        repair = clamp01_100(30 + (k % 8) * 3 - (k % 4) * 2)
        points.append(
            TimelinePoint(
                message_id=m.id,
                i=k,
                speaker=m.speaker,
                mood=mood,
                tension=tension,
                repair=repair,
            )
        )
    return points


def mock_liking(req: AnalyzeRequest, metrics: Optional[Metrics]) -> LikingIndex:
    total = len(req.messages)
    if metrics:
        # warmth/responsiveness 기반으로 매우 간단히
        diff = (metrics.warmth.me + metrics.responsiveness.me) - (
            metrics.warmth.partner + metrics.responsiveness.partner
        )
        score = clamp01_100(50 + int(round(diff * 0.25)))
    else:
        score = 50

    if 46 <= score <= 54:
        winner = "tie"
    else:
        winner = "me" if score > 50 else "partner"

    confidence = "high" if total >= 200 else "medium" if total >= 40 else "low"
    rationale = (
        "표현의 따뜻함/호응 패턴이 비슷해서 균형에 가까움."
        if winner == "tie"
        else (
            "내가 더 자주 공감/확인/유지 신호를 보내는 패턴."
            if winner == "me"
            else "상대가 더 호응적이고 따뜻한 반응 비중이 큰 패턴."
        )
    )
    return LikingIndex(
        score=score, winner=winner, rationale_1line=rationale, confidence=confidence
    )


def mock_analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    me_count = sum(1 for m in req.messages if m.speaker == "me")
    pa_count = sum(1 for m in req.messages if m.speaker == "partner")
    total = max(1, me_count + pa_count)

    initiative_me = int(round(100 * (me_count / total)))
    initiative_pa = 100 - initiative_me

    metrics_obj = (
        Metrics(
            initiative=MetricsPair(me=initiative_me, partner=initiative_pa),
            responsiveness=MetricsPair(me=55, partner=61),
            warmth=MetricsPair(me=58, partner=64),
            repair=MetricsPair(me=46, partner=52),
            balance_index=57,
        )
        if req.options.wantMetrics
        else None
    )

    liking = mock_liking(req, metrics_obj)
    timeline = mock_timeline(req)

    return AnalyzeResponse(
        summary_1line="전반적으로 대화는 안정적이지만, 특정 구간에서 오해 소지가 있는 표현이 관측됨.",
        confidence="medium",
        highlights=(
            [
                Highlight(
                    type="green",
                    message_id=req.messages[0].id,
                    reason="대화를 시작하며 상황을 공유함",
                ),
                Highlight(
                    type="red",
                    message_id=req.messages[-1].id,
                    reason="마지막 표현이 차갑게 느껴질 수 있음",
                ),
            ]
            if req.options.wantHighlights
            else []
        ),
        metrics=metrics_obj,
        liking_index=liking,
        timeline_points=timeline,
    )


def enforce_timeline_size(points: list) -> list:
    if not isinstance(points, list):
        return []
    if len(points) > MAX_TIMELINE_POINTS:
        return points[:MAX_TIMELINE_POINTS]
    return points


def openai_analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    if not openai_client or not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not set on server")

    transcript = build_transcript(req)
    want_metrics = req.options.wantMetrics
    want_highlights = req.options.wantHighlights

    system = (
        "You are a relationship conversation analyst.\n"
        "Return ONLY valid JSON that matches the provided schema.\n"
        "Do not include extra keys.\n"
        "Use message_id values that exist in the transcript.\n"
        "If language is ko, all strings must be in Korean.\n"
        "If uncertain, lower confidence.\n"
    )

    user = f"""
Language: {req.options.language}

Constraints:
- wantMetrics={str(want_metrics).lower()}
- wantHighlights={str(want_highlights).lower()}

Output requirements:
1) summary_1line: 한 줄 인사이트(간결).
2) confidence: low/medium/high (전체 분석 신뢰도).
3) metrics:
   - wantMetrics=false 이면 metrics=null
   - wantMetrics=true 이면 각 항목 0~100 정수로 채움
4) highlights:
   - wantHighlights=false 이면 []
   - wantHighlights=true 이면 3~8개, message_id는 transcript에 있는 값만 사용
5) liking_index:
   - score: 0~100 정수
   - 기준: 50=비슷함, score>50이면 "내가 더 좋아하는 쪽", score<50이면 "상대가 더 좋아하는 쪽"
   - winner: me/partner/tie (tie는 score가 46~54 사이면 사용)
   - rationale_1line: 점수 판단 근거를 1줄로(구체적인 패턴 언급: 공감, 질문, 애정표현, 주도권, 회복 시도 등)
   - confidence: low/medium/high
   - 절대 단정적으로 "사랑한다/안한다" 같은 표현은 피하고, 대화 패턴 기반으로만 설명
   - 표본이 적거나 감정 신호가 약하면 confidence를 낮춰라
6) timeline_points:
   - 목적: 대화 흐름을 시각화하기 위한 타임라인.
   - 길이: 60~200개 사이.
   - 선택 방식: 전체 메시지에서 균등 샘플링 + 갈등/회복 구간은 조금 더 포함.
   - 각 포인트는 transcript의 message_id를 사용.
   - i는 0부터 시작하는 순서 인덱스(시간 대신).
   - mood/tension/repair는 0~100 정수.
   - mood는 따뜻함/긍정(높을수록 좋음), tension은 갈등/방어(높을수록 나쁨), repair는 사과/공감/정리 같은 회복 시도(높을수록 좋음).

Conversation (each line includes message_id):
{transcript}
""".strip()

    try:
        r = openai_client.responses.create(
            model=OPENAI_MODEL,
            input=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            text={
                "format": {
                    "type": "json_schema",
                    "name": "couple_chat_analysis",
                    "schema": ANALYZE_SCHEMA,
                    "strict": True,
                }
            },
            store=False,
        )

        out = r.output_text
        data = json.loads(out)

        # 옵션 강제 정합성
        if not want_metrics:
            data["metrics"] = None
        if not want_highlights:
            data["highlights"] = []

        # 타임라인 폭주 방지
        data["timeline_points"] = enforce_timeline_size(data.get("timeline_points", []))

        return AnalyzeResponse(**data)

    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="OpenAI returned non-JSON output")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenAI error: {str(e)}")


# ---- Auth dependency: verify Firebase ID token ----
def get_current_uid(authorization: Optional[str] = Header(default=None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401, detail="Missing Authorization Bearer token"
        )

    if not FIREBASE_CRED_PATH:
        raise HTTPException(
            status_code=500, detail="FIREBASE_CRED_PATH not set on server"
        )

    token = authorization.split(" ", 1)[1].strip()
    try:
        decoded = fb_auth.verify_id_token(token)
        return decoded["uid"]
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def save_analysis(
    uid: str, req: AnalyzeRequest, resp: AnalyzeResponse
) -> Optional[str]:
    if db is None:
        return None

    doc = {
        "uid": uid,
        "createdAt": datetime.now(timezone.utc),
        "options": req.options.model_dump(),
        "result": resp.model_dump(),
        "messageCount": len(req.messages),
    }
    ref = db.collection("analyses").document()
    ref.set(doc)
    return ref.id


@app.get("/health")
def health():
    return {"ok": True, "mode": ANALYSIS_MODE, "firestore": db is not None}


@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest, uid: str = Depends(get_current_uid)):
    # 최근 1000개만 분석(대화가 길면 비용/토큰 보호)
    if len(req.messages) > MAX_MESSAGES:
        req.messages = req.messages[-MAX_MESSAGES:]

    if ANALYSIS_MODE == "mock":
        resp = mock_analyze(req)
    elif ANALYSIS_MODE == "openai":
        resp = openai_analyze(req)
    else:
        raise HTTPException(
            status_code=500, detail=f"Unknown ANALYSIS_MODE: {ANALYSIS_MODE}"
        )

    _analysis_id = save_analysis(uid, req, resp)
    return resp


# ---- Character APIs ----
class SaveCharacterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    messages: List[Message] = Field(min_length=2)
    emoji: Optional[str] = "👤"


class CharacterSummary(BaseModel):
    id: str
    name: str
    messageCount: int
    createdAt: str
    emoji: str = "👤"


class CharacterDetail(BaseModel):
    id: str
    name: str
    messages: List[Message]
    createdAt: str
    emoji: str = "👤"


@app.post("/api/characters")
async def save_character(
    req: SaveCharacterRequest, uid: str = Depends(get_current_uid)
):
    """캐릭터(대화 템플릿) 저장"""
    if db is None:
        raise HTTPException(status_code=500, detail="Firestore not configured")

    doc = {
        "uid": uid,
        "name": req.name,
        "messages": [m.model_dump() for m in req.messages],
        "messageCount": len(req.messages),
        "emoji": req.emoji or "👤",
        "createdAt": datetime.now(timezone.utc),
    }

    ref = db.collection("characters").document()
    ref.set(doc)

    return {
        "id": ref.id,
        "name": req.name,
        "messageCount": len(req.messages),
        "emoji": req.emoji,
    }


@app.get("/api/characters", response_model=List[CharacterSummary])
async def list_characters(uid: str = Depends(get_current_uid)):
    """사용자의 저장된 캐릭터 목록 조회"""
    if db is None:
        raise HTTPException(status_code=500, detail="Firestore not configured")

    try:
        # order_by 없이 조회 (복합 인덱스 불필요)
        docs = db.collection("characters").where("uid", "==", uid).limit(50).stream()

        results = []
        for doc in docs:
            data = doc.to_dict()
            created_at = data.get("createdAt")

            # datetime 객체를 문자열로 변환
            if created_at:
                if hasattr(created_at, "isoformat"):
                    created_at_str = created_at.isoformat()
                else:
                    created_at_str = str(created_at)
            else:
                created_at_str = datetime.now(timezone.utc).isoformat()

            results.append(
                CharacterSummary(
                    id=doc.id,
                    name=data.get("name", "Untitled"),
                    messageCount=data.get("messageCount", 0),
                    emoji=data.get("emoji", "👤"),
                    createdAt=created_at_str,
                )
            )

        # 클라이언트 측에서 정렬 (최신순)
        results.sort(key=lambda x: x.createdAt, reverse=True)
        return results
    except Exception as e:
        # 디버깅을 위한 에러 로그
        print(f"Error loading characters: {e}")
        raise HTTPException(
            status_code=500, detail=f"Failed to load characters: {str(e)}"
        )


@app.get("/api/characters/{character_id}", response_model=CharacterDetail)
async def get_character(character_id: str, uid: str = Depends(get_current_uid)):
    """특정 캐릭터 상세 조회"""
    if db is None:
        raise HTTPException(status_code=500, detail="Firestore not configured")

    try:
        doc_ref = db.collection("characters").document(character_id)
        doc = doc_ref.get()

        if not doc.exists:
            raise HTTPException(status_code=404, detail="Character not found")

        data = doc.to_dict()
        if data.get("uid") != uid:
            raise HTTPException(status_code=403, detail="Not authorized")

        messages = [Message(**m) for m in data.get("messages", [])]

        # datetime 처리
        created_at = data.get("createdAt")
        if created_at:
            if hasattr(created_at, "isoformat"):
                created_at_str = created_at.isoformat()
            else:
                created_at_str = str(created_at)
        else:
            created_at_str = datetime.now(timezone.utc).isoformat()

        return CharacterDetail(
            id=doc.id,
            name=data.get("name", "Untitled"),
            messages=messages,
            emoji=data.get("emoji", "👤"),
            createdAt=created_at_str,
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error loading character {character_id}: {e}")
        raise HTTPException(
            status_code=500, detail=f"Failed to load character: {str(e)}"
        )


@app.delete("/api/characters/{character_id}")
async def delete_character(character_id: str, uid: str = Depends(get_current_uid)):
    """캐릭터 삭제"""
    if db is None:
        raise HTTPException(status_code=500, detail="Firestore not configured")

    doc_ref = db.collection("characters").document(character_id)
    doc = doc_ref.get()

    if not doc.exists:
        raise HTTPException(status_code=404, detail="Character not found")

    data = doc.to_dict()
    if data.get("uid") != uid:
        raise HTTPException(status_code=403, detail="Not authorized")

    doc_ref.delete()
    return {"ok": True}
