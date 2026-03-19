from __future__ import annotations
import json
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Sequence

from fastapi import HTTPException

from .common import AgentConfig, clamp
from .builtin_tools import build_builtin_tool_definitions, execute_builtin_tool, has_builtin_tool
from .document_skill import summarize_attachments
from .evidence_pack import (
    add_context_evidence,
    build_evidence_debug_summary,
    finalize_evidence_pack,
    init_evidence_pack,
    validate_evidence_pack_contract,
)
from .image_evidence import (
    append_image_summary_to_attachment_context,
    extract_image_attachment_evidence,
    filter_out_extracted_images,
)
from .model_client import request_model as default_model_requester
from .models import ChatRequest, ChatResponse, MemoryCaptureOutcome, ToolCallRecord
from .node_bridge import NodeToolBridge
from .orchestration_helpers import (
    ContextBundle,
    ParsedModelTurn,
    ToolLoopState,
    append_tool_result_message,
    build_knowledge_context,
    build_model_messages,
    build_profile_context_text,
    build_tool_execution_error,
    extract_web_sources_from_result_payload,
    merge_web_sources,
    parse_model_turn,
)
from .planner_executor_sm import run_planner_executor
from .rag import RagEngine
from .router_gate import route_request
from .small_context_engine import build_small_context

ModelRequestFn = Callable[..., Awaitable[Dict[str, Any]]]


def split_for_stream(text: str, chunk_size: int = 48) -> List[str]:
    if not text:
        return []
    return [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]


