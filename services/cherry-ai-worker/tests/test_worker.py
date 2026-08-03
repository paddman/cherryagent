from app.main import chunk_text, lexical_score, rerank_documents


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
