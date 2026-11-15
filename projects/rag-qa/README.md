# RAG-Based Q&A System

Ask questions about your own documents and get answers that are grounded in them, with the
source passages attached. FastAPI, LangChain, Qdrant and an OpenAI model, plus a small React
frontend.

**Live demo of the retrieval step:** https://mahesh741.github.io/demos/rag-qa/

```
ingest:  document ─► split into overlapping chunks ─► embed ─► Qdrant
ask:     question ─► embed ─► nearest chunks ─► prompt with numbered context ─► LLM ─► answer + sources
                                    │
                                    └─ nothing above the score floor ─► "not found", model is not called
```

## Design decisions

- **Answers come only from retrieved context.** The prompt numbers each passage and tells the
  model to cite them and to say it does not know when they do not contain the answer.
- **No relevant context, no model call.** If no chunk clears the similarity floor, the API returns
  a fixed "not found" answer with `grounded: false`. That avoids a guessed answer and its cost.
- **Dependencies are injected.** `RagPipeline` takes the embeddings, chat model and Qdrant client as
  arguments. Production wires OpenAI and a Qdrant server; the tests wire deterministic stand-ins.
- **Sources are part of the response.** Every answer carries the document, chunk, score and text it
  was built from, so a reader can check it.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/documents` | Index a document: `{"title": "...", "text": "..."}` |
| `POST` | `/documents/upload` | Index a UTF-8 text or Markdown file (up to 2 MB) |
| `GET` | `/documents/stats` | Number of chunks in the index |
| `POST` | `/ask` | `{"question": "...", "top_k": 4}` returns `answer`, `grounded`, `sources` |
| `GET` | `/health` | Liveness check |

## Run the tests

No API key or network is needed: the tests use a bag-of-words embedding and a recording chat
model, with Qdrant running embedded in memory.

```bash
pip install -r requirements-dev.txt
```

```bash
pytest
```

Eleven tests cover chunking, retrieval ranking, that the model receives exactly the retrieved
passages, the `top_k` limit, the no-context path (the model must not be called), file upload and
request validation.

## Run it

Requires an OpenAI API key.

```bash
cp .env.example .env
```

```bash
docker compose up --build
```

```bash
curl -X POST localhost:8000/documents -H 'Content-Type: application/json' -d '{"title":"notes","text":"Kafka assigns each partition to exactly one consumer in a group."}'
```

```bash
curl -X POST localhost:8000/ask -H 'Content-Type: application/json' -d '{"question":"How are partitions assigned?"}'
```

The frontend, in `frontend/`:

```bash
npm install
```

```bash
npm run dev
```

## What is and is not verified

The pipeline logic, the API and the Qdrant integration are covered by the tests. The calls to
OpenAI are the one part the tests replace, so the first real run needs a valid key.
