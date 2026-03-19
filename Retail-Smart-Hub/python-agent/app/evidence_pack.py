from __future__ import annotations

import hashlib
import uuid
from typing import Any, Dict, List, Mapping, Sequence

from pydantic import BaseModel, Field

from .router_gate import RouterDecision
from .small_context_engine import SmallContext


class EvidenceSource(BaseModel):
    source_id: str
    source_type: str
    title: str
    locator: Dict[str, Any] = Field(default_factory=dict)
    source_quality: float = 0.75
    freshness: str = "unknown"


class EvidenceItem(BaseModel):
    evidence_id: str
    source_id: str
    claim: str
    source_quality: float = 0.75
    uncertainty: float = 0.3
    relevance: float = 0.7
    support_type: str = "text_support"
    excerpt: str = ""
    locator: Dict[str, Any] = Field(default_factory=dict)
    conflict_group: str | None = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class RetrievalDiagnostics(BaseModel):
    kb_quality: float = 0.0
    web_quality: float = 0.0
    coverage: float = 0.0
    ambiguity: float = 0.0
    needs_web_fallback: bool = False
    reason: str = ""


class EvidencePack(BaseModel):
    schema_version: str = "1.0"
    pack_id: str
    task: Dict[str, Any] = Field(default_factory=dict)
    route: Dict[str, Any] = Field(default_factory=dict)
    query_rewrites: Dict[str, Any] = Field(default_factory=dict)
    sources: List[EvidenceSource] = Field(default_factory=list)
    evidence_items: List[EvidenceItem] = Field(default_factory=list)
    table_views: List[Dict[str, Any]] = Field(default_factory=list)
    missing_evidence: List[Dict[str, Any]] = Field(default_factory=list)
    retrieval_diagnostics: RetrievalDiagnostics = Field(default_factory=RetrievalDiagnostics)
    planner_handoff: Dict[str, Any] = Field(default_factory=dict)
    final_answer_allowed: bool = False


SUPPORTED_EVIDENCE_PACK_SCHEMA_VERSIONS = {"1.0"}


def _compact_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _clip_text(value: str, limit: int = 420) -> str:
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 3)] + "..."


def _source_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def _evidence_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def _hash_claim(value: str) -> str:
    return hashlib.sha1(value.lower().encode("utf-8", errors="ignore")).hexdigest()


def _clamp_01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _attachment_source_type(item: Mapping[str, Any]) -> str:
    support_type = _compact_text(item.get("support_type", "")).lower()
    if "image" in support_type:
        return "attachment_image"
    return "attachment_document"


def _attachment_uncertainty(item: Mapping[str, Any]) -> float:
    support_type = _compact_text(item.get("support_type", "")).lower()
    if "image" in support_type:
        return 0.22
    return 0.18


