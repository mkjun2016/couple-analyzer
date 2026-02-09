from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import List, Optional, Literal

from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

import firebase_admin
from firebase_admin import credentials, firestore, auth as fb_auth

load_dotenv()

Speaker = Literal["me", "partner"]


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
    me: int
    partner: int


class Metrics(BaseModel):
    initiative: MetricsPair
    responsiveness: MetricsPair
    warmth: MetricsPair
    repair: MetricsPair
    balance_index: int


class AnalyzeResponse(BaseModel):
    summary_1line: str
    confidence: Literal["low", "medium", "high"] = "medium"
    metrics: Optional[Metrics] = None
    highlights: List[Highlight] = []


app = FastAPI(title="Couple Chat Analyzer API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ANALYSIS_MODE = os.getenv("ANALYSIS_MODE", "mock")  # "mock" | "openai"


# ---- Firebase Admin init ----
FIREBASE_CRED_PATH = os.getenv("FIREBASE_CRED_PATH")

db = None
if FIREBASE_CRED_PATH:
    cred = credentials.Certificate(FIREBASE_CRED_PATH)
    firebase_admin.initialize_app(cred)
    db = firestore.client()
else:
    # 로컬에서 DB 없이도 mock 동작하게 두고 싶으면 그대로 두면 됨
    db = None


def mock_analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    me_count = sum(1 for m in req.messages if m.speaker == "me")
    pa_count = sum(1 for m in req.messages if m.speaker == "partner")
    total = me_count + pa_count

    initiative_me = int(round(100 * (me_count / total))) if total else 50
    initiative_pa = 100 - initiative_me

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
        metrics=(
            Metrics(
                initiative=MetricsPair(me=initiative_me, partner=initiative_pa),
                responsiveness=MetricsPair(me=55, partner=61),
                warmth=MetricsPair(me=58, partner=64),
                repair=MetricsPair(me=46, partner=52),
                balance_index=57,
            )
            if req.options.wantMetrics
            else None
        ),
    )


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
    # 1) 분석
    if ANALYSIS_MODE == "mock":
        resp = mock_analyze(req)
    elif ANALYSIS_MODE == "openai":
        # TODO: 여기서 OpenAI 분석으로 교체
        resp = mock_analyze(req)
    else:
        raise HTTPException(
            status_code=500, detail=f"Unknown ANALYSIS_MODE: {ANALYSIS_MODE}"
        )

    # 2) Firestore 저장 (원문은 저장 안 함)
    analysis_id = save_analysis(uid, req, resp)

    # 필요하면 resp에 analysis_id를 포함시키도록 스키마 확장 가능
    # 지금은 UI가 그대로 동작하게 응답은 resp 그대로 반환
    return resp
