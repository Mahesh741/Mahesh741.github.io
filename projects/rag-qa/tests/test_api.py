from tests.conftest import KAFKA_DOC


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_ingest_then_ask_returns_an_answer_with_its_sources(client):
    created = client.post("/documents", json={"title": "kafka.md", "text": KAFKA_DOC})
    assert created.status_code == 201
    assert created.json()["chunks"] >= 2

    response = client.post("/ask", json={"question": "How are partitions assigned to consumers?", "top_k": 2})

    assert response.status_code == 200
    body = response.json()
    assert body["grounded"] is True
    assert "[1]" in body["answer"]
    assert 1 <= len(body["sources"]) <= 2
    assert body["sources"][0]["document"] == "kafka.md"
    assert 0 < body["sources"][0]["score"] <= 1


def test_upload_accepts_a_text_file(client):
    response = client.post("/documents/upload", files={"file": ("notes.txt", KAFKA_DOC.encode(), "text/plain")})

    assert response.status_code == 201
    assert response.json()["title"] == "notes.txt"
    assert client.get("/documents/stats").json()["chunks"] == response.json()["chunks"]


def test_upload_rejects_binary_files(client):
    response = client.post("/documents/upload", files={"file": ("image.png", b"\x89PNG\xff\xfe\x00", "image/png")})

    assert response.status_code == 415


def test_invalid_requests_are_rejected(client):
    assert client.post("/ask", json={"question": "", "top_k": 4}).status_code == 422
    assert client.post("/ask", json={"question": "valid question", "top_k": 50}).status_code == 422
    assert client.post("/documents", json={"title": "", "text": ""}).status_code == 422
