from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List, Mapping

import httpx

from .common import AgentConfig


def _compact_text(value: Any, *, limit: int = 400) -> str:
    text = " ".join(str(value or "").strip().split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


def build_builtin_tool_definitions(config: AgentConfig) -> List[Dict[str, Any]]:
    tools: List[Dict[str, Any]] = []

    # Always available: web browsing via Playwright
    tools.append({
        "type": "function",
        "metadata": {"access_mode": "read", "origin": "builtin"},
        "function": {
            "name": "web_browse",
            "description": (
                "Open a web page and extract its visible text content. "
                "Use to read product pages, supplier websites, pricing info, or any public URL. "
                "Returns the page title and extracted text (truncated to ~3000 chars)."
            ),
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "required": ["url"],
                "properties": {
                    "url": {"type": "string", "description": "Full URL to open"},
                    "extract_tables": {"type": "boolean", "description": "Try to extract tables as structured data"},
                },
            },
        },
    })

    if config.is_tavily_search_enabled():
        tools.append({
            "type": "function",
            "metadata": {"access_mode": "read", "origin": "builtin"},
            "function": {
                "name": "web_search",
                "description": "Search the public web for up-to-date information using Tavily. Use when evidence is missing or the question requires current external facts.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "q": {"type": "string", "description": "Alias of query"},
                        "topic": {"type": "string", "enum": ["general", "news"]},
                        "max_results": {"type": "integer", "minimum": 1, "maximum": 8},
                    },
                },
            },
        })

    return tools


def has_builtin_tool(config: AgentConfig, tool_name: str) -> bool:
    if tool_name == "web_browse":
        return True
    return tool_name == "web_search" and config.is_tavily_search_enabled()


def _parse_builtin_tool_arguments(raw_arguments: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(raw_arguments or "{}")
    except Exception:
        parsed = {}
    return parsed if isinstance(parsed, dict) else {}


def _resolve_search_query(args: Mapping[str, Any]) -> str:
    for key in ("query", "q", "prompt", "question"):
        value = str(args.get(key) or "").strip()
        if value:
            return value
    return ""


async def _search_tavily(config: AgentConfig, query: str, *, topic: str, max_results: int) -> Dict[str, Any]:
    endpoint = f"{config.tavily_base_url}/search"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config.tavily_api_key}",
    }
    body = {
        "query": query,
        "topic": topic,
        "max_results": max(1, min(int(max_results), 8)),
        "include_answer": "advanced",
        "search_depth": "advanced",
    }
    timeout = max(5.0, config.request_timeout_ms / 1000.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(endpoint, headers=headers, json=body)
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}


