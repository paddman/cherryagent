from __future__ import annotations

import os
import re
from collections.abc import Sequence
from hmac import compare_digest
from typing import Annotated, Any, Self

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

VERSION = "0.1.0"
MAX_TEXT_CHARS = 2_000_000
MAX_BATCH_CHARS = 2_000_000
MAX_DOCUMENTS = 200
MAX_DOCUMENT_CHARS = 100_000
MIN_WORKER_TOKEN_CHARS = 24


def configured_worker_token() -> str:
    token = os.getenv("CHERRY_AI_WORKER_TOKEN", "").strip()
    if len(token) < MIN_WORKER_TOKEN_CHARS or any(ord(character) < 32 or ord(character) == 127 for character in token):
        raise HTTPException(
            status_code=503,
            detail=f"CHERRY_AI_WORKER_TOKEN must contain at least {MIN_WORKER_TOKEN_CHARS} printable characters",
        )
    return token


async def require_worker_token(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    expected = configured_worker_token()
    scheme, separator, credential = (authorization or "").partition(" ")
    if not separator or scheme.casefold() != "bearer" or not compare_digest(credential.strip(), expected):
        raise HTTPException(status_code=401, detail="Invalid AI worker bearer token")


app = FastAPI(
    title="Cherry AI Worker",
    version=VERSION,
    dependencies=[Depends(require_worker_token)],
)


class ChunkRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    max_chars: int = Field(default=1200, ge=200, le=20_000)
    overlap_chars: int = Field(default=120, ge=0, le=5_000)

    @field_validator("overlap_chars")
    @classmethod
    def validate_overlap(cls, value: int, info: Any) -> int:
        max_chars = info.data.get("max_chars", 1200)
        if value >= max_chars:
            raise ValueError("overlap_chars must be smaller than max_chars")
        return value


class TextChunk(BaseModel):
    index: int
    text: str
    start: int
    end: int


class ChunkResponse(BaseModel):
    chunks: list[TextChunk]
    characters: int


class RerankRequest(BaseModel):
    query: str = Field(min_length=1, max_length=20_000)
    documents: list[str] = Field(min_length=1, max_length=MAX_DOCUMENTS)
    top_k: int | None = Field(default=None, ge=1, le=MAX_DOCUMENTS)

    @field_validator("documents")
    @classmethod
    def validate_documents(cls, value: list[str]) -> list[str]:
        if any(not item.strip() for item in value):
            raise ValueError("documents must not contain empty text")
        if any(len(item) > MAX_DOCUMENT_CHARS for item in value):
            raise ValueError(f"each document must contain at most {MAX_DOCUMENT_CHARS} characters")
        return value

    @model_validator(mode="after")
    def validate_total_characters(self) -> Self:
        total = len(self.query) + sum(len(document) for document in self.documents)
        if total > MAX_BATCH_CHARS:
            raise ValueError(f"rerank payload exceeds {MAX_BATCH_CHARS} characters")
        return self


class RerankItem(BaseModel):
    index: int
    score: float
    preview: str


class RerankResponse(BaseModel):
    results: list[RerankItem]
    method: str


class EmbeddingRequest(BaseModel):
    input: str | list[str]
    model: str | None = None

    @field_validator("input")
    @classmethod
    def validate_input(cls, value: str | list[str]) -> str | list[str]:
        values = [value] if isinstance(value, str) else value
        if not values or len(values) > 256:
            raise ValueError("input must contain between 1 and 256 texts")
        if any(not item.strip() or len(item) > MAX_DOCUMENT_CHARS for item in values):
            raise ValueError("embedding texts must be non-empty and within the size limit")
        if sum(len(item) for item in values) > MAX_BATCH_CHARS:
            raise ValueError(f"embedding payload exceeds {MAX_BATCH_CHARS} characters")
        return value


def _boundary(text: str, start: int, hard_end: int) -> int:
    if hard_end >= len(text):
        return len(text)
    search_start = start + max(1, int((hard_end - start) * 0.65))
    candidates = [
        text.rfind("\n\n", search_start, hard_end),
        text.rfind("\n", search_start, hard_end),
        text.rfind("。", search_start, hard_end),
        text.rfind("!", search_start, hard_end),
        text.rfind("?", search_start, hard_end),
        text.rfind(". ", search_start, hard_end),
        text.rfind(" ", search_start, hard_end),
    ]
    selected = max(candidates)
    return selected + 1 if selected >= search_start else hard_end


def chunk_text(text: str, max_chars: int, overlap_chars: int) -> list[TextChunk]:
    if overlap_chars >= max_chars:
        raise ValueError("overlap_chars must be smaller than max_chars")
    chunks: list[TextChunk] = []
    start = 0
    index = 0

    while start < len(text):
        hard_end = min(len(text), start + max_chars)
        end = _boundary(text, start, hard_end)
        if end <= start:
            end = hard_end
        raw = text[start:end]
        leading = len(raw) - len(raw.lstrip())
        trailing = len(raw.rstrip())
        clean_start = start + leading
        clean_end = start + trailing
        cleaned = text[clean_start:clean_end]
        if cleaned:
            chunks.append(TextChunk(index=index, text=cleaned, start=clean_start, end=clean_end))
            index += 1
        if end >= len(text):
            break
        next_start = max(start + 1, end - overlap_chars)
        if next_start <= start:
            next_start = end
        start = next_start

    return chunks


def _normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value.casefold()).strip()