def ensure_non_empty_reply(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text if text else fallback


def _compact_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _truncate_console_text(text: str, limit: int) -> str:
    if limit > 0 and len(text) > limit:
        return text[: max(0, limit - 15)] + "...(truncated)"
    return text


def _format_console_value(value: Any, limit: int) -> str:
    if isinstance(value, (dict, list, tuple)):
        try:
            text = json.dumps(value, ensure_ascii=False, indent=2, default=str)
        except Exception:
            text = str(value)
    else:
        text = str(value or "").strip()
    return _truncate_console_text(text, limit)


def _indent_console_block(text: str, prefix: str = "    ") -> str:
    return "\n".join(f"{prefix}{line}" if line else prefix.rstrip() for line in str(text).splitlines())


def _layered_console_log(
    config: AgentConfig,
    *,
    conversation_id: str,
    phase: str,
    payload: Mapping[str, Any],
) -> None:
    if not config.ai_layered_console_log:
        return
    max_chars = int(config.ai_layered_console_log_max_chars)
    if max_chars < 0:
        max_chars = 0
    lines = [f"[python-agent][layered][conversation={conversation_id or 'default'}][{phase}]"]
    for key, value in payload.items():
        if value in (None, "", [], {}, ()):
            continue
        formatted = _format_console_value(value, max_chars)
        if "\n" in formatted:
            lines.append(f"  {key}:")
            lines.append(_indent_console_block(formatted))
        else:
            lines.append(f"  {key}: {formatted}")
    print("\n".join(lines))


def _parse_json_object_text(text: Any) -> Dict[str, Any] | None:
    candidate = str(text or "").strip()
    if not candidate:
        return None
    if candidate.startswith("```"):
        stripped = candidate.strip("`").strip()
        if stripped.lower().startswith("json"):
            stripped = stripped[4:].strip()
        candidate = stripped
    try:
        parsed = json.loads(candidate)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if 0 <= start < end:
            try:
                parsed = json.loads(candidate[start : end + 1])
                return parsed if isinstance(parsed, dict) else None
            except Exception:
                return None
    return None


def _as_gap_list(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    resolved: List[Dict[str, Any]] = []
    for item in value:
        if isinstance(item, str):
            question = str(item).strip()
            if not question:
                continue
            lowered = _compact_text(question).lower()
            recommended_tool = "web_search"
            if any(marker in lowered for marker in ("仪表盘", "dashboard", "概览", "总览", "kpi", "指标", "运行状态")):
                recommended_tool = "get_dashboard_overview"
            elif any(marker in lowered for marker in ("趋势", "报表", "统计周期")):
                recommended_tool = "get_reports_overview"
            elif any(marker in lowered for marker in ("库存", "缺货", "预警")):
                recommended_tool = "get_inventory_overview"
            elif any(marker in lowered for marker in ("财务", "应收", "应付", "回款", "付款")):
                recommended_tool = "get_finance_overview"
            resolved.append(
                {
                    "gap_id": f"gap-{len(resolved)+1}",
                    "question": question,
                    "priority": "high" if "实时" in lowered or "当前" in lowered or "仪表盘" in lowered else "medium",
                    "recommended_tool": recommended_tool,
                }
            )
            continue
        if isinstance(item, dict):
            gap_id = str(item.get("gap_id") or item.get("id") or "").strip()
            question = str(item.get("question") or "").strip()
            recommended_tool = str(item.get("recommended_tool") or item.get("tool") or "").strip()
            if not any([gap_id, question, recommended_tool]):
                continue
            if not recommended_tool and question:
                inferred = _as_gap_list([question])
                if inferred:
                    recommended_tool = str(inferred[0].get("recommended_tool") or "").strip()
            resolved.append(
                {
                    "gap_id": gap_id or f"gap-{len(resolved)+1}",
                    "question": question or "Need additional evidence",
                    "priority": str(item.get("priority") or "medium"),
                    "recommended_tool": recommended_tool or "web_search",
                }
            )
    return resolved[:8]


def _merge_gap_lists(*values: Any) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for value in values:
        for gap in _as_gap_list(value):
            key = "|".join(
                [
                    _compact_text(gap.get("gap_id", "")).lower(),
                    _compact_text(gap.get("question", "")).lower(),
                    _compact_text(gap.get("recommended_tool", "")).lower(),
                ]
            )
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(gap)
            if len(merged) >= 8:
                return merged
    return merged


def _resolve_gaps_after_small_prefetch(
    missing_evidence: Sequence[Mapping[str, Any]],
    tool_state: ToolLoopState,
) -> List[Dict[str, Any]]:
    successful_tools = {
        _compact_text(call.name)
        for call in getattr(tool_state, "tool_calls", [])
        if _compact_text(getattr(call, "status", "")).lower() == "completed" and _compact_text(call.name)
    }
    if not successful_tools:
        return _merge_gap_lists(missing_evidence)

    remaining: List[Dict[str, Any]] = []
    for gap in _merge_gap_lists(missing_evidence):
        recommended_tool = _compact_text(gap.get("recommended_tool", ""))
        if recommended_tool and recommended_tool in successful_tools:
            continue
        remaining.append(gap)
    return remaining


def _merge_retrieval_diagnostics(current: Dict[str, Any], updates: Any) -> Dict[str, Any]:
    merged = dict(current)
    if not isinstance(updates, dict):
        return merged
    for key in ("kb_quality", "web_quality", "coverage", "ambiguity"):
        value = updates.get(key)
        if isinstance(value, (int, float)):
            merged[key] = max(0.0, min(1.0, float(value)))
    for key in ("needs_web_fallback",):
        value = updates.get(key)
        if isinstance(value, bool):
            merged[key] = value
    reason = str(updates.get("reason") or "").strip()
    if reason:
        merged["reason"] = reason[:180]
    return merged


def _preferred_runtime_tool_name(tools: Sequence[Mapping[str, Any]]) -> str:
    for tool in tools:
        tool_name = _tool_name(tool)
        if tool_name:
            return tool_name
    return "web_search"


def _with_small_prefetch_runtime_gap(
    *,
    request: ChatRequest,
    small_context: Any,
    tools: Sequence[Mapping[str, Any]],
    failure_reason: str,
) -> Any:
    existing_gaps = _merge_gap_lists(getattr(small_context, "missing_evidence", []))
    available_tool_names = {_tool_name(tool) for tool in tools if _tool_name(tool)}
    recommended_tool = next(
        (
            str(item.get("recommended_tool") or "").strip()
            for item in existing_gaps
            if isinstance(item, Mapping)
            and str(item.get("recommended_tool") or "").strip() in available_tool_names
        ),
        "",
    )
    if not recommended_tool and _is_dashboard_runtime_request(request=request, small_context=small_context, tools=tools):
        recommended_tool = "get_dashboard_overview"
    if not recommended_tool:
        recommended_tool = _preferred_runtime_tool_name(tools)
    has_runtime_gap = any(
        isinstance(item, Mapping)
        and (
            str(item.get("gap_id") or "").strip().startswith("gap-small-runtime-prefetch")
            or str(item.get("recommended_tool") or "").strip() == recommended_tool
            or "runtime evidence" in _compact_text(item.get("question", "")).lower()
        )
        for item in existing_gaps
    )
    if not has_runtime_gap:
        existing_gaps.append(
            {
                "gap_id": f"gap-small-runtime-prefetch-{recommended_tool.replace('_', '-')}",
                "question": "Need current runtime evidence because small read-only prefetch did not resolve tool-backed state.",
                "priority": "high",
                "recommended_tool": recommended_tool,
            }
        )

    diagnostics = dict(getattr(small_context, "retrieval_diagnostics", {}) or {})
    current_kb_quality = diagnostics.get("kb_quality")
    current_coverage = diagnostics.get("coverage")
    current_ambiguity = diagnostics.get("ambiguity")
    diagnostics["kb_quality"] = min(float(current_kb_quality), 0.55) if isinstance(current_kb_quality, (int, float)) else 0.55
    diagnostics["coverage"] = min(float(current_coverage), 0.35) if isinstance(current_coverage, (int, float)) else 0.35
    diagnostics["ambiguity"] = max(float(current_ambiguity), 0.7) if isinstance(current_ambiguity, (int, float)) else 0.7
    diagnostics["reason"] = failure_reason[:180]

    runtime_tool_evidence = list(getattr(small_context, "runtime_tool_evidence", []) or [])
    runtime_tool_evidence.append(
        {
            "tool_name": recommended_tool,
            "status": "disabled",
            "code": "small_read_prefetch_inconclusive",
            "claim": f"Small read-only prefetch left runtime evidence unresolved. Reason: {failure_reason[:160]}",
            "excerpt": failure_reason[:160],
            "support_type": "tool_prefetch_status",
            "source_quality": 0.35,
            "uncertainty": 0.8,
            "relevance": 0.88,
        }
    )

    notes = list(getattr(small_context, "notes", []) or [])
    notes.append("runtime_gap_preserved_after_small_prefetch_failure")
    updated = small_context.model_copy(
        update={
            "missing_evidence": existing_gaps,
            "retrieval_diagnostics": diagnostics,
            "runtime_tool_evidence": runtime_tool_evidence,
            "notes": notes,
            "final_answer_allowed": False,
        }
    )
    return _with_runtime_dashboard_gap(
        request=request,
        small_context=updated,
        tools=tools,
        failure_reason=failure_reason,
    )


def _is_dashboard_runtime_request(
    *,
    request: ChatRequest,
    small_context: Any,
    tools: Sequence[Mapping[str, Any]],
) -> bool:
    if not any(_tool_name(tool) == "get_dashboard_overview" for tool in tools):
        return False
    text = " ".join(
        [
            _compact_text(getattr(request, "prompt", "")),
            _compact_text(getattr(small_context, "query", "")),
            _compact_text(getattr(small_context, "rewritten_query", "")),
        ]
    ).lower()
    return any(marker in text for marker in ("仪表盘", "dashboard", "概览", "总览", "kpi", "指标"))


def _with_runtime_dashboard_gap(
    *,
    request: ChatRequest,
    small_context: Any,
    tools: Sequence[Mapping[str, Any]],
    failure_reason: str,
) -> Any:
    if not _is_dashboard_runtime_request(request=request, small_context=small_context, tools=tools):
        return small_context

    existing_gaps = _merge_gap_lists(getattr(small_context, "missing_evidence", []))
    has_dashboard_gap = any(
        isinstance(item, Mapping)
        and (
            str(item.get("recommended_tool") or "").strip() == "get_dashboard_overview"
            or "仪表盘" in _compact_text(item.get("question", ""))
            or "dashboard" in _compact_text(item.get("question", "")).lower()
        )
        for item in existing_gaps
    )
    if not has_dashboard_gap:
        existing_gaps.append(
            {
                "gap_id": "gap-runtime-dashboard-overview",
                "question": "Need current dashboard overview metrics and business summary from runtime tool.",
                "priority": "high",
                "recommended_tool": "get_dashboard_overview",
            }
        )

    diagnostics = dict(getattr(small_context, "retrieval_diagnostics", {}) or {})
    current_kb_quality = diagnostics.get("kb_quality")
    current_coverage = diagnostics.get("coverage")
    diagnostics["kb_quality"] = min(float(current_kb_quality), 0.55) if isinstance(current_kb_quality, (int, float)) else 0.55
    diagnostics["coverage"] = min(float(current_coverage), 0.35) if isinstance(current_coverage, (int, float)) else 0.35
    diagnostics["reason"] = failure_reason[:180]

    notes = list(getattr(small_context, "notes", []) or [])
    if "runtime_dashboard_gap_preserved_after_small_prefetch_failure" not in notes:
        notes.append("runtime_dashboard_gap_preserved_after_small_prefetch_failure")
    return small_context.model_copy(
        update={
            "missing_evidence": existing_gaps,
            "retrieval_diagnostics": diagnostics,
            "notes": notes,
            "final_answer_allowed": False,
        }
    )


_DASHBOARD_TEXT_MARKERS = (
    "dashboard",
    "overview",
    "kpi",
    "metric",
    "\u4eea\u8868\u76d8",
    "\u6982\u89c8",
    "\u603b\u89c8",
    "\u6307\u6807",
    "\u8fd0\u884c\u72b6\u6001",
)
_REPORT_TEXT_MARKERS = (
    "report",
    "trend",
    "statistics",
    "\u62a5\u8868",
    "\u8d8b\u52bf",
    "\u7edf\u8ba1",
    "\u7edf\u8ba1\u5468\u671f",
)
_INVENTORY_TEXT_MARKERS = (
    "inventory",
    "stock",
    "alert",
    "\u5e93\u5b58",
    "\u7f3a\u8d27",
    "\u9884\u8b66",
)
_FINANCE_TEXT_MARKERS = (
    "finance",
    "receivable",
    "payable",
    "receipt",
    "payment",
    "\u8d22\u52a1",
    "\u5e94\u6536",
    "\u5e94\u4ed8",
    "\u56de\u6b3e",
    "\u4ed8\u6b3e",
)


def _as_gap_list(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    resolved: List[Dict[str, Any]] = []
    for item in value:
        if isinstance(item, str):
            question = str(item).strip()
            if not question:
                continue
            lowered = _compact_text(question).lower()
            recommended_tool = "web_search"
            if any(marker in lowered for marker in _DASHBOARD_TEXT_MARKERS):
                recommended_tool = "get_dashboard_overview"
            elif any(marker in lowered for marker in _REPORT_TEXT_MARKERS):
                recommended_tool = "get_reports_overview"
            elif any(marker in lowered for marker in _INVENTORY_TEXT_MARKERS):
                recommended_tool = "get_inventory_overview"
            elif any(marker in lowered for marker in _FINANCE_TEXT_MARKERS):
                recommended_tool = "get_finance_overview"
            priority = "medium"
            if any(
                marker in lowered
                for marker in (
                    "runtime",
                    "current",
                    "live",
                    "dashboard",
                    "\u5b9e\u65f6",
                    "\u5f53\u524d",
                    "\u4eea\u8868\u76d8",
                )
            ):
                priority = "high"
            resolved.append(
                {
                    "gap_id": f"gap-{len(resolved)+1}",
                    "question": question,
                    "priority": priority,
                    "recommended_tool": recommended_tool,
                }
            )
            continue
        if isinstance(item, dict):
            gap_id = str(item.get("gap_id") or item.get("id") or "").strip()
            question = str(item.get("question") or "").strip()
            recommended_tool = str(item.get("recommended_tool") or item.get("tool") or "").strip()
            if not any([gap_id, question, recommended_tool]):
                continue
            if not recommended_tool and question:
                inferred = _as_gap_list([question])
                if inferred:
                    recommended_tool = str(inferred[0].get("recommended_tool") or "").strip()
            resolved.append(
                {
                    "gap_id": gap_id or f"gap-{len(resolved)+1}",
                    "question": question or "Need additional evidence",
                    "priority": str(item.get("priority") or "medium"),
                    "recommended_tool": recommended_tool or "web_search",
                }
            )
    return resolved[:8]


def _is_dashboard_runtime_request(
    *,
    request: ChatRequest,
    small_context: Any,
    tools: Sequence[Mapping[str, Any]],
) -> bool:
    if not any(_tool_name(tool) == "get_dashboard_overview" for tool in tools):
        return False
    text = " ".join(
        [
            _compact_text(getattr(request, "prompt", "")),
            _compact_text(getattr(small_context, "query", "")),
            _compact_text(getattr(small_context, "rewritten_query", "")),
        ]
    ).lower()
    return any(marker in text for marker in _DASHBOARD_TEXT_MARKERS)


def _with_runtime_dashboard_gap(
    *,
    request: ChatRequest,
    small_context: Any,
    tools: Sequence[Mapping[str, Any]],
    failure_reason: str,
) -> Any:
    if not _is_dashboard_runtime_request(request=request, small_context=small_context, tools=tools):
        return small_context

    existing_gaps = _merge_gap_lists(getattr(small_context, "missing_evidence", []))
    has_dashboard_gap = any(
        isinstance(item, Mapping)
        and (
            str(item.get("recommended_tool") or "").strip() == "get_dashboard_overview"
            or "\u4eea\u8868\u76d8" in _compact_text(item.get("question", ""))
            or "dashboard" in _compact_text(item.get("question", "")).lower()
        )
        for item in existing_gaps
    )
    if not has_dashboard_gap:
        existing_gaps.append(
            {
                "gap_id": "gap-runtime-dashboard-overview",
                "question": "Need current dashboard overview metrics and business summary from runtime tool.",
                "priority": "high",
                "recommended_tool": "get_dashboard_overview",
            }
        )

    diagnostics = dict(getattr(small_context, "retrieval_diagnostics", {}) or {})
    current_kb_quality = diagnostics.get("kb_quality")
    current_coverage = diagnostics.get("coverage")
    diagnostics["kb_quality"] = min(float(current_kb_quality), 0.55) if isinstance(current_kb_quality, (int, float)) else 0.55
    diagnostics["coverage"] = min(float(current_coverage), 0.35) if isinstance(current_coverage, (int, float)) else 0.35
    diagnostics["reason"] = failure_reason[:180]

    notes = list(getattr(small_context, "notes", []) or [])
    if "runtime_dashboard_gap_preserved_after_small_prefetch_failure" not in notes:
        notes.append("runtime_dashboard_gap_preserved_after_small_prefetch_failure")
    return small_context.model_copy(
        update={
            "missing_evidence": existing_gaps,
            "retrieval_diagnostics": diagnostics,
            "notes": notes,
            "final_answer_allowed": False,
        }
    )


async def _request_model_with_role(
    model_requester: ModelRequestFn,
    config: AgentConfig,
    messages: List[Dict[str, Any]],
    *,
    tools: List[Mapping[str, Any]] | None,
    tool_choice: str | None,
    role: str,
) -> Dict[str, Any]:
    try:
        return await model_requester(
            config,
            messages,
            tools=tools,  # type: ignore[arg-type]
            tool_choice=tool_choice,
            role=role,
        )
    except TypeError as error:
        if "role" not in str(error):
            raise
        return await model_requester(
            config,
            messages,
            tools=tools,  # type: ignore[arg-type]
            tool_choice=tool_choice,
        )


def _tool_access_mode(tool: Mapping[str, Any]) -> str:
    metadata = tool.get("metadata")
    if isinstance(metadata, Mapping):
        candidate = str(metadata.get("access_mode") or metadata.get("mode") or "").strip().lower()
        if candidate in {"read", "write"}:
            return candidate
    function_payload = tool.get("function")
    description = ""
    if isinstance(function_payload, Mapping):
        description = str(function_payload.get("description") or "").strip().lower()
    write_markers = (
        "approval required",
        "pending approval action",
        "require approval",
        "high-risk fields require approval",
        "apply immediately",
    )
    if any(marker in description for marker in write_markers):
        return "write"
    return "read"


def _tool_name(tool: Mapping[str, Any]) -> str:
    function_payload = tool.get("function")
    if not isinstance(function_payload, Mapping):
        return ""
    return str(function_payload.get("name") or "").strip()


def _is_web_tool(tool_name: str) -> bool:
    lowered = _compact_text(tool_name).lower()
    return "web" in lowered or "browser" in lowered


def _is_image_related_gap(gap: Mapping[str, Any]) -> bool:
    hints = ("image", "vision", "ocr", "图片", "图像", "识图", "视觉", "文字提取")
    for key in ("gap_id", "recommended_tool", "question"):
        value = _compact_text(gap.get(key, "")).lower()
        if any(hint in value for hint in hints):
            return True
    return False


def _is_image_related_gap(gap: Mapping[str, Any]) -> bool:
    hints = (
        "image",
        "vision",
        "ocr",
        "picture",
        "\u56fe\u7247",
        "\u56fe\u50cf",
        "\u8bc6\u56fe",
        "\u89c6\u89c9",
        "\u6587\u5b57\u63d0\u53d6",
    )
    for key in ("gap_id", "recommended_tool", "question"):
        value = _compact_text(gap.get(key, "")).lower()
        if any(hint in value for hint in hints):
            return True
    return False


def _filter_read_only_tools(
    tools: Sequence[Mapping[str, Any]],
    *,
    request: ChatRequest,
    missing_evidence: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    has_image_attachment = any(
        str(getattr(item, "kind", "") or "").strip().lower() == "image"
        or bool(str(getattr(item, "imageDataUrl", "") or "").strip())
        for item in request.attachments
    )
    image_gap_present = any(_is_image_related_gap(gap) for gap in missing_evidence)

    filtered: List[Dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, Mapping):
            continue
        if _tool_access_mode(tool) != "read":
            continue
        name = _tool_name(tool)
        if (has_image_attachment or image_gap_present) and _is_web_tool(name):
            continue
        filtered.append(dict(tool))
    return filtered


def _clip_context_block(value: Any, limit: int = 1200) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 15)] + "...(truncated)"


def _extract_tool_payloads_from_state(state: ToolLoopState) -> List[Dict[str, Any]]:
    payloads: List[Dict[str, Any]] = []
    for item in state.messages:
        if not isinstance(item, Mapping) or item.get("role") != "tool":
            continue
        raw_content = item.get("content")
        if not isinstance(raw_content, str):
            continue
        parsed = _parse_json_object_text(raw_content)
        if isinstance(parsed, dict):
            payloads.append(parsed)
    return payloads


def _build_small_read_prefetch_messages(
    *,
    request: ChatRequest,
    small_context: Any,
    read_only_tools: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    payload = {
        "query": getattr(small_context, "query", ""),
        "rewritten_query": getattr(small_context, "rewritten_query", ""),
        "missing_evidence": getattr(small_context, "missing_evidence", []),
        "retrieval_diagnostics": getattr(small_context, "retrieval_diagnostics", {}),
        "profile_context": _clip_context_block(getattr(small_context, "profile_context", ""), 600),
        "knowledge_context": _clip_context_block(getattr(small_context, "knowledge_context", ""), 1200),
        "attachment_context": _clip_context_block(getattr(small_context, "attachment_context", ""), 900),
        "skill_context": _clip_context_block(getattr(small_context, "skill_context", ""), 600),
        "roles": list(request.roles),
        "permissions": list(request.permissions),
        "available_read_tools": [_tool_name(tool) for tool in read_only_tools if _tool_name(tool)],
        "user_prompt": request.prompt,
    }
    return [
        {
            "role": "system",
            "content": "\n".join(
                [
                    "You are Small-Read-Executor-v1 in a layered dual-agent runtime.",
                    "You may call the provided read-only tools to collect concrete runtime evidence before large-model synthesis.",
                    "Prefer tools when the user asks about current, real-time, account-specific, or operational system state.",
                    "Do not answer the user directly.",
                    "When enough evidence is collected, return JSON only with keys: tool_summary, evidence_notes, missing_evidence, retrieval_diagnostics, final_answer_allowed.",
                    "final_answer_allowed must be false.",
                ]
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]


def _build_small_read_tool_context(
    *,
    tool_state: ToolLoopState,
    summary_payload: Mapping[str, Any] | None,
) -> str:
    lines = ["Small read-only tool evidence:"]
    summary = ""
    if isinstance(summary_payload, Mapping):
        summary = _compact_text(summary_payload.get("tool_summary") or summary_payload.get("summary") or "")
    if summary:
        lines.append(f"Summary: {summary}")
    payloads = _extract_tool_payloads_from_state(tool_state)
    for index, record in enumerate(tool_state.tool_calls, start=1):
        payload = payloads[index - 1] if index - 1 < len(payloads) else {}
        claim = _compact_text(payload.get("summary") or record.summary)
        context = _compact_text(payload.get("context", ""))
        line = f"{index}. {record.name} -> {claim or record.summary}"
        if context:
            line += f" | context: {context}"
        lines.append(line)
    return "\n".join(lines)


def _build_small_read_tool_evidence(tool_state: ToolLoopState) -> List[Dict[str, Any]]:
    payloads = _extract_tool_payloads_from_state(tool_state)
    evidence: List[Dict[str, Any]] = []
    for index, record in enumerate(tool_state.tool_calls, start=1):
        payload = payloads[index - 1] if index - 1 < len(payloads) else {}
        summary = _compact_text(payload.get("summary") or record.summary)
        context = _compact_text(payload.get("context", ""))
        evidence.append(
            {
                "tool_name": record.name,
                "status": record.status,
                "code": payload.get("code"),
                "claim": summary or record.summary,
                "excerpt": context or summary or record.summary,
                "support_type": "tool_prefetch_result",
                "source_quality": 0.95 if bool(payload.get("ok", False)) else 0.55,
                "uncertainty": 0.1 if bool(payload.get("ok", False)) else 0.35,
                "relevance": 0.9,
            }
        )
    return evidence


def _has_successful_small_prefetch_evidence(runtime_tool_evidence: Sequence[Mapping[str, Any]]) -> bool:
    for item in runtime_tool_evidence:
        try:
            source_quality = float(item.get("source_quality", 0.0))
        except (TypeError, ValueError):
            source_quality = 0.0
        status = _compact_text(item.get("status", "")).lower()
        if source_quality >= 0.85 and status not in {"disabled", "cancelled", "reverted"}:
            return True
    return False


async def _maybe_prefetch_read_tools_with_small(
    *,
    request: ChatRequest,
    config: AgentConfig,
    node_bridge: NodeToolBridge,
    model_requester: ModelRequestFn,
    small_context: Any,
    tools: Sequence[Mapping[str, Any]],
    trace: List[str],
) -> tuple[Any, ToolLoopState | None]:
    read_only_tools = _filter_read_only_tools(
        tools,
        request=request,
        missing_evidence=getattr(small_context, "missing_evidence", []),
    )
    if not read_only_tools:
        trace.append("Layered context: no read-only tools available for small prefetch.")
        return small_context, None
    if not config.is_model_profile_configured("small"):
        trace.append("Layered context: small read-tool prefetch skipped because small model is not configured.")
        return (
            _with_small_prefetch_runtime_gap(
                request=request,
                small_context=small_context,
                tools=read_only_tools,
                failure_reason="small read-tool prefetch unavailable: small model is not configured",
            ),
            None,
        )

    prefetch_messages = _build_small_read_prefetch_messages(
        request=request,
        small_context=small_context,
        read_only_tools=read_only_tools,
    )
    try:
        tool_state = await run_model_tool_loop(
            request=request,
            config=config,
            node_bridge=node_bridge,
            messages=prefetch_messages,
            tools=list(read_only_tools),
            model_requester=model_requester,
            trace=trace,
            role="small",
            trace_prefix="Small read loop",
            max_rounds=3,
        )
    except Exception as error:
        trace.append(f"Layered context: small read-tool prefetch unavailable: {error}")
        return (
            _with_small_prefetch_runtime_gap(
                request=request,
                small_context=small_context,
                tools=read_only_tools,
                failure_reason=f"small read-tool prefetch failed: {error}",
            ),
            None,
        )

    summary_payload = _parse_json_object_text(tool_state.reply)
    if not tool_state.tool_calls:
        merged_missing_evidence = _merge_gap_lists(
            getattr(small_context, "missing_evidence", []),
            summary_payload.get("missing_evidence") if isinstance(summary_payload, dict) else [],
        )
        merged_diagnostics = _merge_retrieval_diagnostics(
            dict(getattr(small_context, "retrieval_diagnostics", {}) or {}),
            summary_payload.get("retrieval_diagnostics") if isinstance(summary_payload, dict) else None,
        )
        updated = small_context.model_copy(
            update={
                "missing_evidence": merged_missing_evidence or list(getattr(small_context, "missing_evidence", [])),
                "retrieval_diagnostics": merged_diagnostics,
                "final_answer_allowed": False,
            }
        )
        updated = _with_small_prefetch_runtime_gap(
            request=request,
            small_context=updated,
            tools=read_only_tools,
            failure_reason="small read-tool prefetch returned no runtime evidence",
        )
        return updated, None

    runtime_tool_context = _build_small_read_tool_context(
        tool_state=tool_state,
        summary_payload=summary_payload,
    )
    runtime_tool_evidence = _build_small_read_tool_evidence(tool_state)
    notes = list(getattr(small_context, "notes", []) or [])
    notes.append("small_read_tools_prefetched")
    merged_missing_evidence = _merge_gap_lists(
        getattr(small_context, "missing_evidence", []),
        summary_payload.get("missing_evidence") if isinstance(summary_payload, dict) else [],
    )
    resolved_missing_evidence = _resolve_gaps_after_small_prefetch(
        merged_missing_evidence,
        tool_state,
    )
    merged_diagnostics = _merge_retrieval_diagnostics(
        dict(getattr(small_context, "retrieval_diagnostics", {}) or {}),
        summary_payload.get("retrieval_diagnostics") if isinstance(summary_payload, dict) else None,
    )
    updated = small_context.model_copy(
        update={
            "runtime_tool_context": runtime_tool_context,
            "runtime_tool_evidence": runtime_tool_evidence,
            "missing_evidence": resolved_missing_evidence,
            "retrieval_diagnostics": merged_diagnostics,
            "notes": notes,
            "final_answer_allowed": False,
        }
    )
    if not _has_successful_small_prefetch_evidence(runtime_tool_evidence):
        trace.append("Layered context: small read-tool prefetch produced no reliable runtime evidence.")
        updated = _with_small_prefetch_runtime_gap(
            request=request,
            small_context=updated,
            tools=read_only_tools,
            failure_reason="small read-tool prefetch did not produce reliable runtime evidence",
        )
    return updated, tool_state


async def _maybe_refine_small_context_with_model(
    *,
    request: ChatRequest,
    config: AgentConfig,
    model_requester: ModelRequestFn,
    small_context: Any,
    trace: List[str],
) -> Any:
    query_rewrites = getattr(small_context, "query_rewrites", {})
    has_attachments = bool(getattr(request, "attachments", []))
    has_images = any(
        str(getattr(item, "kind", "") or "").strip().lower() == "image"
        or bool(str(getattr(item, "imageDataUrl", "") or "").strip())
        for item in getattr(request, "attachments", [])
    )
    modalities = ["text"]
    if has_attachments:
        modalities.extend(["table", "document"])
    if has_images:
        modalities.append("image")
    payload = {
        "query": getattr(small_context, "query", ""),
        "rewritten_query": getattr(small_context, "rewritten_query", ""),
        "query_rewrites": query_rewrites if isinstance(query_rewrites, dict) else {},
        "missing_evidence": getattr(small_context, "missing_evidence", []),
        "retrieval_diagnostics": getattr(small_context, "retrieval_diagnostics", {}),
        "table_views": getattr(small_context, "table_views", []),
        "modalities": modalities,
    }
    messages = [
        {
            "role": "system",
            "content": "\n".join(
                [
                    "You are Context-Engine-v1 in a layered dual-agent runtime.",
                    "Never answer the user.",
                    "Return JSON only with keys: rewritten_query, query_rewrites, missing_evidence, retrieval_diagnostics, notes, final_answer_allowed.",
                    "final_answer_allowed must be false.",
                ]
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    try:
        model_payload = await _request_model_with_role(
            model_requester,
            config,
            messages,
            tools=None,
            tool_choice="none",
            role="small",
        )
        parsed = parse_model_turn(model_payload)
        updates = _parse_json_object_text(parsed.content)
        if not isinstance(updates, dict):
            trace.append("Layered context: small model refinement skipped (non-JSON response).")
            return small_context

        rewritten_query = str(updates.get("rewritten_query") or "").strip()
        merged_query_rewrites = dict(getattr(small_context, "query_rewrites", {}) or {})
        if isinstance(updates.get("query_rewrites"), dict):
            for key, value in updates["query_rewrites"].items():
                if value not in (None, "", [], {}):
                    merged_query_rewrites[str(key)] = value
        if rewritten_query:
            merged_query_rewrites.setdefault("exact_query", rewritten_query)

        merged_missing_evidence = _merge_gap_lists(
            getattr(small_context, "missing_evidence", []),
            updates.get("missing_evidence"),
        )
        merged_diagnostics = _merge_retrieval_diagnostics(
            dict(getattr(small_context, "retrieval_diagnostics", {}) or {}),
            updates.get("retrieval_diagnostics"),
        )
        notes = list(getattr(small_context, "notes", []) or [])
        notes.append("small_model_refined")
        return small_context.model_copy(
            update={
                "rewritten_query": rewritten_query or getattr(small_context, "rewritten_query", ""),
                "query_rewrites": merged_query_rewrites,
                "missing_evidence": merged_missing_evidence,
                "retrieval_diagnostics": merged_diagnostics,
                "notes": notes,
                "final_answer_allowed": False,
            }
        )
    except Exception as error:
        trace.append(f"Layered context: small model refinement unavailable: {error}")
        return small_context


def build_memory_capture_outcome(
    *,
    captured: bool,
    reason: Optional[str],
    error: Optional[str] = None,
) -> MemoryCaptureOutcome:
    return MemoryCaptureOutcome(
        captured=captured,
        owner="python",
        reason=reason,
        error=error,
    )


async def capture_memory_outcome(
    *,
    node_bridge: NodeToolBridge,
    prompt: str,
    reply: str,
    request: ChatRequest,
    citations: List[str],
    trace: List[str],
) -> MemoryCaptureOutcome:
    if not prompt or not reply:
        return build_memory_capture_outcome(captured=False, reason="empty_prompt_or_reply")
    try:
        result = await node_bridge.capture_conversation_memory(
            token=request.token,
            prompt=prompt,
            reply=reply,
            tenant_id=request.tenantId,
            session_id=request.conversationId,
            citations=citations,
        )
        if isinstance(result, dict) and result.get("captured") is True:
            reason = str(result.get("mode") or "captured")
            return build_memory_capture_outcome(captured=True, reason=reason)
        if isinstance(result, dict):
            reason = str(result.get("reason") or "capture_failed")
        else:
            reason = "capture_failed"
        trace.append(f"Conversation memory capture failed: {reason}")
        return build_memory_capture_outcome(captured=False, reason=reason)
    except Exception as error:
        trace.append(f"Conversation memory capture exception: {error}")
        return build_memory_capture_outcome(captured=False, reason="exception", error=str(error))


def build_document_tool_calls(raw_tool_calls: Sequence[Any]) -> List[ToolCallRecord]:
    tool_calls: List[ToolCallRecord] = []
    for item in raw_tool_calls:
        if not isinstance(item, dict):
            continue
        tool_calls.append(
            ToolCallRecord(
                name=str(item.get("name", "document_skill")),
                status=str(item.get("status", "completed")),
                summary=str(item.get("summary", "")),
            )
        )
    return tool_calls


async def maybe_handle_document_request(
    *,
    request: ChatRequest,
    config: AgentConfig,
    node_bridge: NodeToolBridge,
    trace: List[str],
) -> Optional[ChatResponse]:
    if not request.attachments:
        return None

    try:
        document_result = await node_bridge.handle_document_skill(request)
    except Exception as error:
        trace.append(f"Document skill check failed: {error}")
        return None

    if not document_result.get("handled"):
        trace.append("Document skill check: no executable action, continue normal orchestration.")
        return None

    document_reply = ensure_non_empty_reply(
        document_result.get("reply"),
        "Attachment processed, but no displayable reply was returned.",
    )
    citations = [
        str(citation)
        for citation in document_result.get("citations", [])
        if isinstance(citation, str)
    ]
    memory_capture = await capture_memory_outcome(
        node_bridge=node_bridge,
        prompt=request.prompt.strip(),
        reply=document_reply,
        request=request,
        citations=citations,
        trace=trace,
    )
    return ChatResponse(
        reply=document_reply,
        toolCalls=build_document_tool_calls(document_result.get("toolCalls", [])),
        citations=citations,
        pendingAction=document_result.get("pendingAction")
        if isinstance(document_result.get("pendingAction"), dict)
        else None,
        approval=document_result.get("approval")
        if isinstance(document_result.get("approval"), dict)
        else None,
        memoryCapture=memory_capture,
        reasoningContent=None,
        configured=bool(document_result.get("configured", False)),
        provider=str(document_result.get("provider") or config.normalized_provider()),
        model=str(document_result.get("model") or config.active_model()),
        note=str(document_result.get("note") or "Document skill handled by node internal route."),
        trace=[
            *[
                str(item)
                for item in document_result.get("trace", [])
                if isinstance(item, str)
            ],
            *trace,
            "Document skill handled by python runtime via node internal bridge.",
        ],
    )


def resolve_retrieval_mode(config: AgentConfig) -> str:
    retrieval_mode = config.rag_retrieval_mode
    if retrieval_mode not in {"dense", "lexical", "hybrid"}:
        return "hybrid"
    return retrieval_mode


async def resolve_context_bundle(
    *,
    request: ChatRequest,
    prompt: str,
    config: AgentConfig,
    node_bridge: NodeToolBridge,
    rag: RagEngine,
    trace: List[str],
) -> ContextBundle:
    skill_context = "No matched skill context."
    matched_skill_names: List[str] = []
    try:
        skill_payload = await node_bridge.match_skills(prompt or "attachments", request.token, limit=4)
        matched_items = skill_payload.get("matchedSkills", [])
        if isinstance(matched_items, list):
            matched_skill_names = [
                str(item.get("name"))
                for item in matched_items
                if isinstance(item, dict) and item.get("name")
            ]
        raw_context = skill_payload.get("context")
        if isinstance(raw_context, str) and raw_context.strip():
            skill_context = raw_context.strip()
        trace.append(
            f"Skill match: {len(matched_skill_names)} matched "
            f"(available={int(skill_payload.get('availableSkillCount', 0))})."
        )
    except Exception as error:
        trace.append(f"Skill matching unavailable: {error}")

    profile_payload: Dict[str, Any] = {"profile": {}, "records": [], "updatedAt": "", "updatedBy": ""}
    try:
        profile_payload = await node_bridge.get_memory_profile(
            token=request.token,
            scope="effective",
            tenant_id=request.tenantId,
            user_id=request.userId,
            session_id=request.conversationId,
        )
        trace.append("Profile memory resolved via node bridge memory/profile.")
    except Exception as error:
        trace.append(f"Profile memory bridge unavailable: {error}")
    profile_context = build_profile_context_text(profile_payload)

    retrieval_mode = resolve_retrieval_mode(config)
    chunks = await rag.retrieve(
        prompt=prompt,
        limit=max(1, min(10, config.rag_top_k)),
        candidate_limit=max(config.rag_top_k + 2, min(100, config.rag_candidate_k)),
        min_score=clamp(config.rag_min_score, 0.0, 2.0),
        scope=(
            config.rag_scope_default
            if config.rag_scope_default in {"global", "tenant", "user", "session", "all"}
            else "all"
        ),
        tenant_id=request.tenantId,
        user_id=request.userId,
        session_id=request.conversationId,
    )
    citations = [str(item.get("citation", "")) for item in chunks if item.get("citation")]
    knowledge_context = build_knowledge_context(chunks)

    attachment_context = ""
    if request.attachments:
        try:
            attachment_context = await node_bridge.build_document_context(request)
            if attachment_context:
                trace.append("Attachment context resolved via node bridge document/context.")
        except Exception as error:
            trace.append(f"Attachment context bridge unavailable: {error}")
    if not attachment_context:
        attachment_context = summarize_attachments(request.attachments)

    trace.extend(
        [
            f"Profile memory records: {len(profile_payload.get('records', []))}",
            f"RAG retrieval mode: {retrieval_mode}",
            f"RAG chunks matched: {len(chunks)}",
        ]
    )
    if matched_skill_names:
        trace.append(f"Skills injected: {', '.join(matched_skill_names)}")

    try:
        tools = await node_bridge.get_tools_schema(request.token)
        trace.append(f"Visible runtime tools: {len(tools)}")
    except Exception as error:
        tools = []
        trace.append(f"Tool schema fetch failed: {error}")
    builtin_tools = build_builtin_tool_definitions(config)
    if builtin_tools:
        existing_names = {
            str((item.get("function") or {}).get("name") or "").strip()
            for item in tools
            if isinstance(item, dict)
        }
        appended = [
            item
            for item in builtin_tools
            if str((item.get("function") or {}).get("name") or "").strip() not in existing_names
        ]
        if appended:
            tools.extend(appended)
            trace.append(f"Builtin runtime tools appended: {len(appended)}")

    return ContextBundle(
        profile_payload=profile_payload,
        profile_context=profile_context,
        chunks=chunks,
        citations=citations,
        knowledge_context=knowledge_context,
        attachment_context=attachment_context,
        skill_context=skill_context,
        matched_skill_names=matched_skill_names,
        tools=tools,
        retrieval_mode=retrieval_mode,
    )


def build_unconfigured_reply(
    *,
    request: ChatRequest,
    chunks: Sequence[Dict[str, Any]],
    knowledge_context: str,
    attachment_context: str,
) -> str:
    fallback = "Model API key is not configured."
    if chunks:
        fallback = "Model is not configured. Returning retrieved knowledge summary only."
    if request.attachments:
        return fallback + "\n\nAttachment summary:\n" + attachment_context
    if chunks:
        return fallback + "\n\n" + knowledge_context
    return fallback


async def build_unconfigured_response(
    *,
    request: ChatRequest,
    prompt: str,
    config: AgentConfig,
    node_bridge: NodeToolBridge,
    context: ContextBundle,
    trace: List[str],
) -> ChatResponse:
    reply = build_unconfigured_reply(
        request=request,
        chunks=context.chunks,
        knowledge_context=context.knowledge_context,
        attachment_context=context.attachment_context,
    )
    memory_capture = await capture_memory_outcome(
        node_bridge=node_bridge,
        prompt=prompt,
        reply=reply,
        request=request,
        citations=context.citations,
        trace=trace,
    )
    return ChatResponse(
        reply=reply,
        toolCalls=[],
        citations=context.citations,
        memoryCapture=memory_capture,
        configured=False,
        provider=config.normalized_provider(),
        model=config.active_model(),
        note="AI model unavailable. Returned local context only.",
        trace=trace,
    )


async def run_model_tool_loop(
    *,
    request: ChatRequest,
    config: AgentConfig,
    node_bridge: NodeToolBridge,
    messages: List[Dict[str, Any]],
    tools: List[Dict[str, Any]],
    model_requester: ModelRequestFn,
    trace: List[str],
    role: str = "large",
    trace_prefix: str = "Tool loop",
    max_rounds: int = 5,
) -> ToolLoopState:
    state = ToolLoopState(messages=messages, resolved_model=config.resolve_model_profile(role)["model"])

    for round_id in range(1, max_rounds + 1):
        payload = await _request_model_with_role(
            model_requester,
            config,
            state.messages,
            tools=tools,
            tool_choice="auto" if tools else "none",
            role=role,
        )
        parsed = parse_model_turn(payload)
        if parsed.resolved_model:
            state.resolved_model = parsed.resolved_model

        if not parsed.tool_calls:
            state.reply = parsed.content or state.reply
            if not str(state.reply).strip():
                state.reply = "No final answer was generated. Please retry."
                trace.append(
                    f"{trace_prefix} round {round_id}: model returned empty content without tool call; fallback reply injected."
                )
            state.reasoning_content = parsed.reasoning or state.reasoning_content
            trace.append(f"{trace_prefix} round {round_id}: no tool call, finalize response.")
            return state

        trace.append(f"{trace_prefix} round {round_id}: model requested {len(parsed.tool_calls)} tool calls.")
        assistant_tool_message: Dict[str, Any] = {
            "role": "assistant",
            "content": parsed.message.get("content") or "",
            "tool_calls": parsed.tool_calls,
        }
        if parsed.provider_parts:
            assistant_tool_message["provider_parts"] = parsed.provider_parts
        # DeepSeek reasoner requires reasoning_content when the assistant message contains tool_calls.
        if config.requires_reasoning_for_tool_calls(role):
            assistant_tool_message["reasoning_content"] = parsed.reasoning or ""
        state.messages.append(assistant_tool_message)

        for index, call in enumerate(parsed.tool_calls):
            fn_info = call.get("function", {})
            fn_name = str(fn_info.get("name") if isinstance(fn_info, dict) else "")
            fn_args = str(fn_info.get("arguments") if isinstance(fn_info, dict) else "{}")
            if not fn_name:
                continue

            if has_builtin_tool(config, fn_name):
                try:
                    execution = await execute_builtin_tool(config, fn_name, fn_args)
                except Exception as error:
                    execution = build_tool_execution_error(fn_name, error)
            else:
                try:
                    execution = await node_bridge.execute_tool(fn_name, fn_args, request)
                except Exception as error:
                    execution = build_tool_execution_error(fn_name, error)

            tool_call_payload = execution.get("toolCall", {})
            if isinstance(tool_call_payload, dict):
                state.tool_calls.append(
                    ToolCallRecord(
                        name=str(tool_call_payload.get("name", fn_name)),
                        status=str(tool_call_payload.get("status", "disabled")),
                        summary=str(tool_call_payload.get("summary", "")),
                    )
                )

            result_payload = execution.get("result", {})
            if not isinstance(result_payload, dict):
                result_payload = {}

            if isinstance(result_payload.get("pendingAction"), dict):
                state.pending_action = result_payload["pendingAction"]
            if isinstance(result_payload.get("approval"), dict):
                state.approval = result_payload["approval"]
            if isinstance(execution.get("pendingAction"), dict):
                state.pending_action = execution["pendingAction"]
            if isinstance(execution.get("approval"), dict):
                state.approval = execution["approval"]

            state.web_sources = merge_web_sources(
                state.web_sources,
                extract_web_sources_from_result_payload(result_payload, fallback_source_type=fn_name),
            )

            append_tool_result_message(
                state=state,
                call=call,
                result_payload=result_payload,
                round_id=round_id,
                index=index,
            )

    payload = await _request_model_with_role(
        model_requester,
        config,
        state.messages,
        tools=None,
        tool_choice="none",
        role=role,
    )
    parsed = parse_model_turn(payload)
    if parsed.resolved_model:
        state.resolved_model = parsed.resolved_model
    state.reply = parsed.content or "Tools executed, but model returned no final answer."
    state.reasoning_content = parsed.reasoning or state.reasoning_content
    trace.append(f"{trace_prefix} reached max rounds; requested final non-tool response.")
    return state


async def build_configured_response(
    *,
    request: ChatRequest,
    prompt: str,
    config: AgentConfig,
    node_bridge: NodeToolBridge,
    context: ContextBundle,
    tool_state: ToolLoopState,
    trace: List[str],
    layered_note: str | None = None,
    answer_meta: Optional[Dict[str, Any]] = None,
) -> ChatResponse:
    resolved_reply = ensure_non_empty_reply(
        tool_state.reply,
        "No displayable answer was generated. Please retry with more details.",
    )
    memory_capture = await capture_memory_outcome(
        node_bridge=node_bridge,
        prompt=prompt,
        reply=resolved_reply,
        request=request,
        citations=context.citations,
        trace=trace,
    )
    return ChatResponse(
        reply=resolved_reply,
        toolCalls=tool_state.tool_calls,
        citations=context.citations,
        webSources=tool_state.web_sources,
        pendingAction=tool_state.pending_action,
        approval=tool_state.approval,
        memoryCapture=memory_capture,
        answer_meta=answer_meta,
        reasoningContent=tool_state.reasoning_content or None,
        configured=True,
        provider=config.normalized_provider(),
        model=tool_state.resolved_model,
        note=((layered_note + " | ") if layered_note else "")
        + (
            "RAG(v2) enabled: LanceDB+embedding+hybrid+rerank+MMR, "
            f"chunks={len(context.chunks)}, tools={len(tool_state.tool_calls)}"
        ),
        trace=trace,
    )


async def run_chat(
    request: ChatRequest,
    *,
    config: AgentConfig,
    node_bridge: NodeToolBridge,
    rag: RagEngine,
    model_requester: ModelRequestFn = default_model_requester,
) -> ChatResponse:
    prompt = request.prompt.strip()
    if not prompt and not request.attachments:
        raise HTTPException(status_code=400, detail="Prompt or attachments is required")

    trace: List[str] = []
    document_response = await maybe_handle_document_request(
        request=request,
        config=config,
        node_bridge=node_bridge,
        trace=trace,
    )
    if document_response is not None:
        return document_response

    context = await resolve_context_bundle(
        request=request,
        prompt=prompt,
        config=config,
        node_bridge=node_bridge,
        rag=rag,
        trace=trace,
    )

    configured = config.is_model_configured()
    if not configured:
        return await build_unconfigured_response(
            request=request,
            prompt=prompt,
            config=config,
            node_bridge=node_bridge,
            context=context,
            trace=trace,
        )

    async def execute_runtime_tool(tool_name: str, raw_arguments: str, runtime_request: ChatRequest):
        if has_builtin_tool(config, tool_name):
            return await execute_builtin_tool(config, tool_name, raw_arguments)
        return await node_bridge.execute_tool(tool_name, raw_arguments, runtime_request)

    layered_note: str | None = None
    answer_meta: Optional[Dict[str, Any]] = None
    if config.ai_layered_agent_enabled:
        small_prefetch_tool_state: ToolLoopState | None = None
        conversation_id = request.conversationId or "default"
        decision = route_request(
            request,
            prompt=prompt,
            rag_chunk_count=len(context.chunks),
            has_attachments=bool(request.attachments),
        )
        trace.append(
            "Layered router decision: "
            f"route={decision.route}, intention={decision.intention}, complexity={decision.complexity}, "
            f"modalities={','.join(decision.modalities)}"
        )
        _layered_console_log(
            config,
            conversation_id=conversation_id,
            phase="router",
            payload={
                "route": decision.route,
                "intention": decision.intention,
                "complexity": decision.complexity,
                "modalities": ",".join(decision.modalities),
                "web_fallback_allowed": decision.web_fallback_allowed,
                "reason_codes": ",".join(decision.reason_codes),
            },
        )
        small_context = build_small_context(
            request=request,
            context=context,
            decision=decision,
            char_budget=config.ai_layered_context_char_budget,
        )
        small_context = await _maybe_refine_small_context_with_model(
            request=request,
            config=config,
            model_requester=model_requester,
            small_context=small_context,
            trace=trace,
        )
        image_evidence_result = await extract_image_attachment_evidence(
            request=request,
            rewritten_query=small_context.rewritten_query,
            config=config,
            model_requester=model_requester,
            trace=trace,
        )
        if image_evidence_result.evidence:
            updated_attachment_context = append_image_summary_to_attachment_context(
                small_context.attachment_context or context.attachment_context,
                image_evidence_result.summary_lines,
            )
            updated_notes = list(small_context.notes)
            updated_notes.append("image_evidence_extracted_by_small_model")
            small_context = small_context.model_copy(
                update={
                    "attachment_context": updated_attachment_context,
                    "attachment_evidence": list(small_context.attachment_evidence) + list(image_evidence_result.evidence),
                    "notes": updated_notes,
                }
            )
        small_context, small_prefetch_tool_state = await _maybe_prefetch_read_tools_with_small(
            request=request,
            config=config,
            node_bridge=node_bridge,
            model_requester=model_requester,
            small_context=small_context,
            tools=context.tools,
            trace=trace,
        )
        if small_prefetch_tool_state is not None:
            _layered_console_log(
                config,
                conversation_id=conversation_id,
                phase="small_read_prefetch",
                payload={
                    "tool_calls": len(small_prefetch_tool_state.tool_calls),
                    "summary": small_context.runtime_tool_context,
                },
            )
        trace.extend([f"Layered context: {note}" for note in small_context.notes])
        _layered_console_log(
            config,
            conversation_id=conversation_id,
            phase="small_context",
            payload={
                "rewritten_query": small_context.rewritten_query,
                "history_turns": len(small_context.history),
                "chunks": len(small_context.chunks),
                "table_views": len(small_context.table_views),
                "missing_evidence": len(small_context.missing_evidence),
                "kb_quality": small_context.retrieval_diagnostics.get("kb_quality"),
                "coverage": small_context.retrieval_diagnostics.get("coverage"),
                "runtime_tools": len(small_context.runtime_tool_evidence),
            },
        )

        handoff_request = filter_out_extracted_images(request, image_evidence_result.extracted_indices)
        messages = build_model_messages(
            handoff_request,
            small_context.profile_context or context.profile_context,
            small_context.knowledge_context or context.knowledge_context,
            small_context.attachment_context or context.attachment_context,
            small_context.skill_context or context.skill_context,
            runtime_tool_context=small_context.runtime_tool_context,
            history_messages_override=small_context.history,
            system_mode="planner_executor",
        )
        evidence_pack = init_evidence_pack(
            request=request,
            decision=decision,
            small_context=small_context,
        )
        add_context_evidence(
            evidence_pack,
            context=context,
            small_context=small_context,
        )
        finalize_evidence_pack(evidence_pack)
        contract_issues = validate_evidence_pack_contract(evidence_pack, stage="orchestration")
        if contract_issues:
            trace.extend([f"Evidence pack contract issue: {issue}" for issue in contract_issues])
        _layered_console_log(
            config,
            conversation_id=conversation_id,
            phase="small_to_large_handoff",
            payload={
                "pack_id": evidence_pack.pack_id,
                "sources": len(evidence_pack.sources),
                "evidence_items": len(evidence_pack.evidence_items),
                "missing_evidence": len(evidence_pack.missing_evidence),
                "sufficiency": evidence_pack.planner_handoff.get("sufficiency_score", 0),
                "suggested_tools": ",".join(evidence_pack.planner_handoff.get("suggested_tools", [])),
            },
        )

        def planner_debug_hook(event: str, payload: Dict[str, Any]) -> None:
            _layered_console_log(
                config,
                conversation_id=conversation_id,
                phase=f"large_{event}",
                payload=payload,
            )

        runtime_state = await run_planner_executor(
            request=request,
            config=config,
            model_requester=model_requester,
            tool_executor=execute_runtime_tool,
            decision=decision,
            small_context=small_context,
            messages=messages,
            tools=context.tools,
            evidence_pack=evidence_pack,
            trace=trace,
            debug_hook=planner_debug_hook,
        )
        tool_state = runtime_state.tool_state
        if small_prefetch_tool_state is not None:
            tool_state.tool_calls = list(small_prefetch_tool_state.tool_calls) + list(tool_state.tool_calls)
            tool_state.web_sources = merge_web_sources(
                list(small_prefetch_tool_state.web_sources),
                list(tool_state.web_sources),
            )
        trace = runtime_state.trace
        answer_meta = dict(runtime_state.answer_meta) if runtime_state.answer_meta else None
        layered_note = (
            f"layered route={decision.route}, evidence={len(runtime_state.evidence_pack.evidence_items)}, "
            f"missing={len(runtime_state.evidence_pack.missing_evidence)}"
        )
        trace.append(build_evidence_debug_summary(runtime_state.evidence_pack))
        _layered_console_log(
            config,
            conversation_id=conversation_id,
            phase="final",
            payload={
                "model": tool_state.resolved_model,
                "tool_calls": len(tool_state.tool_calls),
                "missing_evidence": len(runtime_state.evidence_pack.missing_evidence),
                "reply_preview": tool_state.reply,
            },
        )
    else:
        messages = build_model_messages(
            request,
            context.profile_context,
            context.knowledge_context,
            context.attachment_context,
            context.skill_context,
        )
        tool_state = await run_model_tool_loop(
            request=request,
            config=config,
            node_bridge=node_bridge,
            messages=messages,
            tools=context.tools,
            model_requester=model_requester,
            trace=trace,
        )

    return await build_configured_response(
        request=request,
        prompt=prompt,
        config=config,
        node_bridge=node_bridge,
        context=context,
        tool_state=tool_state,
        trace=trace,
        layered_note=layered_note,
        answer_meta=answer_meta,
    )
