from app.rag import NO_CONTEXT_ANSWER
from tests.conftest import BREAD_DOC, KAFKA_DOC


def test_ingest_splits_a_document_into_overlapping_chunks(pipeline):
    chunks = pipeline.ingest("kafka.md", KAFKA_DOC)

    assert chunks >= 2, "a 350-character document does not fit one 200-character chunk"
    assert pipeline.chunk_count() == chunks


def test_retrieval_finds_the_relevant_document_and_ignores_the_other(pipeline):
    pipeline.ingest("kafka.md", KAFKA_DOC)
    pipeline.ingest("bread.md", BREAD_DOC)

    sources = pipeline.retrieve("How are partitions assigned to consumers in a group?")

    assert sources, "expected at least one hit"
    assert {source.document for source in sources} == {"kafka.md"}
    assert sources == sorted(sources, key=lambda source: source.score, reverse=True)


def test_the_model_is_given_the_retrieved_passages_and_the_question(pipeline, chat_model):
    pipeline.ingest("kafka.md", KAFKA_DOC)
    pipeline.ingest("bread.md", BREAD_DOC)

    result = pipeline.ask("How are partitions assigned to consumers in a group?")

    assert result.grounded
    assert result.answer == chat_model.reply
    assert len(chat_model.prompts) == 1
    prompt = chat_model.prompts[0]
    assert "How are partitions assigned to consumers in a group?" in prompt
    assert "[1] (from kafka.md)" in prompt
    assert result.sources[0].text in prompt
    assert "Sourdough" not in prompt, "the unrelated document must not leak into the context"


def test_top_k_limits_how_many_passages_are_used(pipeline):
    pipeline.ingest("kafka.md", KAFKA_DOC)

    assert len(pipeline.retrieve("consumer group partitions rebalance offsets", top_k=1)) == 1


def test_without_relevant_context_the_model_is_not_called(pipeline, chat_model):
    pipeline.ingest("bread.md", BREAD_DOC)

    result = pipeline.ask("What is the capital of Mongolia?")

    assert not result.grounded
    assert result.answer == NO_CONTEXT_ANSWER
    assert result.sources == []
    assert chat_model.prompts == [], "no context means no model call"


def test_an_empty_index_answers_that_nothing_was_found(pipeline, chat_model):
    result = pipeline.ask("How are partitions assigned?")

    assert not result.grounded
    assert chat_model.prompts == []
