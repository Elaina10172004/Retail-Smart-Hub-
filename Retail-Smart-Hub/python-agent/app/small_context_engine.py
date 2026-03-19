from __future__ import annotations

import hashlib
import re
from typing import Any, Dict, List, Mapping, Sequence

from pydantic import BaseModel, Field

from .router_gate import RouterDecision


class SmallContext(BaseModel):
    query: str = ""
    rewritten_query: str = ""
    history: List[Dict[str, Any]] = Field(default_factory=list)
    profile_context: str = ""
    knowledge_context: str = ""
    attachment_context: str = ""
    skill_context: str = ""
    runtime_tool_context: str = ""
    chunks: List[Dict[str, Any]] = Field(default_factory=list)
    attachment_evidence: List[Dict[str, Any]] = Field(default_factory=list)
    runtime_tool_evidence: List[Dict[str, Any]] = Field(default_factory=list)
    table_views: List[Dict[str, Any]] = Field(default_factory=list)
    missing_evidence: List[Dict[str, Any]] = Field(default_factory=list)
    retrieval_diagnostics: Dict[str, Any] = Field(default_factory=dict)
    notes: List[str] = Field(default_factory=list)
    query_rewrites: Dict[str, Any] = Field(default_factory=dict)
    final_answer_allowed: bool = False


def _compact_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _clip_text(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 3)] + "..."


def _normalize_history_item(item: Any) -> Dict[str, Any] | None:
    if isinstance(item, Mapping):
        role = "assistant" if str(item.get("role", "")).strip().lower() == "assistant" else "user"
        content = _compact_text(item.get("content", ""))
        if not content:
            return None
        result: Dict[str, Any] = {"role": role, "content": content}
        for key in ("toolCalls", "pendingActionId", "pendingActionName", "pendingActionStatus"):
            value = item.get(key)
            if value is not None:
                result[key] = value
        return result

    role = "assistant" if str(getattr(item, "role", "")).strip().lower() == "assistant" else "user"
    content = _compact_text(getattr(item, "content", ""))
    if not content:
        return None
    result = {"role": role, "content": content}
    for key in ("toolCalls", "pendingActionId", "pendingActionName", "pendingActionStatus"):
        value = getattr(item, key, None)
        if value is not None:
            result[key] = value
    return result


def trim_history(
    history: Sequence[Any] | None,
    *,
    max_turns: int = 6,
    max_chars: int = 6000,
) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for item in history or []:
        row = _normalize_history_item(item)
        if row is None:
            continue
        normalized.append(row)

    if not normalized:
        return []

    trimmed = normalized[-max(1, int(max_turns)) :]
    while trimmed:
        total_chars = sum(len(str(item.get("content", ""))) for item in trimmed)
        if total_chars <= max_chars:
            break
        trimmed = trimmed[1:]
    return trimmed


def _rewrite_query(query: str, history: Sequence[Dict[str, Any]]) -> str:
    resolved = _compact_text(query)
    if not resolved:
        return ""
    if len(resolved) >= 24:
        return resolved

    for item in reversed(history):
        if item.get("role") != "user":
            continue
        previous = _compact_text(item.get("content", ""))
        if not previous or previous == resolved:
            continue
        return f"{previous} | follow-up: {resolved}"[:240]
    return resolved


def _chunk_text(chunk: Mapping[str, Any]) -> str:
    for key in ("content", "text", "summary", "context"):
        text = _compact_text(chunk.get(key, ""))
        if text:
            return text
    return ""


def _chunk_score(chunk: Mapping[str, Any]) -> float:
    for key in ("score", "denseScore", "lexicalScore", "rerankScore"):
        value = chunk.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return 0.0


def _chunk_key(chunk: Mapping[str, Any]) -> str:
    citation = _compact_text(chunk.get("citation", ""))
    if citation:
        return f"citation:{citation.lower()}"
    text = _chunk_text(chunk)
    if text:
        return hashlib.sha1(text.lower().encode("utf-8")).hexdigest()
    title = _compact_text(chunk.get("docTitle", "")) or _compact_text(chunk.get("title", ""))
    if title:
        return f"title:{title.lower()}"
    return hashlib.sha1(repr(sorted(chunk.items())).encode("utf-8", errors="ignore")).hexdigest()


def _freshness_score(metadata: Mapping[str, Any]) -> float:
    freshness_text = _compact_text(
        metadata.get("freshness")
        or metadata.get("updatedAt")
        or metadata.get("timestamp")
        or ""
    )
    if not freshness_text:
        return 0.0
    if any(token in freshness_text for token in ("2026", "2025")):
        return 1.0
    if "2024" in freshness_text:
        return 0.7
    return 0.4


