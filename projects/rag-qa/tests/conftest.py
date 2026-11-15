"""
Deterministic stand-ins so the tests need no network and no API key:

- HashingEmbeddings: a bag-of-words vector, so texts that share words are close together.
- RecordingChatModel: returns a canned reply and remembers the prompt it was given.

Qdrant itself is real: the client runs in its embedded in-memory mode.
"""

import hashlib
import math
import re

import pytest
from fastapi.testclient import TestClient
from langchain_core.embeddings import Embeddings
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda
from qdrant_client import QdrantClient

from app.main import app, get_pipeline
from app.rag import RagPipeline

STOPWORDS = {"a", "an", "and", "are", "does", "do", "how", "in", "is", "it", "of", "on", "the", "to", "what", "when", "why"}

KAFKA_DOC = (
    "Kafka consumer groups let several consumers share the work of reading a topic. "
    "Each partition is assigned to exactly one consumer in the group. "
    "When a consumer joins or leaves, the group coordinator triggers a rebalance and "
    "partitions are reassigned. Offsets are committed so a consumer can resume where it stopped."
)
BREAD_DOC = (
    "Sourdough bread needs a starter of flour and water that ferments for several days. "
    "The dough is folded, proofed overnight in the fridge and baked in a hot dutch oven. "
    "Steam during the first twenty minutes gives the loaf its crisp crust."
)


class HashingEmbeddings(Embeddings):
    dimensions = 256

    def _embed(self, text: str) -> list[float]:
        vector = [0.0] * self.dimensions
        for token in re.findall(r"[a-z0-9]+", text.lower()):
            if token in STOPWORDS:
                continue
            bucket = int(hashlib.md5(token.encode()).hexdigest(), 16) % self.dimensions
            vector[bucket] += 1.0
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(text) for text in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)


class RecordingChatModel:
    def __init__(self, reply: str = "Each partition goes to exactly one consumer in the group [1].") -> None:
        self.reply = reply
        self.prompts: list[str] = []

    def as_runnable(self) -> RunnableLambda:
        def respond(prompt_value) -> AIMessage:
            self.prompts.append("\n".join(str(message.content) for message in prompt_value.to_messages()))
            return AIMessage(content=self.reply)

        return RunnableLambda(respond)


@pytest.fixture
def chat_model() -> RecordingChatModel:
    return RecordingChatModel()


@pytest.fixture
def pipeline(chat_model: RecordingChatModel) -> RagPipeline:
    return RagPipeline(
        embeddings=HashingEmbeddings(),
        chat_model=chat_model.as_runnable(),
        client=QdrantClient(":memory:"),
        chunk_size=200,
        chunk_overlap=40,
        min_score=0.15,
    )


@pytest.fixture
def client(pipeline: RagPipeline):
    app.dependency_overrides[get_pipeline] = lambda: pipeline
    yield TestClient(app)
    app.dependency_overrides.clear()