def validate_evidence_pack_contract(pack: EvidencePack, *, stage: str = "runtime") -> List[str]:
    issues: List[str] = []
    prefix = f"[{stage}]"

    schema_version = _compact_text(pack.schema_version)
    if not schema_version:
        issues.append(f"{prefix} schema_version is empty")
    elif schema_version not in SUPPORTED_EVIDENCE_PACK_SCHEMA_VERSIONS:
        issues.append(
            f"{prefix} unsupported schema_version: {schema_version} "
            f"(supported={','.join(sorted(SUPPORTED_EVIDENCE_PACK_SCHEMA_VERSIONS))})"
        )
    if not _compact_text(pack.pack_id):
        issues.append(f"{prefix} pack_id is empty")
    if pack.final_answer_allowed:
        issues.append(f"{prefix} final_answer_allowed must be false before ANSWER synthesis")

    for field_name in ("task", "route", "query_rewrites", "planner_handoff"):
        value = getattr(pack, field_name, None)
        if not isinstance(value, dict):
            issues.append(f"{prefix} {field_name} must be a dict")

    if not isinstance(pack.sources, list):
        issues.append(f"{prefix} sources must be a list")
    if not isinstance(pack.evidence_items, list):
        issues.append(f"{prefix} evidence_items must be a list")
    if not isinstance(pack.missing_evidence, list):
        issues.append(f"{prefix} missing_evidence must be a list")

    seen_source_ids: set[str] = set()
    for index, source in enumerate(pack.sources):
        source_id = _compact_text(getattr(source, "source_id", ""))
        if not source_id:
            issues.append(f"{prefix} source[{index}] missing source_id")
        elif source_id in seen_source_ids:
            issues.append(f"{prefix} duplicate source_id: {source_id}")
        else:
            seen_source_ids.add(source_id)
        if str(getattr(source, "source_type", "")).startswith("attachment") and not getattr(source, "locator", None):
            issues.append(f"{prefix} source[{index}] attachment source must include locator")

    for index, item in enumerate(pack.evidence_items):
        evidence_id = _compact_text(getattr(item, "evidence_id", ""))
        source_id = _compact_text(getattr(item, "source_id", ""))
        claim = _compact_text(getattr(item, "claim", ""))
        if not evidence_id:
            issues.append(f"{prefix} evidence_item[{index}] missing evidence_id")
        if not source_id:
            issues.append(f"{prefix} evidence_item[{index}] missing source_id")
        elif source_id not in seen_source_ids:
            issues.append(f"{prefix} evidence_item[{index}] references unknown source_id: {source_id}")
        if not claim:
            issues.append(f"{prefix} evidence_item[{index}] missing claim")
        if str(getattr(item, "support_type", "")).startswith("attachment") and not getattr(item, "locator", None):
            issues.append(f"{prefix} evidence_item[{index}] attachment evidence must include locator")

    for index, gap in enumerate(pack.missing_evidence):
        if not isinstance(gap, dict):
            issues.append(f"{prefix} missing_evidence[{index}] must be a dict")
            continue
        if not any(_compact_text(gap.get(key, "")) for key in ("gap_id", "question", "recommended_tool")):
            issues.append(f"{prefix} missing_evidence[{index}] must include gap_id, question, or recommended_tool")

    diagnostics = pack.retrieval_diagnostics
    if not isinstance(diagnostics, RetrievalDiagnostics):
        issues.append(f"{prefix} retrieval_diagnostics must be a RetrievalDiagnostics model")
    else:
        for key in ("kb_quality", "web_quality", "coverage", "ambiguity"):
            value = getattr(diagnostics, key, None)
            if not isinstance(value, (int, float)):
                issues.append(f"{prefix} retrieval_diagnostics.{key} must be numeric")

    route = pack.route if isinstance(pack.route, dict) else {}
    if "route" not in route:
        issues.append(f"{prefix} route.route is required")
    if "budgets" not in route:
        issues.append(f"{prefix} route.budgets is required")
    if "reason_codes" not in route:
        issues.append(f"{prefix} route.reason_codes is required")

    return issues


def init_evidence_pack(
    *,
    request: Any,
    decision: RouterDecision,
    small_context: SmallContext,
) -> EvidencePack:
    task = {
        "raw_query": _compact_text(getattr(request, "prompt", "")),
        "intent": decision.intention,
        "complexity": decision.complexity,
        "modalities": list(decision.modalities),
        "sub_questions": [dict(item) for item in small_context.missing_evidence],
    }
    route = {
        "route": decision.route,
        "web_fallback_allowed": decision.web_fallback_allowed,
        "budgets": dict(decision.budgets),
        "reason_codes": list(decision.reason_codes),
    }

    diagnostics = RetrievalDiagnostics(
        kb_quality=float(small_context.retrieval_diagnostics.get("kb_quality", 0.0)),
        web_quality=float(small_context.retrieval_diagnostics.get("web_quality", 0.0)),
        coverage=float(small_context.retrieval_diagnostics.get("coverage", 0.0)),
        ambiguity=float(small_context.retrieval_diagnostics.get("ambiguity", 0.0)),
        needs_web_fallback=bool(small_context.retrieval_diagnostics.get("needs_web_fallback", False)),
        reason=_compact_text(small_context.retrieval_diagnostics.get("reason", "")),
    )
    pack = EvidencePack(
        pack_id=_source_id("pack"),
        task=task,
        route=route,
        query_rewrites=dict(small_context.query_rewrites),
        table_views=list(small_context.table_views),
        missing_evidence=[dict(item) for item in small_context.missing_evidence],
        retrieval_diagnostics=diagnostics,
        planner_handoff={
            "sufficiency_score": 0.0,
            "must_verify_evidence_ids": [],
            "suggested_tools": [],
            "reasoning_hints": [],
        },
        final_answer_allowed=False,
    )
    pack.planner_handoff["contract_issues"] = validate_evidence_pack_contract(pack, stage="init")
    pack.planner_handoff["contract_valid"] = not pack.planner_handoff["contract_issues"]
    return pack


