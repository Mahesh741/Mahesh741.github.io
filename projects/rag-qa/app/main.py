from __future__ import annotations

from functools import lru_cache

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.config import get_settings
from app.rag import RagPipeline

MAX_UPLOAD_BYTES = 2 * 1024 * 1024


class DocumentIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=500_000)


class DocumentOut(BaseModel):
    title: str
    chunks: int


class QuestionIn(BaseModel):
    question: str = Field(min_length=3, max_length=1_000)
    top_k: int = Field(default=4, ge=1, le=10)


class SourceOut(BaseModel):
    document: str
    chunk: int
    score: float
    text: str


class AnswerOut(BaseModel):
    answer: str
    grounded: bool
    sources: list[SourceOut]


@lru_cache
def get_pipeline() -> RagPipeline:
    """Build the production pipeline once: OpenAI models and Qdrant."""
    from langchain_openai import ChatOpenAI, OpenAIEmbeddings
    from qdrant_client import QdrantClient

    settings = get_settings()
    if not settings.openai_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "OPENAI_API_KEY is not configured")

    client = (
        QdrantClient(url=settings.qdrant_url, api_key=settings.qdrant_api_key or None)
        if settings.qdrant_url
        else QdrantClient(":memory:")
    )
    return RagPipeline(
        embeddings=OpenAIEmbeddings(model=settings.embedding_model, api_key=settings.openai_api_key),
        chat_model=ChatOpenAI(model=settings.chat_model, temperature=0, api_key=settings.openai_api_key),
        client=client,
        collection=settings.collection,
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        min_score=settings.min_score,
    )


app = FastAPI(title="RAG Q&A", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in get_settings().cors_origins.split(",") if origin.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/documents", response_model=DocumentOut, status_code=status.HTTP_201_CREATED)
def add_document(document: DocumentIn, pipeline: RagPipeline = Depends(get_pipeline)) -> DocumentOut:
    chunks = pipeline.ingest(document.title, document.text)
    return DocumentOut(title=document.title, chunks=chunks)


@app.post("/documents/upload", response_model=DocumentOut, status_code=status.HTTP_201_CREATED)
async def upload_document(file: UploadFile = File(...), pipeline: RagPipeline = Depends(get_pipeline)) -> DocumentOut:
    """Accepts a plain-text or Markdown file."""
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "file is larger than 2 MB")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "file must be UTF-8 text") from error
    if not text.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "file is empty")
    title = file.filename or "upload"
    return DocumentOut(title=title, chunks=pipeline.ingest(title, text))


@app.get("/documents/stats")
def stats(pipeline: RagPipeline = Depends(get_pipeline)) -> dict[str, int]:
    return {"chunks": pipeline.chunk_count()}


@app.post("/ask", response_model=AnswerOut)
def ask(question: QuestionIn, pipeline: RagPipeline = Depends(get_pipeline)) -> AnswerOut:
    result = pipeline.ask(question.question, question.top_k)
    return AnswerOut(
        answer=result.answer,
        grounded=result.grounded,
        sources=[SourceOut(**source.__dict__) for source in result.sources],
    )
