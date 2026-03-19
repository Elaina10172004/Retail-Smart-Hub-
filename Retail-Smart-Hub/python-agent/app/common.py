from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

AGENT_SHARED_KEY_FILE_NAME = "agent-shared-key.txt"


def _read_text_trimmed(path: Path) -> str:
    try:
        value = path.read_text(encoding="utf-8", errors="ignore").strip()
        return value or ""
    except Exception:
        return ""


def _ensure_agent_shared_key() -> str:
    env_key = (os.getenv("AI_AGENT_SHARED_KEY") or "").strip()
    if env_key:
        return env_key

    data_root = Path(os.getenv("RETAIL_SMART_HUB_DATA_DIR", str(Path.cwd() / "database"))).resolve()
    key_path = data_root / AGENT_SHARED_KEY_FILE_NAME
    existing = _read_text_trimmed(key_path)
    if existing:
        os.environ["AI_AGENT_SHARED_KEY"] = existing
        return existing

    ensure_parent(key_path)
    generated = secrets.token_hex(32)
    try:
        # Exclusive create when possible; fall back to reading if another process won the race.
        with open(key_path, "x", encoding="utf-8") as handle:
            handle.write(generated + "\n")
    except FileExistsError:
        existing = _read_text_trimmed(key_path)
        if existing:
            os.environ["AI_AGENT_SHARED_KEY"] = existing
            return existing
        raise

    os.environ["AI_AGENT_SHARED_KEY"] = generated
    return generated