def _register_source(
    pack: EvidencePack,
    *,
    source_type: str,
    title: str,
    locator: Mapping[str, Any] | None,
    source_quality: float,
    freshness: str = "unknown",
) -> str:
    source_id = _source_id(f"src_{source_type}")
    pack.sources.append(
        EvidenceSource(
            source_id=source_id,
            source_type=source_type,
            title=_clip_text(_compact_text(title), 180) or source_type,
            locator=dict(locator or {}),
            source_quality=_clamp_01(source_quality),
            freshness=_clip_text(_compact_text(freshness), 80) or "unknown",
        )
    )
    return source_id


def add_context_evidence(
    pack: EvidencePack,
    *,
    context: Any,
    small_context: SmallContext,
) -> EvidencePack:
    chunks = list(small_context.chunks)
    for index, chunk in enumerate(chunks, start=1):
        source_id = _register_source(
            pack,
            source_type="rag",
            title=str(chunk.get("docTitle", "Knowledge")),
            locator={
                "citation": str(chunk.get("citation", "") or ""),
                "doc_title": str(chunk.get("docTitle", "") or ""),
                "index": index,
            },
            source_quality=0.78,
            freshness="session",
        )
        claim = _clip_text(_compact_text(chunk.get("content", "")), 500)
        if not claim:
            continue
        pack.evidence_items.append(
            EvidenceItem(
                evidence_id=_evidence_id("e_ctx"),
                source_id=source_id,
                claim=claim,
                source_quality=0.78,
                uncertainty=0.24,
                relevance=_clamp_01(float(chunk.get("score", 0.6))),
                support_type="rag_chunk",
                excerpt=claim,
                locator={"citation": chunk.get("citation", ""), "index": index},
                metadata={"score": chunk.get("score", 0.0)},
            )
        )

    if small_context.profile_context:
        source_id = _register_source(
            pack,
            source_type="memory",
            title="Profile memory",
            locator={"scope": "effective", "path": "memory/profile"},
            source_quality=0.9,
            freshness="session",
        )
        profile_claim = _clip_text(small_context.profile_context, 420)
        pack.evidence_items.append(
            EvidenceItem(
                evidence_id=_evidence_id("e_mem"),
                source_id=source_id,
                claim=profile_claim,
                source_quality=0.9,
                uncertainty=0.1,
                relevance=0.7,
                support_type="memory_profile",
                excerpt=profile_claim,
                locator={"scope": "effective"},
            )
        )

    if small_context.attachment_context:
        source_id = _register_source(
            pack,
            source_type="attachment",
            title="Attachment context",
            locator={"type": "attachment_context"},
            source_quality=0.86,
            freshness="uploaded_session",
        )
        attachment_claim = _clip_text(small_context.attachment_context, 420)
        pack.evidence_items.append(
            EvidenceItem(
                evidence_id=_evidence_id("e_att"),
                source_id=source_id,
                claim=attachment_claim,
                source_quality=0.86,
                uncertainty=0.16,
                relevance=0.75,
                support_type="attachment_summary",
                excerpt=attachment_claim,
                locator={"type": "attachment"},
            )
        )

    for index, item in enumerate(small_context.attachment_evidence, start=1):
        source_id = _register_source(
            pack,
            source_type=_attachment_source_type(item),
            title=str(item.get("title") or item.get("file_name") or f"Attachment {index}"),
            locator=item.get("locator") if isinstance(item.get("locator"), Mapping) else {},
            source_quality=float(item.get("source_quality", 0.88)),
            freshness="uploaded_session",
        )
        pack.evidence_items.append(
            EvidenceItem(
                evidence_id=_evidence_id("e_att_doc"),
                source_id=source_id,
                claim=_clip_text(_compact_text(item.get("claim", "")), 500),
                source_quality=float(item.get("source_quality", 0.88)),
                uncertainty=_attachment_uncertainty(item),
                relevance=0.82,
                support_type=str(item.get("support_type") or "attachment_block"),
                excerpt=_clip_text(_compact_text(item.get("excerpt", "")), 320),
                locator=dict(item.get("locator", {})) if isinstance(item.get("locator"), Mapping) else {},
                metadata={"attachment_id": item.get("attachment_id"), "file_name": item.get("file_name")},
            )
        )

    for index, view in enumerate(small_context.table_views, start=1):
        locator = {
            "file_name": view.get("fileName", ""),
            "sheet_name": view.get("sheetName", ""),
            "row_ranges": list(view.get("rowRanges", []))[:3],
            "column_ranges": list(view.get("columnRanges", []))[:3],
            "cell_ranges": list(view.get("cellRanges", []))[:3],
        }
        source_id = _register_source(
            pack,
            source_type="attachment_table",
            title=str(view.get("sheetName") or view.get("fileName") or f"Table view {index}"),
            locator=locator,
            source_quality=0.9,
            freshness="uploaded_session",
        )
        summary_parts = [
            f"rows={view.get('rowCount', 0)}",
            f"columns={','.join(str(item) for item in list(view.get('columns', []))[:8])}",
        ]
        pack.evidence_items.append(
            EvidenceItem(
                evidence_id=_evidence_id("e_att_tbl"),
                source_id=source_id,
                claim=_clip_text("table view -> " + " | ".join(summary_parts), 480),
                source_quality=0.9,
                uncertainty=0.14,
                relevance=0.84,
                support_type="attachment_table_view",
                excerpt=_clip_text(_compact_text(view.get("previewRows", "")), 320),
                locator=locator,
                metadata={"view_id": view.get("viewId", ""), "measure_columns": list(view.get("measureColumns", []))},
            )
        )

    if small_context.skill_context:
        source_id = _register_source(
            pack,
            source_type="skill",
            title="Skill context",
            locator={"path": "skill/context"},
            source_quality=0.7,
            freshness="runtime",
        )
        skill_claim = _clip_text(small_context.skill_context, 320)
        pack.evidence_items.append(
            EvidenceItem(
                evidence_id=_evidence_id("e_skill"),
                source_id=source_id,
                claim=skill_claim,
                source_quality=0.7,
                uncertainty=0.32,
                relevance=0.55,
                support_type="skill_hint",
                excerpt=skill_claim,
                locator={"type": "skill"},
            )
        )

    if small_context.runtime_tool_context:
        source_id = _register_source(
            pack,
            source_type="tool_prefetch",
            title="Small read-only tool context",
            locator={"type": "small_read_tool_context"},
            source_quality=0.94,
            freshness="runtime",
        )
        tool_claim = _clip_text(small_context.runtime_tool_context, 420)
        pack.evidence_items.append(
            EvidenceItem(
                evidence_id=_evidence_id("e_tool_prefetch_ctx"),
                source_id=source_id,
                claim=tool_claim,
                source_quality=0.94,
                uncertainty=0.1,
                relevance=0.88,
                support_type="tool_prefetch_summary",
                excerpt=tool_claim,
                locator={"type": "small_read_tool_context"},
            )
        )

    for index, item in enumerate(small_context.runtime_tool_evidence, start=1):
        tool_name = _compact_text(item.get("tool_name", "")) or f"read_tool_{index}"
        source_id = _register_source(
            pack,
            source_type="tool_prefetch",
            title=tool_name,
            locator={"tool": tool_name, "phase": "small_read_prefetch"},
            source_quality=float(item.get("source_quality", 0.94)),
            freshness="runtime",
        )
        summary = _clip_text(_compact_text(item.get("claim", "")), 500)
        if not summary:
            continue
        pack.evidence_items.append(
            EvidenceItem(
                evidence_id=_evidence_id("e_tool_prefetch"),
                source_id=source_id,
                claim=summary,
                source_quality=float(item.get("source_quality", 0.94)),
                uncertainty=float(item.get("uncertainty", 0.1)),
                relevance=float(item.get("relevance", 0.9)),
                support_type=str(item.get("support_type") or "tool_prefetch_result"),
                excerpt=_clip_text(_compact_text(item.get("excerpt", "")), 320),
                locator={
                    "tool": tool_name,
                    "phase": "small_read_prefetch",
                },
                metadata={
                    "code": item.get("code"),
                    "status": item.get("status"),
                },
            )
        )

    pack.planner_handoff["contract_issues"] = validate_evidence_pack_contract(pack, stage="context")
    pack.planner_handoff["contract_valid"] = not pack.planner_handoff["contract_issues"]
    return pack


