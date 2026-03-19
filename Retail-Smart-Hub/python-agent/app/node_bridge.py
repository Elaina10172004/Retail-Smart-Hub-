from __future__ import annotations

from typing import Any, Dict, List, Sequence

import httpx

from .common import AgentConfig
from .models import ChatRequest


ALLOWED_TOOL_CALL_STATUSES = {
    "planned",
    "disabled",
    "completed",
    "awaiting_confirmation",
    "cancelled",
    "reverted",
}

ALLOWED_PENDING_ACTION_STATUSES = {
    "pending",
    "confirmed",
    "cancelled",
    "undone",
    "expired",
}


def _compact_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _build_tool_history(request: ChatRequest) -> List[Dict[str, Any]]:
    history: List[Dict[str, Any]] = []
    for item in request.history[-8:]:
        content = str(item.content or "").strip()
        if not content:
            continue

        row: Dict[str, Any] = {
            "role": "assistant" if item.role == "assistant" else "user",
            "content": content,
        }

        tool_calls: List[Dict[str, str]] = []
        if isinstance(item.toolCalls, list):
            for call in item.toolCalls:
                if not isinstance(call, dict):
                    continue
                name = _compact_optional_text(str(call.get("name") or ""))
                status = _compact_optional_text(str(call.get("status") or ""))
                summary = _compact_optional_text(str(call.get("summary") or ""))
                if not name or not status or not summary:
                    continue
                if status not in ALLOWED_TOOL_CALL_STATUSES:
                    continue
                tool_calls.append(
                    {
                        "name": name,
                        "status": status,
                        "summary": summary,
                    }
                )
        if tool_calls:
            row["toolCalls"] = tool_calls

        pending_action_id = _compact_optional_text(item.pendingActionId)
        if pending_action_id:
            row["pendingActionId"] = pending_action_id
        pending_action_name = _compact_optional_text(item.pendingActionName)
        if pending_action_name:
            row["pendingActionName"] = pending_action_name
        pending_action_status = _compact_optional_text(item.pendingActionStatus)
        if pending_action_status and pending_action_status in ALLOWED_PENDING_ACTION_STATUSES:
            row["pendingActionStatus"] = pending_action_status

        history.append(row)
    return history


class NodeToolBridge:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config

    async def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        endpoint = f"{self.config.node_internal_base_url}{path}"
        headers = {
            "Content-Type": "application/json",
            "x-agent-key": self.config.node_internal_key,
        }
        timeout = max(5.0, self.config.request_timeout_ms / 1000.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(endpoint, headers=headers, json=body)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise RuntimeError("invalid node bridge response")
            return payload

    async def get_tools_schema(self, token: str) -> List[Dict[str, Any]]:
        payload = await self._post("/tools/schema", {"token": token})
        tools = payload.get("tools", [])
        return [item for item in tools if isinstance(item, dict)]

    async def execute_tool(
        self,
        tool_name: str,
        raw_arguments: str,
        request: ChatRequest,
    ) -> Dict[str, Any]:
        payload = await self._post(
            "/tools/execute",
            {
                "toolName": tool_name,
                "rawArguments": raw_arguments,
                "request": {
                    "prompt": request.prompt,
                    "userId": request.userId,
                    "tenantId": request.tenantId,
                    "sessionId": request.conversationId,
                    "username": request.username,
                    "permissions": request.permissions,
                    "token": request.token,
                    "history": _build_tool_history(request),
                },
            },
        )
        execution = payload.get("execution")
        if not isinstance(execution, dict):
            raise RuntimeError("invalid tool execution response")
        return execution

    async def match_skills(
        self,
        prompt: str,
        token: str,
        *,
        limit: int = 4,
    ) -> Dict[str, Any]:
        payload = await self._post(
            "/skills/match",
            {
                "prompt": prompt,
                "token": token,
                "limit": max(1, min(8, int(limit))),
            },
        )
        return payload if isinstance(payload, dict) else {}

    async def handle_document_skill(self, request: ChatRequest) -> Dict[str, Any]:
        payload = await self._post(
            "/document/handle",
            {
                "prompt": request.prompt,
                "attachments": [item.model_dump(exclude_none=True) for item in request.attachments],
                "token": request.token,
            },
        )
        result = payload.get("result")
        return result if isinstance(result, dict) else {}

    async def build_document_context(self, request: ChatRequest) -> str:
        payload = await self._post(
            "/document/context",
            {
                "prompt": request.prompt,
                "attachments": [item.model_dump(exclude_none=True) for item in request.attachments],
            },
        )
        context = payload.get("context")
        return str(context).strip() if isinstance(context, str) else ""

    async def get_memory_profile(
        self,
        *,
        token: str,
        scope: str,
        tenant_id: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
    ) -> Dict[str, Any]:
        payload = await self._post(
            "/memory/profile",
            {
                "token": token,
                "scope": scope,
                "tenantId": tenant_id,
                "userId": user_id,
                "sessionId": session_id,
            },
        )
        result = payload.get("result")
        return result if isinstance(result, dict) else {}

    async def get_memory_facts(
        self,
        *,
        token: str,
        scope: str,
        tenant_id: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        limit: int = 30,
    ) -> Dict[str, Any]:
        payload = await self._post(
            "/memory/facts",
            {
                "token": token,
                "scope": scope,
                "tenantId": tenant_id,
                "userId": user_id,
                "sessionId": session_id,
                "limit": max(1, min(limit, 200)),
            },
        )
        result = payload.get("result")
        return result if isinstance(result, dict) else {}

    async def patch_memory_profile(
        self,
        *,
        token: str,
        scope: str,
        patch: Dict[str, Any],
        updated_by: str,
        tenant_id: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
    ) -> Dict[str, Any]:
        payload = await self._post(
            "/memory/profile/patch",
            {
                "token": token,
                "scope": scope,
                "tenantId": tenant_id,
                "userId": user_id,
                "sessionId": session_id,
                "patch": patch,
                "updatedBy": updated_by,
            },
        )
        result = payload.get("result")
        return result if isinstance(result, dict) else {}

    async def delete_memory_fact(
        self,
        *,
        token: str,
        fact_id: str,
        scope: str,
        tenant_id: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
    ) -> Dict[str, Any]:
        payload = await self._post(
            "/memory/facts/delete",
            {
                "token": token,
                "id": fact_id,
                "scope": scope,
                "tenantId": tenant_id,
                "userId": user_id,
                "sessionId": session_id,
            },
        )
        result = payload.get("result")
        return result if isinstance(result, dict) else {}

    async def capture_conversation_memory(
        self,
        *,
        token: str,
        prompt: str,
        reply: str,
        tenant_id: str | None = None,
        session_id: str | None = None,
        citations: Sequence[str] | None = None,
    ) -> Dict[str, Any]:
        payload = await self._post(
            "/memory/capture",
            {
                "token": token,
                "prompt": prompt,
                "reply": reply,
                "sessionId": session_id,
                "citations": list(citations or []),
            },
        )
        result = payload.get("result")
        return result if isinstance(result, dict) else {}


