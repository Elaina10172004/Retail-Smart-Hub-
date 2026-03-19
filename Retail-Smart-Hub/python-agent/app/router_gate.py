from __future__ import annotations

from typing import Any, Dict, List, Mapping, Sequence

from pydantic import BaseModel, Field

ROUTE_DIRECT_CONTEXT = "direct_context"
ROUTE_KB_RAG = "kb_rag"
ROUTE_TABLE_FIRST = "table_first"
ROUTE_HYBRID = "hybrid"
ROUTE_WEB_ONLY = "web_only"

ALLOWED_ROUTES = {
    ROUTE_DIRECT_CONTEXT,
    ROUTE_KB_RAG,
    ROUTE_TABLE_FIRST,
    ROUTE_HYBRID,
    ROUTE_WEB_ONLY,
}

FRESHNESS_KEYWORDS = (
    "latest",
    "most recent",
    "today",
    "now",
    "current",
    "recent",
    "news",
    "price",
    "rate",
    "schedule",
    "weather",
)

ACTION_KEYWORDS = (
    "create",
    "add",
    "update",
    "edit",
    "modify",
    "delete",
    "remove",
    "import",
    "export",
    "approve",
    "reject",
    "execute",
)


class RouterDecision(BaseModel):
    route: str = ROUTE_DIRECT_CONTEXT
    intention: str = "inform"
    complexity: int = 2
    modalities: List[str] = Field(default_factory=lambda: ["text"])
    direct_context_allowed: bool = False
    preprocess: Dict[str, Any] = Field(default_factory=dict)
    web_fallback_allowed: bool = False
    budgets: Dict[str, int] = Field(
        default_factory=lambda: {
            "history_turns": 6,
            "context_chars": 12000,
            "tool_rounds": 5,
            "web_rounds": 1,
            "browser_rounds": 1,
            "executor_steps": 5,
        }
    )
    reason_codes: List[str] = Field(default_factory=list)
    final_answer_allowed: bool = False

    def ensure_valid(self) -> "RouterDecision":
        if self.route not in ALLOWED_ROUTES:
            self.route = ROUTE_DIRECT_CONTEXT
        self.complexity = max(1, min(5, int(self.complexity)))
        self.final_answer_allowed = False
        return self


def _compact_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _contains_keyword(text: str, keywords: Sequence[str]) -> bool:
    lowered = text.lower()
    return any(keyword in lowered for keyword in keywords)


def _normalize_modalities(
    *,
    prompt: str,
    attachments: Sequence[Any] | None,
) -> List[str]:
    modalities: List[str] = ["text"]
    lowered = prompt.lower()
    if attachments:
        modalities.extend(["table", "document"])
        if any(
            str(getattr(item, "kind", "") or "").strip().lower() == "image"
            or bool(str(getattr(item, "imageDataUrl", "") or "").strip())
            for item in attachments
        ):
            modalities.append("image")
    if "csv" in lowered or "xlsx" in lowered or "table" in lowered or "sheet" in lowered:
        modalities.append("table")
    if "web" in lowered or "browser" in lowered or "internet" in lowered:
        modalities.append("web")
    deduped: List[str] = []
    for item in modalities:
        if item not in deduped:
            deduped.append(item)
    return deduped


def _infer_intention(prompt: str) -> str:
    lowered = prompt.lower()
    if _contains_keyword(lowered, ACTION_KEYWORDS):
        return "act"
    if "debug" in lowered or "error" in lowered or "failed" in lowered:
        return "debug"
    if "plan" in lowered or "roadmap" in lowered or "next step" in lowered:
        return "plan"
    if "compare" in lowered or "difference" in lowered:
        return "compare"
    if "search" in lowered or "find" in lowered or "look up" in lowered:
        return "retrieve"
    return "inform"


def _infer_complexity(
    *,
    prompt: str,
    history_turns: int,
    rag_chunk_count: int,
    has_attachments: bool,
) -> int:
    score = len(prompt)
    score += max(0, history_turns) * 70
    score += max(0, rag_chunk_count) * 50
    if has_attachments:
        score += 180
    if score >= 1800:
        return 5
    if score >= 1200:
        return 4
    if score >= 700:
        return 3
    if score >= 300:
        return 2
    return 1


