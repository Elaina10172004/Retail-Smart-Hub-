from __future__ import annotations
import asyncio
import json
import re
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Sequence

from fastapi import HTTPException

from .common import AgentConfig, clamp, compact_text, hash_text, parse_json_object_text
from .builtin_tools import build_builtin_tool_definitions, execute_builtin_tool, has_builtin_tool
from .document_skill import summarize_attachments
from .model_client import request_model as default_model_requester
from .models import AgentPlan, ChatRequest, ChatResponse, InterruptionState, MemoryCaptureOutcome, ToolCallRecord
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
from .prompt_catalog import get_python_prompt_text
from .rag import RagEngine

ModelRequestFn = Callable[..., Awaitable[Dict[str, Any]]]


def split_for_stream(text: str, chunk_size: int = 120) -> List[str]:
    if not text:
        return []
    return [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]


def ensure_non_empty_reply(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text if text else fallback



def _normalize_tool_arguments(value: Any) -> str:
    if isinstance(value, str):
        text = value.strip()
        return text or "{}"
    if isinstance(value, Mapping):
        try:
            return json.dumps(dict(value), ensure_ascii=False)
        except Exception:
            return "{}"
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        try:
            return json.dumps(list(value), ensure_ascii=False)
        except Exception:
            return "{}"
    if value in (None, ""):
        return "{}"
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return "{}"


def _has_image_attachments(request: ChatRequest) -> bool:
    return any(compact_text(getattr(item, "kind", "")).lower() == "image" or getattr(item, "imageDataUrl", None) for item in request.attachments)


def _reply_has_visual_hallucination_markers(reply: str) -> bool:
    normalized = compact_text(reply).lower()
    markers = (
        "模拟视觉识别",
        "模拟ocr",
        "假设识别",
        "根据图片推测",
        "模拟图片识别",
        "模拟视觉提取",
    )
    return any(marker in normalized for marker in markers)


def _build_unverified_vision_reply() -> str:
    return (
        "当前不能把这张图片当作已可靠识别的业务证据。"
        "如果图片字段没有被明确识别并核对，我不能直接生成采购单或订单。"
        "请重新上传清晰图片，或先让我返回逐字段识别结果供你确认。"
    )


def _sanitize_final_reply(*, request: ChatRequest, reply: str, trace: List[str]) -> str:
    resolved = ensure_non_empty_reply(reply, "")
    if not resolved:
        return resolved
    if _has_image_attachments(request) and _reply_has_visual_hallucination_markers(resolved):
        trace.append("Answer guard: replaced hallucinated image-reading reply with explicit uncertainty notice.")
        return _build_unverified_vision_reply()
    return resolved


def _build_clarification_prompt(label: str, description: str) -> str:
    combined = f"{label} {description}".strip()
    if description:
        return f"我选择：{label}。补充说明：{description}。请按这个方向继续处理。"
    return f"我选择：{combined or label}。请按这个方向继续处理。"


def _extract_clarification_card(reply: str) -> Optional[Dict[str, Any]]:
    text = str(reply or "").strip()
    if not text:
        return None

    lines = [line.strip() for line in text.splitlines()]
    question_line = next(
        (
            line.rstrip("：: ")
            for line in lines
            if ("请问" in line or "请选择" in line or "是否" in line) and len(line) >= 4
        ),
        "",
    )

    if question_line and "还是" in question_line:
        normalized_question = re.sub(r"[*`_]+", "", question_line)
        candidates = re.split(r"还是", normalized_question, maxsplit=1)
        if len(candidates) == 2:
            left = re.sub(r"^.*?(希望|选择|需要)", "", candidates[0]).strip(" ，。？?：:")
            right = candidates[1].strip(" ，。？?：:")
            right = re.sub(r"(后再.*|然后.*|并.*继续.*)$", "", right).strip(" ，。？?：:")
            paired_options = []
            if left:
                paired_options.append(
                    {
                        "id": "option-1",
                        "label": left,
                        "description": "",
                        "prompt": _build_clarification_prompt(left, ""),
                    }
                )
            if right:
                paired_options.append(
                    {
                        "id": "option-2",
                        "label": right,
                        "description": "",
                        "prompt": _build_clarification_prompt(right, ""),
                    }
                )
            if paired_options:
                return {
                    "title": normalized_question,
                    "message": normalized_question,
                    "options": paired_options[:4],
                }

    options: List[Dict[str, str]] = []
    for line in lines:
        match = re.match(r"^\s*(\d+)[\.\、]\s*(.+)$", line)
        if not match:
            continue
        body = match.group(2).strip().lstrip("*").strip()
        if any(marker in body for marker in ("未匹配", "未确认", "信息缺口", "核对情况")):
            continue
        label = body
        description = ""
        if "：" in body:
            label, description = [part.strip() for part in body.split("：", 1)]
        elif ":" in body:
            label, description = [part.strip() for part in body.split(":", 1)]
        options.append(
            {
                "id": f"option-{match.group(1)}",
                "label": label or body,
                "description": description,
                "prompt": _build_clarification_prompt(label or body, description),
            }
        )

    if not options:
        return None

    return {
        "title": question_line or "请选择下一步",
        "message": question_line or "AI 需要您确认下一步处理方式。",
        "options": options[:4],
    }


def _build_interruption_from_reply(reply: str) -> Optional[InterruptionState]:
    clarification = _extract_clarification_card(reply)
    if not clarification:
        return None
    fingerprint = hash_text(
        f"{clarification.get('title','')}|{clarification.get('message','')}|{json.dumps(clarification.get('options', []), ensure_ascii=False)}"
    )[:12]
    return InterruptionState(
        id=f"interrupt-{fingerprint}",
        title=str(clarification.get("title") or "请选择下一步"),
        message=str(clarification.get("message") or "AI 需要您确认下一步处理方式。"),
        options=list(clarification.get("options") or []),
    )


def _image_request_prompt_text(prompt: str) -> str:
    return compact_text(prompt).lower()


def _wants_image_import(prompt: str) -> bool:
    text = _image_request_prompt_text(prompt)
    return any(
        keyword in text
        for keyword in (
            "导入",
            "创建单据",
            "创建采购单",
            "生成采购单",
            "生成订单",
            "建单",
            "import",
            "create procurement",
            "create order",
        )
    )


def _wants_image_extraction(prompt: str) -> bool:
    text = _image_request_prompt_text(prompt)
    return any(
        keyword in text
        for keyword in (
            "识别",
            "提取",
            "读取",
            "看图",
            "ocr",
            "图片",
            "截图",
            "单据",
            "票据",
            "read image",
            "extract",
            "document",
        )
    )


def _should_use_image_document_pipeline(request: ChatRequest) -> bool:
    return _has_image_attachments(request)


def _build_image_user_content(request: ChatRequest, instruction: str) -> Any:
    image_parts: List[Dict[str, str]] = []
    for attachment in request.attachments:
        if compact_text(getattr(attachment, "kind", "")).lower() != "image" and not getattr(attachment, "imageDataUrl", None):
            continue
        data_url = str(getattr(attachment, "imageDataUrl", "") or "").strip()
        if not data_url:
            continue
        image_parts.append(
            {
                "file_name": str(getattr(attachment, "fileName", "") or "").strip() or "image",
                "mime_type": str(getattr(attachment, "mimeType", "") or "").strip() or "image/jpeg",
                "data_url": data_url,
            }
        )
    if not image_parts:
        return instruction
    return {
        "text": instruction,
        "images": image_parts,
    }


def _coerce_number(value: Any) -> float | None:
    try:
        text = str(value or "").strip().replace(",", "")
        if not text:
            return None
        return float(text)
    except Exception:
        return None


def _coerce_int(value: Any) -> int | None:
    number = _coerce_number(value)
    if number is None:
        return None
    try:
        return int(round(number))
    except Exception:
        return None


def _normalize_image_line_items(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    items: List[Dict[str, Any]] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        product_name = compact_text(
            item.get("product_name")
            or item.get("productName")
            or item.get("name")
            or item.get("goods_name")
            or item.get("goodsName")
        )
        quantity = _coerce_int(item.get("quantity"))
        unit_cost = _coerce_number(item.get("unit_cost") or item.get("unitCost") or item.get("price") or item.get("unit_price"))
        line: Dict[str, Any] = {}
        if product_name:
            line["product_name"] = product_name
        sku = compact_text(item.get("sku"))
        if sku:
            line["sku"] = sku
        unit = compact_text(item.get("unit"))
        if unit:
            line["unit"] = unit
        excerpt = compact_text(item.get("excerpt") or item.get("source_text") or item.get("sourceText"))
        if excerpt:
            line["excerpt"] = excerpt
        if quantity is not None and quantity > 0:
            line["quantity"] = quantity
        if unit_cost is not None and unit_cost > 0:
            line["unit_cost"] = round(unit_cost, 4)
        amount = _coerce_number(item.get("amount"))
        if amount is not None and amount > 0:
            line["amount"] = round(amount, 4)
        if product_name:
            items.append(line)
    return items[:40]


def _normalize_image_document_payload(raw: Mapping[str, Any] | None) -> Dict[str, Any]:
    if not isinstance(raw, Mapping):
        return {}
    payload: Dict[str, Any] = {
        "document_type": compact_text(raw.get("document_type") or raw.get("documentType") or raw.get("doc_type")),
        "title": compact_text(raw.get("title") or raw.get("document_title") or raw.get("documentTitle")),
        "document_number": compact_text(raw.get("document_number") or raw.get("documentNumber") or raw.get("number")),
        "date": compact_text(raw.get("date") or raw.get("document_date") or raw.get("documentDate")),
        "supplier_name": compact_text(raw.get("supplier_name") or raw.get("supplierName") or raw.get("supplier")),
        "customer_name": compact_text(raw.get("customer_name") or raw.get("customerName") or raw.get("customer")),
        "summary": compact_text(raw.get("summary")),
        "import_target": compact_text(raw.get("import_target") or raw.get("importTarget") or "none").lower(),
    }
    payload["line_items"] = _normalize_image_line_items(raw.get("line_items") or raw.get("items"))
    payload["missing_fields"] = [
        compact_text(item)
        for item in (raw.get("missing_fields") or raw.get("missingFields") or [])
        if compact_text(item)
    ][:12]
    confidence = _coerce_number(raw.get("confidence"))
    payload["confidence"] = max(0.0, min(1.0, confidence if confidence is not None else 0.0))
    return payload


def _is_supported_procurement_candidate(payload: Mapping[str, Any]) -> bool:
    document_type = compact_text(payload.get("document_type", "")).lower()
    title = compact_text(payload.get("title", "")).lower()
    import_target = compact_text(payload.get("import_target", "")).lower()
    return any(
        marker in f"{document_type} {title} {import_target}"
        for marker in ("采购", "进货", "procurement", "purchase")
    )


def _is_ambiguous_delivery_document(payload: Mapping[str, Any]) -> bool:
    text = " ".join(
        [
            compact_text(payload.get("document_type", "")),
            compact_text(payload.get("title", "")),
            compact_text(payload.get("summary", "")),
        ]
    ).lower()
    return any(marker in text for marker in ("送货", "发货", "delivery note", "delivery order", "shipment note"))


def _prompt_explicitly_sets_import_target(prompt: str) -> bool:
    normalized = compact_text(prompt).lower()
    procurement_markers = ("采购单", "采购", "进货", "procurement", "purchase")
    sales_markers = ("销售单", "销售订单", "客户订单", "销售", "sales order", "sales")
    return any(marker in normalized for marker in procurement_markers + sales_markers)


def _apply_image_target_guardrails(fields: Mapping[str, Any], request: ChatRequest) -> Dict[str, Any]:
    guarded = dict(fields)
    if _is_ambiguous_delivery_document(guarded) and not _prompt_explicitly_sets_import_target(request.prompt):
        guarded["import_target"] = "none"
        missing_fields = list(guarded.get("missing_fields") or [])
        if "需确认按采购单还是销售单导入" not in missing_fields:
            missing_fields.append("需确认按采购单还是销售单导入")
        guarded["missing_fields"] = missing_fields
    return guarded


def _build_image_extraction_reply(payload: Mapping[str, Any], *, validated: bool, issues: Sequence[str]) -> str:
    lines: List[str] = []
    title = compact_text(payload.get("title", ""))
    document_type = compact_text(payload.get("document_type", ""))
    document_number = compact_text(payload.get("document_number", ""))
    date = compact_text(payload.get("date", ""))
    supplier_name = compact_text(payload.get("supplier_name", ""))
    customer_name = compact_text(payload.get("customer_name", ""))
    line_items = payload.get("line_items", [])

    lines.append("图片识别结果如下。")
    if document_type:
        lines.append(f"单据类型：{document_type}")
    if title:
        lines.append(f"标题：{title}")
    if document_number:
        lines.append(f"单号：{document_number}")
    if date:
        lines.append(f"日期：{date}")
    if supplier_name:
        lines.append(f"供应方：{supplier_name}")
    if customer_name:
        lines.append(f"客户：{customer_name}")
    if isinstance(line_items, list) and line_items:
        lines.append("明细：")
        for index, item in enumerate(line_items[:12], start=1):
            if not isinstance(item, Mapping):
                continue
            product_name = compact_text(item.get("product_name", ""))
            quantity = item.get("quantity")
            unit = compact_text(item.get("unit", ""))
            unit_cost = item.get("unit_cost")
            amount = item.get("amount")
            row = f"{index}. {product_name or '未识别商品'}"
            if quantity:
                row += f" / 数量 {quantity}"
            if unit:
                row += f" / 单位 {unit}"
            if unit_cost:
                row += f" / 单价 {unit_cost}"
            if amount:
                row += f" / 金额 {amount}"
            lines.append(row)
    missing_fields = payload.get("missing_fields", [])
    if isinstance(missing_fields, list) and missing_fields:
        lines.append("缺失字段：" + "、".join(str(item) for item in missing_fields[:8]))
    if issues:
        lines.append("复核结果：" + "；".join(issues[:6]))
    lines.append("可用于导入：" + ("是" if validated else "否"))
    return "\n".join(lines)


async def _extract_image_document_payload(
    *,
    request: ChatRequest,
    config: AgentConfig,
    model_requester: ModelRequestFn,
    trace: List[str],
) -> Dict[str, Any]:
    system_prompt = "\n".join(
        [
            get_python_prompt_text(
                "vision_evidence_system_prompt_lines",
                [
                    "你是运行时视觉证据提取器。",
                    "不要猜测，只能提取图中可见字段。",
                    "只返回 JSON。",
                ],
            ),
            "返回紧凑 JSON，键必须是：document_type, title, document_number, date, supplier_name, customer_name, line_items, summary, missing_fields, import_target, confidence。",
            "line_items 中每项包含：product_name, quantity, unit, unit_cost, amount, excerpt。",
            "import_target 只能是 procurement, sales, none 之一。",
            "送货单、发货单、delivery note 本身不能决定采购或销售方向；除非图片明确写采购单/销售单，import_target 必须返回 none。",
            "不能仅凭出现供应商、客户、商品、金额或送货信息推断采购/销售方向。",
            "如果字段看不清或无法确认，保留为空，并把原因写入 missing_fields。",
        ]
    )
    user_prompt = _build_image_user_content(
        request,
        (
            "请仅根据图片本身提取单据信息。"
            "不要调用工具，不要联想系统中的订单，不要补造不可见字段。"
        ),
    )
    payload = await _request_model_with_role(
        model_requester,
        config,
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        tools=None,
        tool_choice="none",
        role="vision",
    )
    parsed = parse_model_turn(payload)
    normalized = _normalize_image_document_payload(parse_json_object_text(parsed.content))
    if normalized:
        trace.append(
            "Image extraction: candidate fields extracted "
            f"(items={len(normalized.get('line_items', []))}, target={normalized.get('import_target', 'none')})."
        )
    else:
        trace.append("Image extraction: model did not return a valid JSON payload.")
    return normalized


async def _validate_image_document_payload(
    *,
    request: ChatRequest,
    config: AgentConfig,
    model_requester: ModelRequestFn,
    candidate: Mapping[str, Any],
    trace: List[str],
) -> Dict[str, Any]:
    system_prompt = "\n".join(
        [
            "你是图片单据复核器。",
            "请对照图片，检查候选字段是否真的可见、是否足以支持导入。",
            "不要补充图片中看不见的字段，只返回 JSON。",
            "JSON 键必须是：approved, import_target, confidence, issues, approved_fields。",
            "approved_fields 只保留你能从图片确认的字段。",
            "送货单、发货单、delivery note 本身不能决定采购或销售方向；除非图片明确写采购单/销售单，import_target 必须返回 none。",
            "不能仅凭出现供应商、客户、商品、金额或送货信息推断采购/销售方向。",
            "如果候选字段与图片不一致、证据不足或字段缺失，approved 必须为 false。",
        ]
    )
    user_prompt = _build_image_user_content(
        request,
        "请对照图片复核以下候选字段，只保留图中真正可见且可信的字段：\n"
        + json.dumps(candidate, ensure_ascii=False),
    )
    payload = await _request_model_with_role(
        model_requester,
        config,
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        tools=None,
        tool_choice="none",
        role="vision",
    )
    parsed = parse_model_turn(payload)
    raw = parse_json_object_text(parsed.content)
    if not isinstance(raw, Mapping):
        trace.append("Image validation: model did not return a valid JSON payload.")
        return {
            "approved": False,
            "import_target": "none",
            "confidence": 0.0,
            "issues": ["图片复核阶段未返回可解析结果。"],
            "approved_fields": {},
        }
    approved_fields = _normalize_image_document_payload(raw.get("approved_fields") if isinstance(raw.get("approved_fields"), Mapping) else {})
    issues = [
        compact_text(item)
        for item in (raw.get("issues") or [])
        if compact_text(item)
    ][:12]
    confidence = _coerce_number(raw.get("confidence"))
    result = {
        "approved": bool(raw.get("approved")),
        "import_target": compact_text(raw.get("import_target") or approved_fields.get("import_target") or "none").lower(),
        "confidence": max(0.0, min(1.0, confidence if confidence is not None else 0.0)),
        "issues": issues,
        "approved_fields": approved_fields,
    }
    trace.append(
        "Image validation: "
        f"approved={str(result['approved']).lower()} target={result['import_target']} confidence={result['confidence']:.2f}."
    )
    return result


def _build_procurement_payload_from_image_fields(fields: Mapping[str, Any], request: ChatRequest) -> Dict[str, Any] | None:
    supplier_name = compact_text(fields.get("supplier_name", ""))
    expected_date = compact_text(fields.get("date", ""))
    line_items = fields.get("line_items", [])
    if not supplier_name or not expected_date or not isinstance(line_items, list) or not line_items:
        return None
    items: List[Dict[str, Any]] = []
    for item in line_items:
        if not isinstance(item, Mapping):
            continue
        product_name = compact_text(item.get("product_name", ""))
        quantity = _coerce_int(item.get("quantity"))
        unit_cost = _coerce_number(item.get("unit_cost"))
        if not product_name or quantity is None or quantity <= 0 or unit_cost is None or unit_cost <= 0:
            continue
        payload_item: Dict[str, Any] = {
            "productName": product_name,
            "quantity": quantity,
            "unitCost": round(unit_cost, 4),
        }
        unit = compact_text(item.get("unit", ""))
        if unit:
            payload_item["unit"] = unit
        sku = compact_text(item.get("sku", ""))
        if sku:
            payload_item["sku"] = sku
        items.append(payload_item)
    if not items:
        return None
    remark_parts = [
        f"图片导入：{compact_text(request.attachments[0].fileName if request.attachments else 'image')}",
    ]
    title = compact_text(fields.get("title", ""))
    if title:
        remark_parts.append(f"标题={title}")
    document_number = compact_text(fields.get("document_number", ""))
    if document_number:
        remark_parts.append(f"原单号={document_number}")
    return {
        "supplierName": supplier_name,
        "expectedDate": expected_date,
        "remark": "；".join(remark_parts),
        "items": items,
    }


def _extract_supplier_not_found_reference(summary: str) -> str:
    text = str(summary or "").strip()
    marker = "Active supplier not found:"
    if marker not in text:
        return ""
    return compact_text(text.split(marker, 1)[1])


def _extract_json_from_tool_context(value: Any) -> Any:
    text = str(value or "").strip()
    if not text:
        return None
    start = text.find("{")
    end = text.rfind("}")
    if 0 <= start < end:
        try:
            return json.loads(text[start : end + 1])
        except Exception:
            return None
    return None


async def _load_supplier_candidates(
    *,
    node_bridge: NodeToolBridge,
    request: ChatRequest,
    trace: List[str],
) -> List[str]:
    try:
        execution = await node_bridge.execute_tool("get_master_data_overview", "{}", request)
    except Exception as error:
        trace.append(f"Supplier suggestion lookup failed: {error}")
        return []
    result_payload = execution.get("result", {}) if isinstance(execution, Mapping) else {}
    context_text = ""
    if isinstance(result_payload, Mapping):
        context_text = str(result_payload.get("context") or result_payload.get("summary") or "")
    payload = _extract_json_from_tool_context(context_text)
    if not isinstance(payload, Mapping):
        return []
    suppliers = payload.get("suppliers")
    if not isinstance(suppliers, list):
        return []
    names: List[str] = []
    for item in suppliers:
        if not isinstance(item, Mapping):
            continue
        if compact_text(item.get("status", "active")).lower() != "active":
            continue
        name = compact_text(item.get("name"))
        if name and name not in names:
            names.append(name)
    trace.append(f"Supplier suggestion lookup returned {len(names)} active suppliers.")
    return names[:8]


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


def _merge_gap_lists(*values: Any) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for value in values:
        for gap in _as_gap_list(value):
            key = "|".join(
                [
                    compact_text(gap.get("gap_id", "")).lower(),
                    compact_text(gap.get("question", "")).lower(),
                    compact_text(gap.get("recommended_tool", "")).lower(),
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
        compact_text(call.name)
        for call in getattr(tool_state, "tool_calls", [])
        if compact_text(getattr(call, "status", "")).lower() == "completed" and compact_text(call.name)
    }
    if not successful_tools:
        return _merge_gap_lists(missing_evidence)

    remaining: List[Dict[str, Any]] = []
    for gap in _merge_gap_lists(missing_evidence):
        recommended_tool = compact_text(gap.get("recommended_tool", ""))
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
            or "runtime evidence" in compact_text(item.get("question", "")).lower()
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
            lowered = compact_text(question).lower()
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
            compact_text(getattr(request, "prompt", "")),
            compact_text(getattr(small_context, "query", "")),
            compact_text(getattr(small_context, "rewritten_query", "")),
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
            or "\u4eea\u8868\u76d8" in compact_text(item.get("question", ""))
            or "dashboard" in compact_text(item.get("question", "")).lower()
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
    lowered = compact_text(tool_name).lower()
    return "web" in lowered or "browser" in lowered




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
        value = compact_text(gap.get(key, "")).lower()
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
        parsed = parse_json_object_text(raw_content)
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
            "content": get_python_prompt_text(
                "small_read_prefetch_system_prompt_lines",
                [
                    "你是小模型只读证据执行器，负责在大模型综合前补充具体运行时证据。",
                    "当用户问题涉及当前、实时、账户相关或业务运行状态时，应优先使用只读工具。",
                    "不要直接回答用户。",
                    "在证据足够后，只返回 JSON，键必须是：tool_summary, evidence_notes, missing_evidence, retrieval_diagnostics, final_answer_allowed。",
                    "final_answer_allowed 必须为 false。",
                ],
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
        summary = compact_text(summary_payload.get("tool_summary") or summary_payload.get("summary") or "")
    if summary:
        lines.append(f"Summary: {summary}")
    payloads = _extract_tool_payloads_from_state(tool_state)
    for index, record in enumerate(tool_state.tool_calls, start=1):
        payload = payloads[index - 1] if index - 1 < len(payloads) else {}
        claim = compact_text(payload.get("summary") or record.summary)
        context = compact_text(payload.get("context", ""))
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
        summary = compact_text(payload.get("summary") or record.summary)
        context = compact_text(payload.get("context", ""))
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
        status = compact_text(item.get("status", "")).lower()
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

    summary_payload = parse_json_object_text(tool_state.reply)
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
            "content": get_python_prompt_text(
                "context_engine_system_prompt_lines",
                [
                    "你是分层运行时中的上下文重写引擎。",
                    "不要直接回答用户。",
                    "只返回 JSON，键必须是：rewritten_query, query_rewrites, missing_evidence, retrieval_diagnostics, notes, final_answer_allowed。",
                    "final_answer_allowed 必须为 false。",
                ],
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
        updates = parse_json_object_text(parsed.content)
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


def _derive_image_skill_hint(fields: Mapping[str, Any]) -> str:
    target = compact_text(fields.get("import_target") or fields.get("target") or "").lower()
    document_type = compact_text(fields.get("document_type", ""))
    if target == "procurement":
        return "导入 图片 采购单 供应商 商品"
    if target == "sales":
        return "导入 图片 订单 客户 商品"
    if document_type:
        return f"导入 图片 {document_type}"
    return "导入 图片 附件"


def _build_execution_guardrails(hints: Sequence[str]) -> str:
    normalized = [compact_text(item) for item in hints if compact_text(item)]
    if not normalized:
        return ""
    lines = ["Execution guardrails:"]
    for item in normalized[:12]:
        lines.append(f"- {item}")
    return "\n".join(lines)


def _build_skill_match_prompt(*, prompt: str, attachment_context: str, skill_hint: str) -> str:
    pieces = [prompt.strip()]
    if skill_hint:
        pieces.append(f"Attachment routing hint: {skill_hint}")
    clipped = _clip_context_block(attachment_context, 900)
    if clipped:
        pieces.append(f"Attachment context: {clipped}")
    return "\n".join(piece for piece in pieces if piece).strip() or "attachments"


async def preprocess_document_request(
    *,
    request: ChatRequest,
    config: AgentConfig,
    model_requester: ModelRequestFn,
    base_attachment_context: str,
    trace: List[str],
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "attachment_context": base_attachment_context or "",
        "planner_hints": [],
        "skill_hint": "",
    }
    has_image = any(
        compact_text(getattr(item, "kind", "")).lower() == "image"
        or bool(str(getattr(item, "imageDataUrl", "") or "").strip())
        for item in request.attachments
    )
    trace.append(
        "Image preprocessing check: "
        f"attachments={len(request.attachments)} has_image={str(has_image).lower()} prompt={compact_text(request.prompt)[:80]}"
    )
    if not has_image:
        return result

    trace.append("Image preprocessing engaged before normal ReAct flow.")
    extracted = await _extract_image_document_payload(
        request=request,
        config=config,
        model_requester=model_requester,
        trace=trace,
    )
    if not extracted:
        fallback_context = (
            "图片预处理结果：无法提取稳定字段。"
            "\n执行建议：不要直接建单；先告诉用户图片不清晰，并要求补充更清晰图片或手工字段。"
        )
        result["attachment_context"] = "\n\n".join(
            part for part in [fallback_context, base_attachment_context] if compact_text(part)
        )
        result["planner_hints"] = [
            "当前图片没有形成稳定字段，禁止基于该图片直接调用写工具。",
            "应先向用户说明图片不清晰，并请求更清晰图片或手工补充字段。",
        ]
        result["skill_hint"] = "导入 图片 识别失败"
        return result

    validation = await _validate_image_document_payload(
        request=request,
        config=config,
        model_requester=model_requester,
        candidate=extracted,
        trace=trace,
    )
    approved_fields = (
        validation.get("approved_fields", {})
        if isinstance(validation.get("approved_fields"), Mapping)
        else {}
    )
    issues = validation.get("issues", []) if isinstance(validation.get("issues"), list) else []
    approved = bool(validation.get("approved")) and bool(approved_fields)
    fields = _apply_image_target_guardrails(approved_fields or extracted, request)
    summary = _build_image_extraction_reply(fields, validated=approved, issues=issues)

    supplier_name = compact_text(fields.get("supplier_name") or fields.get("supplier"))
    customer_name = compact_text(fields.get("customer_name") or fields.get("customer"))
    target = compact_text(fields.get("import_target") or fields.get("target") or "").lower()

    guidance_lines = [
        "图片预处理说明：以下字段来自图片预处理，只能视为候选业务字段，不等于已匹配系统主数据。",
        "主流程必须按 ReAct 顺序继续：先查主数据，再决定是否追问用户，最后才允许创建待确认动作。",
        "如果供应商/客户/商品在系统中缺失、歧义或低置信度，必须先追问用户，不要先调用写工具再补救。",
        "具体追问顺序和选项设计应遵循已匹配 skill 的规则，不在图片预处理阶段写死。",
    ]
    if supplier_name:
        guidance_lines.append(f"待解析供应商主体：{supplier_name}")
    if customer_name:
        guidance_lines.append(f"待解析客户主体：{customer_name}")
    if target and target != "none":
        guidance_lines.append(f"候选业务目标：{target}")
    if _wants_image_import(request.prompt):
        guidance_lines.append("当前用户意图包含导入/建单；只有在主体和商品解析完成后才可继续执行写工具。")

    structured_context = "\n\n".join(
        [
            summary,
            "\n".join(guidance_lines),
        ]
    ).strip()
    result["attachment_context"] = "\n\n".join(
        part for part in [structured_context, base_attachment_context] if compact_text(part)
    )
    result["planner_hints"] = guidance_lines
    result["skill_hint"] = _derive_image_skill_hint(fields)
    return result


def resolve_retrieval_mode(config: AgentConfig) -> str:
    retrieval_mode = config.rag_retrieval_mode
    if retrieval_mode not in {"dense", "lexical", "hybrid"}:
        return "hybrid"
    return retrieval_mode


async def _resolve_document_and_skills_chain(
    *,
    request: ChatRequest,
    prompt: str,
    config: AgentConfig,
    node_bridge: NodeToolBridge,
    model_requester: ModelRequestFn,
    trace: List[str],
) -> Dict[str, Any]:
    """Resolve document context -> preprocess -> match skills in one chain."""
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

    preprocessed_attachment = await preprocess_document_request(
        request=request,
        config=config,
        model_requester=model_requester,
        base_attachment_context=attachment_context,
        trace=trace,
    )
    attachment_context = str(preprocessed_attachment.get("attachment_context") or attachment_context or "").strip()
    planner_hints = [
        compact_text(item)
        for item in preprocessed_attachment.get("planner_hints", [])
        if compact_text(item)
    ]
    skill_hint = compact_text(preprocessed_attachment.get("skill_hint", ""))

    skill_context = "No matched skill context."
    matched_skill_names: List[str] = []
    skill_tool_names: List[str] = []
    try:
        skill_match_prompt = _build_skill_match_prompt(
            prompt=prompt,
            attachment_context=attachment_context,
            skill_hint=skill_hint,
        )
        skill_payload = await node_bridge.match_skills(skill_match_prompt, request.token, limit=4)
        matched_items = skill_payload.get("matchedSkills", [])
        if isinstance(matched_items, list):
            matched_skill_names = [
                str(item.get("name"))
                for item in matched_items
                if isinstance(item, dict) and item.get("name")
            ]
            seen_skill_tools: set[str] = set()
            for item in matched_items:
                if not isinstance(item, dict):
                    continue
                raw_tools = item.get("tools", [])
                if not isinstance(raw_tools, list):
                    continue
                for tool_name in raw_tools:
                    normalized = str(tool_name or "").strip()
                    if normalized and normalized not in seen_skill_tools:
                        seen_skill_tools.add(normalized)
                        skill_tool_names.append(normalized)
        raw_context = skill_payload.get("context")
        if isinstance(raw_context, str) and raw_context.strip():
            skill_context = raw_context.strip()
        trace.append(
            f"Skill match: {len(matched_skill_names)} matched "
            f"(available={int(skill_payload.get('availableSkillCount', 0))})."
        )
    except Exception as error:
        trace.append(f"Skill matching unavailable: {error}")

    return {
        "attachment_context": attachment_context,
        "planner_hints": planner_hints,
        "skill_context": skill_context,
        "matched_skill_names": matched_skill_names,
        "skill_tool_names": skill_tool_names,
    }


async def resolve_context_bundle(
    *,
    request: ChatRequest,
    prompt: str,
    config: AgentConfig,
    node_bridge: NodeToolBridge,
    rag: RagEngine,
    model_requester: ModelRequestFn,
    trace: List[str],
) -> ContextBundle:
    retrieval_mode = resolve_retrieval_mode(config)

    # Run 4 independent chains in parallel:
    # 1. Document + skills chain (internally sequential)
    # 2. Memory profile fetch
    # 3. RAG retrieval
    # 4. Tools schema fetch
    doc_chain_coro = _resolve_document_and_skills_chain(
        request=request,
        prompt=prompt,
        config=config,
        node_bridge=node_bridge,
        model_requester=model_requester,
        trace=trace,
    )

    profile_coro = node_bridge.get_memory_profile(
        token=request.token,
        scope="effective",
        tenant_id=request.tenantId,
        user_id=request.userId,
        session_id=request.conversationId,
    )

    rag_coro = rag.retrieve(
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

    tools_coro = node_bridge.get_tools_schema(request.token)

    results = await asyncio.gather(
        doc_chain_coro,
        profile_coro,
        rag_coro,
        tools_coro,
        return_exceptions=True,
    )

    # Unpack document + skills chain result
    doc_result = results[0]
    if isinstance(doc_result, Exception):
        trace.append(f"Document/skills chain failed: {doc_result}")
        doc_result = {
            "attachment_context": "",
            "planner_hints": [],
            "skill_context": "No matched skill context.",
            "matched_skill_names": [],
            "skill_tool_names": [],
        }

    attachment_context = str(doc_result.get("attachment_context", "") or "").strip()
    planner_hints = list(doc_result.get("planner_hints", []) or [])
    skill_context = str(doc_result.get("skill_context", "") or "No matched skill context.")
    matched_skill_names = list(doc_result.get("matched_skill_names", []) or [])
    skill_tool_names = list(doc_result.get("skill_tool_names", []) or [])

    # Unpack profile
    profile_result = results[1]
    if isinstance(profile_result, Exception):
        trace.append(f"Profile memory bridge unavailable: {profile_result}")
        profile_payload: Dict[str, Any] = {"profile": {}, "records": [], "updatedAt": "", "updatedBy": ""}
    else:
        profile_payload = profile_result
        trace.append("Profile memory resolved via node bridge memory/profile.")
    profile_context = build_profile_context_text(profile_payload)

    # Unpack RAG
    rag_result = results[2]
    if isinstance(rag_result, Exception):
        trace.append(f"RAG retrieval failed: {rag_result}")
        chunks: List[Dict[str, Any]] = []
    else:
        chunks = rag_result
    citations = [str(item.get("citation", "")) for item in chunks if item.get("citation")]
    knowledge_context = build_knowledge_context(chunks)

    # Unpack tools
    tools_result = results[3]
    if isinstance(tools_result, Exception):
        trace.append(f"Tool schema fetch failed: {tools_result}")
        tools: List[Dict[str, Any]] = []
    else:
        tools = tools_result
        trace.append(f"Visible runtime tools: {len(tools)}")

    trace.extend(
        [
            f"Profile memory records: {len(profile_payload.get('records', []))}",
            f"RAG retrieval mode: {retrieval_mode}",
            f"RAG chunks matched: {len(chunks)}",
        ]
    )
    if matched_skill_names:
        trace.append(f"Skills injected: {', '.join(matched_skill_names)}")
    if skill_tool_names:
        trace.append(f"Skill-recommended tools: {', '.join(skill_tool_names[:12])}")

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
        planner_hints=planner_hints,
        skill_context=skill_context,
        matched_skill_names=matched_skill_names,
        skill_tool_names=skill_tool_names,
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
    # Fire-and-forget: don't block response on memory capture
    asyncio.create_task(
        capture_memory_outcome(
            node_bridge=node_bridge,
            prompt=prompt,
            reply=reply,
            request=request,
            citations=context.citations,
            trace=trace,
        )
    )
    memory_capture = build_memory_capture_outcome(captured=False, reason="pending_background")
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

        # Collect valid tool calls and their metadata
        valid_calls: list[tuple[int, dict[str, Any], str, str]] = []
        for index, call in enumerate(parsed.tool_calls):
            fn_info = call.get("function", {})
            fn_name = str(fn_info.get("name") if isinstance(fn_info, dict) else "")
            fn_args = _normalize_tool_arguments(
                fn_info.get("arguments") if isinstance(fn_info, dict) else "{}"
            )
            if not fn_name:
                continue
            valid_calls.append((index, call, fn_name, fn_args))

        # Execute all tool calls concurrently
        async def _execute_one(fn_name: str, fn_args: str) -> Dict[str, Any]:
            if has_builtin_tool(config, fn_name):
                try:
                    return await execute_builtin_tool(config, fn_name, fn_args)
                except Exception as error:
                    return build_tool_execution_error(fn_name, error)
            else:
                try:
                    return await node_bridge.execute_tool(fn_name, fn_args, request)
                except Exception as error:
                    return build_tool_execution_error(fn_name, error)

        if valid_calls:
            executions = await asyncio.gather(
                *[_execute_one(fn_name, fn_args) for _, _, fn_name, fn_args in valid_calls],
                return_exceptions=True,
            )

            for (index, call, fn_name, _fn_args), execution in zip(valid_calls, executions):
                if isinstance(execution, Exception):
                    execution = build_tool_execution_error(fn_name, execution)

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


def _tool_names_from_definitions(tools: Sequence[Mapping[str, Any]], limit: int = 16) -> List[str]:
    names: List[str] = []
    for tool in tools:
        name = _tool_name(tool)
        if name and name not in names:
            names.append(name)
        if len(names) >= limit:
            break
    return names


def _build_fallback_agent_plan(
    *,
    request: ChatRequest,
    available_tools: Sequence[str],
    mode: str = "answer",
) -> AgentPlan:
    return AgentPlan(
        objective=request.prompt.strip() or "Handle user request",
        mode=mode,
        needs_tools=bool(available_tools),
        needs_confirmation=False,
        tool_names=list(available_tools[:4]),
        steps=["Read available context", "Call tools only when needed", "Answer or create a pending action"],
        missing_evidence=[],
    )


def _normalize_plan_steps(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    steps: List[str] = []
    for item in value:
        if isinstance(item, Mapping):
            text = compact_text(item.get("step") or item.get("action") or item.get("description"))
        else:
            text = compact_text(item)
        if text:
            steps.append(text)
    return steps


def _normalize_agent_plan(
    value: Mapping[str, Any] | AgentPlan | None,
    *,
    request: ChatRequest,
    available_tools: Sequence[str],
) -> AgentPlan:
    if isinstance(value, AgentPlan):
        plan = value
    elif isinstance(value, Mapping):
        normalized_candidate = dict(value)
        normalized_candidate["steps"] = _normalize_plan_steps(value.get("steps"))
        plan = AgentPlan.model_validate(normalized_candidate)
    else:
        plan = _build_fallback_agent_plan(request=request, available_tools=available_tools)

    mode = compact_text(plan.mode).lower()
    if mode not in {"answer", "analyze", "write_candidate"}:
        mode = "answer"

    allowed_tool_names = [name for name in plan.tool_names if compact_text(name)]
    if available_tools:
        available_set = {name for name in available_tools if name}
        allowed_tool_names = [name for name in allowed_tool_names if name in available_set]

    needs_tools = bool(plan.needs_tools and allowed_tool_names)
    if plan.needs_tools and not allowed_tool_names and available_tools:
        allowed_tool_names = list(available_tools[:4])
        needs_tools = True

    clean_steps = [compact_text(step) for step in plan.steps if compact_text(step)]
    if not clean_steps:
        clean_steps = ["Read available context", "Call tools only when needed", "Answer or create a pending action"]

    missing_evidence = [compact_text(item) for item in plan.missing_evidence if compact_text(item)]

    return AgentPlan(
        objective=compact_text(plan.objective) or request.prompt.strip() or "Handle user request",
        mode=mode,
        needs_tools=needs_tools,
        needs_confirmation=bool(plan.needs_confirmation or mode == "write_candidate"),
        tool_names=allowed_tool_names,
        steps=clean_steps[:8],
        missing_evidence=missing_evidence[:8],
    )


def _filter_tools_for_plan(
    tools: Sequence[Mapping[str, Any]],
    plan: AgentPlan,
) -> List[Dict[str, Any]]:
    if not plan.needs_tools:
        return []

    allowed_names = {name for name in plan.tool_names if name}
    if not allowed_names:
        return [dict(item) for item in tools if isinstance(item, dict)]

    filtered: List[Dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = _tool_name(tool)
        if name and name in allowed_names:
            filtered.append(dict(tool))
    return filtered


def _format_single_agent_plan(plan: Mapping[str, Any] | AgentPlan) -> str:
    if isinstance(plan, AgentPlan):
        objective = compact_text(plan.objective)
        mode = compact_text(plan.mode) or "answer"
        needs_tools = bool(plan.needs_tools)
        needs_confirmation = bool(plan.needs_confirmation)
        tool_names = list(plan.tool_names)
        steps = list(plan.steps)
    else:
        objective = compact_text(plan.get("objective", ""))
        mode = compact_text(plan.get("mode", "")) or "answer"
        needs_tools = bool(plan.get("needs_tools", False))
        needs_confirmation = bool(plan.get("needs_confirmation", False))
        tool_names = plan.get("tool_names", [])
        if not isinstance(tool_names, list):
            tool_names = []
        steps = plan.get("steps", [])
        if not isinstance(steps, list):
            steps = []

    lines = [
        "PLAN:",
        f"- mode: {mode}",
        f"- needs_tools: {str(needs_tools).lower()}",
        f"- needs_confirmation: {str(needs_confirmation).lower()}",
    ]
    if objective:
        lines.append(f"- objective: {objective}")
    clean_tools = [compact_text(item) for item in tool_names if compact_text(item)]
    if clean_tools:
        lines.append(f"- planned_tools: {', '.join(clean_tools[:8])}")
    clean_steps = [compact_text(item) for item in steps if compact_text(item)]
    if clean_steps:
        lines.append("- steps:")
        lines.extend(f"  {idx}. {step}" for idx, step in enumerate(clean_steps[:6], start=1))
    return "\n".join(lines)


async def build_single_agent_plan(
    *,
    request: ChatRequest,
    config: AgentConfig,
    context: ContextBundle,
    model_requester: ModelRequestFn,
    trace: List[str],
) -> AgentPlan:
    plan_source_tools = list(context.skill_tool_names or _tool_names_from_definitions(context.tools))
    attachment_hint = "yes" if request.attachments else "no"
    plan_system = "\n".join(
        [
            "You are the PLAN phase planner for RetailFlow Hub.",
            "Return only a compact JSON object. Do not call tools in this planning step.",
            get_python_prompt_text(
                "structured_plan_request_instruction_lines",
                [
                    "Only output compact PLAN JSON.",
                    "The JSON must contain objective, mode, needs_tools, needs_confirmation, tool_names, steps.",
                    "mode must be one of answer, analyze, write_candidate.",
                    "Write operations must be planned as pending-action candidates, never direct writes.",
                    "If attachment evidence contains unresolved supplier, customer, or product entities, plan a clarification step before any write tool.",
                ],
            ),
        ]
    )
    plan_user = "\n".join(
        [
            f"User prompt: {request.prompt.strip()}",
            f"Has attachments: {attachment_hint}",
            f"Available tools: {', '.join(plan_source_tools) if plan_source_tools else 'none'}",
            "Planner hints:",
            "\n".join(f"- {item}" for item in context.planner_hints) if context.planner_hints else "none",
            "Skill context:",
            context.skill_context or "No skill context.",
            "Attachment context:",
            context.attachment_context or "No attachments.",
            "RAG summary:",
            context.knowledge_context[:1800] if context.knowledge_context else "No retrieved knowledge.",
        ]
    )
    try:
        payload = await _request_model_with_role(
            model_requester,
            config,
            [
                {"role": "system", "content": plan_system},
                {"role": "user", "content": plan_user},
            ],
            tools=None,
            tool_choice="none",
            role="large",
        )
        parsed = parse_model_turn(payload)
        plan = parse_json_object_text(parsed.content)
        if not isinstance(plan, Mapping):
            trace.append("Plan phase: model did not return JSON; fallback plan used.")
            return _build_fallback_agent_plan(request=request, available_tools=plan_source_tools)
        normalized = _normalize_agent_plan(plan, request=request, available_tools=plan_source_tools)
        trace.append(
            "Plan phase: structured plan created "
            f"(mode={normalized.mode}, tools={len(normalized.tool_names)}, confirm={str(normalized.needs_confirmation).lower()})."
        )
        trace.append(_format_single_agent_plan(normalized))
        return normalized
    except Exception as error:
        trace.append(f"Plan phase failed; fallback plan used: {error}")
        return _build_fallback_agent_plan(request=request, available_tools=plan_source_tools)


async def synthesize_final_answer(
    *,
    request: ChatRequest,
    config: AgentConfig,
    tool_state: ToolLoopState,
    model_requester: ModelRequestFn,
    trace: List[str],
    plan: AgentPlan,
) -> ToolLoopState:
    answer_messages = list(tool_state.messages)
    answer_messages.append(
        {
            "role": "user",
            "content": (
                'OUTPUT ONLY THIS JSON (no markdown, no extra text):\n'
                '{"reply":"1-2 sentence Chinese summary","interruption":{"title":"Short question title","message":"What user needs to decide","options":[{"id":"opt1","label":"Action 1","prompt":"Full instruction for AI","description":"What happens"}]}}\n'
                '\n'
                'RULES:\n'
                '- ALWAYS include interruption with 2-4 options when user action/choice is needed.\n'
                '- Only set interruption:null when task is fully complete.\n'
                '- Every option must be a clickable action, not an open question.\n'
                '- Include "Cancel" as last option.\n'
                '- RAW JSON ONLY. No markdown fences. No explanation outside the JSON.\n'
                f'Plan mode: {plan.mode}'
            ),
        }
    )
    payload = await _request_model_with_role(
        model_requester,
        config,
        answer_messages,
        tools=None,
        tool_choice="none",
        role="large",
    )
    parsed = parse_model_turn(payload)
    if parsed.resolved_model:
        tool_state.resolved_model = parsed.resolved_model
    if parsed.reasoning:
        tool_state.reasoning_content = parsed.reasoning
    structured = parse_json_object_text(parsed.content)
    if structured:
        structured_reply = compact_text(structured.get("reply", ""))
        if structured_reply:
            tool_state.reply = _sanitize_final_reply(
                request=request,
                reply=structured_reply,
                trace=trace,
            )
        interruption = structured.get("interruption")
        if isinstance(interruption, Mapping):
            options = interruption.get("options")
            if isinstance(options, list) and options:
                tool_state.interruption = {
                    "title": str(interruption.get("title") or "请选择下一步").strip(),
                    "message": str(interruption.get("message") or interruption.get("title") or "AI 需要您确认下一步处理方式。").strip(),
                    "options": [
                        {
                            "id": str(item.get("id") or f"option-{index+1}").strip(),
                            "label": str(item.get("label") or "").strip(),
                            "prompt": str(item.get("prompt") or "").strip(),
                            "description": str(item.get("description") or "").strip() or None,
                        }
                        for index, item in enumerate(options)
                        if isinstance(item, Mapping)
                        and str(item.get("label") or "").strip()
                        and str(item.get("prompt") or "").strip()
                    ][:6],
                }
    if not compact_text(tool_state.reply):
        tool_state.reply = _sanitize_final_reply(
            request=request,
            reply=parsed.content or tool_state.reply or "No final answer was generated. Please retry.",
            trace=trace,
        )
    trace.append("Answer phase: final non-tool synthesis completed.")
    return tool_state


async def build_configured_response(
    *,
    request: ChatRequest,
    prompt: str,
    config: AgentConfig,
    node_bridge: NodeToolBridge,
    context: ContextBundle,
    tool_state: ToolLoopState,
    trace: List[str],
    answer_meta: Optional[Dict[str, Any]] = None,
) -> ChatResponse:
    resolved_reply = _sanitize_final_reply(
        request=request,
        reply=ensure_non_empty_reply(
            tool_state.reply,
            "No displayable answer was generated. Please retry with more details.",
        ),
        trace=trace,
    )
    # Fire-and-forget: don't block response on memory capture
    asyncio.create_task(
        capture_memory_outcome(
            node_bridge=node_bridge,
            prompt=prompt,
            reply=resolved_reply,
            request=request,
            citations=context.citations,
            trace=trace,
        )
    )
    memory_capture = build_memory_capture_outcome(captured=False, reason="pending_background")
    interruption = None
    if isinstance(tool_state.interruption, Mapping):
        interruption = InterruptionState(
            id=f"interrupt-{hash_text(json.dumps(tool_state.interruption, ensure_ascii=False))[:12]}",
            title=str(tool_state.interruption.get("title") or "请选择下一步"),
            message=str(tool_state.interruption.get("message") or "AI 需要您确认下一步处理方式。"),
            options=list(tool_state.interruption.get("options") or []),
        )
    clarification = None
    if interruption:
        clarification = {
            "title": interruption.title,
            "message": interruption.message,
            "options": list(interruption.options),
        }
    else:
        clarification = _extract_clarification_card(resolved_reply)
        interruption = _build_interruption_from_reply(resolved_reply)
    return ChatResponse(
        reply=resolved_reply,
        toolCalls=tool_state.tool_calls,
        citations=context.citations,
        webSources=tool_state.web_sources,
        pendingAction=tool_state.pending_action,
        approval=tool_state.approval,
        clarification=clarification,
        interruption=interruption,
        memoryCapture=memory_capture,
        answer_meta=answer_meta,
        reasoningContent=tool_state.reasoning_content or None,
        configured=True,
        provider=config.normalized_provider(),
        model=tool_state.resolved_model,
        note=(
            "RAG(v2) enabled: LanceDB+embedding+hybrid+rerank+MMR, "
            f"chunks={len(context.chunks)}, tools={len(tool_state.tool_calls)}"
        ),
        trace=trace,
        conversationMessages=tool_state.messages if interruption else None,
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
    if request.resume:
        resume_prompt = compact_text(request.resume.prompt)
        if resume_prompt:
            prompt = resume_prompt
        elif not prompt:
            prompt = "继续处理上一个中断任务。"
    if not prompt and not request.attachments:
        raise HTTPException(status_code=400, detail="Prompt or attachments is required")

    effective_request = request if prompt == request.prompt else request.model_copy(update={"prompt": prompt})

    trace: List[str] = []
    if effective_request.resume:
        trace.append(
            f"Interrupt resume received: interruption={compact_text(effective_request.resume.interruptionId)} option={compact_text(effective_request.resume.optionId)}"
        )

    # Fast path: if conversationMessages exist (from a previous interruption checkpoint),
    # skip re-gathering context and jump straight to continuing the conversation.
    restored_messages = effective_request.conversationMessages
    trace.append(f"conversationMessages received: {bool(restored_messages)} (count={len(restored_messages) if restored_messages else 0})")
    if restored_messages:
        trace.append("Resume fast path: using saved conversation messages, skipping context rebuild.")
        # Append a user message for the resume prompt
        restored_messages = list(restored_messages)  # shallow copy
        restored_messages.append({"role": "user", "content": prompt})
        configured = config.is_model_configured()
        if not configured:
            return await build_unconfigured_response(
                request=effective_request,
                prompt=prompt,
                config=config,
                node_bridge=node_bridge,
                context=ContextBundle(
                    profile_payload={}, profile_context="", chunks=[], citations=[],
                    knowledge_context="", attachment_context="", planner_hints=[],
                    skill_context="No matched skill context.", matched_skill_names=[],
                    skill_tool_names=[], tools=[], retrieval_mode="hybrid",
                ),
                trace=trace,
            )
        tools = await node_bridge.get_tools_schema(effective_request.token)
        builtin_tools = build_builtin_tool_definitions(config)
        if builtin_tools:
            existing_names = {
                str((item.get("function") or {}).get("name") or "").strip()
                for item in tools if isinstance(item, dict)
            }
            for item in builtin_tools:
                if str((item.get("function") or {}).get("name") or "").strip() not in existing_names:
                    tools.append(item)
        trace.append(f"Resume tools: {len(tools)} visible")
        instrumented_messages = list(restored_messages)
        plan = _build_fallback_agent_plan(
            request=effective_request,
            available_tools=_tool_names_from_definitions(tools),
        )
        tool_state = await run_model_tool_loop(
            request=effective_request,
            config=config,
            node_bridge=node_bridge,
            messages=instrumented_messages,
            tools=tools,
            model_requester=model_requester,
            trace=trace,
            trace_prefix="Resume",
        )
        tool_state = await synthesize_final_answer(
            request=effective_request,
            config=config,
            tool_state=tool_state,
            model_requester=model_requester,
            trace=trace,
            plan=plan,
        )
        answer_meta = {
            "used_evidence_ids": [],
            "unresolved_gaps": [],
            "confidence": "medium" if tool_state.tool_calls else "low",
            "confidence_score": 0.72 if tool_state.tool_calls else 0.42,
        }
        return await build_configured_response(
            request=effective_request,
            prompt=prompt,
            config=config,
            node_bridge=node_bridge,
            context=ContextBundle(
                profile_payload={}, profile_context="", chunks=[], citations=[],
                knowledge_context="", attachment_context="", planner_hints=[],
                skill_context="No matched skill context.", matched_skill_names=[],
                skill_tool_names=[], tools=tools, retrieval_mode="hybrid",
            ),
            tool_state=tool_state,
            trace=trace,
            answer_meta=answer_meta,
        )

    context = await resolve_context_bundle(
        request=effective_request,
        prompt=prompt,
        config=config,
        node_bridge=node_bridge,
        rag=rag,
        model_requester=model_requester,
        trace=trace,
    )

    # After image preprocessing, strip raw image data from attachments so
    # text-only models (DeepSeek) don't receive image_url content blocks.
    # The extracted fields are already in context.attachment_context.
    if effective_request.attachments:
        stripped_attachments = []
        for att in effective_request.attachments:
            if compact_text(getattr(att, "kind", "")).lower() == "image":
                # Keep metadata, drop heavy image payload
                stripped_attachments.append(
                    att.__class__(
                        **{
                            **att.model_dump(exclude_none=True),
                            "imageDataUrl": None,
                        }
                    )
                )
            else:
                stripped_attachments.append(att)
        effective_request = effective_request.model_copy(
            update={"attachments": stripped_attachments}
        )

    configured = config.is_model_configured()
    if not configured:
        return await build_unconfigured_response(
            request=effective_request,
            prompt=prompt,
            config=config,
            node_bridge=node_bridge,
            context=context,
            trace=trace,
        )

    # Build inline plan from context (no separate LLM call — merged into Execute system prompt)
    execution_tools = list(context.tools)
    if context.skill_tool_names:
        skill_tool_set = set(context.skill_tool_names)
        preferred_tools = [t for t in context.tools if isinstance(t, dict) and _tool_name(t) in skill_tool_set]
        if preferred_tools:
            execution_tools = preferred_tools
            trace.append(f"Tools pre-filtered by skill match: {len(execution_tools)} of {len(context.tools)}")

    inline_plan_lines = [
        "INLINE PLAN (no separate plan call — merged into execute phase):",
        f"- objective: {effective_request.prompt.strip()[:200]}",
        f"- mode: answer (use write_candidate for write operations requiring approval)",
        f"- available_tools: {', '.join(_tool_names_from_definitions(execution_tools)[:12]) or 'none'}",
        "- steps:",
        "  1. Analyze the request and available context",
        "  2. Call tools only when evidence is insufficient",
        "  3. For write operations: create pending-action candidates, never claim direct writes",
        "  4. Answer concisely in Chinese, state unresolved gaps explicitly",
    ]
    if context.planner_hints:
        inline_plan_lines.append("Execution guardrails:")
        for hint in context.planner_hints[:8]:
            if compact_text(hint):
                inline_plan_lines.append(f"  - {compact_text(hint)}")
    if context.skill_context and context.skill_context != "No matched skill context.":
        inline_plan_lines.append(f"Skill guidance: {context.skill_context[:600]}")

    plan_context = "\n".join(inline_plan_lines)

    # Build a lightweight plan for answer synthesis
    plan = _build_fallback_agent_plan(
        request=effective_request,
        available_tools=_tool_names_from_definitions(execution_tools),
    )

    messages = build_model_messages(
        effective_request,
        context.profile_context,
        context.knowledge_context,
        context.attachment_context,
        context.skill_context,
        runtime_tool_context=plan_context,
        system_mode="planner_executor",
    )
    tool_state = await run_model_tool_loop(
        request=effective_request,
        config=config,
        node_bridge=node_bridge,
        messages=messages,
        tools=execution_tools,
        model_requester=model_requester,
        trace=trace,
        trace_prefix="Plan/Execute",
    )
    tool_state = await synthesize_final_answer(
        request=effective_request,
        config=config,
        tool_state=tool_state,
        model_requester=model_requester,
        trace=trace,
        plan=plan,
    )
    answer_meta = {
        "used_evidence_ids": context.citations[:8],
        "unresolved_gaps": plan.missing_evidence,
        "confidence": "medium" if context.citations or tool_state.tool_calls else "low",
        "confidence_score": 0.72 if context.citations or tool_state.tool_calls else 0.42,
    }

    return await build_configured_response(
        request=effective_request,
        prompt=prompt,
        config=config,
        node_bridge=node_bridge,
        context=context,
        tool_state=tool_state,
        trace=trace,
        answer_meta=answer_meta,
    )
