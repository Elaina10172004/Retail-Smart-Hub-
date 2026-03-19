from __future__ import annotations

import json
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import quote

import httpx

from .common import AgentConfig


def _resolve_provider_settings(config: AgentConfig, role: str) -> Dict[str, str]:
    profile = config.resolve_model_profile(role)
    return {
        "provider": profile["provider"],
        "api_key": profile["api_key"],
        "base_url": profile["base_url"].rstrip("/"),
        "model": profile["model"],
        "api_key_env": profile["api_key_env"],
    }


def _extract_error_message(payload: Any) -> str:
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict):
            message = err.get("message")
            if isinstance(message, str) and message.strip():
                return message.strip()
        message = payload.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
        detail = payload.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail.strip()
    return ""


def _preview_text(value: Any, limit: int = 240) -> str:
    text = str(value).strip().replace("\r", " ").replace("\n", " ")
    return text[:limit]


def _truncate_log_text(text: str, max_chars: int) -> str:
    if max_chars > 0 and len(text) > max_chars:
        return text[:max_chars] + "\n...(truncated)"
    return text


def _stringify_for_log(payload: Any, max_chars: int) -> str:
    try:
        text = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    except Exception:
        text = _preview_text(payload, limit=max_chars if max_chars > 0 else 2000)
    return _truncate_log_text(text, max_chars)


def _model_io_log(config: AgentConfig, *, role: str, phase: str, payload: Dict[str, Any]) -> None:
    if not getattr(config, "ai_model_io_console_log", False):
        return
    max_chars = max(0, int(getattr(config, "ai_model_io_console_log_max_chars", 0)))
    body = _summarize_model_io_payload(phase=phase, payload=payload, max_chars=max_chars)
    print(f"[python-agent][model-io][role={role}][{phase}]\n{body}")


def _sanitize_binary_payload(value: Any) -> Any:
    if isinstance(value, Mapping):
        sanitized: Dict[str, Any] = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if lowered in {"data", "image_data_url", "imagedataurl"} and isinstance(item, str) and len(item) > 64:
                sanitized[str(key)] = f"<redacted:{len(item)} chars>"
                continue
            sanitized[str(key)] = _sanitize_binary_payload(item)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_binary_payload(item) for item in value]
    if isinstance(value, tuple):
        return [_sanitize_binary_payload(item) for item in value]
    if isinstance(value, str) and value.startswith("data:") and len(value) > 64:
        return f"<redacted:{len(value)} chars>"
    return value