def _information_density(text: str) -> float:
    tokens = re.findall(r"[\w\-]+", text.lower())
    if not tokens:
        return 0.0
    unique_ratio = len(set(tokens)) / max(1, len(tokens))
    return min(1.0, round((unique_ratio + min(1.0, len(tokens) / 180.0)) / 2.0, 3))


def _dedupe_and_rank_chunks(
    chunks: Sequence[Mapping[str, Any]] | None,
    *,
    max_items: int,
) -> List[Dict[str, Any]]:
    unique: Dict[str, Dict[str, Any]] = {}
    for chunk in chunks or []:
        if not isinstance(chunk, Mapping):
            continue
        text = _chunk_text(chunk)
        if not text:
            continue
        row = {
            "docTitle": _compact_text(chunk.get("docTitle", "")) or _compact_text(chunk.get("title", "")) or "Knowledge",
            "citation": _compact_text(chunk.get("citation", "")),
            "content": text,
            "score": _chunk_score(chunk),
            "metadata": {
                str(key): value
                for key, value in chunk.items()
                if key not in {"content", "text", "summary", "context"} and value not in (None, "", [], {})
            },
        }
        metadata = row.get("metadata", {})
        if isinstance(metadata, Mapping):
            row["source_quality"] = float(metadata.get("source_quality", metadata.get("quality", 0.72)))
            row["freshness_score"] = _freshness_score(metadata)
        else:
            row["source_quality"] = 0.72
            row["freshness_score"] = 0.0
        row["evidence_density"] = _information_density(text)
        key = _chunk_key(chunk)
        current = unique.get(key)
        if current is None or float(row.get("score", 0.0)) > float(current.get("score", 0.0)):
            unique[key] = row

    ranked = sorted(
        unique.values(),
        key=lambda item: (
            -(0.55 * float(item.get("score", 0.0)) + 0.2 * float(item.get("source_quality", 0.72)) + 0.25 * float(item.get("freshness_score", 0.0))),
            -float(item.get("evidence_density", 0.0)),
            len(str(item.get("content", ""))),
            str(item.get("citation", "")),
        ),
    )
    return ranked[: max(1, int(max_items))]


def _infer_key_columns(columns: Sequence[str]) -> List[str]:
    key_hints = ("id", "code", "sku", "item", "product", "line", "region", "门店", "区域")
    resolved: List[str] = []
    for col in columns:
        lowered = str(col).lower()
        if any(hint in lowered for hint in key_hints):
            resolved.append(str(col))
    return resolved[:4]


def _infer_measure_columns(columns: Sequence[str]) -> List[str]:
    measure_hints = ("amount", "revenue", "sales", "qty", "quantity", "count", "cost", "price", "利润", "收入", "数量")
    resolved: List[str] = []
    for col in columns:
        lowered = str(col).lower()
        if any(hint in lowered for hint in measure_hints):
            resolved.append(str(col))
    return resolved[:6]


def _extract_table_filters(query: str, columns: Sequence[str]) -> Dict[str, Any]:
    query_text = _compact_text(query)
    if not query_text:
        return {}
    filters: Dict[str, Any] = {}
    region_aliases = (
        "华东",
        "华南",
        "华北",
        "华西",
        "east",
        "west",
        "north",
        "south",
    )
    quarter_match = re.search(r"(20\d{2}\s*Q[1-4]|Q[1-4])", query_text, flags=re.IGNORECASE)
    if quarter_match:
        value = quarter_match.group(1).replace(" ", "").upper()
        for column in columns:
            if "quarter" in str(column).lower() or "季度" in str(column):
                filters[str(column)] = value
                break
    for alias in region_aliases:
        if alias.lower() in query_text.lower():
            for column in columns:
                lowered = str(column).lower()
                if "region" in lowered or "区域" in str(column):
                    filters[str(column)] = alias
                    break
            break
    return filters


