from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Sequence, Tuple

from .common import AgentConfig
from .models import ChatRequest
from .orchestration_helpers import parse_model_turn

ModelRequestFn = Callable[..., Awaitable[Dict[str, Any]]]


@dataclass
class ImageEvidenceExtractionResult:
    evidence: List[Dict[str, Any]] = field(default_factory=list)
    summary_lines: List[str] = field(default_factory=list)
    extracted_indices: List[int] = field(default_factory=list)
    attempted_count: int = 0


def _compact_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _clip_text(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 3)] + "..."


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


def is_image_attachment(attachment: Any) -> bool:
    kind = _compact_text(getattr(attachment, "kind", "")).lower()
    image_data_url = _compact_text(getattr(attachment, "imageDataUrl", ""))
    return kind == "image" or bool(image_data_url.startswith("data:"))


def has_image_attachments(attachments: Sequence[Any] | None) -> bool:
    return any(is_image_attachment(item) for item in attachments or [])


def filter_out_extracted_images(request: ChatRequest, extracted_indices: Sequence[int]) -> ChatRequest:
    if not extracted_indices:
        return request
    extracted = set(int(index) for index in extracted_indices)
    remaining = [item for index, item in enumerate(request.attachments) if index not in extracted]
    return request.model_copy(update={"attachments": remaining})


def append_image_summary_to_attachment_context(
    attachment_context: str,
    summary_lines: Sequence[str],
) -> str:
    lines = [_compact_text(item) for item in summary_lines if _compact_text(item)]
    if not lines:
        return attachment_context
    base = str(attachment_context or "").strip()
    section = "Image evidence extracted by small multimodal model:\n" + "\n".join(lines)
    if not base:
        return section
    return f"{base}\n\n{section}"


def _iter_image_attachments(attachments: Sequence[Any] | None) -> List[Tuple[int, Any]]:
    images: List[Tuple[int, Any]] = []
    for index, attachment in enumerate(attachments or []):
        if is_image_attachment(attachment):
            images.append((index, attachment))
    return images


