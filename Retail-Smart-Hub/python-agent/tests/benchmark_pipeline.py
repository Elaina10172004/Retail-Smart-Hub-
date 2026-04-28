"""
End-to-end pipeline benchmark with simulated LLM latency.
Tests image procurement flow timing and correctness.
Run from python-agent/ directory: python tests/benchmark_pipeline.py
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Mapping

# Ensure python-agent is on sys.path
_AGENT_DIR = Path(__file__).resolve().parent.parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))

def _load_image_b64(path: str) -> str:
    """Load a real image file and return base64-encoded data URL."""
    import base64
    full_path = Path(__file__).resolve().parent.parent / path
    if not full_path.exists():
        # Try working directory
        full_path = Path(path)
    with open(full_path, "rb") as f:
        raw = f.read()
    return base64.b64encode(raw).decode()


# ---------------------------------------------------------------------------
# Simulated model requester (mimics real LLM latency)
# ---------------------------------------------------------------------------
LARGE_MODEL_LATENCY = 1.2   # seconds per call
SMALL_MODEL_LATENCY = 0.45  # seconds per call
TOOL_EXEC_LATENCY = 0.05    # simulated internal tool execution


def _make_simulated_model_requester():
    """Factory: return a stateful simulated LLM with realistic procurement flow.

    Flow (with Plan merged into Execute — our optimization):
      1. Image extraction (tool_choice=none) → extract fields
      2. Image validation (tool_choice=none) → approve fields
      3. Execute round 1 (tools available) → call get_master_data_overview
      4. Execute round 2 (tools available) → call create_procurement_order
      5. Execute round 3 (tools available) → final answer (no more tools needed)
      6. Answer synthesis (tool_choice=none) → structured answer JSON
    """
    call_count = [0]  # mutable counter

    async def requester(
        config: Any,
        messages: List[Dict[str, Any]],
        *,
        tools: List[Mapping[str, Any]] | None = None,
        tool_choice: str | None = None,
        role: str = "large",
    ) -> Dict[str, Any]:
        latency = SMALL_MODEL_LATENCY if role == "small" else LARGE_MODEL_LATENCY
        await asyncio.sleep(latency)
        call_count[0] += 1
        n = call_count[0]
        has_tools = bool(tools)

        # --- Image extraction (call 1) ---
        if n == 1:
            extract_json = json.dumps({
                "document_type": "采购单",
                "title": "测试采购订单",
                "document_number": "PO-2026-0428",
                "date": "2026-04-28",
                "supplier_name": "测试供应商A",
                "line_items": [{
                    "product_name": "测试商品X", "quantity": 100, "unit": "件",
                    "unit_cost": 25.50, "amount": 2550.00
                }],
                "summary": "测试采购订单 - 供应商A 商品X 100件",
                "import_target": "procurement",
                "confidence": 0.85
            }, ensure_ascii=False)
            return {"choices": [{"message": {"content": extract_json}}], "model": "simulated-large"}

        # --- Image validation (call 2) ---
        if n == 2:
            validate_json = json.dumps({
                "approved": True,
                "import_target": "procurement",
                "confidence": 0.88,
                "issues": [],
                "approved_fields": {
                    "document_type": "采购单", "title": "测试采购订单",
                    "document_number": "PO-2026-0428", "date": "2026-04-28",
                    "supplier_name": "测试供应商A",
                    "line_items": [{"product_name": "测试商品X", "quantity": 100, "unit": "件", "unit_cost": 25.50, "amount": 2550.00}],
                    "import_target": "procurement"
                }
            }, ensure_ascii=False)
            return {"choices": [{"message": {"content": validate_json}}], "model": "simulated-large"}

        # --- Execute phase with tools ---
        if has_tools and tool_choice != "none":
            # Round 1 (call 3): query master data
            if n == 3:
                return {
                    "choices": [{"message": {
                        "content": "先查询供应商主数据",
                        "tool_calls": [{
                            "id": "call_supplier",
                            "type": "function",
                            "function": {"name": "get_master_data_overview", "arguments": json.dumps({"scope": "suppliers"})}
                        }]
                    }}],
                    "model": "simulated-large"
                }
            # Round 2 (call 4): create procurement order after getting supplier data
            if n == 4:
                return {
                    "choices": [{"message": {
                        "content": "供应商已确认，创建采购单草稿",
                        "tool_calls": [{
                            "id": "call_procurement",
                            "type": "function",
                            "function": {"name": "create_procurement_order", "arguments": json.dumps({
                                "supplierName": "测试供应商A",
                                "expectedDate": "2026-04-28",
                                "remark": "图片导入：procurement-order.png；标题=测试采购订单；原单号=PO-2026-0428",
                                "items": [{"productName": "测试商品X", "quantity": 100, "unit": "件", "unitCost": 25.50}]
                            })}
                        }]
                    }}],
                    "model": "simulated-large"
                }
            # Round 3 (call 5): tools done, return final answer
            if n >= 5:
                return {"choices": [{"message": {"content": "采购单草稿已创建，等待用户确认。"}}], "model": "simulated-large"}

        # --- Answer synthesis (call 6, tool_choice=none) ---
        answer_json = json.dumps({
            "reply": (
                "已根据图片内容创建采购单草稿。\n\n"
                "单据类型：采购单\n"
                "供应方：测试供应商A\n"
                "日期：2026-04-28\n"
                "明细：\n"
                "1. 测试商品X / 数量 100 / 单价 25.50 / 金额 2550.00\n\n"
                "[!] 待确认：请确认供应方和商品信息是否正确，确认后采购单将正式生成。"
            ),
            "interruption": {
                "title": "请确认采购单信息",
                "message": "以下采购单草稿需要您确认后才能正式创建。",
                "options": [
                    {"id": "confirm", "label": "确认创建", "prompt": "确认创建此采购单", "description": "信息无误，正式生成采购单"},
                    {"id": "modify", "label": "修改后创建", "prompt": "修改采购单信息后再创建", "description": "需要调整供应方、商品、数量或价格"}
                ]
            }
        }, ensure_ascii=False)
        return {"choices": [{"message": {"content": answer_json}}], "model": "simulated-large"}

    return requester


# ---------------------------------------------------------------------------
# Benchmark
# ---------------------------------------------------------------------------

async def run_benchmark():
    import io
    import os
    # Fix Windows console encoding
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    os.environ.setdefault("AI_PROVIDER", "openai")
    os.environ.setdefault("OPENAI_API_KEY", "sk-test-benchmark")
    os.environ.setdefault("OPENAI_MODEL", "gpt-5.4-mini")
    os.environ.setdefault("AI_MODEL_IO_CONSOLE_LOG", "false")
    os.environ.setdefault("RAG_LANCEDB_DIR", "database/rag/lancedb")
    os.environ.setdefault("RAG_EMBEDDING_API_KEY", "sk-test-benchmark")
    os.environ.setdefault("RAG_EMBEDDING_MODEL", "text-embedding-3-small")
    os.environ.setdefault("RAG_RERANK_ENABLED", "false")
    os.environ.setdefault("RAG_LANCEDB_ENABLED", "false")

    from app.common import AgentConfig
    from app.models import ChatRequest, AttachmentInput
    from app.node_bridge import NodeToolBridge
    from app.rag import RagEngine, EmbeddingClient
    from app.memory import EpisodicMemoryStore
    from app.orchestration import run_chat, ModelRequestFn

    config = AgentConfig()
    node_bridge = NodeToolBridge(config)

    # Patch node_bridge to simulate responses
    original_post = node_bridge._post

    async def simulated_post(path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        await asyncio.sleep(TOOL_EXEC_LATENCY)
        if path == "/tools/schema":
            return {"tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "get_master_data_overview",
                        "description": "Get master data overview",
                        "parameters": {"type": "object", "properties": {"scope": {"type": "string"}}}
                    },
                    "metadata": {"access_mode": "read"}
                },
                {
                    "type": "function",
                    "function": {
                        "name": "create_procurement_order",
                        "description": "Create procurement order (approval required)",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "supplierName": {"type": "string"},
                                "expectedDate": {"type": "string"},
                                "items": {"type": "array"},
                                "remark": {"type": "string"}
                            }
                        }
                    },
                    "metadata": {"access_mode": "write"}
                }
            ]}
        elif path == "/skills/match":
            return {"matchedSkills": [], "context": "", "availableSkillCount": 0}
        elif path == "/document/context":
            return {"context": "采购订单图片附件"}
        elif path == "/memory/profile":
            return {"result": {"profile": {}, "records": [], "updatedAt": "", "updatedBy": ""}}
        elif path == "/tools/execute":
            tool_name = body.get("toolName", "")
            if tool_name == "get_master_data_overview":
                return {
                    "execution": {
                        "toolCall": {"name": tool_name, "status": "completed", "summary": "Found 1 active supplier"},
                        "result": {
                            "ok": True,
                            "code": "ok",
                            "message": "Suppliers loaded",
                            "summary": "Active suppliers: 测试供应商A",
                            "context": json.dumps({"suppliers": [{"name": "测试供应商A", "status": "active"}]}),
                            "data": {"suppliers": [{"name": "测试供应商A", "status": "active"}]}
                        }
                    }
                }
            elif tool_name == "create_procurement_order":
                return {
                    "execution": {
                        "toolCall": {"name": tool_name, "status": "awaiting_confirmation", "summary": "Pending procurement order created"},
                        "result": {
                            "ok": True,
                            "code": "pending_confirmation",
                            "message": "Procurement order draft created, pending confirmation",
                            "summary": "采购单草稿已创建，等待确认",
                            "pendingAction": {
                                "id": "pending-po-001",
                                "type": "procurement_order",
                                "name": "采购单 PO-2026-0428",
                                "status": "pending",
                                "summary": "供应方: 测试供应商A, 1 items, total: 2550.00"
                            }
                        }
                    }
                }
            return {"execution": {"toolCall": {"name": tool_name, "status": "disabled", "summary": "Unknown tool"}}}
        elif path == "/memory/capture":
            return {"result": {"captured": True, "mode": "python_captured"}}
        return await original_post(path, body)

    node_bridge._post = simulated_post

    # Build RAG (disabled - no LanceDB needed)
    embedding = EmbeddingClient(config)
    episodic = EpisodicMemoryStore(config)
    rag = RagEngine(config, embedding, episodic)

    # Build request with simulated procurement image
    request = ChatRequest(
        prompt="请根据这张采购订单图片创建采购单",
        token="benchmark-token",
        tenantId="default",
        userId="user-1",
        username="测试用户",
        conversationId="benchmark-session",
        roles=["admin"],
        permissions=["procurement:write"],
        attachments=[
            AttachmentInput(
                fileName="496-2.jpg",
                kind="image",
                mimeType="image/jpeg",
                imageDataUrl=f"data:image/jpeg;base64,{_load_image_b64('496-2.jpg')}"
            )
        ]
    )

    print("=" * 60)
    print("Retail Smart Hub - Pipeline Benchmark")
    print("=" * 60)
    print(f"Simulated LLM latency: large={LARGE_MODEL_LATENCY}s, small={SMALL_MODEL_LATENCY}s")
    print(f"Simulated tool latency: {TOOL_EXEC_LATENCY}s")
    print(f"Request: image procurement order creation")
    print()

    # Warmup
    print("Warming up...")
    simulated_model_requester = _make_simulated_model_requester()
    await run_chat(request, config=config, node_bridge=node_bridge, rag=rag, model_requester=simulated_model_requester)
    await asyncio.sleep(0.5)

    # Benchmark
    runs = 3
    times = []
    results = []

    for i in range(runs):
        print(f"Run {i+1}/{runs}...")
        t0 = time.perf_counter()
        result = await run_chat(
            request,
            config=config,
            node_bridge=node_bridge,
            rag=rag,
            model_requester=_make_simulated_model_requester(),
        )
        elapsed = time.perf_counter() - t0
        times.append(elapsed)
        results.append(result)
        print(f"  Elapsed: {elapsed:.2f}s")
        print(f"  Reply preview: {result.reply[:120]}...")
        print(f"  Tool calls: {len(result.toolCalls)}")
        if result.pendingAction:
            print(f"  Pending action: {result.pendingAction.get('name', 'N/A')}")
        print(f"  Configured: {result.configured}")
        print()

    avg_time = sum(times) / len(times)
    min_time = min(times)
    max_time = max(times)

    print("=" * 60)
    print("RESULTS")
    print("=" * 60)
    print(f"  Average: {avg_time:.2f}s")
    print(f"  Min:     {min_time:.2f}s")
    print(f"  Max:     {max_time:.2f}s")

    # Validate correctness
    final_result = results[-1]
    checks = []

    # Check 1: Response should not be empty
    checks.append(("Non-empty reply", bool(final_result.reply.strip())))

    # Check 2: Should have tool calls
    checks.append(("Has tool calls", len(final_result.toolCalls) > 0))

    # Check 3: Should have a pending action (procurement order created)
    checks.append(("Has pending action", final_result.pendingAction is not None))

    # Check 4: Should be configured (model available)
    checks.append(("Model configured", final_result.configured))

    # Check 5: Reply should mention procurement
    reply_has_procurement = any(
        kw in final_result.reply
        for kw in ["采购", "供应", "商品", "订单", "procurement"]
    )
    checks.append(("Reply mentions procurement", reply_has_procurement))

    # Check 6: No hallucination markers
    no_hallucination = not any(
        marker in final_result.reply
        for marker in ["模拟视觉识别", "模拟OCR", "假设识别", "推测图片内容"]
    )
    checks.append(("No hallucination markers", no_hallucination))

    print()
    print("CORRECTNESS CHECKS:")
    all_pass = True
    for name, passed in checks:
        status = "PASS" if passed else "FAIL"
        if not passed:
            all_pass = False
        print(f"  [{status}] {name}")

    print()
    if all_pass:
        print("All checks PASSED - procurement order pipeline works correctly!")
    else:
        print("Some checks FAILED - review needed.")

    # Estimated real-world times
    simulated_llm_calls = 6  # 2 image + 3 execute + 1 answer (Plan merged, was 7)
    simulated_llm_total = simulated_llm_calls * LARGE_MODEL_LATENCY
    overhead = avg_time - simulated_llm_total
    print()
    print("=" * 60)
    print("ESTIMATED REAL-WORLD TIMES (with actual LLM API latency)")
    print("=" * 60)
    print(f"  Simulated LLM calls: {simulated_llm_calls} (2 image + 3 execute + 1 answer)")
    print(f"  Simulated overhead (our code):     {overhead:.2f}s")
    print(f"  Real LLM estimate (6 calls @ 2-5s): 12-30s")
    print(f"  Estimated real total:              ~{overhead + 12:.1f}-{overhead + 30:.1f}s")
    print()
    print(f"  Before optimization (7 calls + serial ctx + serial tools):")
    print(f"  Old real total estimate:           ~{overhead + 1.0 + 14:.1f}-{overhead + 1.0 + 35:.1f}s")
    print()
    print("Optimizations applied:")
    print("  1. Parallel context gathering (4 coros)")
    print("  2. Parallel tool execution")
    print("  3. Plan phase merged into Execute (saved 1 LLM call)")
    print("  4. Shared httpx client with connection pooling")
    print("  5. Console logging disabled by default")
    print("  6. Memory capture fire-and-forget")

    return avg_time, all_pass, final_result


if __name__ == "__main__":
    avg, ok, result = asyncio.run(run_benchmark())
    if not ok:
        exit(1)
