from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List

ALLOWED_RAG_EXTENSIONS = {".md", ".txt", ".json", ".yml", ".yaml", ".csv"}


def infer_source_type(file_name: str) -> str:
    lowered = file_name.lower()
    if "api" in lowered and ("catalog" in lowered or "接口" in file_name):
        return "api_spec"
    if "数据库" in file_name or "数据表" in file_name or "table" in lowered:
        return "db_spec"
    if "报表" in file_name or "report" in lowered:
        return "report_definition"
    if "规则" in file_name or "策略" in file_name or "policy" in lowered:
        return "business_rule"
    if "memory" in lowered:
        return "memory"
    return "project_doc"


def infer_module_id(file_name: str) -> str:
    lowered = file_name.lower()
    mapping = {
        "order": "orders",
        "订单": "orders",
        "purchase": "procurement",
        "采购": "procurement",
        "inventory": "inventory",
        "库存": "inventory",
        "arrival": "arrival",
        "到货": "arrival",
        "inbound": "inbound",
        "入库": "inbound",
        "shipping": "shipping",
        "发货": "shipping",
        "finance": "finance",
        "财务": "finance",
        "report": "reports",
        "报表": "reports",
        "audit": "settings",
        "审计": "settings",
        "权限": "settings",
        "security": "settings",
        "安全": "settings",
    }
    for keyword, module in mapping.items():
        if keyword in lowered or keyword in file_name:
            return module
    return "ai"


def discover_documents(workspace: Path) -> List[Path]:
    # Discover text-like docs under the managed docs tree. Inclusion is decided
    # later by the knowledge-document settings map in RagEngine.
    roots = [workspace / "docs"]
    files: List[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for item in sorted(root.rglob("*")):
            if not item.is_file():
                continue
            if item.suffix.lower() not in ALLOWED_RAG_EXTENSIONS:
                continue
            files.append(item)

    dedup: Dict[str, Path] = {}
    for item in files:
        dedup[str(item.resolve())] = item
    return sorted(dedup.values(), key=lambda p: str(p))


def split_paragraphs(text: str) -> List[str]:
    raw_parts = re.split(r"\n\s*\n", text)
    return [part.strip() for part in raw_parts if part.strip()]


def split_long_text(text: str, min_len: int = 260, max_len: int = 900) -> List[str]:
    if len(text) <= max_len:
        return [text.strip()]

    chunks: List[str] = []
    buffer = ""
    paragraphs = split_paragraphs(text)
    if not paragraphs:
        paragraphs = [text]

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        candidate = f"{buffer}\n\n{para}".strip() if buffer else para
        if len(candidate) <= max_len:
            buffer = candidate
            continue

        if buffer:
            chunks.append(buffer)

        if len(para) <= max_len:
            buffer = para
            continue

        sentences = re.split(r"(?<=[。！？?!])\s+", para)
        temp = ""
        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue
            temp_candidate = f"{temp} {sentence}".strip() if temp else sentence
            if len(temp_candidate) <= max_len:
                temp = temp_candidate
            else:
                if temp:
                    chunks.append(temp)
                temp = sentence

        buffer = temp if temp else ""

    if buffer:
        chunks.append(buffer)

    merged: List[str] = []
    carry = ""
    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk:
            continue
        if carry and len(carry) < min_len:
            carry = f"{carry}\n\n{chunk}"
            if len(carry) <= max_len:
                continue
            merged.append(carry[:max_len])
            carry = carry[max_len:]
            continue
        if carry:
            merged.append(carry)
            carry = ""
        if len(chunk) < min_len and merged:
            merged[-1] = f"{merged[-1]}\n\n{chunk}"
        else:
            merged.append(chunk)
    if carry:
        merged.append(carry)

    return merged or [text.strip()]