def _attachment_units(attachments: Sequence[Any] | None) -> List[Dict[str, Any]]:
    units: List[Dict[str, Any]] = []
    for attachment in attachments or []:
        file_name = _compact_text(getattr(attachment, "fileName", "")) or "attachment"
        sheets = getattr(attachment, "sheets", None)
        if isinstance(sheets, list) and sheets:
            for sheet in sheets:
                if not hasattr(sheet, "rows"):
                    continue
                rows = getattr(sheet, "rows", None)
                if not isinstance(rows, list) or not rows:
                    continue
                units.append(
                    {
                        "file_name": file_name,
                        "sheet_name": _compact_text(getattr(sheet, "name", "")) or file_name,
                        "rows": rows,
                        "attachment": attachment,
                    }
                )
            continue
        rows = getattr(attachment, "rows", None)
        if isinstance(rows, list) and rows:
            units.append(
                {
                    "file_name": file_name,
                    "sheet_name": _compact_text(getattr(attachment, "sheetName", "")) or file_name,
                    "rows": rows,
                    "attachment": attachment,
                }
            )
    return units


def _build_attachment_evidence(
    attachments: Sequence[Any] | None,
    *,
    max_items: int = 6,
) -> List[Dict[str, Any]]:
    evidence: List[Dict[str, Any]] = []
    for attachment in attachments or []:
        file_name = _compact_text(getattr(attachment, "fileName", "")) or "attachment"
        attachment_id = _compact_text(getattr(attachment, "id", "")) or hashlib.sha1(file_name.encode("utf-8")).hexdigest()[:12]
        blocks = getattr(attachment, "blocks", None)
        if isinstance(blocks, list) and blocks:
            for index, block in enumerate(blocks[: max_items]):
                text = _compact_text(getattr(block, "text", ""))
                if not text:
                    continue
                locator_raw = getattr(block, "locator", None)
                locator: Dict[str, Any]
                if isinstance(locator_raw, Mapping):
                    locator = dict(locator_raw)
                elif hasattr(locator_raw, "model_dump"):
                    locator = dict(locator_raw.model_dump(exclude_none=True))
                else:
                    locator = {}
                locator.setdefault("attachment_id", attachment_id)
                locator.setdefault("file_name", file_name)
                locator.setdefault("kind", "document")
                locator.setdefault("block_id", _compact_text(getattr(block, "blockId", "")) or f"{attachment_id}-block-{index + 1}")
                evidence.append(
                    {
                        "attachment_id": attachment_id,
                        "file_name": file_name,
                        "title": _compact_text(getattr(block, "title", "")) or file_name,
                        "claim": _clip_text(text, 420),
                        "excerpt": _clip_text(text, 320),
                        "locator": locator,
                        "support_type": "attachment_block",
                        "source_quality": 0.88,
                    }
                )
                if len(evidence) >= max_items:
                    return evidence
            continue
        text = _compact_text(getattr(attachment, "textContent", ""))
        if text:
            evidence.append(
                {
                    "attachment_id": attachment_id,
                    "file_name": file_name,
                    "title": file_name,
                    "claim": _clip_text(text, 420),
                    "excerpt": _clip_text(text, 320),
                    "locator": {
                        "attachment_id": attachment_id,
                        "file_name": file_name,
                        "kind": "document",
                    },
                    "support_type": "attachment_text",
                    "source_quality": 0.84,
                }
            )
            if len(evidence) >= max_items:
                return evidence
    return evidence


def _build_table_views(
    attachments: Sequence[Any] | None,
    *,
    query: str,
    max_views: int = 2,
) -> List[Dict[str, Any]]:
    views: List[Dict[str, Any]] = []
    for unit in _attachment_units(attachments):
        rows = unit["rows"]
        file_name = unit["file_name"]
        sheet_name = unit["sheet_name"]
        columns: List[str] = []
        for row in rows[:20]:
            if not isinstance(row, Mapping):
                continue
            for key in row.keys():
                if str(key) not in columns:
                    columns.append(str(key))
        preview_rows: List[Dict[str, Any]] = []
        filters = _extract_table_filters(query, columns)
        selected_rows: List[Dict[str, Any]] = []
        selected_row_indices: List[int] = []
        for row_index, row in enumerate(rows, start=1):
            if not isinstance(row, Mapping):
                continue
            if filters:
                matched = True
                for key, expected in filters.items():
                    actual = _compact_text(row.get(key, ""))
                    if _compact_text(expected).lower() not in actual.lower():
                        matched = False
                        break
                if not matched:
                    continue
            selected_rows.append(dict(row))
            selected_row_indices.append(row_index)
            if len(selected_rows) >= 30:
                break
        if not selected_rows:
            for row_index, row in enumerate(rows[:30], start=1):
                if not isinstance(row, Mapping):
                    continue
                selected_rows.append(dict(row))
                selected_row_indices.append(row_index)

        for row in selected_rows[:5]:
            if not isinstance(row, Mapping):
                continue
            preview_rows.append(
                {
                    str(key): value
                    for key, value in row.items()
                    if value not in (None, "", [], {})
                }
            )
        key_columns = _infer_key_columns(columns)
        measure_columns = _infer_measure_columns(columns)
        last_row = selected_row_indices[-1] if selected_row_indices else min(len(rows), 30)
        column_limit = max(1, min(len(columns), 12))
        views.append(
            {
                "viewId": hashlib.sha1(f"{file_name}:{sheet_name}".encode("utf-8")).hexdigest()[:12],
                "fileName": file_name or "attachment",
                "sheetName": sheet_name,
                "columns": columns[:12],
                "headers": columns[:12],
                "keyColumns": key_columns,
                "measureColumns": measure_columns,
                "filters": filters,
                "rowCount": len(rows),
                "rowIndices": selected_row_indices[:30],
                "rowRanges": [f"{selected_row_indices[0]}:{last_row}"] if selected_row_indices else [],
                "columnRanges": [f"1:{column_limit}"],
                "cellRanges": [f"R{selected_row_indices[0] if selected_row_indices else 1}C1:R{last_row}C{column_limit}"],
                "previewRows": preview_rows,
            }
        )
        if len(views) >= max_views:
            break
    return views