def _unwrap_json_answer_text(text: str) -> str | None:
    candidate = text.strip()
    if not candidate:
        return None
    if candidate.startswith("```"):
        stripped = candidate.strip("`").strip()
        if stripped.lower().startswith("json"):
            stripped = stripped[4:].strip()
        candidate = stripped
    if not candidate.startswith("{"):
        return None
    try:
        parsed = json.loads(candidate)
    except Exception:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if 0 <= start < end:
            try:
                parsed = json.loads(candidate[start : end + 1])
            except Exception:
                return None
        else:
            return None
    if not isinstance(parsed, Mapping):
        return None
    mode = str(parsed.get("mode") or "").strip().upper()
    answer = parsed.get("answer")
    if isinstance(answer, str) and answer.strip():
        return answer.strip()
    if mode in {"ANSWER", "FINAL", "RESPONSE", "RESULT"}:
        for key in ("reply", "response", "final_answer", "final", "content", "message"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _normalize_text_part(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("{") or text.startswith("```"):
            unwrapped = _unwrap_json_answer_text(text)
            if unwrapped:
                return unwrapped
        return text
    if isinstance(value, (int, float, bool)):
        return str(value).strip()
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        parts: List[str] = []
        for item in value:
            text = _normalize_text_part(item)
            if text:
                parts.append(text)
        return " ".join(parts).strip()
    if isinstance(value, Mapping):
        for key in ("text", "content", "value", "output_text", "message"):
            if key not in value:
                continue
            text = _normalize_text_part(value.get(key))
            if text:
                return text
        return ""
    return ""


def _normalize_openai_message_content(content: Any) -> str:
    if isinstance(content, Mapping) and ("images" in content or "text" in content):
        text = _normalize_text_part(content.get("text"))
        image_lines: List[str] = []
        images = content.get("images")
        if isinstance(images, Sequence) and not isinstance(images, (str, bytes, bytearray)):
            for item in images:
                if not isinstance(item, Mapping):
                    continue
                file_name = str(item.get("file_name") or item.get("fileName") or "image").strip()
                mime_type = str(item.get("mime_type") or item.get("mimeType") or "").strip()
                suffix = f" ({mime_type})" if mime_type else ""
                image_lines.append(f"- {file_name}{suffix}")
        if image_lines:
            note = "Attached images are present:\n" + "\n".join(image_lines)
            return f"{text}\n\n{note}".strip()
        return text
    return _normalize_text_part(content)


def _preview_console_block(text: str, limit: int = 180) -> str:
    if limit > 0 and len(text) > limit:
        return text[:limit] + "...(truncated)"
    return text


def _parse_json_object_text(value: Any) -> Dict[str, Any] | None:
    candidate = str(value or "").strip()
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


def _unwrap_json_answer_for_log(text: str) -> str:
    parsed = _parse_json_object_text(text)
    if not isinstance(parsed, dict):
        return text
    for key in ("answer", "reply", "response", "final", "content", "message"):
        candidate = parsed.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return text


def _extract_tool_names(tools: Any) -> List[str]:
    names: List[str] = []
    if not isinstance(tools, Sequence) or isinstance(tools, (str, bytes, bytearray)):
        return names
    for item in tools:
        if not isinstance(item, Mapping):
            continue
        function_payload = item.get("function")
        if isinstance(function_payload, Mapping):
            name = str(function_payload.get("name") or "").strip()
            if name and name not in names:
                names.append(name)
        declarations = item.get("functionDeclarations")
        if isinstance(declarations, Sequence) and not isinstance(declarations, (str, bytes, bytearray)):
            for declaration in declarations:
                if not isinstance(declaration, Mapping):
                    continue
                name = str(declaration.get("name") or "").strip()
                if name and name not in names:
                    names.append(name)
    return names


def _format_tool_name_summary(names: Sequence[str], limit: int = 8) -> str:
    visible = [name for name in names[:limit] if name]
    if not visible:
        return ""
    suffix = ""
    if len(names) > len(visible):
        suffix = f" (+{len(names) - len(visible)} more)"
    return ", ".join(visible) + suffix


def _summarize_openai_messages_for_log(messages: Any, limit: int = 8) -> List[str]:
    lines: List[str] = []
    if not isinstance(messages, Sequence) or isinstance(messages, (str, bytes, bytearray)):
        return lines
    start = max(0, len(messages) - limit)
    if start > 0:
        lines.append(f"... {start} earlier message(s)")
    for index, message in enumerate(messages[start:], start=start):
        if not isinstance(message, Mapping):
            continue
        role = str(message.get("role") or "user").strip() or "user"
        content = _normalize_openai_message_content(message.get("content"))
        if content:
            if role == "assistant":
                content = _unwrap_json_answer_for_log(content)
            content = content.replace("\\n", "\n")
            content = _preview_console_block(content, limit=180)
            if "\n" in content:
                lines.append(f"{role}:")
                lines.extend(f"  {line}" for line in content.splitlines())
            else:
                lines.append(f"{role}: {content}")
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, Sequence) and not isinstance(tool_calls, (str, bytes, bytearray)):
            for tool_call in tool_calls[:4]:
                if not isinstance(tool_call, Mapping):
                    continue
                function_payload = tool_call.get("function")
                if not isinstance(function_payload, Mapping):
                    continue
                name = str(function_payload.get("name") or "").strip() or "unknown_tool"
                args_preview = _preview_console_block(
                    _normalize_text_part(function_payload.get("arguments") or "{}"), limit=120
                )
                lines.append(f"{role} -> tool {name}: {args_preview}")
        if role == "tool":
            tool_call_id = str(message.get("tool_call_id") or "").strip()
            if tool_call_id:
                lines.append(f"tool id: {tool_call_id}")
    return lines


def _summarize_gemini_contents_for_log(
    contents: Any,
    *,
    system_instruction: Any = None,
    limit: int = 8,
) -> List[str]:
    lines: List[str] = []
    if isinstance(system_instruction, Mapping):
        system_parts = system_instruction.get("parts")
        system_text = _normalize_text_part(system_parts)
        if system_text:
            lines.append(f"system: {_preview_console_block(system_text, limit=180)}")
    if not isinstance(contents, Sequence) or isinstance(contents, (str, bytes, bytearray)):
        return lines
    start = max(0, len(contents) - limit)
    if start > 0:
        lines.append(f"... {start} earlier content item(s)")
    for index, content in enumerate(contents[start:], start=start):
        if not isinstance(content, Mapping):
            continue
        role = str(content.get("role") or "user").strip() or "user"
        parts = content.get("parts")
        if not isinstance(parts, Sequence) or isinstance(parts, (str, bytes, bytearray)):
            continue
        for part in parts[:6]:
            if not isinstance(part, Mapping):
                continue
            text = _normalize_text_part(part.get("text"))
            if text:
                if role == "model":
                    text = _unwrap_json_answer_for_log(text)
                text = text.replace("\\n", "\n")
                text = _preview_console_block(text, limit=180)
                if "\n" in text:
                    lines.append(f"{role}:")
                    lines.extend(f"  {line}" for line in text.splitlines())
                else:
                    lines.append(f"{role}: {text}")
                continue
            function_call = part.get("functionCall")
            if isinstance(function_call, Mapping):
                name = str(function_call.get("name") or "").strip() or "unknown_tool"
                args_preview = _preview_console_block(
                    _normalize_text_part(function_call.get("args") or "{}"), limit=120
                )
                lines.append(f"{role} -> tool {name}: {args_preview}")
                continue
            function_response = part.get("functionResponse")
            if isinstance(function_response, Mapping):
                name = str(function_response.get("name") or "").strip() or "unknown_tool"
                response_preview = _preview_console_block(
                    _normalize_text_part(function_response.get("response") or ""), limit=160
                )
                lines.append(f"tool {name}: {response_preview}")
    return lines


def _summarize_openai_response_for_log(response: Any) -> List[str]:
    lines: List[str] = []
    if not isinstance(response, Mapping):
        return [f"response: {_preview_console_block(_preview_text(response), limit=180)}"]
    choices = response.get("choices")
    if isinstance(choices, Sequence) and not isinstance(choices, (str, bytes, bytearray)):
        for index, choice in enumerate(choices[:3]):
            if not isinstance(choice, Mapping):
                continue
            message = choice.get("message")
            if isinstance(message, Mapping):
                lines.extend(_summarize_openai_messages_for_log([message], limit=1))
            finish_reason = str(choice.get("finish_reason") or "").strip()
            if finish_reason:
                lines.append(f"finish_reason: {finish_reason}")
            if index == 2 and len(choices) > 3:
                lines.append(f"... {len(choices) - 3} more choice(s)")
                break
    usage = response.get("usage")
    if isinstance(usage, Mapping):
        prompt_tokens = usage.get("prompt_tokens")
        completion_tokens = usage.get("completion_tokens")
        total_tokens = usage.get("total_tokens")
        lines.append(
            "usage: "
            f"prompt={prompt_tokens if prompt_tokens is not None else '?'} "
            f"completion={completion_tokens if completion_tokens is not None else '?'} "
            f"total={total_tokens if total_tokens is not None else '?'}"
        )
    return lines


def _summarize_gemini_response_for_log(response: Any) -> List[str]:
    lines: List[str] = []
    if not isinstance(response, Mapping):
        return [f"response: {_preview_console_block(_preview_text(response), limit=180)}"]
    candidates = response.get("candidates")
    if isinstance(candidates, Sequence) and not isinstance(candidates, (str, bytes, bytearray)):
        for index, candidate in enumerate(candidates[:3]):
            if not isinstance(candidate, Mapping):
                continue
            content = candidate.get("content")
            if isinstance(content, Mapping):
                lines.extend(_summarize_gemini_contents_for_log([content], limit=1))
            finish_reason = str(candidate.get("finishReason") or "").strip()
            if finish_reason:
                lines.append(f"finish_reason: {finish_reason}")
            if index == 2 and len(candidates) > 3:
                lines.append(f"... {len(candidates) - 3} more candidate(s)")
                break
    usage = response.get("usageMetadata")
    if isinstance(usage, Mapping):
        lines.append(
            "usage: "
            f"prompt={usage.get('promptTokenCount', '?')} "
            f"candidates={usage.get('candidatesTokenCount', '?')} "
            f"total={usage.get('totalTokenCount', '?')}"
        )
    return lines


def _summarize_model_io_payload(*, phase: str, payload: Dict[str, Any], max_chars: int) -> str:
    lines: List[str] = []
    for key in ("provider", "model", "status_code", "endpoint", "message_count", "tool_count", "tool_choice", "error"):
        value = payload.get(key)
        if value not in (None, "", [], {}, ()):
            lines.append(f"{key}: {value}")

    request_body = payload.get("payload")
    response_body = payload.get("response")
    if isinstance(request_body, Mapping):
        tool_names = _extract_tool_names(request_body.get("tools"))
        if tool_names:
            lines.append(f"tools: {_format_tool_name_summary(tool_names)}")
        if "messages" in request_body:
            lines.append("chat:")
            lines.extend(
                f"  {line}"
                for line in _summarize_openai_messages_for_log(request_body.get("messages"), limit=4)
            )
        elif "contents" in request_body:
            lines.append("chat:")
            lines.extend(
                f"  {line}"
                for line in _summarize_gemini_contents_for_log(
                    request_body.get("contents"),
                    system_instruction=request_body.get("systemInstruction"),
                    limit=4,
                )
            )
    elif isinstance(response_body, Mapping):
        provider = str(payload.get("provider") or "").strip().lower()
        lines.append("chat:")
        if provider == "gemini":
            lines.extend(f"  {line}" for line in _summarize_gemini_response_for_log(response_body))
        else:
            lines.extend(f"  {line}" for line in _summarize_openai_response_for_log(response_body))

    body = "\n".join(line for line in lines if line.strip())
    if not body:
        body = _stringify_for_log(payload, max_chars)
    return _truncate_log_text(body, max_chars)


def _normalize_openai_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, Mapping):
            continue
        role = str(message.get("role") or "user").strip() or "user"
        if role == "tool":
            tool_message: Dict[str, Any] = {
                "role": "tool",
                "content": _normalize_openai_message_content(message.get("content")),
            }
            tool_call_id = str(message.get("tool_call_id") or "").strip()
            if tool_call_id:
                tool_message["tool_call_id"] = tool_call_id
            normalized.append(tool_message)
            continue
        next_message: Dict[str, Any] = {
            "role": role,
            "content": _normalize_openai_message_content(message.get("content")),
        }
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list):
            next_message["tool_calls"] = [item for item in tool_calls if isinstance(item, dict)]
        reasoning_content = _normalize_text_part(message.get("reasoning_content"))
        if reasoning_content:
            next_message["reasoning_content"] = reasoning_content
        normalized.append(next_message)
    return normalized


