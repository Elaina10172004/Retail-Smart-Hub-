from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Sequence

from .evidence_pack import (
    EvidencePack,
    add_tool_evidence,
    finalize_evidence_pack,
    validate_evidence_pack_contract,
)
from .models import ToolCallRecord
from .orchestration_helpers import (
    ParsedModelTurn,
    ToolLoopState,
    append_tool_result_message,
    build_tool_execution_error,
    extract_web_sources_from_result_payload,
    merge_web_sources,
    parse_model_turn,
)
from .router_gate import RouterDecision, gate_execution
from .small_context_engine import SmallContext

ModelRequestFn = Callable[..., Awaitable[Dict[str, Any]]]
ToolExecutorFn = Callable[[str, str, Any], Awaitable[Dict[str, Any]]]
DebugHookFn = Callable[[str, Dict[str, Any]], None]


class PlannerState(str, Enum):
    PLAN = "PLAN"
    EXECUTE = "EXECUTE"
    ANSWER = "ANSWER"
    DONE = "DONE"
    FAILED = "FAILED"


@dataclass
class PlannerRuntimeState:
    phase: PlannerState
    tool_state: ToolLoopState
    evidence_pack: EvidencePack
    plan: List[str] = field(default_factory=list)
    plan_json: Dict[str, Any] | None = None
    answer_meta: Dict[str, Any] = field(default_factory=dict)
    trace: List[str] = field(default_factory=list)


def _compact_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _preview_value(value: Any, *, limit: int = 1200) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return _compact_text(value)[:limit]
    if isinstance(value, (int, float, bool)):
        return _compact_text(value)[:limit]
    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        text = str(value)
    return _compact_text(text)[:limit]


def _has_noisy_payload(payload: Mapping[str, Any]) -> bool:
    context = str(payload.get("context", ""))
    summary = str(payload.get("summary", ""))
    data = payload.get("data")
    serialized_data = str(data)
    if len(context) > 1200 or len(summary) > 800:
        return True
    if isinstance(data, (list, dict)) and len(serialized_data) > 1200:
        return True
    return context.count("\n") > 12


def _repack_noisy_payload(tool_name: str, payload: Mapping[str, Any]) -> Dict[str, Any]:
    summary = _compact_text(payload.get("summary", "")) or _compact_text(payload.get("message", ""))
    context = _compact_text(payload.get("context", ""))
    code = _compact_text(payload.get("code", "")) or ("ok" if payload.get("ok") else "execution_error")
    data_preview = _preview_value(payload.get("data"), limit=320)
    return {
        "ok": bool(payload.get("ok", False)),
        "code": code,
        "message": _compact_text(payload.get("message", ""))[:260],
        "summary": (summary or f"{tool_name}:{code}")[:260],
        "context": context[:260],
        "data": data_preview[:320],
    }


def _normalize_repacked_payload(
    *,
    tool_name: str,
    original_payload: Mapping[str, Any],
    repacked_payload: Mapping[str, Any],
) -> Dict[str, Any]:
    summary = _compact_text(repacked_payload.get("summary", "")) or _compact_text(original_payload.get("summary", ""))
    if not summary:
        summary = _compact_text(repacked_payload.get("message", "")) or _compact_text(original_payload.get("message", ""))
    context = _compact_text(repacked_payload.get("context", ""))
    if not context:
        context = _compact_text(original_payload.get("context", ""))
    code = _compact_text(repacked_payload.get("code", "")) or _compact_text(original_payload.get("code", ""))
    if not code:
        code = "ok" if repacked_payload.get("ok", original_payload.get("ok", False)) else "execution_error"
    data = repacked_payload.get("data")
    if data in (None, "", [], {}):
        data = _preview_value(original_payload.get("data"), limit=480)
    return {
        "ok": bool(repacked_payload.get("ok", original_payload.get("ok", False))),
        "code": code,
        "message": _compact_text(repacked_payload.get("message", ""))[:260]
        or _compact_text(original_payload.get("message", ""))[:260]
        or summary[:260],
        "summary": (summary or f"{tool_name}:{code}")[:260],
        "context": context[:260],
        "data": data,
    }