def _normalize_tavily_results(payload: Mapping[str, Any]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    results = payload.get("results", [])
    if not isinstance(results, list):
        return normalized
    for item in results:
        if not isinstance(item, Mapping):
            continue
        title = _compact_text(item.get("title", ""), limit=160)
        url = str(item.get("url") or "").strip()
        content = _compact_text(item.get("content", ""), limit=320)
        if not any([title, url, content]):
            continue
        normalized.append(
            {
                "title": title,
                "url": url,
                "content": content,
                "score": item.get("score"),
                "published_date": item.get("published_date"),
            }
        )
    return normalized


def _build_search_context(query: str, answer: str, results: List[Dict[str, Any]]) -> str:
    lines = [f"Web search query: {query}"]
    if answer:
        lines.append(f"Tavily answer: {answer}")
    for index, item in enumerate(results[:5], start=1):
        title = _compact_text(item.get("title", ""), limit=160) or f"Result {index}"
        url = str(item.get("url") or "").strip()
        content = _compact_text(item.get("content", ""), limit=240)
        line = f"[{index}] {title}"
        if url:
            line += f" | {url}"
        if content:
            line += f" | {content}"
        lines.append(line)
    return "\n".join(lines)


async def _browse_web(url: str, extract_tables: bool = False) -> Dict[str, Any]:
    """Open a URL in headless Chromium and extract visible text."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return {"ok": False, "code": "execution_error",
                "summary": "Playwright not installed. Run: pip install playwright && python -m playwright install chromium",
                "context": "Playwright is required for web_browse."}

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            page = await browser.new_page()
            await page.goto(url, timeout=15000, wait_until="domcontentloaded")
            title = await page.title()
            text = await page.inner_text("body")
            tables: List[Dict[str, Any]] = []
            if extract_tables:
                # Try to extract table data
                table_elements = await page.query_selector_all("table")
                for t in table_elements:
                    rows = await t.query_selector_all("tr")
                    table_data: List[List[str]] = []
                    for row in rows[:20]:
                        cells = await row.query_selector_all("td,th")
                        table_data.append([(await c.inner_text()).strip() for c in cells])
                    if table_data:
                        tables.append({"rows": len(table_data), "data": table_data[:10]})
            await browser.close()

            # Truncate text
            text = " ".join(text.split())[:3000]
            summary = f"Browsed: {title}" if title else f"Browsed: {url[:80]}"
            context = f"Title: {title}\nURL: {url}\n\nContent:\n{text}"
            if tables:
                context += "\n\nTables extracted: " + json.dumps(tables, ensure_ascii=False)[:1000]
            return {"ok": True, "code": "ok", "summary": summary, "context": context,
                    "data": {"url": url, "title": title, "tables": tables}}
    except Exception as error:
        return {"ok": False, "code": "execution_error",
                "summary": f"Browse failed: {error}",
                "context": f"Failed to browse {url}: {error}"}


async def execute_builtin_tool(
    config: AgentConfig,
    tool_name: str,
    raw_arguments: str,
) -> Dict[str, Any]:
    if not has_builtin_tool(config, tool_name):
        raise RuntimeError(f"unknown builtin tool: {tool_name}")

    args = _parse_builtin_tool_arguments(raw_arguments)

    # --- web_browse ---
    if tool_name == "web_browse":
        url = str(args.get("url") or "").strip()
        if not url:
            summary = "web_browse requires a url."
            return {
                "toolCall": {"name": tool_name, "status": "disabled", "summary": summary},
                "result": {"ok": False, "code": "invalid_arguments", "message": summary, "summary": summary, "context": summary},
            }
        if not url.startswith("http"):
            url = "https://" + url
        extract_tables = bool(args.get("extract_tables"))
        result = await _browse_web(url, extract_tables=extract_tables)
        return {
            "toolCall": {"name": tool_name, "status": "completed" if result["ok"] else "disabled", "summary": result["summary"]},
            "result": result,
        }

    # --- web_search (Tavily) ---
    if not config.is_tavily_search_enabled():
        summary = "Tavily search is not configured."
        return {
            "toolCall": {"name": tool_name, "status": "disabled", "summary": summary},
            "result": {
                "ok": False,
                "code": "disabled",
                "message": summary,
                "summary": summary,
                "context": summary,
            },
        }

    args = _parse_builtin_tool_arguments(raw_arguments)
    query = _resolve_search_query(args)
    if not query:
        summary = "web_search requires query or q."
        return {
            "toolCall": {"name": tool_name, "status": "disabled", "summary": summary},
            "result": {
                "ok": False,
                "code": "invalid_arguments",
                "message": summary,
                "summary": summary,
                "context": summary,
            },
        }

    topic = str(args.get("topic") or config.tavily_topic or "general").strip().lower()
    if topic not in {"general", "news"}:
        topic = "general"
    max_results_raw = args.get("max_results", config.tavily_max_results)
    try:
        max_results = int(max_results_raw)
    except Exception:
        max_results = config.tavily_max_results

    try:
        payload = await _search_tavily(config, query, topic=topic, max_results=max_results)
    except Exception as error:
        summary = f"Tavily search failed: {error}"
        return {
            "toolCall": {"name": tool_name, "status": "disabled", "summary": summary},
            "result": {
                "ok": False,
                "code": "execution_error",
                "message": summary,
                "summary": summary,
                "context": summary,
            },
        }

    answer = _compact_text(payload.get("answer", ""), limit=320)
    results = _normalize_tavily_results(payload)
    context = _build_search_context(query, answer, results)
    summary = answer or (f"Found {len(results)} web result(s)." if results else "No strong web result found.")
    return {
        "toolCall": {"name": tool_name, "status": "completed", "summary": summary},
        "result": {
            "ok": True,
            "code": "ok" if results or answer else "no_result",
            "message": summary,
            "summary": summary,
            "context": context,
            "data": {
                "query": query,
                "topic": topic,
                "answer": answer,
                "results": results,
            },
        },
    }
