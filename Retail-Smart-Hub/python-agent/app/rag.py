from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import httpx

from .common import (
    AgentConfig,
    clamp,
    cosine_similarity,
    ensure_parent,
    hash_text,
    json_dumps,
    min_max_normalize,
    normalize_vector,
    now_iso,
    safe_read_text,
    term_frequency,
    tokenize,
)
from .memory import EpisodicMemoryStore
from .rag_document_utils import (
    discover_documents,
    infer_module_id,
    infer_source_type,
    split_long_text,
)

@dataclass
class IndexedChunk:
    id: str
    doc_id: str
    file_name: str
    doc_title: str
    section_title: str
    module_id: str
    source_type: str
    scope_type: str
    scope_id: Optional[str]
    updated_at: str
    updated_at_ts: float
    content: str
    citation: str
    keywords: List[str]
    token_freq: Dict[str, int]
    token_set: set[str]
    body_len: int
    vector: List[float] = field(default_factory=list)


class EmbeddingClient:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.cache: Dict[str, List[float]] = {}
        self.lock = Lock()
        self.last_error: str = ""

    def enabled(self) -> bool:
        if not self.config.rag_embedding_model.strip():
            return False
        provider = self.config.rag_embedding_provider
        if provider == "ollama":
            return bool(self.config.rag_embedding_base_url)
        return bool(self.config.rag_embedding_base_url) and bool(
            self.config.rag_embedding_api_key or self.config.active_api_key()
        )

    def _cache_key(self, text: str) -> str:
        return f"{self.config.rag_embedding_provider}:{self.config.rag_embedding_model}:{hash_text(text)}"

    async def embed_texts(self, texts: Sequence[str]) -> List[List[float]]:
        if not texts:
            return []
        if not self.enabled():
            return []

        dims = max(0, self.config.rag_embedding_dimensions)
        result: List[Optional[List[float]]] = [None] * len(texts)
        pending_indexes: List[int] = []
        pending_texts: List[str] = []
        with self.lock:
            for idx, text in enumerate(texts):
                key = self._cache_key(text)
                hit = self.cache.get(key)
                if hit is not None:
                    result[idx] = list(hit)
                else:
                    pending_indexes.append(idx)
                    pending_texts.append(text)

        if pending_texts:
            vectors = await self._embed_batch(pending_texts)
            for pos, vector in enumerate(vectors):
                idx = pending_indexes[pos]
                normalized = normalize_vector(vector, dims)
                result[idx] = normalized
                with self.lock:
                    self.cache[self._cache_key(texts[idx])] = normalized

        return [item if item is not None else [] for item in result]

    async def _embed_batch(self, texts: Sequence[str]) -> List[List[float]]:
        provider = self.config.rag_embedding_provider
        if provider == "ollama":
            return await self._embed_ollama(texts)
        return await self._embed_openai_compatible(texts)

    async def _embed_openai_compatible(self, texts: Sequence[str]) -> List[List[float]]:
        endpoint = f"{self.config.rag_embedding_base_url.rstrip('/')}/embeddings"
        headers = {"Content-Type": "application/json"}
        api_key = self.config.rag_embedding_api_key or self.config.active_api_key()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        payload: Dict[str, Any] = {
            "model": self.config.rag_embedding_model,
            "input": list(texts),
        }
        if self.config.rag_embedding_dimensions > 0:
            payload["dimensions"] = self.config.rag_embedding_dimensions

        timeout = max(5.0, self.config.request_timeout_ms / 1000.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(endpoint, headers=headers, json=payload)
                response.raise_for_status()
                body = response.json()
                data = body.get("data", [])
                if not isinstance(data, list):
                    raise RuntimeError("invalid embedding response: data is not list")
                vectors: List[List[float]] = []
                for item in data:
                    if isinstance(item, dict) and isinstance(item.get("embedding"), list):
                        vectors.append([float(v) for v in item["embedding"]])
                    else:
                        vectors.append([])
                self.last_error = ""
                return vectors
        except Exception as error:
            self.last_error = str(error)
            return [[] for _ in texts]

    async def _embed_ollama(self, texts: Sequence[str]) -> List[List[float]]:
        base = self.config.rag_embedding_base_url.rstrip("/")
        timeout = max(5.0, self.config.request_timeout_ms / 1000.0)
        endpoint_embed = f"{base}/api/embed"
        payload_embed = {"model": self.config.rag_embedding_model, "input": list(texts)}
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(endpoint_embed, json=payload_embed)
                response.raise_for_status()
                body = response.json()
                embeddings = body.get("embeddings")
                if isinstance(embeddings, list):
                    self.last_error = ""
                    return [[float(v) for v in vector] if isinstance(vector, list) else [] for vector in embeddings]
        except Exception as error:
            self.last_error = str(error)

        # fallback endpoint for older Ollama APIs
        vectors: List[List[float]] = []
        async with httpx.AsyncClient(timeout=timeout) as client:
            for text in texts:
                try:
                    response = await client.post(
                        f"{base}/api/embeddings",
                        json={"model": self.config.rag_embedding_model, "prompt": text},
                    )
                    response.raise_for_status()
                    body = response.json()
                    vector = body.get("embedding", [])
                    vectors.append([float(v) for v in vector] if isinstance(vector, list) else [])
                except Exception as error:
                    self.last_error = str(error)
                    vectors.append([])
        return vectors




class LanceDbStore:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.enabled = config.rag_lancedb_enabled
        self.available = False
        self.last_error = ""
        self.table_name = config.rag_lancedb_table
        self.db_path = str(config.rag_lancedb_dir)
        self.indexed_rows = 0
        self.last_sync_at = ""
        self.changed_doc_ids: List[str] = []
        self.removed_doc_ids: List[str] = []
        self._module = None
        self._db = None
        self._table = None
        self._lock = Lock()

    def _ensure_ready(self) -> bool:
        if not self.enabled:
            self.available = False
            return False
        with self._lock:
            if self._table is not None:
                return True
            try:
                import lancedb  # type: ignore

                self._module = lancedb
                self._db = lancedb.connect(self.db_path)
                self._table = self._db.open_table(self.table_name)
                self.available = True
                self.last_error = ""
                return True
            except Exception as error:
                self.last_error = str(error)
                self.available = False
                return False

    def _create_table(self, rows: List[Dict[str, Any]]) -> None:
        if not self._module or not self._db:
            raise RuntimeError("lancedb not initialized")
        if not rows:
            raise RuntimeError("cannot create LanceDB table without rows")
        try:
            self._table = self._db.create_table(self.table_name, rows)
        except Exception:
            self._table = self._db.create_table(self.table_name, rows, mode="overwrite")

    def sync(self, all_chunks: Sequence[IndexedChunk], changed_doc_ids: Sequence[str], removed_doc_ids: Sequence[str]) -> None:
        if not self.enabled:
            self.available = False
            return
        rows_by_doc: Dict[str, List[Dict[str, Any]]] = {}
        for chunk in all_chunks:
            rows_by_doc.setdefault(chunk.doc_id, []).append(
                {
                    "id": chunk.id,
                    "doc_id": chunk.doc_id,
                    "file_name": chunk.file_name,
                    "doc_title": chunk.doc_title,
                    "section_title": chunk.section_title,
                    "source_type": chunk.source_type,
                    "module_id": chunk.module_id,
                    "scope": chunk.scope_type,
                    "scope_id": chunk.scope_id,
                    "updated_at": chunk.updated_at,
                    "ts": chunk.updated_at_ts,
                    "text": chunk.content,
                    "citation": chunk.citation,
                    "keywords": chunk.keywords,
                    "metadata": json_dumps(
                        {
                            "docId": chunk.doc_id,
                            "moduleId": chunk.module_id,
                            "sourceType": chunk.source_type,
                            "scopeType": chunk.scope_type,
                            "scopeId": chunk.scope_id,
                            "updatedAt": chunk.updated_at,
                        }
                    ),
                    "vector": chunk.vector,
                }
            )

        try:
            ready = self._ensure_ready()
            if not ready:
                all_rows: List[Dict[str, Any]] = []
                for values in rows_by_doc.values():
                    all_rows.extend(values)
                if not all_rows:
                    self.indexed_rows = 0
                    return
                # create table directly if open failed because table did not exist
                import lancedb  # type: ignore

                self._module = lancedb
                self._db = lancedb.connect(self.db_path)
                self._create_table(all_rows)
                ready = True

            if not ready or self._table is None:
                return

            changed_set = set(changed_doc_ids) | set(removed_doc_ids)
            for doc_id in changed_set:
                try:
                    self._table.delete(f"doc_id = '{doc_id.replace('\"', '')}'")
                except Exception:
                    continue

            add_rows: List[Dict[str, Any]] = []
            for doc_id in changed_doc_ids:
                add_rows.extend(rows_by_doc.get(doc_id, []))

            if add_rows:
                self._table.add(add_rows)
            try:
                if hasattr(self._table, "create_fts_index"):
                    self._table.create_fts_index("text", replace=True)
            except Exception:
                pass

            try:
                count_val = self._table.count_rows() if hasattr(self._table, "count_rows") else None
                self.indexed_rows = int(count_val) if count_val is not None else len(all_chunks)
            except Exception:
                self.indexed_rows = len(all_chunks)

            self.available = True
            self.last_error = ""
            self.changed_doc_ids = list(changed_doc_ids)
            self.removed_doc_ids = list(removed_doc_ids)
            self.last_sync_at = now_iso()
        except Exception as error:
            self.available = False
            self.last_error = str(error)

    def _extract_rows(self, obj: Any) -> List[Dict[str, Any]]:
        if obj is None:
            return []
        if hasattr(obj, "to_list"):
            try:
                data = obj.to_list()
                return data if isinstance(data, list) else []
            except Exception:
                return []
        if isinstance(obj, list):
            return [item for item in obj if isinstance(item, dict)]
        return []

    def search_vector(self, query_vector: Sequence[float], limit: int) -> List[Dict[str, Any]]:
        if not query_vector:
            return []
        if not self._ensure_ready() or self._table is None:
            return []
        try:
            query = self._table.search(list(query_vector))
            if hasattr(query, "limit"):
                query = query.limit(limit)
            rows = self._extract_rows(query.to_list() if hasattr(query, "to_list") else query)
            return rows
        except Exception:
            return []

    def search_fts(self, query_text: str, limit: int) -> List[Dict[str, Any]]:
        if not query_text.strip():
            return []
        if not self._ensure_ready() or self._table is None:
            return []
        try:
            query = self._table.search(query_text)
            if hasattr(query, "query_type"):
                query = query.query_type("fts")
            if hasattr(query, "limit"):
                query = query.limit(limit)
            rows = self._extract_rows(query.to_list() if hasattr(query, "to_list") else query)
            return rows
        except Exception:
            return []


class RagEngine:
    def __init__(self, config: AgentConfig, embedding: EmbeddingClient, episodic_memory: EpisodicMemoryStore) -> None:
        self.config = config
        self.embedding = embedding
        self.episodic_memory = episodic_memory
        self.lancedb = LanceDbStore(config)
        self.index_lock = Lock()
        self.index_chunks: List[IndexedChunk] = []
        self.chunk_map: Dict[str, IndexedChunk] = {}
        self.idf_map: Dict[str, float] = {}
        self.avg_body_len: float = 1.0
        self.signature: str = ""
        self.refreshed_at: str = ""

    def _workspace(self) -> Path:
        configured = str(os.getenv("RETAIL_SMART_HUB_WORKSPACE_ROOT", "")).strip()
        if configured:
            candidate = Path(configured).resolve()
            if candidate.exists():
                return candidate
        return Path.cwd().resolve()

    def _load_manifest(self) -> Dict[str, Any]:
        path = self.config.rag_manifest_path
        if not path.exists():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                return value
        except Exception:
            pass
        return {}

    def _save_manifest(self, payload: Dict[str, Any]) -> None:
        ensure_parent(self.config.rag_manifest_path)
        self.config.rag_manifest_path.write_text(json_dumps(payload), encoding="utf-8")

    def _load_cache(self) -> bool:
        path = self.config.rag_cache_path
        if not path.exists():
            return False
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                return False
            raw_chunks = raw.get("chunks", [])
            if not isinstance(raw_chunks, list):
                return False
            chunks: List[IndexedChunk] = []
            for item in raw_chunks:
                if not isinstance(item, dict):
                    continue
                content = str(item.get("content", ""))
                tokens = tokenize(content)
                freq = term_frequency(tokens)
                token_set = set(tokens)
                chunk = IndexedChunk(
                    id=str(item.get("id", "")),
                    doc_id=str(item.get("doc_id", "")),
                    file_name=str(item.get("file_name", "")),
                    doc_title=str(item.get("doc_title", "")),
                    section_title=str(item.get("section_title", "")),
                    module_id=str(item.get("module_id", "ai")),
                    source_type=str(item.get("source_type", "project_doc")),
                    scope_type=str(item.get("scope_type", "global")),
                    scope_id=item.get("scope_id"),
                    updated_at=str(item.get("updated_at", now_iso())),
                    updated_at_ts=float(item.get("updated_at_ts", time.time())),
                    content=content,
                    citation=str(item.get("citation", "")),
                    keywords=[str(v) for v in item.get("keywords", []) if isinstance(v, str)],
                    token_freq=freq,
                    token_set=token_set,
                    body_len=max(1, len(tokens)),
                    vector=[float(v) for v in item.get("vector", []) if isinstance(v, (int, float))],
                )
                if chunk.id and chunk.content:
                    chunks.append(chunk)
            self._set_index(chunks)
            self.signature = str(raw.get("signature", ""))
            self.refreshed_at = str(raw.get("refreshedAt", now_iso()))
            return True
        except Exception:
            return False

    def _save_cache(self, chunks: Sequence[IndexedChunk]) -> None:
        serializable = []
        for chunk in chunks:
            serializable.append(
                {
                    "id": chunk.id,
                    "doc_id": chunk.doc_id,
                    "file_name": chunk.file_name,
                    "doc_title": chunk.doc_title,
                    "section_title": chunk.section_title,
                    "module_id": chunk.module_id,
                    "source_type": chunk.source_type,
                    "scope_type": chunk.scope_type,
                    "scope_id": chunk.scope_id,
                    "updated_at": chunk.updated_at,
                    "updated_at_ts": chunk.updated_at_ts,
                    "content": chunk.content,
                    "citation": chunk.citation,
                    "keywords": chunk.keywords,
                    "vector": chunk.vector,
                }
            )
        payload = {
            "signature": self.signature,
            "refreshedAt": self.refreshed_at,
            "chunks": serializable,
        }
        ensure_parent(self.config.rag_cache_path)
        self.config.rag_cache_path.write_text(json_dumps(payload), encoding="utf-8")

    def _set_index(self, chunks: Sequence[IndexedChunk]) -> None:
        self.index_chunks = list(chunks)
        self.chunk_map = {item.id: item for item in self.index_chunks}
        doc_freq: Dict[str, int] = {}
        for chunk in self.index_chunks:
            for token in chunk.token_set:
                doc_freq[token] = doc_freq.get(token, 0) + 1
        total = max(1, len(self.index_chunks))
        self.idf_map = {token: math.log((1 + total) / (1 + freq)) + 1.0 for token, freq in doc_freq.items()}
        body_lengths = [chunk.body_len for chunk in self.index_chunks]
        self.avg_body_len = float(sum(body_lengths) / max(1, len(body_lengths))) if body_lengths else 1.0

    def _memory_chunks(self) -> List[IndexedChunk]:
        records = self.episodic_memory._records()
        chunks: List[IndexedChunk] = []
        for record in records:
            content = str(record.get("content", "")).strip()
            if not content:
                continue
            updated = str(record.get("lastAccessAt") or record.get("createdAt") or now_iso())
            ts = datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp() if updated else time.time()
            tokens = tokenize(content)
            freq = term_frequency(tokens)
            chunk = IndexedChunk(
                id=str(record["id"]),
                doc_id="memory-store",
                file_name="database/rag/memory-store.jsonl",
                doc_title="Conversation Memory",
                section_title=str(record.get("title", "Memory")),
                module_id="ai",
                source_type="memory",
                scope_type="session" if record.get("sessionId") else ("tenant" if record.get("tenantId") else "user"),
                scope_id=str(record.get("sessionId") or record.get("tenantId") or record.get("userId")),
                updated_at=updated,
                updated_at_ts=ts,
                content=content,
                citation=f"memory:{record.get('userId')}/{record.get('sessionId') or record.get('tenantId') or 'user'}",
                keywords=[str(v) for v in record.get("tags", []) if isinstance(v, str)],
                token_freq=freq,
                token_set=set(tokens),
                body_len=max(1, len(tokens)),
                vector=[],
            )
            chunks.append(chunk)
        return chunks

    def _load_document_inclusion_map(self) -> Dict[str, bool]:
        settings_path = self.config.rag_root / "knowledge-document-settings.json"
        if not settings_path.exists():
            return {}
        try:
            payload = json.loads(settings_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        if not isinstance(payload, dict):
            return {}
        raw_map = payload.get("includeInAssistant")
        if not isinstance(raw_map, dict):
            return {}
        result: Dict[str, bool] = {}
        for key, value in raw_map.items():
            if not isinstance(key, str):
                continue
            normalized = key.replace("\\", "/").strip().lstrip("./")
            if not normalized:
                continue
            result[normalized] = bool(value)
        return result

    def _is_document_included(self, relative_path: str, inclusion_map: Dict[str, bool]) -> bool:
        normalized = relative_path.replace("\\", "/").strip().lstrip("./")
        if normalized in inclusion_map:
            return bool(inclusion_map[normalized])
        return normalized.startswith("docs/rag/knowledge/")

    def _doc_chunks(self) -> Tuple[List[IndexedChunk], Dict[str, str], Dict[str, str]]:
        workspace = self._workspace()
        files = discover_documents(workspace)
        inclusion_map = self._load_document_inclusion_map()
        chunks: List[IndexedChunk] = []
        signatures: Dict[str, str] = {}
        file_name_map: Dict[str, str] = {}
        for source_file in files:
            relative = str(source_file.relative_to(workspace)).replace("\\", "/")
            if not self._is_document_included(relative, inclusion_map):
                continue
            doc_id = hash_text(relative)[:16]
            text = safe_read_text(source_file)
            if not text.strip():
                continue
            stat = source_file.stat()
            signature = hash_text(f"{relative}|{int(stat.st_mtime)}|{stat.st_size}")
            signatures[doc_id] = signature
            file_name_map[doc_id] = relative
            doc_title = source_file.stem
            sections = split_long_text(text, min_len=260, max_len=900)
            for idx, section in enumerate(sections):
                section_title = f"Block {idx + 1}"
                token_list = tokenize(section)
                token_freq = term_frequency(token_list)
                chunk_id = f"{doc_id}-{idx + 1:04d}"
                updated = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")
                chunk = IndexedChunk(
                    id=chunk_id,
                    doc_id=doc_id,
                    file_name=relative,
                    doc_title=doc_title,
                    section_title=section_title,
                    module_id=infer_module_id(relative),
                    source_type=infer_source_type(relative),
                    scope_type="global",
                    scope_id=None,
                    updated_at=updated,
                    updated_at_ts=float(stat.st_mtime),
                    content=section.strip(),
                    citation=f"{relative} / {section_title}",
                    keywords=list(token_freq.keys())[:16],
                    token_freq=token_freq,
                    token_set=set(token_list),
                    body_len=max(1, len(token_list)),
                    vector=[],
                )
                chunks.append(chunk)
        return chunks, signatures, file_name_map

    async def ensure_index(self, force: bool = False, incremental: bool = True) -> None:
        with self.index_lock:
            if self.index_chunks and not force:
                return
            if not self.index_chunks and not force:
                self._load_cache()

        doc_chunks, source_signatures, file_name_map = self._doc_chunks()
        memory_chunks = self._memory_chunks()
        all_chunks = doc_chunks + memory_chunks

        if all_chunks and self.embedding.enabled():
            batch_size = max(1, min(64, self.config.rag_embedding_batch_size))
            for start in range(0, len(all_chunks), batch_size):
                batch = all_chunks[start : start + batch_size]
                vectors = await self.embedding.embed_texts([item.content for item in batch])
                for idx, vector in enumerate(vectors):
                    batch[idx].vector = normalize_vector(vector, self.config.rag_embedding_dimensions)

        manifest = self._load_manifest()
        previous_signatures = manifest.get("sourceSignatures", {}) if isinstance(manifest, dict) else {}
        changed_doc_ids = sorted(
            [
                doc_id
                for doc_id, signature in source_signatures.items()
                if force or previous_signatures.get(doc_id) != signature
            ]
        )
        removed_doc_ids = sorted(
            [doc_id for doc_id in previous_signatures.keys() if doc_id not in source_signatures]
        )
        if not changed_doc_ids and not removed_doc_ids and not force and self.index_chunks and incremental:
            changed_doc_ids = []
            removed_doc_ids = []
        elif not changed_doc_ids and not removed_doc_ids and (force or not self.index_chunks):
            changed_doc_ids = sorted(source_signatures.keys())

        signature_source = "|".join(f"{k}:{v}" for k, v in sorted(source_signatures.items()))
        signature_source += f"|memory:{len(memory_chunks)}|embed:{self.config.rag_embedding_model}"
        self.signature = hash_text(signature_source)
        self.refreshed_at = now_iso()
        self._set_index(all_chunks)

        self.lancedb.sync(all_chunks, changed_doc_ids, removed_doc_ids)
        self._save_cache(all_chunks)
        self._save_manifest(
            {
                "version": 2,
                "updatedAt": self.refreshed_at,
                "signature": self.signature,
                "sourceSignatures": source_signatures,
                "sourceFiles": file_name_map,
                "chunkCount": len(all_chunks),
                "embeddingProvider": self.config.rag_embedding_provider,
                "embeddingModel": self.config.rag_embedding_model,
                "embeddingBaseUrl": self.config.rag_embedding_base_url,
            }
        )

    def _scope_allows(
        self,
        chunk: IndexedChunk,
        scope: str,
        tenant_id: Optional[str],
        user_id: Optional[str],
        session_id: Optional[str],
    ) -> bool:
        if chunk.scope_type in {"global", "module"}:
            return True
        if scope == "global":
            return False
        if chunk.scope_type == "tenant":
            if not tenant_id:
                return False
            return chunk.scope_id == tenant_id
        if chunk.scope_type == "user":
            if not user_id:
                return False
            return chunk.scope_id == user_id
        if chunk.scope_type == "session":
            if not session_id:
                return False
            return chunk.scope_id == session_id
        return True

    def _bm25(self, chunk: IndexedChunk, query_tf: Dict[str, int]) -> float:
        k1 = 1.5
        b = 0.75
        score = 0.0
        for token, qf in query_tf.items():
            tf = float(chunk.token_freq.get(token, 0))
            if tf <= 0:
                continue
            idf = self.idf_map.get(token, 0.0)
            numerator = tf * (k1 + 1.0)
            denominator = tf + k1 * (1.0 - b + b * chunk.body_len / max(1e-6, self.avg_body_len))
            score += idf * (numerator / denominator) * max(1.0, float(qf))
        return score

    def _tfidf_dense(self, chunk: IndexedChunk, query_tf: Dict[str, int]) -> float:
        score = 0.0
        denom = 0.0
        for token, qf in query_tf.items():
            idf = self.idf_map.get(token, 0.0)
            tf = float(chunk.token_freq.get(token, 0))
            score += tf * idf * float(qf)
            denom += float(qf) * idf
        if denom <= 1e-9:
            return 0.0
        return score / (denom + 1e-9)

    def _recency(self, ts_seconds: float) -> float:
        half_life_days = max(1.0, self.config.rag_recency_half_life_days)
        half_life_seconds = half_life_days * 86400.0
        delta = max(0.0, time.time() - ts_seconds)
        return math.exp(-math.log(2.0) * delta / half_life_seconds)

    async def _remote_rerank(
        self, prompt: str, candidates: Sequence[Tuple[IndexedChunk, float]]
    ) -> Dict[str, float]:
        if not self.config.rag_rerank_enabled:
            return {}
        provider = self.config.rag_rerank_provider
        if provider == "heuristic":
            return {}
        if not self.config.rag_rerank_base_url or not self.config.rag_rerank_model:
            return {}
        docs = [chunk.content for chunk, _ in candidates[: self.config.rag_rerank_top_n]]
        if not docs:
            return {}
        endpoint = f"{self.config.rag_rerank_base_url.rstrip('/')}/v1/rerank"
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if self.config.rag_rerank_api_key:
            headers["Authorization"] = f"Bearer {self.config.rag_rerank_api_key}"
        payload = {
            "model": self.config.rag_rerank_model,
            "query": prompt,
            "documents": docs,
            "top_n": min(len(docs), self.config.rag_rerank_top_n),
        }
        try:
            async with httpx.AsyncClient(timeout=max(5.0, self.config.request_timeout_ms / 1000.0)) as client:
                response = await client.post(endpoint, headers=headers, json=payload)
                response.raise_for_status()
                body = response.json()
                results = body.get("results", [])
                mapping: Dict[str, float] = {}
                for row in results:
                    if not isinstance(row, dict):
                        continue
                    idx = row.get("index")
                    score = row.get("relevance_score")
                    if isinstance(idx, int) and 0 <= idx < len(candidates) and isinstance(score, (int, float)):
                        mapping[candidates[idx][0].id] = float(score)
                return mapping
        except Exception:
            return {}

    def _mmr_select(
        self, ranked: Sequence[Tuple[IndexedChunk, float, float, float, float]], limit: int
    ) -> List[Tuple[IndexedChunk, float, float, float, float]]:
        if not ranked:
            return []
        lambda_param = clamp(self.config.rag_mmr_lambda, 0.2, 0.95)
        candidates = list(ranked)
        selected: List[Tuple[IndexedChunk, float, float, float, float]] = []
        while candidates and len(selected) < limit:
            best_idx = 0
            best_score = -1e9
            for idx, item in enumerate(candidates):
                chunk, rerank_score, dense_score, lexical_score, recency_score = item
                if not selected:
                    objective = rerank_score
                else:
                    max_sim = 0.0
                    for selected_item in selected:
                        selected_chunk = selected_item[0]
                        sim = cosine_similarity(chunk.vector, selected_chunk.vector)
                        if sim <= 0.0:
                            inter = len(chunk.token_set.intersection(selected_chunk.token_set))
                            union = len(chunk.token_set.union(selected_chunk.token_set))
                            sim = inter / union if union > 0 else 0.0
                        max_sim = max(max_sim, sim)
                    objective = lambda_param * rerank_score - (1.0 - lambda_param) * max_sim
                if objective > best_score:
                    best_score = objective
                    best_idx = idx
            selected.append(candidates.pop(best_idx))
        return selected

    async def retrieve(
        self,
        prompt: str,
        *,
        limit: int,
        candidate_limit: int,
        min_score: float,
        scope: str,
        tenant_id: Optional[str],
        user_id: Optional[str],
        session_id: Optional[str],
        module_ids: Optional[List[str]] = None,
        source_types: Optional[List[str]] = None,
        doc_ids: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        query = prompt.strip()
        if not query:
            return []
        if self.config.rag_adaptive_retrieve_enabled:
            quick = query.lower()
            if len(query) < 4 and not re.search(r"(库存|订单|采购|报表|客户|memory|rag|api|table)", quick):
                return []

        await self.ensure_index(force=False, incremental=True)
        query_tokens = tokenize(query)
        if not query_tokens:
            return []
        query_tf = term_frequency(query_tokens)

        filtered: List[IndexedChunk] = []
        module_set = set(module_ids or [])
        source_set = set(source_types or [])
        doc_set = set(doc_ids or [])
        for chunk in self.index_chunks:
            if not self._scope_allows(chunk, scope, tenant_id, user_id, session_id):
                continue
            if module_set and chunk.module_id not in module_set:
                continue
            if source_set and chunk.source_type not in source_set:
                continue
            if doc_set and chunk.doc_id not in doc_set:
                continue
            filtered.append(chunk)
        if not filtered:
            return []

        lexical_local = {chunk.id: self._bm25(chunk, query_tf) for chunk in filtered}
        dense_local = {chunk.id: self._tfidf_dense(chunk, query_tf) for chunk in filtered}
        lexical_norm = min_max_normalize(lexical_local)
        dense_norm = min_max_normalize(dense_local)

        dense_remote: Dict[str, float] = {}
        lexical_remote: Dict[str, float] = {}
        if self.config.rag_lancedb_enabled and self.lancedb.enabled:
            query_vector = (await self.embedding.embed_texts([query]))[0] if self.embedding.enabled() else []
            vector_limit = max(candidate_limit, self.config.rag_vector_candidate_k)
            fts_limit = max(candidate_limit, self.config.rag_fts_candidate_k)
            vector_rows = self.lancedb.search_vector(query_vector, vector_limit)
            fts_rows = self.lancedb.search_fts(query, fts_limit)

            vector_scores: Dict[str, float] = {}
            for row in vector_rows:
                row_id = str(row.get("id", ""))
                if not row_id:
                    continue
                distance = row.get("_distance")
                score = 1.0 / (1.0 + float(distance)) if isinstance(distance, (int, float)) else 0.0
                vector_scores[row_id] = max(vector_scores.get(row_id, 0.0), score)
                vector = row.get("vector")
                if isinstance(vector, list):
                    chunk = self.chunk_map.get(row_id)
                    if chunk is not None and not chunk.vector:
                        chunk.vector = [float(v) for v in vector if isinstance(v, (int, float))]
            dense_remote = min_max_normalize(vector_scores)

            fts_scores: Dict[str, float] = {}
            for row in fts_rows:
                row_id = str(row.get("id", ""))
                if not row_id:
                    continue
                raw_score = row.get("_score")
                if raw_score is None:
                    raw_score = row.get("_distance")
                if isinstance(raw_score, (int, float)):
                    fts_scores[row_id] = max(fts_scores.get(row_id, 0.0), float(raw_score))
            lexical_remote = min_max_normalize(fts_scores)

        dense_scores = dense_remote if dense_remote else dense_norm
        lexical_scores = lexical_remote if lexical_remote else lexical_norm

        candidate_ids = sorted(
            {
                *sorted(dense_scores.keys(), key=lambda cid: dense_scores.get(cid, 0.0), reverse=True)[
                    :candidate_limit
                ],
                *sorted(lexical_scores.keys(), key=lambda cid: lexical_scores.get(cid, 0.0), reverse=True)[
                    :candidate_limit
                ],
            }
        )
        if not candidate_ids:
            candidate_ids = [chunk.id for chunk in filtered[:candidate_limit]]
        candidate_chunks = [self.chunk_map[cid] for cid in candidate_ids if cid in self.chunk_map]

        dense_weight = clamp(self.config.rag_dense_weight, 0.0, 1.0)
        lexical_weight = clamp(self.config.rag_lexical_weight, 0.0, 1.0)
        recency_weight = clamp(1.0 - dense_weight - lexical_weight, 0.0, 0.4)

        scored: List[Tuple[IndexedChunk, float, float, float, float]] = []
        for chunk in candidate_chunks:
            dense = dense_scores.get(chunk.id, 0.0)
            lexical = lexical_scores.get(chunk.id, 0.0)
            recency = self._recency(chunk.updated_at_ts)
            if self.config.rag_retrieval_mode == "dense":
                hybrid = 0.84 * dense + 0.16 * recency
            elif self.config.rag_retrieval_mode == "lexical":
                hybrid = 0.84 * lexical + 0.16 * recency
            else:
                hybrid = lexical_weight * lexical + dense_weight * dense + recency_weight * recency
            if chunk.source_type == "memory":
                hybrid = clamp(hybrid * 1.08, 0.0, 1.6)
            scored.append((chunk, hybrid, dense, lexical, recency))

        scored.sort(key=lambda item: item[1], reverse=True)
        scored = [item for item in scored if item[1] >= min_score][:candidate_limit]

        # heuristic rerank
        query_set = set(query_tokens)
        reranked: List[Tuple[IndexedChunk, float, float, float, float]] = []
        for chunk, hybrid, dense, lexical, recency in scored:
            coverage = len(query_set.intersection(chunk.token_set)) / max(1, len(query_set))
            phrase = 0.08 if query.lower() in chunk.content.lower() else 0.0
            rerank_score = clamp(0.72 * hybrid + 0.2 * coverage + phrase, 0.0, 1.6)
            reranked.append((chunk, rerank_score, dense, lexical, recency))

        # optional remote rerank
        remote = await self._remote_rerank(query, [(item[0], item[1]) for item in reranked])
        if remote:
            adjusted: List[Tuple[IndexedChunk, float, float, float, float]] = []
            for chunk, rerank_score, dense, lexical, recency in reranked:
                if chunk.id in remote:
                    rerank_score = clamp(0.7 * remote[chunk.id] + 0.3 * rerank_score, 0.0, 1.6)
                adjusted.append((chunk, rerank_score, dense, lexical, recency))
            reranked = adjusted

        reranked.sort(key=lambda item: item[1], reverse=True)
        selected = self._mmr_select(reranked, limit=max(1, limit))

        results: List[Dict[str, Any]] = []
        for chunk, rerank_score, dense, lexical, recency in selected:
            results.append(
                {
                    "id": chunk.id,
                    "docId": chunk.doc_id,
                    "docTitle": chunk.doc_title,
                    "sectionTitle": chunk.section_title,
                    "moduleId": chunk.module_id,
                    "sourceType": chunk.source_type,
                    "scopeType": chunk.scope_type,
                    "scopeId": chunk.scope_id,
                    "updatedAt": chunk.updated_at,
                    "content": chunk.content,
                    "citation": chunk.citation,
                    "score": float(rerank_score),
                    "denseScore": float(dense),
                    "lexicalScore": float(lexical),
                    "recencyScore": float(recency),
                    "rerankScore": float(rerank_score),
                }
            )
        return results

    def stats(self) -> Dict[str, Any]:
        return {
            "chunkCount": len(self.index_chunks),
            "lancedb": {
                "enabled": bool(self.lancedb.enabled),
                "available": bool(self.lancedb.available),
                "tableName": self.lancedb.table_name,
                "dbPath": self.lancedb.db_path,
                "indexedRows": self.lancedb.indexed_rows,
                "lastSyncAt": self.lancedb.last_sync_at,
                "lastError": self.lancedb.last_error,
                "changedDocIds": self.lancedb.changed_doc_ids,
                "removedDocIds": self.lancedb.removed_doc_ids,
            },
        }

    def diagnostics(self) -> Dict[str, Any]:
        manifest = self._load_manifest()
        return {
            "generatedAt": now_iso(),
            "manifestPath": str(self.config.rag_manifest_path),
            "manifestExists": self.config.rag_manifest_path.exists(),
            "manifest": manifest or None,
            "cachePath": str(self.config.rag_cache_path),
            "cacheExists": self.config.rag_cache_path.exists(),
            "cacheSignature": self.signature,
            "cacheRefreshedAt": self.refreshed_at,
            "chunkCount": len(self.index_chunks),
            "embedding": {
                "provider": self.config.rag_embedding_provider,
                "model": self.config.rag_embedding_model,
                "enabled": self.embedding.enabled(),
                "lastError": self.embedding.last_error,
            },
            "retrieval": {
                "mode": self.config.rag_retrieval_mode,
                "topK": self.config.rag_top_k,
                "candidateK": self.config.rag_candidate_k,
                "denseWeight": self.config.rag_dense_weight,
                "lexicalWeight": self.config.rag_lexical_weight,
                "mmrLambda": self.config.rag_mmr_lambda,
                "minScore": self.config.rag_min_score,
            },
            "lancedb": self.stats().get("lancedb"),
        }


def create_embedding_client(config: AgentConfig) -> EmbeddingClient:
    return EmbeddingClient(config)


def create_rag_engine(
    config: AgentConfig,
    embedding: EmbeddingClient,
    episodic_memory: EpisodicMemoryStore,
) -> RagEngine:
    return RagEngine(config, embedding, episodic_memory)