def _build_small_repack_messages(
    *,
    tool_name: str,
    result_payload: Mapping[str, Any],
    small_context: SmallContext,
    round_id: int,
) -> List[Dict[str, Any]]:
    system_content = "\n".join(
        [
            "You compress noisy tool outputs into a concise JSON object.",
            "Return JSON only with keys: ok, code, message, summary, context, data.",
            "Keep the content faithful but compact.",
        ]
    )
    user_payload = {
        "round": round_id,
        "tool_name": tool_name,
        "current_query": _compact_text(getattr(small_context, "rewritten_query", "")) or _compact_text(
            getattr(small_context, "query", "")
        ),
        "missing_evidence": list(getattr(small_context, "missing_evidence", []))[:3],
        "evidence_hint": {
            "ok": bool(result_payload.get("ok", False)),
            "code": _compact_text(result_payload.get("code", "")),
            "message": _compact_text(result_payload.get("message", "")),
            "summary": _compact_text(result_payload.get("summary", "")),
            "context": _preview_value(result_payload.get("context", ""), limit=1600),
            "data_preview": _preview_value(result_payload.get("data"), limit=1600),
        },
    }
    return [
        {"role": "system", "content": system_content},
        {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
    ]


def _parse_json_object_text(text: str) -> Dict[str, Any] | None:
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


async def _repack_tool_result_payload(
    *,
    tool_name: str,
    result_payload: Mapping[str, Any],
    small_context: SmallContext,
    round_id: int,
    config: Any,
    model_requester: ModelRequestFn,
    trace: List[str],
    debug_hook: DebugHookFn | None,
) -> Dict[str, Any]:
    messages = _build_small_repack_messages(
        tool_name=tool_name,
        result_payload=result_payload,
        small_context=small_context,
        round_id=round_id,
    )
    try:
        payload = await _request_model_with_role(
            model_requester,
            config,
            messages,
            tools=None,
            tool_choice="none",
            role="small",
        )
        parsed = parse_model_turn(payload)
        repacked = _parse_json_object_text(parsed.content)
        if isinstance(repacked, dict):
            normalized = _normalize_repacked_payload(
                tool_name=tool_name,
                original_payload=result_payload,
                repacked_payload=repacked,
            )
            trace.append(f"EXECUTE round {round_id}: high-noise tool output repacked by small model.")
            _emit_debug(
                debug_hook,
                "tool_repack",
                {
                    "round": round_id,
                    "tool": tool_name,
                    "source": "small",
                    "summary": _compact_text(normalized.get("summary", "")),
                },
            )
            return normalized
        trace.append(f"EXECUTE round {round_id}: small repack returned unusable content; falling back to local compression.")
    except Exception as error:
        trace.append(f"EXECUTE round {round_id}: small repack failed: {error}; falling back to local compression.")

    trace.append(f"EXECUTE round {round_id}: high-noise tool output repacked locally.")
    _emit_debug(
        debug_hook,
        "tool_repack",
        {
            "round": round_id,
            "tool": tool_name,
            "source": "local",
            "summary": _compact_text(result_payload.get("summary", ""))[:260],
        },
    )
    return _repack_noisy_payload(tool_name, result_payload)


def _normalize_execution_payload(tool_name: str, execution: Any) -> Dict[str, Any]:
    if not isinstance(execution, Mapping):
        return build_tool_execution_error(tool_name, RuntimeError("malformed tool execution payload"))

    tool_call_payload = execution.get("toolCall")
    result_payload = execution.get("result")
    if not isinstance(tool_call_payload, Mapping) or not isinstance(result_payload, Mapping):
        return build_tool_execution_error(tool_name, RuntimeError("malformed tool execution payload"))

    normalized = {
        "toolCall": {
            "name": _compact_text(tool_call_payload.get("name", "")) or tool_name,
            "status": _compact_text(tool_call_payload.get("status", "")) or "completed",
            "summary": _compact_text(tool_call_payload.get("summary", "")) or "tool execution completed",
        },
        "result": dict(result_payload),
        "pendingAction": execution.get("pendingAction"),
        "approval": execution.get("approval"),
    }
    result_normalized = normalized["result"]
    if (
        result_normalized.get("ok") is True
        and result_normalized.get("data") in (None, "", [], {})
        and result_normalized.get("code") in (None, "", "ok")
    ):
        normalized["result"] = {
            "ok": False,
            "code": "no_result",
            "message": "tool returned no actionable data",
            "summary": _compact_text(result_normalized.get("summary", "")) or "tool returned no actionable data",
            "context": _compact_text(result_normalized.get("context", "")),
            "data": result_normalized.get("data"),
        }
    return normalized


def _extract_tool_name(call: Mapping[str, Any]) -> str:
    fn_info = call.get("function", {})
    if isinstance(fn_info, Mapping):
        return _compact_text(fn_info.get("name", ""))
    return ""


def _extract_tool_args(call: Mapping[str, Any]) -> str:
    fn_info = call.get("function", {})
    if isinstance(fn_info, Mapping):
        return str(fn_info.get("arguments", "{}"))
    return "{}"


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


def _should_skip_text_web_fallback(
    *,
    fallback_tool: str,
    missing_evidence: Sequence[Mapping[str, Any]],
) -> bool:
    if not _is_web_tool(fallback_tool):
        return False
    return any(_is_image_related_gap(gap) for gap in missing_evidence)


def _tool_names(tools: Sequence[Mapping[str, Any]]) -> List[str]:
    names: List[str] = []
    for item in tools:
        fn_payload = item.get("function", {})
        if isinstance(fn_payload, Mapping):
            candidate = _compact_text(fn_payload.get("name", ""))
            if candidate and candidate not in names:
                names.append(candidate)
    return names


def _find_matching_tool_name(tool_names: Sequence[str], candidate: str) -> str | None:
    normalized = _compact_text(candidate).lower()
    if not normalized:
        return None
    for name in tool_names:
        lowered = name.lower()
        if lowered == normalized or lowered.endswith(normalized) or normalized in lowered:
            return name
    return None


def _pick_deterministic_tool_name(
    *,
    missing_evidence: Sequence[Mapping[str, Any]],
    tools: Sequence[Mapping[str, Any]],
    web_fallback_allowed: bool,
) -> str | None:
    available = _tool_names(tools)
    if not available:
        return None

    for gap in missing_evidence:
        recommended = _compact_text(gap.get("recommended_tool", ""))
        matched = _find_matching_tool_name(available, recommended)
        if matched:
            return matched

    if web_fallback_allowed:
        for preferred in ("web_search", "search_web", "browser_search"):
            matched = _find_matching_tool_name(available, preferred)
            if matched:
                return matched

    return available[0] if available else None


def _find_tool_definition(
    tools: Sequence[Mapping[str, Any]],
    tool_name: str,
) -> Mapping[str, Any] | None:
    for item in tools:
        fn_payload = item.get("function")
        if not isinstance(fn_payload, Mapping):
            continue
        if _compact_text(fn_payload.get("name", "")) == tool_name:
            return fn_payload
    return None


def _required_parameter_names(tool_definition: Mapping[str, Any] | None) -> List[str]:
    if not isinstance(tool_definition, Mapping):
        return []
    parameters = tool_definition.get("parameters")
    if not isinstance(parameters, Mapping):
        return []
    required = parameters.get("required")
    if not isinstance(required, Sequence) or isinstance(required, (str, bytes, bytearray)):
        return []
    names: List[str] = []
    for item in required:
        name = _compact_text(item)
        if name and name not in names:
            names.append(name)
    return names


def _build_deterministic_tool_args(
    tool_name: str,
    small_context: SmallContext,
    tools: Sequence[Mapping[str, Any]],
) -> str | None:
    query = ""
    rewrites = small_context.query_rewrites
    if isinstance(rewrites, Mapping):
        candidates = rewrites.get("web_fallback_queries")
        if isinstance(candidates, Sequence) and not isinstance(candidates, (str, bytes)):
            for item in candidates:
                text = _compact_text(item)
                if text:
                    query = text
                    break
    if not query:
        query = _compact_text(small_context.rewritten_query) or _compact_text(small_context.query)

    if _is_web_tool(tool_name):
        if not query:
            return None
        return json.dumps({"query": query}, ensure_ascii=False)

    tool_definition = _find_tool_definition(tools, tool_name)
    if _required_parameter_names(tool_definition):
        return None
    return "{}"


def _build_fallback_answer_from_pack(pack: EvidencePack) -> str:
    claims = [
        _compact_text(item.claim)
        for item in pack.evidence_items[:3]
        if _compact_text(item.claim)
    ]
    gaps = [
        _compact_text(gap.get("question", ""))
        for gap in pack.missing_evidence[:2]
        if _compact_text(gap.get("question", ""))
    ]
    if claims and not gaps:
        return " ".join(claims)
    if claims and gaps:
        return f"{' '.join(claims)} Unresolved gaps: {'; '.join(gaps)}."
    if gaps:
        return f"No sufficient evidence yet. Unresolved gaps: {'; '.join(gaps)}."
    return "No final answer was generated."


def _gap_matches_tool(gap: Mapping[str, Any], tool_name: str) -> bool:
    recommended_tool = _compact_text(gap.get("recommended_tool", ""))
    if recommended_tool and recommended_tool == tool_name:
        return True
    question = _compact_text(gap.get("question", "")).lower()
    if tool_name == "get_dashboard_overview":
        return any(marker in question for marker in ("仪表盘", "dashboard", "概览", "总览", "kpi", "指标", "运行状态"))
    if tool_name == "get_reports_overview":
        return any(marker in question for marker in ("趋势", "报表", "统计"))
    if tool_name == "get_inventory_overview":
        return any(marker in question for marker in ("库存", "缺货", "预警"))
    if tool_name == "get_finance_overview":
        return any(marker in question for marker in ("财务", "应收", "应付", "回款", "付款"))
    return False


def _gap_matches_tool(gap: Mapping[str, Any], tool_name: str) -> bool:
    recommended_tool = _compact_text(gap.get("recommended_tool", ""))
    if recommended_tool and recommended_tool == tool_name:
        return True
    question = _compact_text(gap.get("question", "")).lower()
    if tool_name == "get_dashboard_overview":
        return any(
            marker in question
            for marker in (
                "dashboard",
                "overview",
                "kpi",
                "metric",
                "runtime",
                "\u4eea\u8868\u76d8",
                "\u6982\u89c8",
                "\u603b\u89c8",
                "\u6307\u6807",
                "\u8fd0\u884c\u72b6\u6001",
            )
        )
    if tool_name == "get_reports_overview":
        return any(
            marker in question
            for marker in ("report", "trend", "statistics", "\u62a5\u8868", "\u8d8b\u52bf", "\u7edf\u8ba1")
        )
    if tool_name == "get_inventory_overview":
        return any(
            marker in question
            for marker in ("inventory", "stock", "alert", "\u5e93\u5b58", "\u7f3a\u8d27", "\u9884\u8b66")
        )
    if tool_name == "get_finance_overview":
        return any(
            marker in question
            for marker in (
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
        )
    return False


def _resolve_missing_gaps_after_tool(
    *,
    tool_name: str,
    result_payload: Mapping[str, Any],
    missing_evidence: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    if not bool(result_payload.get("ok", False)):
        return [dict(item) for item in missing_evidence if isinstance(item, Mapping)]
    code = _compact_text(result_payload.get("code", "")).lower()
    if code in {"execution_error", "disabled", "no_result", "web_budget_exhausted"}:
        return [dict(item) for item in missing_evidence if isinstance(item, Mapping)]
    remaining: List[Dict[str, Any]] = []
    for item in missing_evidence:
        if not isinstance(item, Mapping):
            continue
        if _gap_matches_tool(item, tool_name):
            continue
        remaining.append(dict(item))
    return remaining


def _build_plan_request_messages(
    *,
    messages: List[Dict[str, Any]],
    decision: RouterDecision,
    small_context: SmallContext,
    tools: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    plan_request = "\n".join(
        [
            "PLAN phase: produce JSON only.",
            "Return an object with keys: objective, steps, tool_policy, evidence_targets, confidence, fallback.",
            "steps must be an array of short strings.",
            "tool_policy should explain when tools are allowed.",
            "fallback should explain how to proceed if JSON cannot be honored.",
            f"route={decision.route}",
            f"missing_evidence={len(small_context.missing_evidence)}",
            f"visible_tools={len(tools)}",
        ]
    )
    return [
        *messages,
        {
            "role": "user",
            "content": plan_request,
        },
    ]


def _parse_json_object_text(text: str) -> Dict[str, Any] | None:
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


def _normalize_plan_steps(value: Any) -> List[str]:
    steps: List[str] = []
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for item in value:
            text = _compact_text(item)
            if text:
                steps.append(text)
    elif isinstance(value, str):
        for line in value.splitlines():
            text = _compact_text(line)
            if text:
                steps.append(text)
    return steps


def _normalize_structured_plan(plan_payload: Mapping[str, Any]) -> Dict[str, Any] | None:
    if bool(plan_payload.get("final_answer_allowed", False)):
        return None
    objective = _compact_text(
        plan_payload.get("objective")
        or plan_payload.get("goal")
        or plan_payload.get("summary")
        or plan_payload.get("intent")
    )
    steps = _normalize_plan_steps(plan_payload.get("steps") or plan_payload.get("plan") or plan_payload.get("actions"))
    tool_policy = _compact_text(plan_payload.get("tool_policy") or plan_payload.get("toolPolicy"))
    evidence_targets = _normalize_plan_steps(
        plan_payload.get("evidence_targets") or plan_payload.get("evidenceTargets")
    )
    fallback = _compact_text(plan_payload.get("fallback") or plan_payload.get("fallback_strategy"))
    confidence_raw = plan_payload.get("confidence")
    if isinstance(confidence_raw, (int, float)):
        confidence = max(0.0, min(1.0, float(confidence_raw)))
    else:
        confidence = None

    if not objective and not steps and not tool_policy:
        return None

    return {
        "mode": "structured",
        "objective": objective or "Layered answer objective unavailable.",
        "steps": steps or ["Review evidence pack", "Execute only needed tools", "Answer from evidence"],
        "tool_policy": tool_policy or "Use tools only when evidence is missing or weak.",
        "evidence_targets": evidence_targets,
        "confidence": confidence if confidence is not None else 0.5,
        "fallback": fallback or "Fallback to deterministic plan when JSON cannot be produced.",
    }


def _render_plan_lines(structured_plan: Mapping[str, Any]) -> List[str]:
    lines = [
        f"PLAN phase: structured objective={_compact_text(structured_plan.get('objective', ''))}.",
        f"PLAN phase: tool policy={_compact_text(structured_plan.get('tool_policy', ''))}.",
    ]
    steps = structured_plan.get("steps", [])
    if isinstance(steps, Sequence) and not isinstance(steps, (str, bytes)):
        for index, step in enumerate(steps, start=1):
            text = _compact_text(step)
            if text:
                lines.append(f"PLAN phase: step {index} = {text}")
    evidence_targets = structured_plan.get("evidence_targets", [])
    if isinstance(evidence_targets, Sequence) and not isinstance(evidence_targets, (str, bytes)) and evidence_targets:
        lines.append(
            "PLAN phase: evidence targets = "
            + ", ".join(_compact_text(item) for item in evidence_targets if _compact_text(item))
        )
    fallback = _compact_text(structured_plan.get("fallback", ""))
    if fallback:
        lines.append(f"PLAN phase: fallback = {fallback}")
    return lines


async def _attempt_structured_plan(
    *,
    request: Any,
    config: Any,
    model_requester: ModelRequestFn,
    decision: RouterDecision,
    small_context: SmallContext,
    messages: List[Dict[str, Any]],
    tools: Sequence[Mapping[str, Any]],
    trace: List[str],
    debug_hook: DebugHookFn | None,
) -> Dict[str, Any] | None:
    request_meta = {
        "route": decision.route,
        "intent": decision.intention,
        "complexity": decision.complexity,
        "missing_evidence": small_context.missing_evidence[:5],
        "retrieval_diagnostics": dict(small_context.retrieval_diagnostics),
        "visible_tools": _tool_names(tools),
    }
    instruction = "\n".join(
        [
            "MODE=PLAN",
            "Return JSON only.",
            "Do not call tools and do not output final answer.",
            "Schema:",
            "{",
            '  "objective": "string",',
            '  "steps": ["string"],',
            '  "tool_policy": "string",',
            '  "evidence_targets": ["string"],',
            '  "confidence": 0.0,',
            '  "fallback": "string",',
            '  "final_answer_allowed": false',
            "}",
        ]
    )
    model_messages = [
        *messages,
        {"role": "user", "content": instruction + "\n\nINPUT:\n" + json.dumps(request_meta, ensure_ascii=False)},
    ]
    try:
        payload = await _request_model_with_role(
            model_requester,
            config,
            model_messages,
            tools=None,
            tool_choice="none",
            role="large",
        )
        parsed = parse_model_turn(payload)
        candidate = _parse_json_object_text(parsed.content)
        if isinstance(candidate, Mapping):
            structured = _normalize_structured_plan(candidate)
            if structured is not None:
                structured["source"] = "large"
                trace.append("PLAN phase: structured JSON plan accepted from large model.")
                return structured
        trace.append("PLAN phase: structured model plan unusable; falling back to local plan.")
    except Exception as error:
        trace.append(f"PLAN phase: structured plan request failed: {error}; falling back to local plan.")

    plan_payload = {
        "objective": f"Resolve route={decision.route} with {len(small_context.missing_evidence)} evidence gaps.",
        "steps": [
            "Review the evidence pack and route constraints.",
            "Execute only necessary tools for unresolved evidence.",
            "Answer from grounded evidence and preserve gaps when unresolved.",
        ],
        "tool_policy": (
            "Use tools only when evidence is missing or weak."
            if tools
            else "Do not call tools; answer from evidence pack."
        ),
        "evidence_targets": [
            _compact_text(gap.get("gap_id", "")) or _compact_text(gap.get("question", ""))
            for gap in small_context.missing_evidence[:3]
            if _compact_text(gap.get("gap_id", "")) or _compact_text(gap.get("question", ""))
        ],
        "confidence": 0.5 if small_context.missing_evidence else 0.8,
        "fallback": "Fallback to deterministic plan when structured plan is incomplete.",
        "final_answer_allowed": False,
    }
    structured = _normalize_structured_plan(plan_payload)
    if structured is not None:
        structured["source"] = "local"
        trace.append("PLAN phase: structured JSON plan accepted from local fallback.")
        return structured
    trace.append("PLAN phase: structured JSON plan unusable; falling back to deterministic plan.")
    return None


def _build_answer_meta(runtime_state: PlannerRuntimeState) -> Dict[str, Any]:
    used_evidence_ids = [
        item.evidence_id
        for item in runtime_state.evidence_pack.evidence_items[:8]
        if _compact_text(item.evidence_id)
    ]
    unresolved_gaps = [
        _compact_text(gap.get("gap_id", "")) or _compact_text(gap.get("question", ""))
        for gap in runtime_state.evidence_pack.missing_evidence[:8]
        if _compact_text(gap.get("gap_id", "")) or _compact_text(gap.get("question", ""))
    ]
    confidence = runtime_state.evidence_pack.planner_handoff.get("sufficiency_score", 0.0)
    if not isinstance(confidence, (int, float)):
        confidence = 0.0
    confidence_score = round(max(0.0, min(1.0, float(confidence))), 3)
    if confidence_score >= 0.8:
        confidence_label = "high"
    elif confidence_score >= 0.55:
        confidence_label = "medium"
    else:
        confidence_label = "low"
    return {
        "used_evidence_ids": used_evidence_ids,
        "unresolved_gaps": unresolved_gaps,
        "confidence": confidence_label,
        "confidence_score": confidence_score,
    }


def _emit_debug(debug_hook: DebugHookFn | None, event: str, payload: Dict[str, Any]) -> None:
    if not callable(debug_hook):
        return
    try:
        debug_hook(event, payload)
    except Exception:
        return


def _build_plan(decision: RouterDecision, small_context: SmallContext, tools: Sequence[Mapping[str, Any]]) -> List[str]:
    plan = [
        f"PLAN phase: route={decision.route}, intention={decision.intention}, complexity={decision.complexity}.",
        f"PLAN phase: history={len(small_context.history)} turns, chunks={len(small_context.chunks)}, missing={len(small_context.missing_evidence)}.",
    ]
    if tools:
        plan.append(f"PLAN phase: visible tools={len(tools)}; executor may call tools only when evidence is missing.")
    else:
        plan.append("PLAN phase: no visible tools; executor must avoid tool execution.")
    return plan


async def _request_model_with_role(
    model_requester: ModelRequestFn,
    config: Any,
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
        message = str(error)
        if "role" not in message:
            raise
        return await model_requester(
            config,
            messages,
            tools=tools,  # type: ignore[arg-type]
            tool_choice=tool_choice,
        )


async def run_planner_executor(
    *,
    request: Any,
    config: Any,
    model_requester: ModelRequestFn,
    tool_executor: ToolExecutorFn,
    decision: RouterDecision,
    small_context: SmallContext,
    messages: List[Dict[str, Any]],
    tools: List[Mapping[str, Any]],
    evidence_pack: EvidencePack,
    trace: List[str],
    debug_hook: DebugHookFn | None = None,
) -> PlannerRuntimeState:
    runtime_trace = list(trace)
    active_model_getter = getattr(config, "active_model", None)
    resolved_model = (
        str(active_model_getter()) if callable(active_model_getter) else str(getattr(config, "deepseek_model", ""))
    )
    tool_state = ToolLoopState(messages=messages, resolved_model=resolved_model)
    runtime_state = PlannerRuntimeState(
        phase=PlannerState.PLAN,
        tool_state=tool_state,
        evidence_pack=evidence_pack,
        trace=runtime_trace,
    )
    structured_plan = await _attempt_structured_plan(
        request=request,
        config=config,
        model_requester=model_requester,
        decision=decision,
        small_context=small_context,
        messages=messages,
        tools=tools,
        trace=runtime_state.trace,
        debug_hook=debug_hook,
    )
    if structured_plan is not None:
        runtime_state.plan_json = dict(structured_plan)
        runtime_state.plan = _render_plan_lines(structured_plan)
        runtime_state.tool_state.messages.append(
            {
                "role": "assistant",
                "content": json.dumps(
                    {
                        "mode": "PLAN",
                        "objective": structured_plan.get("objective", ""),
                        "steps": structured_plan.get("steps", []),
                        "tool_policy": structured_plan.get("tool_policy", ""),
                        "final_answer_allowed": False,
                    },
                    ensure_ascii=False,
                ),
            }
        )
    else:
        runtime_state.plan = _build_plan(decision, small_context, tools)
    runtime_state.trace.extend(runtime_state.plan)
    _emit_debug(
        debug_hook,
        "plan",
        {
            "route": decision.route,
            "intention": decision.intention,
            "complexity": decision.complexity,
            "missing_evidence": len(small_context.missing_evidence),
            "visible_tools": len(tools),
        },
    )
    if structured_plan is not None:
        _emit_debug(
            debug_hook,
            "plan_json",
            {
                "mode": "structured",
                "objective": structured_plan.get("objective", ""),
                "steps": len(structured_plan.get("steps", [])) if isinstance(structured_plan.get("steps"), list) else 0,
                "confidence": structured_plan.get("confidence", 0.0),
            },
        )

    runtime_state.phase = PlannerState.EXECUTE

    max_rounds = max(1, min(8, int(getattr(config, "ai_layered_max_execute_rounds", 2))))
    web_fallback_budget = max(0, min(3, int(getattr(config, "ai_layered_web_fallback_max_rounds", 1))))
    final_answer_generated = False

    for round_id in range(1, max_rounds + 1):
        planner_quality = runtime_state.evidence_pack.planner_handoff.get("sufficiency_score")
        fallback_quality = small_context.retrieval_diagnostics.get("kb_quality", 0.0)
        if isinstance(planner_quality, (int, float)) and float(planner_quality) > 0:
            evidence_quality = float(planner_quality)
        else:
            try:
                evidence_quality = float(fallback_quality)
            except (TypeError, ValueError):
                evidence_quality = 0.0
        allow_tools = gate_execution(
            decision,
            available_tools=tools,
            missing_evidence=runtime_state.evidence_pack.missing_evidence,
            evidence_quality=evidence_quality,
            require_tool_match=True,
        )
        payload = await _request_model_with_role(
            model_requester,
            config,
            runtime_state.tool_state.messages,
            tools=tools if allow_tools else None,  # type: ignore[arg-type]
            tool_choice="auto" if allow_tools and tools else "none",
            role="large",
        )
        parsed: ParsedModelTurn = parse_model_turn(payload)
        if parsed.resolved_model:
            runtime_state.tool_state.resolved_model = parsed.resolved_model
        _emit_debug(
            debug_hook,
            "large_response",
            {
                "round": round_id,
                "allow_tools": allow_tools,
                "tool_call_count": len(parsed.tool_calls),
                "content_preview": parsed.content,
                "reasoning_preview": parsed.reasoning,
                "resolved_model": runtime_state.tool_state.resolved_model,
            },
        )

        execute_calls: List[Dict[str, Any]] = [dict(item) for item in parsed.tool_calls]
        if not execute_calls:
            if allow_tools and tools and runtime_state.evidence_pack.missing_evidence:
                fallback_tool = _pick_deterministic_tool_name(
                    missing_evidence=runtime_state.evidence_pack.missing_evidence,
                    tools=tools,
                    web_fallback_allowed=decision.web_fallback_allowed,
                )
                if fallback_tool:
                    if _should_skip_text_web_fallback(
                        fallback_tool=fallback_tool,
                        missing_evidence=runtime_state.evidence_pack.missing_evidence,
                    ):
                        runtime_state.trace.append(
                            f"EXECUTE round {round_id}: deterministic fallback skipped for {fallback_tool}; image-related evidence gaps may not use text web search."
                        )
                        _emit_debug(
                            debug_hook,
                            "deterministic_fallback_skipped",
                            {
                                "round": round_id,
                                "tool": fallback_tool,
                                "reason": "image_gap_blocks_text_web_fallback",
                            },
                        )
                    elif _is_web_tool(fallback_tool) and not decision.web_fallback_allowed:
                        runtime_state.trace.append(
                            f"EXECUTE round {round_id}: deterministic fallback skipped for {fallback_tool}; web fallback is not allowed for this route."
                        )
                        _emit_debug(
                            debug_hook,
                            "deterministic_fallback_skipped",
                            {
                                "round": round_id,
                                "tool": fallback_tool,
                                "reason": "web_fallback_not_allowed",
                            },
                        )
                    elif decision.web_fallback_allowed and _is_web_tool(fallback_tool) and web_fallback_budget <= 0:
                        runtime_state.trace.append(
                            f"EXECUTE round {round_id}: deterministic fallback skipped; web fallback budget exhausted."
                        )
                    else:
                        fallback_args = _build_deterministic_tool_args(
                            fallback_tool,
                            small_context,
                            tools,
                        )
                        if fallback_args is None:
                            runtime_state.trace.append(
                                f"EXECUTE round {round_id}: deterministic fallback skipped for {fallback_tool}; required arguments could not be inferred safely."
                            )
                            _emit_debug(
                                debug_hook,
                                "deterministic_fallback_skipped",
                                {
                                    "round": round_id,
                                    "tool": fallback_tool,
                                    "reason": "deterministic_arguments_unavailable",
                                },
                            )
                        else:
                            execute_calls = [
                                {
                                    "id": f"deterministic-{round_id}",
                                    "type": "function",
                                    "function": {
                                        "name": fallback_tool,
                                        "arguments": fallback_args,
                                    },
                                }
                            ]
                            runtime_state.trace.append(
                                f"EXECUTE round {round_id}: deterministic fallback triggered tool {fallback_tool} for missing evidence."
                            )
                            _emit_debug(
                                debug_hook,
                                "deterministic_fallback",
                                {
                                    "round": round_id,
                                    "tool": fallback_tool,
                                    "reason": "missing_evidence_and_no_model_tool_call",
                                },
                            )

            if not execute_calls:
                runtime_state.trace.append(f"EXECUTE round {round_id}: no tool call; switch to ANSWER.")
                runtime_state.tool_state.reply = (
                    parsed.content
                    or runtime_state.tool_state.reply
                    or _build_fallback_answer_from_pack(runtime_state.evidence_pack)
                )
                runtime_state.tool_state.reasoning_content = parsed.reasoning or runtime_state.tool_state.reasoning_content
                runtime_state.phase = PlannerState.ANSWER
                final_answer_generated = True
                break

        if not allow_tools or not tools:
            runtime_state.trace.append(
                f"EXECUTE round {round_id}: tool_calls ignored because tool schema unavailable or execution gated."
            )
            runtime_state.tool_state.reply = (
                parsed.content
                or runtime_state.tool_state.reply
                or _build_fallback_answer_from_pack(runtime_state.evidence_pack)
            )
            runtime_state.tool_state.reasoning_content = parsed.reasoning or runtime_state.tool_state.reasoning_content
            runtime_state.phase = PlannerState.ANSWER
            final_answer_generated = True
            break

        if parsed.tool_calls:
            runtime_state.trace.append(f"EXECUTE round {round_id}: model requested {len(parsed.tool_calls)} tool calls.")
            _emit_debug(
                debug_hook,
                "large_tool_request",
                {
                    "round": round_id,
                    "requested_tools": ",".join(
                        _extract_tool_name(item) or "unknown" for item in parsed.tool_calls
                    ),
                },
            )
        assistant_tool_message: Dict[str, Any] = {
            "role": "assistant",
            "content": parsed.message.get("content", "") if isinstance(parsed.message, Mapping) else "",
            "tool_calls": execute_calls,
        }
        if parsed.provider_parts:
            assistant_tool_message["provider_parts"] = parsed.provider_parts
        requires_reasoning_getter = getattr(config, "requires_reasoning_for_tool_calls", None)
        if callable(requires_reasoning_getter):
            try:
                requires_reasoning = bool(requires_reasoning_getter("large"))
            except TypeError:
                requires_reasoning = bool(requires_reasoning_getter())
        else:
            requires_reasoning = str(getattr(config, "deepseek_model", "")) == "deepseek-reasoner"
        if requires_reasoning:
            assistant_tool_message["reasoning_content"] = parsed.reasoning or ""
        runtime_state.tool_state.messages.append(assistant_tool_message)

        for index, call in enumerate(execute_calls):
            fn_name = _extract_tool_name(call)
            fn_args = _extract_tool_args(call)
            if not fn_name:
                continue

            if decision.web_fallback_allowed and _is_web_tool(fn_name):
                if web_fallback_budget <= 0:
                    execution_raw = {
                        "toolCall": {
                            "name": fn_name,
                            "status": "disabled",
                            "summary": "web fallback budget exhausted",
                        },
                        "result": {
                            "ok": False,
                            "code": "web_budget_exhausted",
                            "message": "web fallback budget exhausted",
                            "summary": "web fallback budget exhausted",
                            "context": "",
                        },
                    }
                    runtime_state.trace.append(
                        f"EXECUTE round {round_id}: skipped {fn_name} because web fallback budget is exhausted."
                    )
                else:
                    web_fallback_budget -= 1
                    try:
                        execution_raw = await tool_executor(fn_name, fn_args, request)
                    except Exception as error:
                        execution_raw = build_tool_execution_error(fn_name, error)
            else:
                try:
                    execution_raw = await tool_executor(fn_name, fn_args, request)
                except Exception as error:
                    execution_raw = build_tool_execution_error(fn_name, error)
            normalized_execution = _normalize_execution_payload(fn_name, execution_raw)

            tool_call_payload = normalized_execution.get("toolCall", {})
            result_payload = normalized_execution.get("result", {})
            if not isinstance(tool_call_payload, Mapping):
                tool_call_payload = {"name": fn_name, "status": "disabled", "summary": "execution_error"}
            if not isinstance(result_payload, Mapping):
                result_payload = {
                    "ok": False,
                    "code": "execution_error",
                    "message": "malformed tool result",
                    "summary": "malformed tool result",
                    "context": "",
                }
            web_sources = extract_web_sources_from_result_payload(result_payload, fallback_source_type=fn_name)

            repacked = False
            if _has_noisy_payload(result_payload):
                repacked_result = await _repack_tool_result_payload(
                    tool_name=fn_name,
                    result_payload=result_payload,
                    small_context=small_context,
                    round_id=round_id,
                    config=config,
                    model_requester=model_requester,
                    trace=runtime_state.trace,
                    debug_hook=debug_hook,
                )
                if isinstance(repacked_result, Mapping):
                    result_payload = dict(repacked_result)
                    repacked = True
                else:
                    repacked = True
                    result_payload = _repack_noisy_payload(fn_name, result_payload)
                    runtime_state.trace.append(
                        f"EXECUTE round {round_id}: high-noise tool output repacked locally."
                    )
            if result_payload.get("code") == "no_result" and runtime_state.evidence_pack.missing_evidence:
                runtime_state.trace.append(
                    f"EXECUTE round {round_id}: missing_evidence unresolved after empty result from {fn_name}."
                )

            runtime_state.tool_state.tool_calls.append(
                ToolCallRecord(
                    name=_compact_text(tool_call_payload.get("name", "")) or fn_name,
                    status=_compact_text(tool_call_payload.get("status", "")) or "completed",
                    summary=_compact_text(tool_call_payload.get("summary", "")) or _compact_text(result_payload.get("summary", "")),
                )
            )

            if isinstance(result_payload.get("pendingAction"), Mapping):
                runtime_state.tool_state.pending_action = dict(result_payload.get("pendingAction", {}))
            if isinstance(result_payload.get("approval"), Mapping):
                runtime_state.tool_state.approval = dict(result_payload.get("approval", {}))
            if isinstance(normalized_execution.get("pendingAction"), Mapping):
                runtime_state.tool_state.pending_action = dict(normalized_execution.get("pendingAction", {}))
            if isinstance(normalized_execution.get("approval"), Mapping):
                runtime_state.tool_state.approval = dict(normalized_execution.get("approval", {}))

            runtime_state.tool_state.web_sources = merge_web_sources(
                runtime_state.tool_state.web_sources,
                web_sources,
            )

            append_tool_result_message(
                state=runtime_state.tool_state,
                call=dict(call),
                result_payload=dict(result_payload),
                round_id=round_id,
                index=index,
            )

            add_tool_evidence(
                runtime_state.evidence_pack,
                tool_name=fn_name,
                result_payload=result_payload,
                round_id=round_id,
                repacked=repacked,
            )
            runtime_state.evidence_pack.missing_evidence = _resolve_missing_gaps_after_tool(
                tool_name=fn_name,
                result_payload=result_payload,
                missing_evidence=runtime_state.evidence_pack.missing_evidence,
            )
            _emit_debug(
                debug_hook,
                "tool_result",
                {
                    "round": round_id,
                    "tool": fn_name,
                    "status": _compact_text(tool_call_payload.get("status", "")) or "completed",
                    "code": _compact_text(result_payload.get("code", "")) or "unknown",
                    "summary": _compact_text(result_payload.get("summary", "")),
                    "repacked": repacked,
                },
            )

        finalize_evidence_pack(runtime_state.evidence_pack)
        contract_issues = validate_evidence_pack_contract(runtime_state.evidence_pack, stage=f"round_{round_id}")
        if contract_issues:
            runtime_state.trace.extend(
                [f"Evidence pack contract issue: {issue}" for issue in contract_issues[:6]]
            )

    if not final_answer_generated:
        sufficiency_score = runtime_state.evidence_pack.planner_handoff.get("sufficiency_score", 0.0)
        if not runtime_state.evidence_pack.missing_evidence or float(sufficiency_score or 0.0) >= 0.72:
            runtime_state.tool_state.reply = (
                runtime_state.tool_state.reply or _build_fallback_answer_from_pack(runtime_state.evidence_pack)
            )
            runtime_state.trace.append("ANSWER phase: synthesized from evidence pack without extra large request.")
        else:
            payload = await _request_model_with_role(
                model_requester,
                config,
                runtime_state.tool_state.messages,
                tools=None,
                tool_choice="none",
                role="large",
            )
            parsed = parse_model_turn(payload)
            if parsed.resolved_model:
                runtime_state.tool_state.resolved_model = parsed.resolved_model
            runtime_state.tool_state.reply = (
                parsed.content
                or runtime_state.tool_state.reply
                or _build_fallback_answer_from_pack(runtime_state.evidence_pack)
            )
            runtime_state.tool_state.reasoning_content = parsed.reasoning or runtime_state.tool_state.reasoning_content
            runtime_state.trace.append("ANSWER phase: requested final large synthesis.")
        runtime_state.phase = PlannerState.ANSWER

    finalize_evidence_pack(runtime_state.evidence_pack)
    contract_issues = validate_evidence_pack_contract(runtime_state.evidence_pack, stage="answer")
    if contract_issues:
        runtime_state.trace.extend(
            [f"Evidence pack contract issue: {issue}" for issue in contract_issues[:6]]
        )
    runtime_state.answer_meta = _build_answer_meta(runtime_state)
    runtime_state.trace.append(
        "ANSWER meta: "
        + json.dumps(runtime_state.answer_meta, ensure_ascii=False, separators=(",", ":"))
    )
    runtime_state.trace.append("ANSWER phase: finalized from evidence pack.")
    _emit_debug(
        debug_hook,
        "answer",
        {
            "reply_preview": runtime_state.tool_state.reply,
            "tool_calls": len(runtime_state.tool_state.tool_calls),
            "remaining_gaps": len(runtime_state.evidence_pack.missing_evidence),
            "answer_meta": runtime_state.answer_meta,
        },
    )
    runtime_state.phase = PlannerState.DONE
    runtime_state.evidence_pack.final_answer_allowed = False
    return runtime_state


__all__ = ["PlannerState", "PlannerRuntimeState", "run_planner_executor"]
