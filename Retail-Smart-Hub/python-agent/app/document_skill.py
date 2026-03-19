from __future__ import annotations

from typing import List, Sequence

from .models import AttachmentInput


def _compact_text(value: object) -> str:
    return " ".join(str(value or "").strip().split())


def summarize_attachments(attachments: Sequence[AttachmentInput]) -> str:
    if not attachments:
        return "No attachments."

    lines: List[str] = []
    for item in attachments:
        kind = (
            item.kind
            or ("image" if item.imageDataUrl else "workbook" if item.sheets else "table" if item.rows else "document")
        ).strip() or "document"
        if kind == "image":
            dimensions = ""
            if item.imageWidth and item.imageHeight:
                dimensions = f" size={item.imageWidth}x{item.imageHeight}"
            mime = f" mime={item.mimeType}" if item.mimeType else ""
            lines.append(f"- {item.fileName} kind=image{dimensions}{mime}")
            continue
        if kind in {"table", "workbook"}:
            fields: List[str] = []
            sample = item.rows[0] if item.rows else {}
            if isinstance(sample, dict):
                fields = [str(key) for key in list(sample.keys())[:10]]
            sheet_summary = ""
            if item.sheets:
                sheet_summary = f" sheets={len(item.sheets)}"
            lines.append(
                f"- {item.fileName} kind={kind} target={item.target} rows={len(item.rows)}{sheet_summary} fields={','.join(fields) if fields else '-'}"
            )
            continue

        page_count = sum(1 for block in item.blocks if block.type == "page")
        excerpt = ""
        if item.blocks:
            excerpt = _compact_text(item.blocks[0].text)[:180]
        elif item.textContent:
            excerpt = _compact_text(item.textContent)[:180]
        label_parts = [f"- {item.fileName} kind=document"]
        if page_count > 0:
            label_parts.append(f"pages={page_count}")
        elif item.blocks:
            label_parts.append(f"blocks={len(item.blocks)}")
        if excerpt:
            label_parts.append(f"excerpt={excerpt}")
        lines.append(" ".join(label_parts))

    return "\n".join(lines)