def _tokens(value: str) -> set[str]:
    return {token for token in re.findall(r"[\w\u0E00-\u0E7F]+", _normalize(value), flags=re.UNICODE) if token}


def _ngrams(value: str, size: int = 3) -> set[str]:
    compact = re.sub(r"\s+", "", _normalize(value))
    if len(compact) <= size:
        return {compact} if compact else set()
    return {compact[index : index + size] for index in range(len(compact) - size + 1)}


def _overlap(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def lexical_score(query: str, document: str) -> float:
    normalized_query = _normalize(query)
    normalized_document = _normalize(document)
    exact = 1.0 if normalized_query and normalized_query in normalized_document else 0.0
    token_score = _overlap(_tokens(query), _tokens(document))
    ngram_score = _overlap(_ngrams(query), _ngrams(document))
    prefix = 1.0 if normalized_document.startswith(normalized_query) else 0.0
    return round((0.50 * ngram_score) + (0.30 * token_score) + (0.15 * exact) + (0.05 * prefix), 6)


def rerank_documents(query: str, documents: Sequence[str], top_k: int | None = None) -> list[RerankItem]:
    ranked = [
        RerankItem(index=index, score=lexical_score(query, document), preview=document[:240])
        for index, document in enumerate(documents)
    ]
    ranked.sort(key=lambda item: (-item.score, item.index))
    return ranked[: top_k or len(ranked)]


@app.get("/health")
async def health() -> dict[str, Any]:
    embedding_base_url = os.getenv("CHERRY_AI_EMBEDDING_BASE_URL", "").strip()
    return {
        "ok": True,
        "service": "cherry-ai-worker",
        "version": VERSION,
        "authentication": "bearer",
        "embeddingConfigured": bool(embedding_base_url),
        "capabilities": ["chunk", "rerank", "embedding-proxy"],
    }


@app.post("/v1/chunk", response_model=ChunkResponse)
async def chunk(request: ChunkRequest) -> ChunkResponse:
    chunks = chunk_text(request.text, request.max_chars, request.overlap_chars)
    return ChunkResponse(chunks=chunks, characters=len(request.text))


@app.post("/v1/rerank", response_model=RerankResponse)
async def rerank(request: RerankRequest) -> RerankResponse:
    return RerankResponse(
        results=rerank_documents(request.query, request.documents, request.top_k),
        method="deterministic-token-char-ngram-v1",
    )


@app.post("/v1/embeddings")
async def embeddings(request: EmbeddingRequest) -> dict[str, Any]:
    base_url = os.getenv("CHERRY_AI_EMBEDDING_BASE_URL", "").strip().rstrip("/")
    if not base_url:
        raise HTTPException(status_code=503, detail="CHERRY_AI_EMBEDDING_BASE_URL is not configured")
    api_key = os.getenv("CHERRY_AI_EMBEDDING_API_KEY", "local")
    model = os.getenv("CHERRY_AI_EMBEDDING_MODEL", "").strip()
    if not model:
        raise HTTPException(status_code=503, detail="CHERRY_AI_EMBEDDING_MODEL is not configured")
    if request.model and request.model != model:
        raise HTTPException(status_code=400, detail="Embedding model override is disabled")
    try:
        timeout_seconds = max(1.0, float(os.getenv("CHERRY_AI_EMBEDDING_TIMEOUT_SECONDS", "60")))
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="CHERRY_AI_EMBEDDING_TIMEOUT_SECONDS must be numeric") from exc

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(
                f"{base_url}/embeddings",
                headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
                json={"model": model, "input": request.input},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Embedding provider request failed: {exc}") from exc

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"Embedding provider returned non-JSON HTTP {response.status_code}") from exc
    if response.is_error:
        error_payload = payload.get("error") if isinstance(payload, dict) else None
        detail = error_payload.get("message") if isinstance(error_payload, dict) else None
        raise HTTPException(status_code=response.status_code, detail=detail or "Embedding provider returned an error")
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise HTTPException(status_code=502, detail="Embedding provider response is missing data")
    return payload
