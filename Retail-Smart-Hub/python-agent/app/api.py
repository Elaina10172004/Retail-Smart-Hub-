from __future__ import annotations

import asyncio
import traceback
from typing import Any, Dict

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from .common import json_dumps, now_iso
from .deps import get_runtime, require_agent_key
from .model_client import request_model as default_model_requester
from .models import (
    ChatRequest,
    MemoryFactDeleteRequest,
    MemoryFactsQuery,
    MemoryProfilePatchRequest,
    MemoryProfileQuery,
    RagRebuildRequest,
    StatusRequest,
)
from .orchestration import ModelRequestFn, run_chat as run_chat_flow, split_for_stream
from .runtime import AgentRuntime, build_runtime
from .builtin_tools import build_builtin_tool_definitions


async def run_chat(
    request: ChatRequest,
    *,
    runtime: AgentRuntime,
    model_requester: ModelRequestFn = default_model_requester,
):
    return await run_chat_flow(
        request,
        config=runtime.config,
        node_bridge=runtime.node_bridge,
        rag=runtime.rag,
        model_requester=model_requester,
    )


def create_app(
    *,
    runtime: AgentRuntime | None = None,
    model_requester: ModelRequestFn = default_model_requester,
) -> FastAPI:
    app = FastAPI(title="Retail Smart Hub Python Agent", version="2.0.0")
    if runtime is not None:
        app.state.runtime = runtime

    @app.get("/internal/agent/health", dependencies=[Depends(require_agent_key)])
    async def health() -> Dict[str, Any]:
        return {"ok": True, "service": "python-agent", "runtime": "python"}

    @app.post("/internal/agent/status", dependencies=[Depends(require_agent_key)])
    async def status(payload: StatusRequest, runtime: AgentRuntime = Depends(get_runtime)) -> Dict[str, Any]:
        try:
            await runtime.rag.ensure_index(force=False, incremental=True)
        except Exception:
            pass
        rag_stats = runtime.rag.stats()
        try:
            tools = await runtime.node_bridge.get_tools_schema(payload.token)
            visible_tools = len(tools)
        except Exception:
            visible_tools = 0
        visible_tools += len(build_builtin_tool_definitions(runtime.config))
        return {
            "configured": bool(
                runtime.config.is_model_configured()
            ),
            "provider": runtime.config.normalized_provider(),
            "model": runtime.config.active_model(),
            "ragEnabled": rag_stats.get("chunkCount", 0) > 0 or rag_stats.get("lancedb", {}).get("enabled", False),
            "functionUseEnabled": visible_tools > 0,
            "apiKeyEnv": (
                f"{runtime.config.active_api_key_env_name()} / "
                f"visibleRuntimeTools:{visible_tools} / "
                f"chunks:{rag_stats.get('chunkCount', 0)}"
            ),
        }

    @app.post("/internal/agent/chat", dependencies=[Depends(require_agent_key)])
    async def chat(payload: ChatRequest, runtime: AgentRuntime = Depends(get_runtime)) -> Dict[str, Any]:
        try:
            result = await run_chat(payload, runtime=runtime, model_requester=model_requester)
            return result.model_dump()
        except Exception as error:
            message = str(error).strip() or error.__class__.__name__
            raise HTTPException(status_code=500, detail=f"chat failed: {message}") from error

    @app.post("/internal/agent/chat/stream", dependencies=[Depends(require_agent_key)])
    async def chat_stream(payload: ChatRequest, runtime: AgentRuntime = Depends(get_runtime)) -> StreamingResponse:
        async def event_stream() -> Any:
            try:
                result = await run_chat(payload, runtime=runtime, model_requester=model_requester)
                meta = {
                    "toolCalls": [item.model_dump() for item in result.toolCalls],
                    "citations": result.citations,
                    "webSources": [item.model_dump() for item in result.webSources],
                    "pendingAction": result.pendingAction,
                    "approval": result.approval,
                    "answer_meta": result.answer_meta.model_dump() if result.answer_meta else None,
                    "configured": result.configured,
                    "provider": result.provider,
                    "model": result.model,
                    "note": result.note,
                    "trace": result.trace,
                }
                yield f"event: meta\ndata: {json_dumps(meta)}\n\n"

                for piece in split_for_stream(result.reasoningContent or "", 60):
                    yield f"event: delta\ndata: {json_dumps({'reasoningDelta': piece})}\n\n"
                    await asyncio.sleep(0)

                for piece in split_for_stream(result.reply, 60):
                    yield f"event: delta\ndata: {json_dumps({'replyDelta': piece})}\n\n"
                    await asyncio.sleep(0)

                yield f"event: done\ndata: {json_dumps(result.model_dump())}\n\n"
            except Exception as error:
                message = str(error).strip() or error.__class__.__name__
                print(f"[python-agent] stream error: {error.__class__.__name__}: {message}")
                traceback.print_exc()
                payload_error = {"message": f"stream failed: {message}"}
                yield f"event: error\ndata: {json_dumps(payload_error)}\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    @app.get("/internal/agent/rag/status", dependencies=[Depends(require_agent_key)])
    async def rag_status(runtime: AgentRuntime = Depends(get_runtime)) -> Dict[str, Any]:
        await runtime.rag.ensure_index(force=False, incremental=True)
        stats_payload = runtime.rag.stats()
        return {
            "chunkCount": stats_payload.get("chunkCount", 0),
            "lancedb": {
                "enabled": stats_payload.get("lancedb", {}).get("enabled", False),
                "available": stats_payload.get("lancedb", {}).get("available", False),
                "tableName": stats_payload.get("lancedb", {}).get(
                    "tableName",
                    runtime.config.rag_lancedb_table,
                ),
            },
        }

    @app.get("/internal/agent/rag/diagnostics", dependencies=[Depends(require_agent_key)])
    async def rag_diagnostics(runtime: AgentRuntime = Depends(get_runtime)) -> Dict[str, Any]:
        await runtime.rag.ensure_index(force=False, incremental=True)
        return runtime.rag.diagnostics()

    @app.post("/internal/agent/rag/rebuild", dependencies=[Depends(require_agent_key)])
    async def rag_rebuild(
        payload: RagRebuildRequest,
        runtime: AgentRuntime = Depends(get_runtime),
    ) -> Dict[str, Any]:
        await runtime.rag.ensure_index(force=payload.force, incremental=payload.incremental)
        stats_payload = runtime.rag.stats()
        lancedb_payload = stats_payload.get("lancedb", {})
        return {
            "chunkCount": stats_payload.get("chunkCount", 0),
            "lancedbEnabled": lancedb_payload.get("enabled", False),
            "lancedbAvailable": lancedb_payload.get("available", False),
            "lancedbError": lancedb_payload.get("lastError", ""),
            "rebuiltAt": now_iso(),
        }

    @app.post("/internal/agent/memory/profile", dependencies=[Depends(require_agent_key)])
    async def memory_profile(
        payload: MemoryProfileQuery,
        runtime: AgentRuntime = Depends(get_runtime),
    ) -> Dict[str, Any]:
        if payload.scope not in {"effective", "global", "tenant", "user", "session"}:
            raise HTTPException(status_code=400, detail="invalid scope")
        return await runtime.node_bridge.get_memory_profile(
            token=payload.token,
            scope=payload.scope,
            tenant_id=payload.tenantId,
            user_id=payload.userId,
            session_id=payload.sessionId,
        )

    @app.post("/internal/agent/memory/facts", dependencies=[Depends(require_agent_key)])
    async def memory_facts(
        payload: MemoryFactsQuery,
        runtime: AgentRuntime = Depends(get_runtime),
    ) -> Dict[str, Any]:
        scope = payload.scope if payload.scope in {"user", "tenant", "session"} else "user"
        return await runtime.node_bridge.get_memory_facts(
            token=payload.token,
            scope=scope,
            tenant_id=payload.tenantId,
            user_id=payload.userId,
            session_id=payload.sessionId,
            limit=payload.limit,
        )

    @app.post("/internal/agent/memory/profile/patch", dependencies=[Depends(require_agent_key)])
    async def memory_profile_patch(
        payload: MemoryProfilePatchRequest,
        runtime: AgentRuntime = Depends(get_runtime),
    ) -> Dict[str, Any]:
        if payload.scope not in {"global", "tenant", "user", "session"}:
            raise HTTPException(status_code=400, detail="invalid scope")
        return await runtime.node_bridge.patch_memory_profile(
            token=payload.token,
            scope=payload.scope,
            tenant_id=payload.tenantId,
            user_id=payload.userId,
            session_id=payload.sessionId,
            patch=payload.patch,
            updated_by=payload.updatedBy,
        )

    @app.post("/internal/agent/memory/facts/delete", dependencies=[Depends(require_agent_key)])
    async def memory_fact_delete(
        payload: MemoryFactDeleteRequest,
        runtime: AgentRuntime = Depends(get_runtime),
    ) -> Dict[str, Any]:
        return await runtime.node_bridge.delete_memory_fact(
            token=payload.token,
            fact_id=payload.id,
            scope=payload.scope if payload.scope in {"user", "tenant", "session"} else "user",
            tenant_id=payload.tenantId,
            user_id=payload.userId,
            session_id=payload.sessionId,
        )

    @app.on_event("startup")
    async def startup() -> None:
        if getattr(app.state, "runtime", None) is None:
            app.state.runtime = build_runtime()
        try:
            await app.state.runtime.rag.ensure_index(force=False, incremental=True)
        except Exception as error:
            print(f"[python-agent] startup index warning: {error}")

    return app