def _ensure_node_internal_key() -> str:
    env_key = (os.getenv("NODE_INTERNAL_AGENT_KEY") or "").strip()
    if env_key:
        return env_key
    return _ensure_agent_shared_key()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_bool(value: Optional[str], fallback: bool) -> bool:
    if value is None:
        return fallback
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_int(value: Optional[str], fallback: int) -> int:
    if value is None:
        return fallback
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def parse_float(value: Optional[str], fallback: float) -> float:
    if value is None:
        return fallback
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def safe_read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def hash_text(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def normalize_vector(vector: Sequence[float], dimensions: int = 0) -> List[float]:
    values = [float(v) for v in vector]
    if dimensions > 0:
        if len(values) > dimensions:
            values = values[:dimensions]
        elif len(values) < dimensions:
            values.extend([0.0] * (dimensions - len(values)))
    norm = math.sqrt(sum(v * v for v in values))
    if norm <= 1e-12:
        return values
    return [v / norm for v in values]


def cosine_similarity(vec_a: Sequence[float], vec_b: Sequence[float]) -> float:
    if not vec_a or not vec_b:
        return 0.0
    length = min(len(vec_a), len(vec_b))
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for i in range(length):
        a = float(vec_a[i])
        b = float(vec_b[i])
        dot += a * b
        norm_a += a * a
        norm_b += b * b
    if norm_a <= 1e-12 or norm_b <= 1e-12:
        return 0.0
    return dot / math.sqrt(norm_a * norm_b)


def tokenize(text: str) -> List[str]:
    if not text:
        return []
    lowered = text.lower()
    tokens = re.findall(r"[a-z0-9_]+|[\u4e00-\u9fff]{1,4}", lowered)
    return [token for token in tokens if len(token) >= 1]


def term_frequency(tokens: Sequence[str]) -> Dict[str, int]:
    result: Dict[str, int] = {}
    for token in tokens:
        result[token] = result.get(token, 0) + 1
    return result


def min_max_normalize(values: Dict[str, float]) -> Dict[str, float]:
    if not values:
        return {}
    items = list(values.items())
    all_scores = [score for _, score in items]
    lo = min(all_scores)
    hi = max(all_scores)
    if hi - lo <= 1e-9:
        return {key: 1.0 for key, _ in items}
    return {key: (score - lo) / (hi - lo) for key, score in items}


@dataclass
class AgentConfig:
    host: str = field(default_factory=lambda: os.getenv("AI_AGENT_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: parse_int(os.getenv("AI_AGENT_PORT"), 18080))
    shared_key: str = field(default_factory=_ensure_agent_shared_key)
    node_internal_base_url: str = field(
        default_factory=lambda: os.getenv(
            "NODE_INTERNAL_AGENT_BASE_URL", "http://127.0.0.1:4000/api/internal/agent"
        ).rstrip("/")
    )
    node_internal_key: str = field(default_factory=_ensure_node_internal_key)
    request_timeout_ms: int = field(
        default_factory=lambda: parse_int(os.getenv("AI_AGENT_REQUEST_TIMEOUT_MS"), 120000)
    )
    provider: str = field(default_factory=lambda: os.getenv("AI_PROVIDER", "deepseek"))
    small_provider: str = field(default_factory=lambda: os.getenv("AI_SMALL_PROVIDER", os.getenv("AI_PROVIDER", "deepseek")))
    small_base_url: str = field(default_factory=lambda: os.getenv("AI_SMALL_BASE_URL", "").rstrip("/"))
    small_model: str = field(default_factory=lambda: os.getenv("AI_SMALL_MODEL", ""))
    small_api_key: str = field(default_factory=lambda: os.getenv("AI_SMALL_API_KEY", ""))
    large_provider: str = field(default_factory=lambda: os.getenv("AI_LARGE_PROVIDER", os.getenv("AI_PROVIDER", "deepseek")))
    large_base_url: str = field(default_factory=lambda: os.getenv("AI_LARGE_BASE_URL", "").rstrip("/"))
    large_model: str = field(default_factory=lambda: os.getenv("AI_LARGE_MODEL", ""))
    large_api_key: str = field(default_factory=lambda: os.getenv("AI_LARGE_API_KEY", ""))
    deepseek_base_url: str = field(
        default_factory=lambda: os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    )
    deepseek_model: str = field(default_factory=lambda: os.getenv("DEEPSEEK_MODEL", "deepseek-chat"))
    deepseek_api_key: str = field(default_factory=lambda: os.getenv("DEEPSEEK_API_KEY", ""))
    openai_base_url: str = field(
        default_factory=lambda: os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    )
    openai_model: str = field(default_factory=lambda: os.getenv("OPENAI_MODEL", "gpt-4o-mini"))
    openai_api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", ""))
    gemini_base_url: str = field(
        default_factory=lambda: os.getenv(
            "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"
        ).rstrip("/")
    )
    gemini_model: str = field(default_factory=lambda: os.getenv("GEMINI_MODEL", "gemini-2.5-flash"))
    gemini_api_key: str = field(default_factory=lambda: os.getenv("GEMINI_API_KEY", ""))
    tavily_base_url: str = field(default_factory=lambda: os.getenv("TAVILY_BASE_URL", "https://api.tavily.com").rstrip("/"))
    tavily_api_key: str = field(default_factory=lambda: os.getenv("TAVILY_API_KEY", ""))
    tavily_topic: str = field(default_factory=lambda: os.getenv("TAVILY_TOPIC", "general").strip().lower() or "general")
    tavily_max_results: int = field(default_factory=lambda: parse_int(os.getenv("TAVILY_MAX_RESULTS"), 5))
    mock_fallback: bool = field(default_factory=lambda: parse_bool(os.getenv("AI_MOCK_FALLBACK"), False))
    data_root: Path = field(
        default_factory=lambda: Path(
            os.getenv("RETAIL_SMART_HUB_DATA_DIR", str(Path.cwd() / "database"))
        ).resolve()
    )
    rag_retrieval_mode: str = field(default_factory=lambda: os.getenv("RAG_RETRIEVAL_MODE", "hybrid"))
    rag_scope_default: str = field(default_factory=lambda: os.getenv("RAG_SCOPE_DEFAULT", "all"))
    rag_top_k: int = field(default_factory=lambda: parse_int(os.getenv("RAG_TOP_K"), 3))
    rag_candidate_k: int = field(default_factory=lambda: parse_int(os.getenv("RAG_CANDIDATE_K"), 18))
    rag_min_score: float = field(default_factory=lambda: parse_float(os.getenv("RAG_MIN_SCORE"), 0.18))
    rag_dense_weight: float = field(default_factory=lambda: parse_float(os.getenv("RAG_DENSE_WEIGHT"), 0.42))
    rag_lexical_weight: float = field(default_factory=lambda: parse_float(os.getenv("RAG_LEXICAL_WEIGHT"), 0.48))
    rag_mmr_lambda: float = field(default_factory=lambda: parse_float(os.getenv("RAG_MMR_LAMBDA"), 0.72))
    rag_recency_half_life_days: float = field(
        default_factory=lambda: parse_float(os.getenv("RAG_RECENCY_HALF_LIFE_DAYS"), 45.0)
    )
    rag_lancedb_enabled: bool = field(default_factory=lambda: parse_bool(os.getenv("RAG_LANCEDB_ENABLED"), True))
    rag_lancedb_dir: Path = field(
        default_factory=lambda: Path(os.getenv("RAG_LANCEDB_DIR", "database/rag/lancedb"))
    )
    rag_lancedb_table: str = field(default_factory=lambda: os.getenv("RAG_LANCEDB_TABLE", "knowledge_chunks"))
    rag_embedding_provider: str = field(
        default_factory=lambda: os.getenv("RAG_EMBEDDING_PROVIDER", "openai").strip().lower()
    )
    rag_embedding_base_url: str = field(
        default_factory=lambda: os.getenv("RAG_EMBEDDING_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    )
    rag_embedding_api_key: str = field(default_factory=lambda: os.getenv("RAG_EMBEDDING_API_KEY", ""))
    rag_embedding_model: str = field(default_factory=lambda: os.getenv("RAG_EMBEDDING_MODEL", ""))
    rag_embedding_batch_size: int = field(
        default_factory=lambda: parse_int(os.getenv("RAG_EMBEDDING_BATCH_SIZE"), 24)
    )
    rag_embedding_dimensions: int = field(
        default_factory=lambda: parse_int(os.getenv("RAG_EMBEDDING_DIMENSIONS"), 0)
    )
    rag_vector_candidate_k: int = field(
        default_factory=lambda: parse_int(os.getenv("RAG_VECTOR_CANDIDATE_K"), 32)
    )
    rag_fts_candidate_k: int = field(default_factory=lambda: parse_int(os.getenv("RAG_FTS_CANDIDATE_K"), 32))
    rag_rerank_enabled: bool = field(default_factory=lambda: parse_bool(os.getenv("RAG_RERANK_ENABLED"), True))
    rag_rerank_provider: str = field(
        default_factory=lambda: os.getenv("RAG_RERANK_PROVIDER", "heuristic").strip().lower()
    )
    rag_rerank_base_url: str = field(default_factory=lambda: os.getenv("RAG_RERANK_BASE_URL", "").rstrip("/"))
    rag_rerank_api_key: str = field(default_factory=lambda: os.getenv("RAG_RERANK_API_KEY", ""))
    rag_rerank_model: str = field(default_factory=lambda: os.getenv("RAG_RERANK_MODEL", ""))
    rag_rerank_top_n: int = field(default_factory=lambda: parse_int(os.getenv("RAG_RERANK_TOP_N"), 20))
    rag_adaptive_retrieve_enabled: bool = field(
        default_factory=lambda: parse_bool(os.getenv("RAG_ADAPTIVE_RETRIEVE_ENABLED"), True)
    )
    rag_memory_enabled: bool = field(default_factory=lambda: parse_bool(os.getenv("RAG_MEMORY_ENABLED"), True))
    rag_memory_retention_days: int = field(
        default_factory=lambda: parse_int(os.getenv("RAG_MEMORY_RETENTION_DAYS"), 60)
    )
    ai_layered_agent_enabled: bool = field(
        default_factory=lambda: parse_bool(os.getenv("AI_LAYERED_AGENT_ENABLED"), True)
    )
    ai_layered_max_execute_rounds: int = field(
        default_factory=lambda: parse_int(os.getenv("AI_LAYERED_MAX_EXECUTE_ROUNDS"), 2)
    )
    ai_layered_context_char_budget: int = field(
        default_factory=lambda: parse_int(os.getenv("AI_LAYERED_CONTEXT_CHAR_BUDGET"), 12000)
    )
    ai_layered_web_fallback_max_rounds: int = field(
        default_factory=lambda: parse_int(os.getenv("AI_LAYERED_WEB_FALLBACK_MAX_ROUNDS"), 1)
    )
    ai_layered_console_log: bool = field(
        default_factory=lambda: parse_bool(os.getenv("AI_LAYERED_CONSOLE_LOG"), True)
    )
    ai_layered_console_log_max_chars: int = field(
        default_factory=lambda: parse_int(os.getenv("AI_LAYERED_CONSOLE_LOG_MAX_CHARS"), 1200)
    )
    ai_model_io_console_log: bool = field(
        default_factory=lambda: parse_bool(os.getenv("AI_MODEL_IO_CONSOLE_LOG"), True)
    )
    ai_model_io_console_log_max_chars: int = field(
        default_factory=lambda: parse_int(os.getenv("AI_MODEL_IO_CONSOLE_LOG_MAX_CHARS"), 0)
    )

    def __post_init__(self) -> None:
        if not self.rag_lancedb_dir.is_absolute():
            self.rag_lancedb_dir = (Path.cwd() / self.rag_lancedb_dir).resolve()
        self.data_root.mkdir(parents=True, exist_ok=True)
        (self.data_root / "rag").mkdir(parents=True, exist_ok=True)
        self.rag_lancedb_dir.mkdir(parents=True, exist_ok=True)

    @property
    def rag_root(self) -> Path:
        root = self.data_root / "rag"
        root.mkdir(parents=True, exist_ok=True)
        return root

    @property
    def profile_memory_path(self) -> Path:
        return self.rag_root / "profile-memory.jsonl"

    @property
    def episodic_memory_path(self) -> Path:
        return self.rag_root / "memory-store.jsonl"

    @property
    def rag_manifest_path(self) -> Path:
        return self.rag_root / "python-rag-manifest.json"

    @property
    def rag_cache_path(self) -> Path:
        return self.rag_root / "python-rag-index.json"

    def normalized_provider(self) -> str:
        normalized = str(self.large_provider or self.provider or "").strip().lower()
        if normalized == "openai":
            return "openai"
        if normalized == "gemini":
            return "gemini"
        return "deepseek"

    def _resolve_provider_defaults(self, provider: str) -> Dict[str, str]:
        normalized = str(provider or "").strip().lower()
        if normalized == "openai":
            return {
                "provider": "openai",
                "base_url": self.openai_base_url.rstrip("/"),
                "model": self.openai_model,
                "api_key": self.openai_api_key,
                "api_key_env": "OPENAI_API_KEY",
            }
        if normalized == "gemini":
            return {
                "provider": "gemini",
                "base_url": self.gemini_base_url.rstrip("/"),
                "model": self.gemini_model,
                "api_key": self.gemini_api_key,
                "api_key_env": "GEMINI_API_KEY",
            }
        return {
            "provider": "deepseek",
            "base_url": self.deepseek_base_url.rstrip("/"),
            "model": self.deepseek_model,
            "api_key": self.deepseek_api_key,
            "api_key_env": "DEEPSEEK_API_KEY",
        }

    def resolve_model_profile(self, role: str = "large") -> Dict[str, str]:
        normalized_role = "small" if str(role or "").strip().lower() == "small" else "large"
        if normalized_role == "small":
            provider_raw = self.small_provider or self.provider
            defaults = self._resolve_provider_defaults(provider_raw)
            base_url = (self.small_base_url or "").strip() or defaults["base_url"]
            model = (self.small_model or "").strip() or defaults["model"]
            api_key = (self.small_api_key or "").strip() or defaults["api_key"]
            api_key_env = "AI_SMALL_API_KEY" if (self.small_api_key or "").strip() else defaults["api_key_env"]
            return {
                "provider": defaults["provider"],
                "base_url": base_url.rstrip("/"),
                "model": model,
                "api_key": api_key,
                "api_key_env": api_key_env,
                "role": "small",
            }

        provider_raw = self.large_provider or self.provider
        defaults = self._resolve_provider_defaults(provider_raw)
        base_url = (self.large_base_url or "").strip() or defaults["base_url"]
        model = (self.large_model or "").strip() or defaults["model"]
        api_key = (self.large_api_key or "").strip() or defaults["api_key"]
        api_key_env = "AI_LARGE_API_KEY" if (self.large_api_key or "").strip() else defaults["api_key_env"]
        return {
            "provider": defaults["provider"],
            "base_url": base_url.rstrip("/"),
            "model": model,
            "api_key": api_key,
            "api_key_env": api_key_env,
            "role": "large",
        }

    def active_model(self) -> str:
        return self.resolve_model_profile("large")["model"]

    def active_api_key(self) -> str:
        return self.resolve_model_profile("large")["api_key"]

    def active_base_url(self) -> str:
        return self.resolve_model_profile("large")["base_url"]

    def active_api_key_env_name(self) -> str:
        return self.resolve_model_profile("large")["api_key_env"]

    def is_model_profile_configured(self, role: str = "large") -> bool:
        key = self.resolve_model_profile(role)["api_key"]
        return bool(key and not key.startswith("REPLACE_WITH_"))

    def is_model_configured(self) -> bool:
        return self.is_model_profile_configured("large")

    def requires_reasoning_for_tool_calls(self, role: str = "large") -> bool:
        profile = self.resolve_model_profile(role)
        return profile["provider"] == "deepseek" and profile["model"] == "deepseek-reasoner"

    def is_tavily_search_enabled(self) -> bool:
        key = (self.tavily_api_key or "").strip()
        return bool(key and not key.startswith("REPLACE_WITH_"))


def build_config() -> AgentConfig:
    return AgentConfig()