def _parse_data_url(value: str) -> Tuple[str, str] | None:
    raw = str(value or "").strip()
    if not raw.startswith("data:") or "," not in raw:
        return None
    header, data = raw.split(",", 1)
    metadata = header[5:]
    mime_type = metadata.split(";", 1)[0].strip() or "image/jpeg"
    return mime_type, data.strip()


def _build_gemini_user_parts(content: Any) -> List[Dict[str, Any]]:
    if isinstance(content, Mapping) and ("images" in content or "text" in content):
        parts: List[Dict[str, Any]] = []
        text = _normalize_text_part(content.get("text"))
        if text:
            parts.append({"text": text})
        images = content.get("images")
        if isinstance(images, Sequence) and not isinstance(images, (str, bytes, bytearray)):
            for item in images:
                if not isinstance(item, Mapping):
                    continue
                data_url = str(item.get("data_url") or item.get("dataUrl") or "").strip()
                parsed = _parse_data_url(data_url)
                if parsed is None:
                    continue
                mime_type, data = parsed
                parts.append(
                    {
                        "inlineData": {
                            "mimeType": mime_type,
                            "data": data,
                        }
                    }
                )
        return parts
    text = _normalize_text_part(content)
    return [{"text": text}] if text else []


def _extract_gemini_function_call(part: Mapping[str, Any]) -> Mapping[str, Any] | None:
    function_call = part.get("functionCall")
    if isinstance(function_call, Mapping):
        return function_call
    alt = part.get("function_call")
    if isinstance(alt, Mapping):
        return alt
    return None


