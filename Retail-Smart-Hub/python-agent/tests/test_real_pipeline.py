"""
Real end-to-end test using DeepSeek API.
Tests: text-based procurement order creation with real LLM calls.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Mapping

_AGENT_DIR = Path(__file__).resolve().parent.parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))

# Fix Windows console encoding
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Ensure DeepSeek config
os.environ.setdefault("AI_PROVIDER", "deepseek")
os.environ.setdefault("AI_MODEL_IO_CONSOLE_LOG", "false")
os.environ.setdefault("RAG_LANCEDB_ENABLED", "false")
os.environ.setdefault("RAG_RERANK_ENABLED", "false")

from app.common import AgentConfig
from app.models import ChatRequest
from app.node_bridge import NodeToolBridge
from app.rag import RagEngine, EmbeddingClient
from app.memory import EpisodicMemoryStore
from app.orchestration import run_chat

TOOL_EXEC_LATENCY = 0.05


async def simulated_post(path: str, body: Dict[str, Any]) -> Dict[str, Any]:
    await asyncio.sleep(TOOL_EXEC_LATENCY)
    if path == "/tools/schema":
        return {"tools": [
            {"type": "function", "function": {
                "name": "get_master_data_overview",
                "description": "Get master data overview (suppliers, products, customers)",
                "parameters": {"type": "object", "properties": {"scope": {"type": "string"}}}
            }, "metadata": {"access_mode": "read"}},
            {"type": "function", "function": {
                "name": "create_procurement_order",
                "description": "Create procurement order (approval required, pending action)",
                "parameters": {"type": "object", "properties": {
                    "supplierName": {"type": "string"},
                    "expectedDate": {"type": "string"},
                    "items": {"type": "array"},
                    "remark": {"type": "string"}
                }}
            }, "metadata": {"access_mode": "write"}},
        ]}
    elif path == "/skills/match":
        return {"matchedSkills": [], "context": "", "availableSkillCount": 0}
    elif path == "/document/context":
        return {"context": "无附件"}
    elif path == "/memory/profile":
        return {"result": {"profile": {}, "records": [], "updatedAt": "", "updatedBy": ""}}
    elif path == "/tools/execute":
        tool_name = body.get("toolName", "")
        if tool_name == "get_master_data_overview":
            return {"execution": {
                "toolCall": {"name": tool_name, "status": "completed", "summary": "Found suppliers"},
                "result": {"ok": True, "code": "ok", "summary": "Active suppliers",
                           "context": json.dumps({"suppliers": [
                               {"name": "深圳市赛特电子有限公司", "status": "active", "contact": "张经理"},
                               {"name": "广州恒达商贸有限公司", "status": "active", "contact": "李经理"}
                           ]})}
            }}
        elif tool_name == "create_procurement_order":
            return {"execution": {
                "toolCall": {"name": tool_name, "status": "awaiting_confirmation",
                             "summary": "Pending procurement order created"},
                "result": {"ok": True, "code": "pending_confirmation",
                           "summary": "采购单草稿已创建",
                           "pendingAction": {
                               "id": "pending-po-001", "type": "procurement_order",
                               "name": "采购单草稿", "status": "pending",
                               "summary": "等待用户确认"
                           }}
            }}
        return {"execution": {"toolCall": {"name": tool_name, "status": "disabled", "summary": "Unknown"}}}
    elif path == "/memory/capture":
        return {"result": {"captured": True, "mode": "python_captured"}}
    return {}


async def main():
    config = AgentConfig()
    if not config.is_model_configured():
        print("ERROR: No API key configured!")
        print(f"  Provider: {config.normalized_provider()}")
        print(f"  Model: {config.active_model()}")
        print(f"  Key env: {config.active_api_key_env_name()}")
        print("  Set DEEPSEEK_API_KEY in environment and try again.")
        return

    print(f"Using: {config.normalized_provider()} / {config.active_model()}")

    node_bridge = NodeToolBridge(config)
    node_bridge._post = simulated_post  # type: ignore

    embedding = EmbeddingClient(config)
    episodic = EpisodicMemoryStore(config)
    rag = RagEngine(config, embedding, episodic)

    # Test 1: Simple text procurement request
    print("\n" + "=" * 60)
    print("TEST 1: Text-based procurement order (no image)")
    print("=" * 60)

    request = ChatRequest(
        prompt="帮我创建一张采购单，供应商是深圳市赛特电子有限公司，"
               "预计到货日期2026年5月10日，采购以下商品："
               "iPhone 15 Pro Max 256GB 黑色 10台 单价8999元，"
               "AirPods Pro 2 白色 20个 单价1799元",
        token="test-token",
        tenantId="default",
        userId="user-1",
        username="测试用户",
        conversationId="test-session",
        roles=["admin"],
        permissions=["procurement:write"],
    )

    t0 = time.perf_counter()
    result = await run_chat(request, config=config, node_bridge=node_bridge, rag=rag)
    elapsed = time.perf_counter() - t0

    print(f"Duration: {elapsed:.1f}s")
    print(f"Reply:\n{result.reply[:500]}")
    print(f"\nTool calls: {len(result.toolCalls)}")
    for tc in result.toolCalls:
        print(f"  - {tc.name}: {tc.status} | {tc.summary[:80]}")
    if result.pendingAction:
        print(f"Pending action: {result.pendingAction.get('name', 'N/A')}")
        print(f"  Status: {result.pendingAction.get('status', 'N/A')}")
    print(f"Trace ({len(result.trace)} entries):")
    for t in result.trace[-8:]:
        print(f"  {t[:120]}")

    # Test 2: Image procurement (will fail gracefully - DeepSeek no vision)
    print("\n" + "=" * 60)
    print("TEST 2: Image procurement (DeepSeek text-only - expect graceful fallback)")
    print("=" * 60)

    import base64
    img_path = Path(os.getcwd()) / "496-2.jpg"
    if not img_path.exists():
        img_path = Path(__file__).resolve().parent.parent.parent / "496-2.jpg"
    with open(img_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode()

    from app.models import AttachmentInput
    img_request = ChatRequest(
        prompt="请根据这张采购订单图片创建采购单",
        token="test-token",
        tenantId="default",
        userId="user-1",
        username="测试用户",
        conversationId="test-session-2",
        roles=["admin"],
        permissions=["procurement:write"],
        attachments=[
            AttachmentInput(
                fileName="496-2.jpg",
                kind="image",
                mimeType="image/jpeg",
                imageDataUrl=f"data:image/jpeg;base64,{img_b64}"
            )
        ]
    )

    t0 = time.perf_counter()
    img_result = await run_chat(img_request, config=config, node_bridge=node_bridge, rag=rag)
    img_elapsed = time.perf_counter() - t0

    print(f"Duration: {img_elapsed:.1f}s")
    print(f"Reply:\n{img_result.reply[:500]}")
    print(f"Tool calls: {len(img_result.toolCalls)}")
    if img_result.pendingAction:
        print(f"Pending action: {img_result.pendingAction.get('name', 'N/A')}")
    if img_result.clarification:
        print(f"Clarification: {img_result.clarification.get('title', 'N/A')}")
    print(f"Trace ({len(img_result.trace)} entries):")
    for t in img_result.trace[-8:]:
        print(f"  {t[:120]}")

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Test 1 (text procurement): {elapsed:.1f}s - {'OK' if result.reply else 'FAIL'}")
    print(f"Test 2 (image procurement): {img_elapsed:.1f}s - "
          f"{'OK (fallback handled)' if img_result.reply else 'FAIL'}")
    print(f"Note: DeepSeek is text-only. Image recognition needs Gemini or GPT-4V.")


if __name__ == "__main__":
    asyncio.run(main())
