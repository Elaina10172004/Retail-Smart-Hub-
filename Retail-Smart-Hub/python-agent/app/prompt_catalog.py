from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List


def _load_prompt_catalog() -> Dict[str, Any]:
    candidates = [
        Path.cwd() / "AI_PROMPTS.json",
        Path.cwd().parent / "AI_PROMPTS.json",
        Path(__file__).resolve().parents[2] / "AI_PROMPTS.json",
    ]
    for candidate in candidates:
        try:
            if not candidate.exists():
                continue
            return json.loads(candidate.read_text(encoding="utf-8"))
        except Exception:
            continue
    return {}


PROMPT_CATALOG = _load_prompt_catalog()


def _looks_corrupted(lines: List[str]) -> bool:
    merged = "\n".join(str(item) for item in lines)
    if not merged.strip():
        return True

    question_count = merged.count("?")
    if question_count >= 6 and (question_count / max(1, len(merged))) > 0.08:
        return True

    if "???" in merged:
        return True

    mojibake_markers = ("浣", "鍙", "銆", "闃", "缁", "锛", "馃", "�")
    if sum(merged.count(marker) for marker in mojibake_markers) >= 4:
        return True

    return False


def get_python_prompt_lines(key: str, fallback: List[str]) -> List[str]:
    value = PROMPT_CATALOG.get("python", {}).get(key)
    if isinstance(value, list) and value:
        normalized = [str(item) for item in value if str(item).strip()]
        if normalized and not _looks_corrupted(normalized):
            return normalized
    return fallback


def get_python_prompt_text(key: str, fallback: List[str]) -> str:
    return "\n".join(get_python_prompt_lines(key, fallback))
