from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Sequence

from .common import json_dumps
from .models import ChatRequest, ToolCallRecord

DEFAULT_ASSISTANT_SYSTEM_PROMPT = "\n".join(
    [
        "You are Retail Smart Hub AI assistant.",
        "Use available function tools for real-time data and actions.",
        "Write tools are controlled and may require approval.",
        "Never fabricate tool outputs.",
    ]
)

PLANNER_EXECUTOR_SYSTEM_PROMPT = "\n".join(
    [
        "You are Planner-Executor-v1 in a layered dual-agent runtime.",
        "Operate in PLAN -> EXECUTE -> ANSWER phases.",
        "PLAN may not call tools and must not produce final answer.",
        "EXECUTE can call tools only when evidence is missing or weak.",
        "ANSWER must stay grounded in evidence and preserve unresolved gaps.",
    ]
)


@dataclass
class ContextBundle:
    profile_payload: Dict[str, Any]
    profile_context: str
    chunks: List[Dict[str, Any]]
    citations: List[str]
    knowledge_context: str
    attachment_context: str
    skill_context: str
    matched_skill_names: List[str]
    tools: List[Dict[str, Any]]
    retrieval_mode: str


@dataclass
class ToolLoopState:
    messages: List[Dict[str, Any]]
    tool_calls: List[ToolCallRecord] = field(default_factory=list)
    web_sources: List[Dict[str, Any]] = field(default_factory=list)
    pending_action: Dict[str, Any] | None = None
    approval: Dict[str, Any] | None = None
    reasoning_content: str = ""
    reply: str = ""
    resolved_model: str = ""


@dataclass
class ParsedModelTurn:
    message: Dict[str, Any]
    content: str
    reasoning: str
    tool_calls: List[Dict[str, Any]]
    resolved_model: str | None
    provider_parts: List[Dict[str, Any]] = field(default_factory=list)


def build_profile_context_text(profile_payload: Dict[str, Any]) -> str:
    profile = profile_payload.get("profile", {})
    if not isinstance(profile, dict) or not profile:
        return "No active profile memory facts."
    lines = []
    for key in [
        "assistantDisplayName",
        "assistantAliases",
        "userPreferredName",
        "language",
        "stylePreferences",
    ]:
        value = profile.get(key)
        if value is None:
            continue
        if isinstance(value, list):
            text = ", ".join(str(v) for v in value)
        else:
            text = str(value)
        lines.append(f"- {key}: {text}")
    updated_at = profile_payload.get("updatedAt")
    updated_by = profile_payload.get("updatedBy")
    if updated_at:
        lines.append(f"- profileUpdatedAt: {updated_at}")
    if updated_by:
        lines.append(f"- profileUpdatedBy: {updated_by}")
    return "\n".join(lines) if lines else "No active profile memory facts."


def build_knowledge_context(chunks: Sequence[Dict[str, Any]]) -> str:
    if not chunks:
        return "No retrieved knowledge chunks."
    lines = []
    for idx, chunk in enumerate(chunks, start=1):
        lines.append(f"[{idx}] {chunk.get('docTitle', 'Knowledge')}")
        lines.append(f"Citation: {chunk.get('citation', '')}")
        lines.append(
            "Score: "
            f"{float(chunk.get('score', 0.0)):.3f} "
            f"(dense {float(chunk.get('denseScore', 0.0)):.3f}, "
            f"lexical {float(chunk.get('lexicalScore', 0.0)):.3f}, "
            f"recency {float(chunk.get('recencyScore', 0.0)):.3f})"
        )
        lines.append(str(chunk.get("content", "")))
        lines.append("")
    return "\n".join(lines).strip()