def _sanitize_gemini_schema_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        sanitized: Dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = str(key)
            if normalized_key == "additionalProperties":
                continue
            sanitized[normalized_key] = _sanitize_gemini_schema_value(item)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_gemini_schema_value(item) for item in value]
    if isinstance(value, tuple):
        return [_sanitize_gemini_schema_value(item) for item in value]
    return value


def _sanitize_gemini_parameters(value: Any) -> Dict[str, Any]:
    if not isinstance(value, Mapping):
        return {"type": "object", "properties": {}}
    sanitized = _sanitize_gemini_schema_value(value)
    if not isinstance(sanitized, dict):
        return {"type": "object", "properties": {}}
    return sanitized


def _build_gemini_contents(messages: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], str]:
    contents: List[Dict[str, Any]] = []
    system_parts: List[str] = []
    tool_name_by_id: Dict[str, str] = {}

    for message in messages:
        if not isinstance(message, Mapping):
            continue
        role = str(message.get("role") or "user").strip() or "user"
        if role == "system":
            system_text = _normalize_text_part(message.get("content"))
            if system_text:
                system_parts.append(system_text)
            continue

        if role == "tool":
            tool_call_id = str(message.get("tool_call_id") or "").strip()
            tool_name = tool_name_by_id.get(tool_call_id, "tool")
            raw_content = message.get("content")
            if isinstance(raw_content, str):
                try:
                    response_payload = json.loads(raw_content)
                except Exception:
                    response_payload = {"text": raw_content}
            elif isinstance(raw_content, Mapping):
                response_payload = dict(raw_content)
            else:
                response_payload = {"text": _normalize_text_part(raw_content)}
            function_response: Dict[str, Any] = {
                "name": tool_name,
                "response": response_payload,
            }
            if tool_call_id:
                function_response["id"] = tool_call_id
            contents.append({"role": "user", "parts": [{"functionResponse": function_response}]})
            continue

        gemini_role = "model" if role == "assistant" else "user"
        provider_parts = message.get("provider_parts")
        parts: List[Dict[str, Any]] = []
        if role == "assistant" and isinstance(provider_parts, list):
            parts = [item for item in provider_parts if isinstance(item, dict)]
        else:
            parts = _build_gemini_user_parts(message.get("content"))
            tool_calls = message.get("tool_calls")
            if role == "assistant" and isinstance(tool_calls, list):
                for index, call in enumerate(tool_calls):
                    if not isinstance(call, Mapping):
                        continue
                    call_id = str(call.get("id") or f"tool-call-{len(tool_name_by_id) + index + 1}").strip()
                    function_payload = call.get("function")
                    if not isinstance(function_payload, Mapping):
                        continue
                    name = str(function_payload.get("name") or "").strip()
                    raw_arguments = function_payload.get("arguments")
                    if not name:
                        continue
                    if isinstance(raw_arguments, str):
                        try:
                            args = json.loads(raw_arguments or "{}")
                        except Exception:
                            args = {"raw": raw_arguments}
                    elif isinstance(raw_arguments, Mapping):
                        args = dict(raw_arguments)
                    else:
                        args = {}
                    parts.append(
                        {
                            "functionCall": {
                                "name": name,
                                "args": args,
                                "id": call_id,
                            }
                        }
                    )
        for part in parts:
            function_call = _extract_gemini_function_call(part)
            if not isinstance(function_call, Mapping):
                continue
            call_id = str(function_call.get("id") or "").strip()
            name = str(function_call.get("name") or "").strip()
            if call_id and name:
                tool_name_by_id[call_id] = name
        if parts:
            contents.append({"role": gemini_role, "parts": parts})

    return contents, "\n\n".join(item for item in system_parts if item).strip()