def _build_budgets(complexity: int) -> Dict[str, int]:
    if complexity >= 5:
        return {
            "history_turns": 8,
            "context_chars": 16000,
            "tool_rounds": 5,
            "web_rounds": 1,
            "browser_rounds": 1,
            "executor_steps": 5,
        }
    if complexity >= 4:
        return {
            "history_turns": 8,
            "context_chars": 14000,
            "tool_rounds": 5,
            "web_rounds": 1,
            "browser_rounds": 1,
            "executor_steps": 5,
        }
    if complexity >= 3:
        return {
            "history_turns": 6,
            "context_chars": 12000,
            "tool_rounds": 5,
            "web_rounds": 1,
            "browser_rounds": 1,
            "executor_steps": 5,
        }
    return {
        "history_turns": 4,
        "context_chars": 9000,
        "tool_rounds": 3,
        "web_rounds": 1,
        "browser_rounds": 1,
        "executor_steps": 3,
    }


def _build_preprocess(
    *,
    prompt: str,
    modalities: Sequence[str],
    history_turns: int,
    route: str,
    intention: str,
) -> Dict[str, Any]:
    return {
        "normalized_prompt": prompt,
        "history_turns": history_turns,
        "modalities": list(modalities),
        "route_hint": route,
        "intention": intention,
        "query_mode": "direct_context" if route == ROUTE_DIRECT_CONTEXT else route,
    }


def route_request(
    request: Any | None = None,
    *,
    prompt: str | None = None,
    rag_chunk_count: int = 0,
    has_attachments: bool | None = None,
) -> RouterDecision:
    resolved_prompt = _compact_text(prompt if prompt is not None else getattr(request, "prompt", ""))
    history = getattr(request, "history", []) if request is not None else []
    attachments = getattr(request, "attachments", []) if request is not None else []

    resolved_has_attachments = bool(attachments) if has_attachments is None else bool(has_attachments)
    modalities = _normalize_modalities(prompt=resolved_prompt, attachments=attachments)
    intention = _infer_intention(resolved_prompt)
    complexity = _infer_complexity(
        prompt=resolved_prompt,
        history_turns=len(history) if isinstance(history, Sequence) else 0,
        rag_chunk_count=rag_chunk_count,
        has_attachments=resolved_has_attachments,
    )

    route = ROUTE_DIRECT_CONTEXT
    reason_codes: List[str] = []
    web_fallback_allowed = _contains_keyword(resolved_prompt, FRESHNESS_KEYWORDS)

    if resolved_has_attachments:
        route = ROUTE_HYBRID if rag_chunk_count > 0 else ROUTE_TABLE_FIRST
        reason_codes.append("attachments_present")
    elif rag_chunk_count > 0:
        route = ROUTE_KB_RAG
        reason_codes.append("rag_chunks_present")
    elif web_fallback_allowed:
        route = ROUTE_WEB_ONLY
        reason_codes.append("freshness_sensitive_without_kb")
    else:
        route = ROUTE_DIRECT_CONTEXT
        reason_codes.append("direct_context_sufficient")

    if intention in {"act", "debug"}:
        reason_codes.append("tool_capable_intention")
    if "table" in modalities:
        reason_codes.append("table_modality")
    if web_fallback_allowed:
        reason_codes.append("web_fallback_allowed")

    direct_context_allowed = route == ROUTE_DIRECT_CONTEXT

    return RouterDecision(
        route=route,
        intention=intention,
        complexity=complexity,
        modalities=modalities,
        direct_context_allowed=direct_context_allowed,
        preprocess=_build_preprocess(
            prompt=resolved_prompt,
            modalities=modalities,
            history_turns=len(history) if isinstance(history, Sequence) else 0,
            route=route,
            intention=intention,
        ),
        web_fallback_allowed=web_fallback_allowed,
        budgets=_build_budgets(complexity),
        reason_codes=reason_codes,
        final_answer_allowed=False,
    ).ensure_valid()


def gate_execution(
    decision: RouterDecision,
    *,
    available_tools: Sequence[Mapping[str, Any]] | None = None,
    missing_evidence: Sequence[Mapping[str, Any]] | Sequence[str] | None = None,
    evidence_quality: float | None = None,
    require_tool_match: bool = True,
) -> bool:
    tools = [item for item in (available_tools or []) if isinstance(item, Mapping)]
    has_missing = bool(missing_evidence)

    if decision.route not in {ROUTE_DIRECT_CONTEXT, ROUTE_KB_RAG, ROUTE_TABLE_FIRST, ROUTE_HYBRID, ROUTE_WEB_ONLY}:
        return False
    if require_tool_match and not tools:
        return False
    if has_missing:
        return True
    if evidence_quality is not None and float(evidence_quality) < 0.6:
        return True
    return False


__all__ = [
    "RouterDecision",
    "ROUTE_DIRECT_CONTEXT",
    "ROUTE_KB_RAG",
    "ROUTE_TABLE_FIRST",
    "ROUTE_HYBRID",
    "ROUTE_WEB_ONLY",
    "route_request",
    "gate_execution",
]