def _is_tool_payload_empty(payload: Mapping[str, Any]) -> bool:
    data = payload.get("data")
    if data in (None, "", [], {}):
        return True
    return False


def add_tool_evidence(
    pack: EvidencePack,
    *,
    tool_name: str,
    result_payload: Mapping[str, Any],
    round_id: int,
    repacked: bool = False,
) -> EvidencePack:
    source_quality = 0.95 if bool(result_payload.get("ok", False)) else 0.45
    source_id = _register_source(
        pack,
        source_type="tool",
        title=tool_name,
        locator={"tool": tool_name},
        source_quality=source_quality,
        freshness="runtime",
    )

    summary = _compact_text(result_payload.get("summary", "")) or _compact_text(result_payload.get("message", ""))
    if not summary:
        summary = f"{tool_name} returned empty payload"
    code = _compact_text(result_payload.get("code", "")) or ("ok" if result_payload.get("ok") else "unknown")
    claim = f"{tool_name} -> {code}: {summary}"

    uncertainty = 0.18 if bool(result_payload.get("ok", False)) else 0.62
    if repacked:
        uncertainty = min(0.85, uncertainty + 0.1)
    if _is_tool_payload_empty(result_payload):
        uncertainty = max(uncertainty, 0.72)

    pack.evidence_items.append(
        EvidenceItem(
            evidence_id=_evidence_id("e_tool"),
            source_id=source_id,
            claim=_clip_text(claim, 480),
            source_quality=source_quality,
            uncertainty=_clamp_01(uncertainty),
            relevance=0.8,
            support_type="tool_result",
            excerpt=_clip_text(summary, 320),
            locator={"tool": tool_name, "round": round_id},
            metadata={"code": code, "ok": bool(result_payload.get("ok", False)), "repacked": repacked},
        )
    )

    if bool(result_payload.get("ok", False)) and not _is_tool_payload_empty(result_payload):
        remaining: List[Dict[str, Any]] = []
        for gap in pack.missing_evidence:
            recommended = _compact_text(gap.get("recommended_tool", ""))
            if recommended and recommended not in tool_name:
                remaining.append(gap)
                continue
        pack.missing_evidence = remaining

    pack.planner_handoff["contract_issues"] = validate_evidence_pack_contract(pack, stage="tool")
    pack.planner_handoff["contract_valid"] = not pack.planner_handoff["contract_issues"]
    return pack