def build_model_messages(
    request: ChatRequest,
    profile_context: str,
    knowledge_context: str,
    attachment_context: str,
    skill_context: str,
    *,
    runtime_tool_context: str = "",
    history_messages_override: Sequence[Dict[str, str]] | None = None,
    system_mode: str = "assistant",
) -> List[Dict[str, Any]]:
    history_messages: List[Dict[str, Any]] = []
    if history_messages_override is not None:
        for item in history_messages_override:
            role = "assistant" if str(item.get("role", "")).strip().lower() == "assistant" else "user"
            content = str(item.get("content", "")).strip()
            if not content:
                continue
            history_messages.append({"role": role, "content": content})
    else:
        for item in request.history[-6:]:
            role = "assistant" if item.role == "assistant" else "user"
            content = str(item.content or "").strip()
            if not content:
                continue
            history_messages.append({"role": role, "content": content})
    if system_mode == "planner_executor":
        system_content = PLANNER_EXECUTOR_SYSTEM_PROMPT
    else:
        system_content = DEFAULT_ASSISTANT_SYSTEM_PROMPT
    user_content = "\n\n".join(
        [
            f"Current user: {request.username}",
            f"Current tenant: {request.tenantId or 'default'}",
            f"Roles: {', '.join(request.roles) if request.roles else 'none'}",
            f"Permissions: {', '.join(request.permissions) if request.permissions else 'none'}",
            "Profile Memory (higher priority):",
            profile_context,
            "RAG knowledge chunks:",
            knowledge_context,
            "Skill context:",
            skill_context or "No matched skill context.",
            "Runtime tool context:",
            runtime_tool_context or "No prefetched runtime tool context.",
            "Attachment context:",
            attachment_context,
            f"User prompt: {request.prompt.strip()}",
        ]
    )
    image_parts: List[Dict[str, str]] = []
    for attachment in request.attachments:
        if str(getattr(attachment, "kind", "") or "").strip() != "image":
            continue
        image_data_url = str(getattr(attachment, "imageDataUrl", "") or "").strip()
        if not image_data_url:
            continue
        image_parts.append(
            {
                "file_name": str(getattr(attachment, "fileName", "") or "").strip() or "image",
                "mime_type": str(getattr(attachment, "mimeType", "") or "").strip() or "image/jpeg",
                "data_url": image_data_url,
            }
        )
    final_user_content: Any = user_content
    if image_parts:
        final_user_content = {
            "text": user_content,
            "images": image_parts,
        }
    return [
        {"role": "system", "content": system_content},
        *history_messages,
        {"role": "user", "content": final_user_content},
    ]


def _extract_text_like(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value).strip()
    if isinstance(value, list):
        parts: List[str] = []
        for item in value:
            text = _extract_text_like(item)
            if text:
                parts.append(text)
        return " ".join(parts).strip()
    if isinstance(value, Mapping):
        # OpenAI-compatible content blocks often carry text/value in nested fields.
        for key in ("text", "content", "value", "output_text", "message"):
            if key not in value:
                continue
            text = _extract_text_like(value.get(key))
            if text:
                return text
        return ""
    return ""


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


def _unwrap_json_answer(content: str) -> str | None:
    parsed = _parse_json_object_text(content)
    if not isinstance(parsed, Mapping):
        return None
    mode = str(parsed.get("mode") or "").strip().upper()
    answer = parsed.get("answer")
    if isinstance(answer, str) and answer.strip():
        return answer.strip()
    if mode in {"ANSWER", "FINAL", "RESPONSE", "RESULT"}:
        for key in ("reply", "response", "final_answer", "final", "content", "message"):
            candidate = parsed.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
    return None


def _normalize_tool_arguments(value: Any) -> str:
    if isinstance(value, str):
        candidate = value.strip()
        if not candidate:
            return "{}"
        try:
            json.loads(candidate)
            return candidate
        except Exception:
            return json_dumps({"input": candidate})
    if isinstance(value, Mapping):
        return json_dumps(dict(value))
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return json_dumps(list(value))
    if value in (None, ""):
        return "{}"
    return json_dumps({"input": value})


def _normalize_synthetic_tool_call(candidate: Mapping[str, Any], index: int) -> Dict[str, Any] | None:
    function_payload = candidate.get("function")
    if isinstance(function_payload, Mapping):
        tool_name = str(function_payload.get("name") or "").strip()
        arguments = function_payload.get("arguments", {})
        if tool_name:
            return {
                "id": str(candidate.get("id") or f"synthetic-{index}"),
                "type": "function",
                "function": {
                    "name": tool_name,
                    "arguments": _normalize_tool_arguments(arguments),
                },
            }

    tool_name = str(candidate.get("tool_name") or candidate.get("toolName") or "").strip()
    if not tool_name:
        return None
    arguments = candidate.get("arguments", {})
    return {
        "id": str(candidate.get("id") or f"synthetic-{index}"),
        "type": "function",
        "function": {
            "name": tool_name,
            "arguments": _normalize_tool_arguments(arguments),
        },
    }


def _extract_synthetic_tool_calls_from_content(content: str) -> List[Dict[str, Any]]:
    parsed = _parse_json_object_text(content)
    if not isinstance(parsed, Mapping):
        return []

    synthetic_calls: List[Dict[str, Any]] = []
    raw_tool_calls = parsed.get("tool_calls") or parsed.get("toolCalls")
    if isinstance(raw_tool_calls, Sequence) and not isinstance(raw_tool_calls, (str, bytes, bytearray)):
        for index, item in enumerate(raw_tool_calls, start=1):
            if not isinstance(item, Mapping):
                continue
            normalized = _normalize_synthetic_tool_call(item, index)
            if normalized is not None:
                synthetic_calls.append(normalized)
        if synthetic_calls:
            return synthetic_calls

    normalized_single = _normalize_synthetic_tool_call(parsed, 1)
    if normalized_single is not None:
        return [normalized_single]
    return []