def _build_gemini_tools(tools: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    declarations: List[Dict[str, Any]] = []
    for item in tools or []:
        if not isinstance(item, Mapping):
            continue
        function_payload = item.get("function")
        if not isinstance(function_payload, Mapping):
            continue
        name = str(function_payload.get("name") or "").strip()
        if not name:
            continue
        parameters = _sanitize_gemini_parameters(function_payload.get("parameters"))
        declarations.append(
            {
                "name": name,
                "description": str(function_payload.get("description") or "").strip(),
                "parameters": parameters,
            }
        )
    return [{"functionDeclarations": declarations}] if declarations else []


def _sanitize_tool_schema(tools: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    sanitized: List[Dict[str, Any]] = []
    for item in tools or []:
        if not isinstance(item, Mapping):
            continue
        function_payload = item.get("function")
        if not isinstance(function_payload, Mapping):
            continue
        name = str(function_payload.get("name") or "").strip()
        if not name:
            continue
        sanitized.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": str(function_payload.get("description") or "").strip(),
                    "parameters": function_payload.get("parameters") or {"type": "object", "properties": {}},
                },
            }
        )
    return sanitized


def _translate_gemini_response(payload: Mapping[str, Any], *, model: str) -> Dict[str, Any]:
    candidates = payload.get("candidates", [])
    candidate = candidates[0] if isinstance(candidates, list) and candidates else {}
    if not isinstance(candidate, Mapping):
        candidate = {}
    content_payload = candidate.get("content", {})
    if not isinstance(content_payload, Mapping):
        content_payload = {}
    raw_parts = content_payload.get("parts", [])
    parts = [item for item in raw_parts if isinstance(item, dict)] if isinstance(raw_parts, list) else []

    texts: List[str] = []
    reasoning_parts: List[str] = []
    tool_calls: List[Dict[str, Any]] = []
    for index, part in enumerate(parts, start=1):
        text = part.get("text")
        if isinstance(text, str) and text.strip():
            if bool(part.get("thought")):
                reasoning_parts.append(text.strip())
            else:
                texts.append(text.strip())
            continue
        function_call = _extract_gemini_function_call(part)
        if isinstance(function_call, Mapping):
            name = str(function_call.get("name") or "").strip()
            if not name:
                continue
            arguments = function_call.get("args")
            if not isinstance(arguments, Mapping):
                arguments = {}
            call_id = str(function_call.get("id") or f"gemini-tool-call-{index}").strip()
            tool_calls.append(
                {
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": json.dumps(arguments, ensure_ascii=False, separators=(",", ":")),
                    },
                }
            )

    message: Dict[str, Any] = {
        "content": "\n".join(item for item in texts if item).strip(),
        "tool_calls": tool_calls,
        "provider_parts": parts,
    }
    choice: Dict[str, Any] = {"message": message}
    reasoning_content = "\n".join(item for item in reasoning_parts if item).strip()
    if reasoning_content:
        choice["reasoning_content"] = reasoning_content
        message["reasoning_content"] = reasoning_content
    return {
        "model": model,
        "choices": [choice],
    }