def finalize_evidence_pack(pack: EvidencePack) -> EvidencePack:
    unique: Dict[str, EvidenceItem] = {}
    for item in pack.evidence_items:
        key = _hash_claim(f"{item.source_id}|{item.claim}|{item.support_type}")
        current = unique.get(key)
        if current is None or item.relevance > current.relevance:
            unique[key] = item

    pack.evidence_items = sorted(
        unique.values(),
        key=lambda item: (-item.source_quality, item.uncertainty, -item.relevance),
    )

    must_verify = [
        item.evidence_id
        for item in pack.evidence_items
        if item.uncertainty >= 0.4 or item.source_quality < 0.65
    ]
    suggested_tools = sorted(
        {
            str(gap.get("recommended_tool", "")).strip()
            for gap in pack.missing_evidence
            if str(gap.get("recommended_tool", "")).strip()
        }
    )
    quality_mean = (
        sum(item.source_quality for item in pack.evidence_items) / len(pack.evidence_items)
        if pack.evidence_items
        else 0.0
    )
    sufficiency = quality_mean
    if pack.missing_evidence:
        sufficiency = max(0.0, sufficiency - 0.35)
    pack.planner_handoff = {
        "sufficiency_score": round(_clamp_01(sufficiency), 3),
        "must_verify_evidence_ids": must_verify[:12],
        "suggested_tools": suggested_tools,
        "reasoning_hints": [
            "Prefer deterministic/table/tool evidence over generic narrative chunks.",
            "Keep unresolved missing_evidence explicit in final answer.",
        ],
    }
    contract_issues = validate_evidence_pack_contract(pack, stage="finalize")
    pack.planner_handoff["contract_issues"] = contract_issues
    pack.planner_handoff["contract_valid"] = not contract_issues
    pack.final_answer_allowed = False
    return pack


def build_evidence_debug_summary(pack: EvidencePack) -> str:
    parts = [
        f"pack={pack.pack_id}",
        f"route={pack.route.get('route', 'unknown')}",
        f"sources={len(pack.sources)}",
        f"evidence_items={len(pack.evidence_items)}",
        f"missing={len(pack.missing_evidence)}",
        f"sufficiency={pack.planner_handoff.get('sufficiency_score', 0)}",
    ]
    if pack.missing_evidence:
        gap_labels = [
            str(gap.get("gap_id", "")) or str(gap.get("question", ""))[:40]
            for gap in pack.missing_evidence[:3]
        ]
        parts.append("gaps=" + ",".join(gap_labels))
    return "Layered evidence: " + " | ".join(parts)


__all__ = [
    "EvidenceSource",
    "EvidenceItem",
    "RetrievalDiagnostics",
    "EvidencePack",
    "init_evidence_pack",
    "add_context_evidence",
    "add_tool_evidence",
    "finalize_evidence_pack",
    "build_evidence_debug_summary",
    "validate_evidence_pack_contract",
]
