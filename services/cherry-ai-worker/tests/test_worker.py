from fastapi.testclient import TestClient

from app.main import app, chunk_text, lexical_score, rerank_documents

WORKER_TOKEN = "test-worker-token-0123456789abcdef"


def test_chunk_text_respects_limits_and_overlap() -> None:
    text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"
    chunks = chunk_text(text, max_chars=24, overlap_chars=5)
    assert len(chunks) >= 3
    assert all(0 < len(chunk.text) <= 24 for chunk in chunks)
    assert chunks[0].start == 0
    assert chunks[-1].end == len(text)
    assert all(chunks[index].start < chunks[index - 1].end for index in range(1, len(chunks)))


def test_rerank_prefers_relevant_thai_document() -> None:
    documents = [
        "คู่มือทำอาหารและรายการวัตถุดิบ",
        "ตรวจสอบพื้นที่ดิสก์ Linux ด้วยระบบมอนิเตอร์",
        "รายงานยอดขายประจำเดือน",
    ]
    ranked = rerank_documents("ตรวจ disk linux", documents, top_k=2)
    assert ranked[0].index == 1
    assert ranked[0].score > ranked[1].score


def test_lexical_score_is_deterministic() -> None:
    first = lexical_score("model fallback", "model fallback with bounded retries")
    second = lexical_score("model fallback", "model fallback with bounded retries")
    assert first == second
    assert 0 < first <= 1


def test_worker_rejects_missing_and_invalid_tokens(monkeypatch) -> None:
    client = TestClient(app)
    monkeypatch.delenv("CHERRY_AI_WORKER_TOKEN", raising=False)
    assert client.get("/health").status_code == 503

    monkeypatch.setenv("CHERRY_AI_WORKER_TOKEN", WORKER_TOKEN)
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"authorization": "Bearer wrong-token"}).status_code == 401

    response = client.get("/health", headers={"authorization": f"Bearer {WORKER_TOKEN}"})
    assert response.status_code == 200
    assert response.json()["authentication"] == "bearer"