def _normalize_confidence(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return max(0.0, min(1.0, float(value)))
    text = _compact_text(value)
    if not text:
        return None
    try:
        return max(0.0, min(1.0, float(text)))
    except Exception:
        return None


def _normalize_evidence_rows(
    *,
    attachment: Any,
    payload: Mapping[str, Any],
    max_items: int = 4,
) -> List[Dict[str, Any]]:
    file_name = _compact_text(getattr(attachment, "fileName", "")) or "image"
    attachment_id = _compact_text(getattr(attachment, "id", "")) or hashlib.sha1(file_name.encode("utf-8")).hexdigest()[:12]
    mime_type = _compact_text(getattr(attachment, "mimeType", "")) or "image/jpeg"
    width = getattr(attachment, "imageWidth", None)
    height = getattr(attachment, "imageHeight", None)
    summary = _clip_text(_compact_text(payload.get("summary", "")), 220)

    evidence: List[Dict[str, Any]] = []
    raw_items = payload.get("evidence")
    if not isinstance(raw_items, list):
        raw_items = []
    for position, raw in enumerate(raw_items[:max_items], start=1):
        if not isinstance(raw, Mapping):
            continue
        claim = _clip_text(_compact_text(raw.get("claim", "")), 420)
        excerpt = _clip_text(_compact_text(raw.get("excerpt", "")), 320)
        focus = _compact_text(raw.get("focus", "")) or "full_image"
        confidence = _normalize_confidence(raw.get("confidence"))
        if not claim and summary:
            claim = summary
        if not claim:
            continue
        if not excerpt:
            excerpt = claim
        source_quality = 0.84 if confidence is None else round(0.74 + confidence * 0.18, 3)
        locator: Dict[str, Any] = {
            "attachment_id": attachment_id,
            "file_name": file_name,
            "kind": "image",
            "focus": focus,
            "mime_type": mime_type,
        }
        if isinstance(width, int) and width > 0:
            locator["image_width"] = width
        if isinstance(height, int) and height > 0:
            locator["image_height"] = height
        evidence.append(
            {
                "attachment_id": attachment_id,
                "file_name": file_name,
                "title": file_name,
                "claim": claim,
                "excerpt": excerpt,
                "locator": locator,
                "support_type": "attachment_image_vision",
                "source_quality": source_quality,
                "rank": position,
            }
        )

    if evidence or not summary:
        return evidence

    fallback_locator: Dict[str, Any] = {
        "attachment_id": attachment_id,
        "file_name": file_name,
        "kind": "image",
        "focus": "full_image",
        "mime_type": mime_type,
    }
    if isinstance(width, int) and width > 0:
        fallback_locator["image_width"] = width
    if isinstance(height, int) and height > 0:
        fallback_locator["image_height"] = height
    return [
        {
            "attachment_id": attachment_id,
            "file_name": file_name,
            "title": file_name,
            "claim": summary,
            "excerpt": summary,
            "locator": fallback_locator,
            "support_type": "attachment_image_vision",
            "source_quality": 0.82,
            "rank": 1,
        }
    ]


def _build_summary_line(attachment: Any, payload: Mapping[str, Any], evidence: Sequence[Mapping[str, Any]]) -> str:
    file_name = _compact_text(getattr(attachment, "fileName", "")) or "image"
    summary = _clip_text(_compact_text(payload.get("summary", "")), 220)
    if not summary and evidence:
        summary = _clip_text(_compact_text(evidence[0].get("claim", "")), 220)
    if not summary:
        summary = "small model extracted image evidence."
    return f"- {file_name} kind=image extracted={summary}"


def _build_image_extraction_messages(
    *,
    prompt: str,
    rewritten_query: str,
    attachment: Any,
) -> List[Dict[str, Any]]:
    file_name = _compact_text(getattr(attachment, "fileName", "")) or "image"
    mime_type = _compact_text(getattr(attachment, "mimeType", "")) or "image/jpeg"
    width = getattr(attachment, "imageWidth", None)
    height = getattr(attachment, "imageHeight", None)
    image_data_url = _compact_text(getattr(attachment, "imageDataUrl", ""))
    metadata: List[str] = [f"file_name={file_name}", f"mime_type={mime_type}"]
    if isinstance(width, int) and width > 0 and isinstance(height, int) and height > 0:
        metadata.append(f"image_size={width}x{height}")
    instruction = "\n".join(
        [
            "You are Vision-Evidence-Extractor-v1 in a layered dual-agent runtime.",
            "Inspect the attached image and return JSON only.",
            "Do not answer the user. Extract visible evidence relevant to the task.",
            "Avoid speculation. OCR any visible text verbatim when possible.",
            "Schema:",
            "{",
            '  "summary": "string",',
            '  "evidence": [',
            '    {"claim": "string", "excerpt": "string", "focus": "string", "confidence": 0.0}',
            "  ],",
            '  "final_answer_allowed": false',
            "}",
            "Use 1-4 evidence items.",
        ]
    )
    task_text = "\n".join(
        [
            f"User prompt: {_compact_text(prompt) or 'Describe the attached image.'}",
            f"Task-focused query: {_compact_text(rewritten_query) or _compact_text(prompt) or 'Describe the visible content.'}",
            "Attachment metadata:",
            *metadata,
        ]
    )
    return [
        {"role": "system", "content": instruction},
        {
            "role": "user",
            "content": {
                "text": task_text,
                "images": [
                    {
                        "file_name": file_name,
                        "mime_type": mime_type,
                        "data_url": image_data_url,
                    }
                ],
            },
        },
    ]


async def _request_small_model(
    *,
    config: AgentConfig,
    model_requester: ModelRequestFn,
    messages: List[Dict[str, Any]],
) -> Dict[str, Any]:
    try:
        return await model_requester(config, messages, tools=None, tool_choice="none", role="small")
    except TypeError as error:
        if "role" not in str(error):
            raise
        return await model_requester(config, messages, tools=None, tool_choice="none")


async def extract_image_attachment_evidence(
    *,
    request: ChatRequest,
    rewritten_query: str,
    config: AgentConfig,
    model_requester: ModelRequestFn,
    trace: List[str],
    max_images: int = 4,
) -> ImageEvidenceExtractionResult:
    image_attachments = _iter_image_attachments(request.attachments)
    if not image_attachments:
        return ImageEvidenceExtractionResult()

    profile = config.resolve_model_profile("small")
    if profile.get("provider") != "gemini":
        trace.append(
            "Layered image evidence: skipped small multimodal extraction because the active small provider is not Gemini."
        )
        return ImageEvidenceExtractionResult()
    if not config.is_model_profile_configured("small"):
        trace.append("Layered image evidence: skipped because the active small model is not configured.")
        return ImageEvidenceExtractionResult()

    result = ImageEvidenceExtractionResult(attempted_count=min(len(image_attachments), max_images))
    for index, attachment in image_attachments[:max_images]:
        messages = _build_image_extraction_messages(
            prompt=request.prompt,
            rewritten_query=rewritten_query,
            attachment=attachment,
        )
        try:
            payload = await _request_small_model(
                config=config,
                model_requester=model_requester,
                messages=messages,
            )
            parsed = parse_model_turn(payload)
            extracted = _parse_json_object_text(parsed.content)
            if not isinstance(extracted, Mapping) or bool(extracted.get("final_answer_allowed", False)):
                trace.append(
                    f"Layered image evidence: small model returned unusable content for {getattr(attachment, 'fileName', 'image')}."
                )
                continue
            evidence = _normalize_evidence_rows(attachment=attachment, payload=extracted)
            if not evidence:
                trace.append(
                    f"Layered image evidence: no usable evidence extracted for {getattr(attachment, 'fileName', 'image')}."
                )
                continue
            result.evidence.extend(evidence)
            result.summary_lines.append(_build_summary_line(attachment, extracted, evidence))
            result.extracted_indices.append(index)
        except Exception as error:
            trace.append(
                f"Layered image evidence: small multimodal extraction failed for {getattr(attachment, 'fileName', 'image')}: {error}"
            )

    if result.evidence:
        trace.append(
            "Layered image evidence: "
            f"extracted {len(result.evidence)} evidence items from {len(result.extracted_indices)} image attachments via small model."
        )
    return result

