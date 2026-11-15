from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read from environment variables or a local .env file."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str = ""
    chat_model: str = "gpt-4o-mini"
    embedding_model: str = "text-embedding-3-small"

    # Leave empty to run Qdrant embedded in the process (nothing to install, data is not kept).
    qdrant_url: str = ""
    qdrant_api_key: str = ""
    collection: str = "documents"

    chunk_size: int = 800
    chunk_overlap: int = 120
    top_k: int = 4
    min_score: float = 0.25

    cors_origins: str = "http://localhost:5173"


@lru_cache
def get_settings() -> Settings:
    return Settings()
