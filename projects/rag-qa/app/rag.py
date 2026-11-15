"""The retrieval-augmented generation pipeline: ingest documents, then answer from them."""

from __future__ import annotations

from dataclasses import dataclass, field

from langchain_core.embeddings import Embeddings
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import Runnable
from langchain_qdrant import QdrantVectorStore
from langchain_text_splitters import RecursiveCharacterTextSplitter
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams

NO_CONTEXT_ANSWER = "I could not find anything about that in the indexed documents."

PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You answer questions using only the numbered context passages below. "
            "Cite the passages you used like [1] or [2]. "
            "If the passages do not contain the answer, say you do not know. "
            "Do not use outside knowledge.\n\nContext:\n{context}",
        ),
        ("human", "{question}"),
    ]
)


@dataclass(frozen=True)
class Source:
    document: str
    chunk: int
    score: float
    text: str


@dataclass(frozen=True)
class Answer:
    answer: str
    sources: list[Source] = field(default_factory=list)
    grounded: bool = True


class RagPipeline:
    """
    Ingest: split a document into overlapping chunks, embed them, store them in Qdrant.
    Ask: embed the question, fetch the nearest chunks, and have the chat model answer
    from those chunks only.

    The embeddings, chat model and Qdrant client are passed in, so production uses OpenAI
    and a Qdrant server while the tests use small deterministic stand-ins.
    """

    def __init__(
        self,
        embeddings: Embeddings,
        chat_model: Runnable,
        client: QdrantClient,
        collection: str = "documents",
        chunk_size: int = 800,
        chunk_overlap: int = 120,
        min_score: float = 0.25,
    ) -> None:
        self._client = client
        self._collection = collection
        self._min_score = min_score

        if not client.collection_exists(collection):
            dimensions = len(embeddings.embed_query("dimension probe"))
            client.create_collection(
                collection_name=collection,
                vectors_config=VectorParams(size=dimensions, distance=Distance.COSINE),
            )
        self._store = QdrantVectorStore(client=client, collection_name=collection, embedding=embeddings)
        self._splitter = RecursiveCharacterTextSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
        self._chain = PROMPT | chat_model | StrOutputParser()

    def ingest(self, title: str, text: str) -> int:
        """Index one document. Returns the number of chunks stored."""
        chunks = self._splitter.split_text(text)
        if not chunks:
            return 0
        metadata = [{"document": title, "chunk": index} for index in range(len(chunks))]
        self._store.add_texts(chunks, metadatas=metadata)
        return len(chunks)

    def retrieve(self, question: str, top_k: int = 4) -> list[Source]:
        """The chunks most similar to the question, best first, above the score floor."""
        hits = self._store.similarity_search_with_score(question, k=top_k)
        return [
            Source(
                document=doc.metadata.get("document", "untitled"),
                chunk=doc.metadata.get("chunk", 0),
                score=round(float(score), 4),
                text=doc.page_content,
            )
            for doc, score in hits
            if score >= self._min_score
        ]

    def ask(self, question: str, top_k: int = 4) -> Answer:
        sources = self.retrieve(question, top_k)
        if not sources:
            # Nothing relevant was retrieved, so there is nothing to ground an answer in.
            # Returning early avoids paying for a model call that could only guess.
            return Answer(answer=NO_CONTEXT_ANSWER, sources=[], grounded=False)

        context = "\n\n".join(
            f"[{number}] (from {source.document})\n{source.text}" for number, source in enumerate(sources, start=1)
        )
        answer = self._chain.invoke({"context": context, "question": question})
        return Answer(answer=answer, sources=sources)

    def chunk_count(self) -> int:
        return self._client.count(collection_name=self._collection, exact=True).count