def _build_gemini_request(
    config: AgentConfig,
    settings: Dict[str, str],
    messages: List[Dict[str, Any]],
    *,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[str] = None,
    role: str,
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    contents, system_instruction = _build_gemini_contents(messages)
    endpoint = f"{settings['base_url']}/models/{quote(settings['model'], safe='')}:generateContent"
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": settings["api_key"],
    }
    body: Dict[str, Any] = {
        "contents": contents,
    }
    if system_instruction:
        body["systemInstruction"] = {"parts": [{"text": system_instruction}]}
    gemini_tools = _build_gemini_tools(tools)
    if gemini_tools:
        body["tools"] = gemini_tools
        mode = "NONE" if tool_choice == "none" else "AUTO"
        body["toolConfig"] = {"functionCallingConfig": {"mode": mode}}
    if not config.requires_reasoning_for_tool_calls(role):
        body["generationConfig"] = {"temperature": 0.3}
    return endpoint, headers, body


def _build_openai_compatible_request(
    config: AgentConfig,
    settings: Dict[str, str],
    messages: List[Dict[str, Any]],
    *,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[str] = None,
    role: str,
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    endpoint = f"{settings['base_url']}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings['api_key']}",
    }
    body: Dict[str, Any] = {
        "model": settings["model"],
        "messages": _normalize_openai_messages(messages),
        "stream": False,
    }
    sanitized_tools = _sanitize_tool_schema(tools)
    if sanitized_tools:
        body["tools"] = sanitized_tools
        body["tool_choice"] = tool_choice or "auto"
    if not config.requires_reasoning_for_tool_calls(role):
        body["temperature"] = 0.3
    return endpoint, headers, body