def _build_missing_evidence(
    *,
    decision: RouterDecision,
    chunks: Sequence[Dict[str, Any]],
    table_views: Sequence[Dict[str, Any]],
    attachment_evidence: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    missing: List[Dict[str, Any]] = []
    if decision.web_fallback_allowed:
        if not chunks:
            missing.append(
                {
                    "gap_id": "gap-web-evidence",
                    "question": "Need fresh evidence from web/official sources.",
                    "priority": "high",
                    "recommended_tool": "web_search",
                }
            )
        else:
            top_score = max(float(item.get("score", 0.0)) for item in chunks)
            if top_score < 0.58:
                missing.append(
                    {
                        "gap_id": "gap-weak-kb",
                        "question": "Current KB evidence is weak; need stronger web/official confirmation.",
                        "priority": "high",
                        "recommended_tool": "web_search",
                    }
                )
            elif len(chunks) < 2 and decision.route in {"kb_rag", "hybrid", "web_only"}:
                missing.append(
                    {
                        "gap_id": "gap-kb-coverage",
                        "question": "Need additional evidence to improve coverage for final answer.",
                        "priority": "medium",
                        "recommended_tool": "web_search",
                    }
                )
    if "table" in decision.modalities and not table_views:
        missing.append(
            {
                "gap_id": "gap-table-view",
                "question": "Need task-relevant table view from attachments.",
                "priority": "medium",
                "recommended_tool": "spreadsheet_ops",
            }
        )
    elif "table" in decision.modalities and table_views:
        has_measure = any(bool(view.get("measureColumns")) for view in table_views)
        if not has_measure:
            missing.append(
                {
                    "gap_id": "gap-table-measure-columns",
                    "question": "Need measure columns from table views for deterministic computation.",
                    "priority": "medium",
                    "recommended_tool": "spreadsheet_ops",
                }
            )
    if "document" in decision.modalities and not attachment_evidence:
        missing.append(
            {
                "gap_id": "gap-document-evidence",
                "question": "Need attachment excerpts with locator metadata.",
                "priority": "medium",
                "recommended_tool": "document_context",
            }
        )
    return missing


def _build_query_rewrites(
    *,
    query: str,
    decision: RouterDecision,
    chunks: Sequence[Dict[str, Any]],
    table_views: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    compact = _compact_text(query)
    semantic = compact
    if compact and "|" in compact:
        semantic = compact.split("|", 1)[0].strip()
    decomposition_queries = [
        _compact_text(part)
        for part in re.split(r"[，,。;；]|(?:并且|以及|同时|然后|且|and)", compact)
        if _compact_text(part)
    ]
    disambiguation_queries: List[str] = []
    lowered = compact.lower()
    if "revenue" in lowered and "booked revenue" not in lowered:
        disambiguation_queries.append("difference between revenue and booked revenue")
    if "收入" in compact and "已确认收入" not in compact:
        disambiguation_queries.append("收入 与 已确认收入 的定义区别")
    if "毛利" in compact:
        disambiguation_queries.append("毛利 与 销售额 的口径区别")
    kb_queries = [item for item in [compact, semantic] if item]
    web_queries = [compact] if compact and decision.web_fallback_allowed else []
    table_filters: List[Dict[str, Any]] = []
    if table_views:
        for view in table_views[:3]:
            table_filters.append(
                {
                    "view_id": view.get("viewId", ""),
                    "file_name": view.get("fileName", ""),
                    "columns": list(view.get("columns", []))[:12],
                    "row_count": view.get("rowCount", 0),
                }
            )
    elif "table" in decision.modalities:
        table_filters.append(
            {
                "mode": "table_requested",
                "query": compact,
            }
        )
    return {
        "exact_query": compact,
        "semantic_query": semantic,
        "decomposition_queries": decomposition_queries[:6],
        "disambiguation_queries": disambiguation_queries[:4],
        "web_fallback_queries": list(web_queries),
        "kb_queries": kb_queries,
        "web_queries": list(web_queries),
        "table_filters": table_filters,
    }


def _build_retrieval_diagnostics(
    *,
    chunks: Sequence[Dict[str, Any]],
    missing_evidence: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    kb_quality = 0.0
    if chunks:
        kb_quality = sum(float(item.get("score", 0.0)) for item in chunks[:3]) / min(3, len(chunks))
    coverage = 0.9 if chunks else 0.3
    ambiguity = 0.2 if chunks else 0.7
    return {
        "kb_quality": round(max(0.0, min(1.0, kb_quality)), 3),
        "web_quality": 0.0,
        "coverage": coverage if not missing_evidence else max(0.1, coverage - 0.25),
        "ambiguity": ambiguity if not missing_evidence else min(0.95, ambiguity + 0.25),
        "needs_web_fallback": any(item.get("recommended_tool") == "web_search" for item in missing_evidence),
        "reason": "missing_evidence_detected" if missing_evidence else "context_sufficient",
    }


def build_small_context(
    *,
    request: Any,
    context: Any,
    decision: RouterDecision,
    char_budget: int = 12000,
) -> SmallContext:
    raw_prompt = _compact_text(getattr(request, "prompt", ""))
    budget = max(2000, int(char_budget))

    history_limit = int(decision.budgets.get("history_turns", 6))
    history_chars = max(1200, min(6000, budget // 2))
    history = trim_history(getattr(request, "history", []), max_turns=history_limit, max_chars=history_chars)
    rewritten_query = _rewrite_query(raw_prompt, history)

    raw_chunks = getattr(context, "chunks", [])
    chunks = _dedupe_and_rank_chunks(
        raw_chunks,
        max_items=max(2, min(8, int(decision.budgets.get("tool_rounds", 5)) + 2)),
    )

    profile_context = _clip_text(_compact_text(getattr(context, "profile_context", "")), max(300, budget // 6))
    knowledge_context = _clip_text(_compact_text(getattr(context, "knowledge_context", "")), max(600, budget // 2))
    attachment_context = _clip_text(str(getattr(context, "attachment_context", "")).strip(), max(600, budget // 3))
    skill_context = _clip_text(_compact_text(getattr(context, "skill_context", "")), max(240, budget // 7))

    attachment_evidence = _build_attachment_evidence(getattr(request, "attachments", []))
    table_views = _build_table_views(getattr(request, "attachments", []), query=rewritten_query or raw_prompt)
    missing_evidence = _build_missing_evidence(
        decision=decision,
        chunks=chunks,
        table_views=table_views,
        attachment_evidence=attachment_evidence,
    )
    query_rewrites = _build_query_rewrites(
        query=rewritten_query or raw_prompt,
        decision=decision,
        chunks=chunks,
        table_views=table_views,
    )
    diagnostics = _build_retrieval_diagnostics(chunks=chunks, missing_evidence=missing_evidence)

    notes: List[str] = []
    if rewritten_query and rewritten_query != raw_prompt:
        notes.append("query_rewritten")
    if len(chunks) < len(raw_chunks):
        notes.append("chunks_deduplicated")
    if attachment_evidence:
        notes.append("attachment_evidence_extracted")
    if table_views:
        notes.append("table_views_extracted")
    if missing_evidence:
        notes.append("missing_evidence_detected")

    return SmallContext(
        query=raw_prompt,
        rewritten_query=rewritten_query or raw_prompt,
        history=history,
        profile_context=profile_context,
        knowledge_context=knowledge_context,
        attachment_context=attachment_context,
        skill_context=skill_context,
        chunks=chunks,
        attachment_evidence=attachment_evidence,
        table_views=table_views,
        missing_evidence=missing_evidence,
        retrieval_diagnostics=diagnostics,
        notes=notes,
        query_rewrites=query_rewrites,
        final_answer_allowed=False,
    )


__all__ = ["SmallContext", "trim_history", "build_small_context"]