def parse_model_turn(payload: Dict[str, Any]) -> ParsedModelTurn:
    choices = payload.get("choices", [])
    choice = choices[0] if isinstance(choices, list) and choices else {}
    if not isinstance(choice, dict):
        choice = {}
    message = choice.get("message", {})
    if not isinstance(message, dict):
        message = {}
    raw_tool_calls = message.get("tool_calls")
    model_tool_calls = raw_tool_calls if isinstance(raw_tool_calls, list) else []
    raw_provider_parts = message.get("provider_parts")
    provider_parts = raw_provider_parts if isinstance(raw_provider_parts, list) else []
    content = _extract_text_like(message.get("content"))
    if content:
        unwrapped = _unwrap_json_answer(content)
        if unwrapped:
            content = unwrapped
    if not model_tool_calls and content:
        model_tool_calls = _extract_synthetic_tool_calls_from_content(content)
    reasoning = _extract_text_like(message.get("reasoning_content")) or _extract_text_like(message.get("reasoning"))
    if not reasoning:
        reasoning = _extract_text_like(choice.get("reasoning_content")) or _extract_text_like(choice.get("reasoning"))
    return ParsedModelTurn(
        message=message,
        content=content,
        reasoning=reasoning,
        tool_calls=[item for item in model_tool_calls if isinstance(item, dict)],
        resolved_model=str(payload["model"]) if payload.get("model") else None,
        provider_parts=[item for item in provider_parts if isinstance(item, dict)],
    )


def build_tool_execution_error(fn_name: str, error: Exception) -> Dict[str, Any]:
    return {
        "toolCall": {
            "name": fn_name,
            "status": "disabled",
            "summary": f"Tool execution failed: {error}",
        },
        "result": {
            "ok": False,
            "code": "execution_error",
            "message": str(error),
            "summary": f"Tool execution failed: {error}",
            "context": f"Tool {fn_name} failed.",
        },
    }


def extract_web_sources_from_result_payload(
    result_payload: Mapping[str, Any],
    *,
    fallback_source_type: str = "web_search",
) -> List[Dict[str, Any]]:
    data = result_payload.get("data")
    if not isinstance(data, Mapping):
        return []
    results = data.get("results")
    if not isinstance(results, list):
        return []

    sources: List[Dict[str, Any]] = []
    for item in results:
        if not isinstance(item, Mapping):
            continue
        title = " ".join(str(item.get("title") or "").strip().split())
        url = str(item.get("url") or "").strip()
        snippet = " ".join(
            str(item.get("content") or item.get("snippet") or item.get("summary") or "").strip().split()
        )
        if not title and not url and not snippet:
            continue
        score_raw = item.get("score")
        score = float(score_raw) if isinstance(score_raw, (int, float)) else None
        published_raw = item.get("publishedDate") or item.get("published_date") or item.get("published")
        published_date = str(published_raw).strip() if published_raw else None
        sources.append(
            {
                "title": title or url or "Web result",
                "url": url,
                "snippet": snippet or None,
                "sourceType": str(item.get("sourceType") or fallback_source_type).strip() or fallback_source_type,
                "publishedDate": published_date or None,
                "score": score,
            }
        )

    return merge_web_sources([], sources)


def merge_web_sources(
    existing: Sequence[Mapping[str, Any]],
    candidates: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    seen: set[str] = set()

    def append_item(item: Mapping[str, Any]) -> None:
        url = str(item.get("url") or "").strip()
        title = str(item.get("title") or "").strip()
        key = url or title
        if not key or key in seen:
            return
        seen.add(key)
        score_raw = item.get("score")
        merged.append(
            {
                "title": title or url or "Web result",
                "url": url,
                "snippet": str(item.get("snippet") or "").strip() or None,
                "sourceType": str(item.get("sourceType") or "web_search").strip() or "web_search",
                "publishedDate": str(item.get("publishedDate") or "").strip() or None,
                "score": float(score_raw) if isinstance(score_raw, (int, float)) else None,
            }
        )

    for item in existing:
        append_item(item)
    for item in candidates:
        append_item(item)

    return merged


def append_tool_result_message(
    *,
    state: ToolLoopState,
    call: Dict[str, Any],
    result_payload: Dict[str, Any],
    round_id: int,
    index: int,
) -> None:
    fn_name = str((call.get("function") or {}).get("name") or "tool")
    call_id = str(call.get("id") or f"{fn_name}-{round_id}-{index + 1}")
    state.messages.append(
        {
            "role": "tool",
            "tool_call_id": call_id,
            "content": json_dumps(
                {
                    "ok": result_payload.get("ok", False),
                    "code": result_payload.get("code", "execution_error"),
                    "message": result_payload.get("message", ""),
                    "summary": result_payload.get("summary", ""),
                    "context": result_payload.get("context", ""),
                    "data": result_payload.get("data"),
                    "pendingAction": state.pending_action,
                    "approval": state.approval,
                }
            ),
        }
    )