async def request_model(
    config: AgentConfig,
    messages: List[Dict[str, Any]],
    *,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[str] = None,
    role: str = "large",
) -> Dict[str, Any]:
    settings = _resolve_provider_settings(config, role)
    api_key = settings["api_key"]
    if not api_key or api_key.startswith("REPLACE_WITH_"):
        raise RuntimeError(f"{settings['api_key_env']} is not configured")

    if settings["provider"] == "gemini":
        endpoint, headers, body = _build_gemini_request(
            config,
            settings,
            messages,
            tools=tools,
            tool_choice=tool_choice,
            role=role,
        )
    else:
        endpoint, headers, body = _build_openai_compatible_request(
            config,
            settings,
            messages,
            tools=tools,
            tool_choice=tool_choice,
            role=role,
        )

    _model_io_log(
        config,
        role=role,
        phase="request",
        payload={
            "provider": settings["provider"],
            "model": settings["model"],
            "endpoint": endpoint,
            "message_count": len(messages),
            "tool_count": len(tools or []),
            "tool_choice": tool_choice or ("auto" if tools else "none"),
            "payload": _sanitize_binary_payload(body),
        },
    )

    timeout = max(5.0, config.request_timeout_ms / 1000.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            response = await client.post(endpoint, headers=headers, json=body)
        except Exception as error:
            _model_io_log(
                config,
                role=role,
                phase="transport_error",
                payload={
                    "provider": settings["provider"],
                    "model": settings["model"],
                    "endpoint": endpoint,
                    "error": str(error),
                },
            )
            raise RuntimeError(f"{settings['provider']} request transport error: {error}") from error

        raw_text = response.text if response.content else ""
        data: Any = {}
        if raw_text:
            try:
                data = response.json()
            except Exception:
                data = raw_text

        _model_io_log(
            config,
            role=role,
            phase="response",
            payload={
                "provider": settings["provider"],
                "model": settings["model"],
                "status_code": response.status_code,
                "response": _sanitize_binary_payload(data if data not in ({}, None) else raw_text),
            },
        )

        if response.status_code >= 400:
            error_message = _extract_error_message(data)
            details = error_message or (_preview_text(data) if data else "no upstream error body")
            raise RuntimeError(
                f"{settings['provider']} request failed with status {response.status_code}: {details}"
            )

        if not isinstance(data, dict):
            raise RuntimeError(
                f"invalid {settings['provider']} response: expected JSON object, got {type(data).__name__} {_preview_text(data)}"
            )

        if settings["provider"] == "gemini":
            return _translate_gemini_response(data, model=settings["model"])
        return data


async def request_deepseek(
    config: AgentConfig,
    messages: List[Dict[str, Any]],
    *,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[str] = None,
    role: str = "large",
) -> Dict[str, Any]:
    return await request_model(config, messages, tools=tools, tool_choice=tool_choice, role=role)
