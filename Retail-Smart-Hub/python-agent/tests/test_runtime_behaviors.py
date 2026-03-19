from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from app.common import AgentConfig
    from app.models import AttachmentInput, ChatRequest
    from app.orchestration import _resolve_gaps_after_small_prefetch, run_chat
    from app.orchestration_helpers import ToolLoopState, build_tool_execution_error
    from app.models import ToolCallRecord
    from app.runtime import build_runtime
    IMPORT_ERROR: Exception | None = None
except ModuleNotFoundError as error:  # pragma: no cover
    AgentConfig = None  # type: ignore[assignment]
    AttachmentInput = None  # type: ignore[assignment]
    ChatRequest = None  # type: ignore[assignment]
    run_chat = None  # type: ignore[assignment]
    _resolve_gaps_after_small_prefetch = None  # type: ignore[assignment]
    build_tool_execution_error = None  # type: ignore[assignment]
    ToolLoopState = None  # type: ignore[assignment]
    ToolCallRecord = None  # type: ignore[assignment]
    build_runtime = None  # type: ignore[assignment]
    IMPORT_ERROR = error


class NodeBridgeStub:
    def __init__(self) -> None:
        self.document_result: Dict[str, Any] = {"handled": False}
        self.document_context: str = "No attachments."
        self.skill_payload: Dict[str, Any] = {
            "matchedSkills": [],
            "availableSkillCount": 0,
            "disabledSkillCount": 0,
            "context": "",
        }
        self.tools_schema: List[Dict[str, Any]] = []
        self.profile_payload: Dict[str, Any] = {
            "profile": {},
            "records": [],
            "updatedAt": "2026-01-01T00:00:00Z",
            "updatedBy": "test",
        }
        self.tool_results: Dict[str, Dict[str, Any]] = {}
        self.executed_tools: List[Dict[str, str]] = []
        self.capture_result: Dict[str, Any] = {"captured": True, "mode": "created", "id": "mem-test"}
        self.capture_error: Optional[Exception] = None

    async def handle_document_skill(self, request: ChatRequest) -> Dict[str, Any]:
        return self.document_result

    async def build_document_context(self, request: ChatRequest) -> str:
        return self.document_context

    async def match_skills(
        self,
        prompt: str,
        token: str,
        *,
        limit: int = 4,
    ) -> Dict[str, Any]:
        return self.skill_payload

    async def get_tools_schema(self, token: str) -> List[Dict[str, Any]]:
        return self.tools_schema

    async def execute_tool(
        self,
        tool_name: str,
        raw_arguments: str,
        request: ChatRequest,
    ) -> Dict[str, Any]:
        self.executed_tools.append({"name": tool_name, "arguments": raw_arguments})
        if tool_name in self.tool_results:
            return self.tool_results[tool_name]
        raise RuntimeError("execute_tool should not be called in these tests")

    async def get_memory_profile(
        self,
        *,
        token: str,
        scope: str,
        tenant_id: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
    ) -> Dict[str, Any]:
        return self.profile_payload

    async def capture_conversation_memory(
        self,
        *,
        token: str,
        prompt: str,
        reply: str,
        tenant_id: str | None = None,
        session_id: str | None = None,
        citations: List[str] | None = None,
    ) -> Dict[str, Any]:
        if self.capture_error:
            raise self.capture_error
        return self.capture_result


class RagStub:
    async def retrieve(self, *args: Any, **kwargs: Any) -> List[Dict[str, Any]]:
        return []


def _is_plan_probe(messages: List[Dict[str, Any]], tools: List[Dict[str, Any]] | None) -> bool:
    if tools:
        return False
    for item in messages:
        if item.get("role") != "user":
            continue
        if "MODE=PLAN" in str(item.get("content", "")):
            return True
    return False


class PythonRuntimeBehaviorTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if IMPORT_ERROR is not None:
            raise unittest.SkipTest(f"python-agent dependencies are missing: {IMPORT_ERROR}")

    async def asyncSetUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.config = AgentConfig(
            deepseek_api_key="test-key",
            data_root=Path(self.tmpdir.name),
            rag_lancedb_dir=Path(self.tmpdir.name) / "rag" / "lancedb",
            ai_layered_agent_enabled=False,
        )
        self.node_stub = NodeBridgeStub()
        self.rag_stub = RagStub()

    async def asyncTearDown(self) -> None:
        self.tmpdir.cleanup()

    async def test_skill_context_is_injected_in_python_runtime(self) -> None:
        captured_messages: List[Dict[str, Any]] = []

        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            captured_messages.extend(messages)
            return {
                "model": "mock-model",
                "choices": [{"message": {"content": "ok"}}],
            }

        self.node_stub.skill_payload = {
            "matchedSkills": [{"name": "Controlled Write Guard"}],
            "availableSkillCount": 1,
            "disabledSkillCount": 0,
            "context": "SKILL_CONTEXT_MARKER",
        }
        self.node_stub.tools_schema = []

        response = await run_chat(
            ChatRequest(
                prompt="hello",
                userId="usr-1",
                username="tester",
            ),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        user_messages = [item for item in captured_messages if item.get("role") == "user"]
        self.assertTrue(user_messages)
        self.assertIn("SKILL_CONTEXT_MARKER", str(user_messages[-1].get("content", "")))
        self.assertTrue(any("Skills injected" in item for item in response.trace))

    async def test_attachment_context_is_resolved_via_node_bridge(self) -> None:
        captured_messages: List[Dict[str, Any]] = []

        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            captured_messages.extend(messages)
            return {
                "model": "mock-model",
                "choices": [{"message": {"content": "ok"}}],
            }

        self.node_stub.skill_payload = {
            "matchedSkills": [],
            "availableSkillCount": 0,
            "disabledSkillCount": 0,
            "context": "",
        }
        self.node_stub.document_context = "DOCUMENT_CONTEXT_MARKER"
        self.node_stub.tools_schema = []

        response = await run_chat(
            ChatRequest(
                prompt="analyze attachment",
                userId="usr-ctx",
                username="tester",
                attachments=[
                    AttachmentInput(
                        fileName="customers.csv",
                        target="customer",
                        rows=[{"customerName": "A"}],
                    )
                ],
            ),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        user_messages = [item for item in captured_messages if item.get("role") == "user"]
        self.assertTrue(user_messages)
        self.assertIn("DOCUMENT_CONTEXT_MARKER", str(user_messages[-1].get("content", "")))
        self.assertTrue(any("Attachment context resolved via node bridge" in item for item in response.trace))

    async def test_document_skill_returns_pending_action_not_direct_write(self) -> None:
        self.node_stub.document_result = {
            "handled": True,
            "reply": "pending created",
            "note": "approval required",
            "toolCalls": [
                {
                    "name": "import_documents_batch",
                    "status": "awaiting_confirmation",
                    "summary": "pending action created",
                }
            ],
            "citations": [],
            "trace": ["document handled"],
            "pendingAction": {"id": "AIACT-001", "status": "pending"},
            "approval": {"id": "AIACT-001", "canConfirm": True},
            "configured": True,
            "provider": "deepseek",
            "model": "mock-model",
        }

        response = await run_chat(
            ChatRequest(
                prompt="import this file",
                userId="usr-2",
                username="tester",
                attachments=[
                    AttachmentInput(
                        fileName="customers.csv",
                        target="customer",
                        rows=[{"customerName": "A", "channel": "online"}],
                    )
                ],
            ),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
        )

        self.assertIsNotNone(response.pendingAction)
        self.assertEqual(response.pendingAction.get("id"), "AIACT-001")
        self.assertIsNotNone(response.approval)
        self.assertTrue(any(item.status == "awaiting_confirmation" for item in response.toolCalls))
        self.assertIsNotNone(response.memoryCapture)

    async def test_document_skill_permission_reject_passthrough(self) -> None:
        self.node_stub.document_result = {
            "handled": True,
            "reply": "permission denied",
            "note": "no write",
            "toolCalls": [
                {
                    "name": "import_documents_batch",
                    "status": "disabled",
                    "summary": "missing permission",
                }
            ],
            "citations": [],
            "trace": ["permission denied"],
            "configured": True,
            "provider": "deepseek",
            "model": "mock-model",
        }

        response = await run_chat(
            ChatRequest(
                prompt="import this file",
                userId="usr-3",
                username="tester",
                attachments=[
                    AttachmentInput(
                        fileName="customers.csv",
                        target="customer",
                        rows=[{"customerName": "B", "channel": "offline"}],
                    )
                ],
            ),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
        )

        self.assertIsNone(response.pendingAction)
        self.assertIsNone(response.approval)
        self.assertTrue(any(item.status == "disabled" for item in response.toolCalls))
        self.assertIsNotNone(response.memoryCapture)

    async def test_tool_loop_supports_multi_round_calls(self) -> None:
        call_count = 0

        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return {
                    "model": "mock-model",
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "call-1",
                                        "type": "function",
                                        "function": {
                                            "name": "list_orders",
                                            "arguments": "{\"limit\":1}",
                                        },
                                    }
                                ],
                            }
                        }
                    ],
                }
            if call_count == 2:
                return {
                    "model": "mock-model",
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "call-2",
                                        "type": "function",
                                        "function": {
                                            "name": "get_dashboard_overview",
                                            "arguments": "{}",
                                        },
                                    }
                                ],
                            }
                        }
                    ],
                }
            return {
                "model": "mock-model",
                "choices": [{"message": {"content": "final response after tools"}}],
            }

        self.node_stub.tools_schema = [
            {"type": "function", "function": {"name": "list_orders"}},
            {"type": "function", "function": {"name": "get_dashboard_overview"}},
        ]
        self.node_stub.tool_results = {
            "list_orders": {
                "toolCall": {"name": "list_orders", "status": "completed", "summary": "orders ok"},
                "result": {
                    "ok": True,
                    "code": "ok",
                    "message": "orders ok",
                    "summary": "orders ok",
                    "context": "orders context",
                    "data": {"rows": 1},
                },
            },
            "get_dashboard_overview": {
                "toolCall": {"name": "get_dashboard_overview", "status": "completed", "summary": "dashboard ok"},
                "result": {
                    "ok": True,
                    "code": "ok",
                    "message": "dashboard ok",
                    "summary": "dashboard ok",
                    "context": "dashboard context",
                    "data": {"summary": "ok"},
                },
            },
        }

        response = await run_chat(
            ChatRequest(prompt="show dashboard and orders", userId="usr-tool-loop", username="tester"),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        self.assertEqual(response.reply, "final response after tools")
        self.assertEqual([item.name for item in response.toolCalls], ["list_orders", "get_dashboard_overview"])
        self.assertTrue(any("Tool loop round 1" in item for item in response.trace))
        self.assertTrue(any("Tool loop round 2" in item for item in response.trace))
        self.assertEqual(len(self.node_stub.executed_tools), 2)

    async def test_tool_loop_recovers_when_node_bridge_tool_fails(self) -> None:
        call_count = 0

        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return {
                    "model": "mock-model",
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "call-fail",
                                        "type": "function",
                                        "function": {
                                            "name": "list_orders",
                                            "arguments": "{\"limit\":1}",
                                        },
                                    }
                                ],
                            }
                        }
                    ],
                }
            return {
                "model": "mock-model",
                "choices": [{"message": {"content": "final response after failure"}}],
            }

        self.node_stub.tools_schema = [{"type": "function", "function": {"name": "list_orders"}}]

        response = await run_chat(
            ChatRequest(prompt="trigger tool failure", userId="usr-tool-fail", username="tester"),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        self.assertEqual(response.reply, "final response after failure")
        self.assertEqual(len(response.toolCalls), 1)
        self.assertEqual(response.toolCalls[0].status, "disabled")
        self.assertIn("Tool execution failed", response.toolCalls[0].summary)

    async def test_tool_loop_promotes_textual_execute_json_into_tool_call(self) -> None:
        call_count = 0

        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return {
                    "model": "mock-model",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '进入 EXECUTE: 先拉取仪表盘概览数据。 '
                                    '{"mode":"EXECUTE","tool_name":"get_dashboard_overview","arguments":{}}'
                                )
                            }
                        }
                    ],
                }
            return {
                "model": "mock-model",
                "choices": [{"message": {"content": "dashboard ready"}}],
            }

        self.node_stub.tools_schema = [{"type": "function", "function": {"name": "get_dashboard_overview"}}]
        self.node_stub.tool_results = {
            "get_dashboard_overview": {
                "toolCall": {"name": "get_dashboard_overview", "status": "completed", "summary": "dashboard ok"},
                "result": {
                    "ok": True,
                    "code": "ok",
                    "message": "dashboard ok",
                    "summary": "dashboard ok",
                    "context": "orders=18, receivables=120000",
                    "data": {"orders": 18, "receivables": 120000},
                },
            }
        }

        response = await run_chat(
            ChatRequest(prompt="show me the current dashboard", userId="usr-text-exec", username="tester"),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        self.assertEqual(response.reply, "dashboard ready")
        self.assertEqual([item["name"] for item in self.node_stub.executed_tools], ["get_dashboard_overview"])
        self.assertEqual([item.name for item in response.toolCalls], ["get_dashboard_overview"])
        self.assertTrue(any("model requested 1 tool calls" in item for item in response.trace))

    async def test_tool_loop_marks_malformed_tool_payload_as_execution_error(self) -> None:
        call_count = 0

        class JsonValidatingNodeBridgeStub(NodeBridgeStub):
            async def execute_tool(
                self,
                tool_name: str,
                raw_arguments: str,
                request: ChatRequest,
            ) -> Dict[str, Any]:
                self.executed_tools.append({"name": tool_name, "arguments": raw_arguments})
                json.loads(raw_arguments)
                return {
                    "toolCall": {"name": tool_name, "status": "completed", "summary": "payload accepted"},
                    "result": {
                        "ok": True,
                        "code": "ok",
                        "message": "payload accepted",
                        "summary": "payload accepted",
                        "context": "payload accepted",
                        "data": {"accepted": True},
                    },
                }

        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return {
                    "model": "mock-model",
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "call-malformed",
                                        "type": "function",
                                        "function": {
                                            "name": "list_orders",
                                            "arguments": "{\"limit\":",
                                        },
                                    }
                                ],
                            }
                        }
                    ],
                }
            return {
                "model": "mock-model",
                "choices": [{"message": {"content": "final response after malformed payload"}}],
            }

        node_stub = JsonValidatingNodeBridgeStub()
        node_stub.tools_schema = [{"type": "function", "function": {"name": "list_orders"}}]

        response = await run_chat(
            ChatRequest(prompt="trigger malformed payload", userId="usr-malformed", username="tester"),
            config=self.config,
            node_bridge=node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        self.assertEqual(response.reply, "final response after malformed payload")
        self.assertEqual(len(response.toolCalls), 1)
        self.assertEqual(response.toolCalls[0].status, "disabled")
        self.assertIn("Tool execution failed", response.toolCalls[0].summary)
        self.assertEqual(len(node_stub.executed_tools), 1)
        self.assertIn("Tool loop round 1", " ".join(response.trace))
        self.assertIsNotNone(build_tool_execution_error)
        self.assertEqual(
            build_tool_execution_error("list_orders", RuntimeError("malformed payload"))["result"]["code"],
            "execution_error",
        )

    async def test_tool_loop_injects_non_empty_reply_when_model_returns_empty_content(self) -> None:
        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            return {
                "model": "mock-model",
                "choices": [{"message": {"content": ""}}],
            }

        response = await run_chat(
            ChatRequest(prompt="empty output check", userId="usr-empty-reply", username="tester"),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        self.assertTrue(response.reply.strip())
        self.assertIn("No final answer was generated", response.reply)

    async def test_memory_capture_reports_success(self) -> None:
        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            return {"model": "mock-model", "choices": [{"message": {"content": "ok"}}]}

        self.node_stub.capture_result = {"captured": True, "mode": "created", "id": "mem-1"}

        response = await run_chat(
            ChatRequest(prompt="remember this", userId="usr-4", username="tester"),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        self.assertIsNotNone(response.memoryCapture)
        self.assertTrue(response.memoryCapture.captured)
        self.assertEqual(response.memoryCapture.reason, "created")
        self.assertEqual(response.memoryCapture.owner, "python")

    async def test_layered_runtime_exposes_answer_meta_as_formal_response_field(self) -> None:
        self.config.ai_layered_agent_enabled = True

        class ChunkedRagStub:
            async def retrieve(self, *args: Any, **kwargs: Any) -> List[Dict[str, Any]]:
                return [
                    {
                        "id": "chunk-1",
                        "docTitle": "KB",
                        "citation": "docs/rag/knowledge/policy.md / Block 1",
                        "content": "booked revenue is recognized after confirmation",
                        "score": 0.92,
                        "denseScore": 0.8,
                        "lexicalScore": 0.9,
                        "recencyScore": 0.95,
                    }
                ]

        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
            role: str | None = None,
        ) -> Dict[str, Any]:
            if _is_plan_probe(messages, tools):
                return {
                    "model": "mock-model",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"objective":"answer from evidence","steps":["review evidence"],'
                                    '"tool_policy":"do not call tools","evidence_targets":[],'
                                    '"confidence":0.8,"fallback":"local","final_answer_allowed":false}'
                                )
                            }
                        }
                    ],
                }
            return {"model": "mock-model", "choices": [{"message": {"content": "grounded answer"}}]}

        response = await run_chat(
            ChatRequest(prompt="what is booked revenue", userId="usr-layered", username="tester"),
            config=self.config,
            node_bridge=self.node_stub,
            rag=ChunkedRagStub(),
            model_requester=fake_request_deepseek,
        )

        self.assertEqual(response.reply, "grounded answer")
        self.assertIsNotNone(response.answer_meta)
        self.assertGreaterEqual(len(response.answer_meta.used_evidence_ids), 1)
        self.assertIn(response.answer_meta.confidence, {"low", "medium", "high"})

    async def test_layered_runtime_routes_image_evidence_through_small_model_before_large_handoff(self) -> None:
        self.config.ai_layered_agent_enabled = True
        self.config.large_provider = "openai"
        self.config.large_model = "gpt-5.4"
        self.config.large_api_key = "large-key"
        self.config.small_provider = "gemini"
        self.config.small_model = "gemini-2.5-flash"
        self.config.small_api_key = "small-key"

        small_payloads: List[List[Dict[str, Any]]] = []
        large_payloads: List[List[Dict[str, Any]]] = []

        async def fake_request_model(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
            role: str | None = None,
        ) -> Dict[str, Any]:
            if role == "small":
                small_payloads.append(messages)
                has_inline_images = any(
                    isinstance(item.get("content"), dict) and bool(item["content"].get("images"))
                    for item in messages
                    if isinstance(item, dict)
                )
                if has_inline_images:
                    return {
                        "model": "gemini-2.5-flash",
                        "choices": [
                            {
                                "message": {
                                    "content": (
                                        '{"summary":"The image shows boxed inventory on a shelf and a label reading 12 units.",'
                                        '"evidence":['
                                        '{"claim":"A shelf label shows 12 units.","excerpt":"12 units","focus":"shelf label","confidence":0.93},'
                                        '{"claim":"Cardboard boxes are stacked on a warehouse shelf.","excerpt":"boxes on shelf","focus":"center rack","confidence":0.82}'
                                        '],'
                                        '"final_answer_allowed":false}'
                                    )
                                }
                            }
                        ],
                    }
                return {
                    "model": "gemini-2.5-flash",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"rewritten_query":"analyze uploaded warehouse image",'
                                    '"query_rewrites":{"exact_query":"analyze uploaded warehouse image"},'
                                    '"missing_evidence":[],"retrieval_diagnostics":{"kb_quality":0.0,"coverage":0.5},'
                                    '"notes":["small_refined"],"final_answer_allowed":false}'
                                )
                            }
                        }
                    ],
                }

            large_payloads.append(messages)
            if _is_plan_probe(messages, tools):
                return {
                    "model": "gpt-5.4",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"objective":"answer from image evidence","steps":["review image evidence"],'
                                    '"tool_policy":"do not call tools","evidence_targets":["attachment_image"],'
                                    '"confidence":0.7,"fallback":"local","final_answer_allowed":false}'
                                )
                            }
                        }
                    ],
                }
            return {"model": "gpt-5.4", "choices": [{"message": {"content": "final grounded answer"}}]}

        response = await run_chat(
            ChatRequest(
                prompt="这张图里有什么库存线索",
                userId="usr-image-layered",
                username="tester",
                attachments=[
                    AttachmentInput(
                        id="img-1",
                        fileName="shelf.webp",
                        kind="image",
                        mimeType="image/webp",
                        imageWidth=576,
                        imageHeight=1080,
                        imageDataUrl="data:image/webp;base64,QUJD",
                    )
                ],
            ),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_model,
        )

        self.assertEqual(response.reply, "final grounded answer")
        self.assertTrue(any("Layered image evidence: extracted" in item for item in response.trace))
        self.assertTrue(any("image_evidence_extracted_by_small_model" in item for item in response.trace))

        self.assertTrue(
            any(
                isinstance(item.get("content"), dict) and bool(item["content"].get("images"))
                for messages in small_payloads
                for item in messages
                if isinstance(item, dict)
            )
        )
        self.assertTrue(large_payloads)
        self.assertFalse(
            any(
                isinstance(item.get("content"), dict) and bool(item["content"].get("images"))
                for messages in large_payloads
                for item in messages
                if isinstance(item, dict)
            )
        )

    async def test_memory_capture_reports_exception(self) -> None:
        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            return {"model": "mock-model", "choices": [{"message": {"content": "ok"}}]}

        self.node_stub.capture_error = RuntimeError("memory down")

        response = await run_chat(
            ChatRequest(prompt="remember this", userId="usr-5", username="tester"),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        self.assertIsNotNone(response.memoryCapture)
        self.assertFalse(response.memoryCapture.captured)
        self.assertEqual(response.memoryCapture.reason, "exception")
        self.assertIn("memory down", response.memoryCapture.error or "")

    async def test_tool_schema_fetch_failure_is_reported_in_trace(self) -> None:
        call_count = 0

        class SchemaFailingNodeBridgeStub(NodeBridgeStub):
            async def get_tools_schema(self, token: str) -> List[Dict[str, Any]]:
                raise RuntimeError("schema unavailable")

        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            nonlocal call_count
            call_count += 1
            return {
                "model": "mock-model",
                "choices": [{"message": {"content": "final response without tools"}}],
            }

        node_stub = SchemaFailingNodeBridgeStub()

        response = await run_chat(
            ChatRequest(prompt="trace schema failure", userId="usr-schema", username="tester"),
            config=self.config,
            node_bridge=node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        self.assertEqual(response.reply, "final response without tools")
        self.assertTrue(any("Tool schema fetch failed" in item for item in response.trace))

    async def test_small_prefetches_read_only_tools_before_large_handoff(self) -> None:
        self.config.ai_layered_agent_enabled = True
        self.config.large_provider = "openai"
        self.config.large_model = "gpt-5.4"
        self.config.large_api_key = "large-key"
        self.config.small_provider = "gemini"
        self.config.small_model = "gemini-2.5-flash"
        self.config.small_api_key = "small-key"
        self.node_stub.tools_schema = [
            {
                "type": "function",
                "metadata": {"access_mode": "read", "origin": "node"},
                "function": {
                    "name": "get_dashboard_overview",
                    "description": "Get dashboard overview KPIs. Permission: reports.view.",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "metadata": {"access_mode": "write", "origin": "node"},
                "function": {
                    "name": "create_sales_order",
                    "description": "Create sales order (approval required). The call only creates a pending approval action.",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
        ]
        self.node_stub.tool_results = {
            "get_dashboard_overview": {
                "toolCall": {"name": "get_dashboard_overview", "status": "completed", "summary": "dashboard kpi loaded"},
                "result": {
                    "ok": True,
                    "code": "ok",
                    "message": "dashboard kpi loaded",
                    "summary": "dashboard kpi loaded",
                    "context": "orders=18, inventory_alerts=4, receivables=120000",
                    "data": {"orders": 18, "inventoryAlerts": 4, "receivables": 120000},
                },
            }
        }

        large_payloads: List[List[Dict[str, Any]]] = []

        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
            role: str | None = None,
        ) -> Dict[str, Any]:
            role_name = role or "large"
            if role_name == "small" and not tools:
                return {
                    "model": "mock-small",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"rewritten_query":"请给我当前仪表盘概览",'
                                    '"query_rewrites":{"exact_query":"请给我当前仪表盘概览"},'
                                    '"missing_evidence":[],"retrieval_diagnostics":{"kb_quality":0.82,"coverage":0.7},'
                                    '"notes":["need_live_dashboard"],"final_answer_allowed":false}'
                                )
                            }
                        }
                    ],
                }
            if role_name == "small" and tools:
                has_tool_result = any(item.get("role") == "tool" for item in messages)
                if not has_tool_result:
                    return {
                        "model": "mock-small",
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "tool_calls": [
                                        {
                                            "id": "small-read-1",
                                            "type": "function",
                                            "function": {
                                                "name": "get_dashboard_overview",
                                                "arguments": "{}",
                                            },
                                        }
                                    ],
                                }
                            }
                        ],
                    }
                return {
                    "model": "mock-small",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"tool_summary":"已获取当前仪表盘概览数据",'
                                    '"evidence_notes":["dashboard overview loaded"],'
                                    '"missing_evidence":[],"retrieval_diagnostics":{"kb_quality":0.96,"coverage":0.96},'
                                    '"final_answer_allowed":false}'
                                )
                            }
                        }
                    ],
                }
            if _is_plan_probe(messages, tools):
                return {
                    "model": "mock-large",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"objective":"回答当前仪表盘概览",'
                                    '"steps":["use prefetched dashboard evidence"],'
                                    '"tool_policy":"Only call tools when evidence is missing.",'
                                    '"evidence_targets":["dashboard overview"],'
                                    '"confidence":0.92,"fallback":"local","final_answer_allowed":false}'
                                )
                            }
                        }
                    ],
                }
            if role_name == "large":
                large_payloads.append(messages)
                return {
                    "model": "mock-large",
                    "choices": [{"message": {"content": "当前仪表盘已获取：订单18，库存预警4，应收120000。"}}],
                }
            return {
                "model": "mock-large",
                "choices": [{"message": {"content": "fallback"}}],
            }

        response = await run_chat(
            ChatRequest(
                prompt="把当前仪表盘概览给我",
                userId="usr-dashboard",
                username="admin",
                permissions=["reports.view"],
            ),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        self.assertEqual(response.reply, "当前仪表盘已获取：订单18，库存预警4，应收120000。")
        self.assertEqual([item["name"] for item in self.node_stub.executed_tools], ["get_dashboard_overview"])
        self.assertEqual([item.name for item in response.toolCalls], ["get_dashboard_overview"])
        self.assertTrue(any("small_read_tools_prefetched" in item for item in response.trace))
        self.assertTrue(
            any(
                "Small read-only tool evidence:" in str(item.get("content", ""))
                for messages in large_payloads
                for item in messages
                if isinstance(item, dict) and item.get("role") == "user"
            )
        )

    async def test_small_prefetch_resolution_drops_matching_runtime_gap(self) -> None:
        tool_state = ToolLoopState(
            messages=[],
            tool_calls=[
                ToolCallRecord(
                    name="get_dashboard_overview",
                    status="completed",
                    summary="dashboard ok",
                )
            ],
        )

        remaining = _resolve_gaps_after_small_prefetch(
            [
                {
                    "gap_id": "gap-dashboard",
                    "question": "Need current dashboard overview metrics.",
                    "priority": "high",
                    "recommended_tool": "get_dashboard_overview",
                },
                {
                    "gap_id": "gap-web",
                    "question": "Need official external confirmation.",
                    "priority": "medium",
                    "recommended_tool": "web_search",
                },
            ],
            tool_state,
        )

        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["recommended_tool"], "web_search")

    async def test_layered_runtime_keeps_runtime_gap_when_small_prefetch_fails(self) -> None:
        self.config.ai_layered_agent_enabled = True
        self.config.large_provider = "openai"
        self.config.large_model = "gpt-5.4"
        self.config.large_api_key = "large-key"
        self.config.small_provider = "gemini"
        self.config.small_model = "gemini-2.5-flash"
        self.config.small_api_key = "small-key"
        self.node_stub.tools_schema = [
            {
                "type": "function",
                "metadata": {"access_mode": "read", "origin": "node"},
                "function": {
                    "name": "get_dashboard_overview",
                    "description": "Get dashboard overview KPIs. Permission: reports.view.",
                    "parameters": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {},
                    },
                },
            }
        ]
        self.node_stub.tool_results = {
            "get_dashboard_overview": {
                "toolCall": {"name": "get_dashboard_overview", "status": "completed", "summary": "dashboard loaded"},
                "result": {
                    "ok": True,
                    "code": "ok",
                    "message": "dashboard loaded",
                    "summary": "dashboard loaded",
                    "context": "orders=18, inventory_alerts=4",
                    "data": {"orders": 18, "inventoryAlerts": 4},
                },
            }
        }

        async def fake_request_deepseek(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
            role: str | None = None,
        ) -> Dict[str, Any]:
            role_name = role or "large"
            if role_name == "small" and not tools:
                return {
                    "model": "mock-small",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"rewritten_query":"Show the current dashboard overview with KPI and runtime metrics.",'
                                    '"query_rewrites":{"exact_query":"show me dashboard overview"},'
                                    '"missing_evidence":["Current dashboard runtime metrics are missing","KPI values visible to this user are missing"],'
                                    '"retrieval_diagnostics":{"kb_quality":0.728,"coverage":0.4,"reason":"context_sufficient"},'
                                    '"notes":["need_runtime_dashboard"],"final_answer_allowed":false}'
                                )
                            }
                        }
                    ],
                }
            if role_name == "small" and tools:
                raise RuntimeError(
                    'Invalid JSON payload received. Unknown name "additionalProperties" at '
                    "'tools[0].function_declarations[0].parameters': Cannot find field."
                )
            if _is_plan_probe(messages, tools):
                return {
                    "model": "mock-large",
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"objective":"回答当前仪表盘概览","steps":["get runtime dashboard evidence"],'
                                    '"tool_policy":"Use tools when evidence is missing.",'
                                    '"evidence_targets":["dashboard overview"],'
                                    '"confidence":0.8,"fallback":"local","final_answer_allowed":false}'
                                )
                            }
                        }
                    ],
                }
            if role_name == "large" and tools:
                has_tool_result = any(item.get("role") == "tool" for item in messages if isinstance(item, dict))
                if not has_tool_result:
                    return {"model": "mock-large", "choices": [{"message": {"content": ""}}]}
                return {
                    "model": "mock-large",
                    "choices": [{"message": {"content": "Dashboard loaded: orders 18, inventory alerts 4."}}],
                }
            return {
                "model": "mock-large",
                "choices": [{"message": {"content": "Dashboard loaded: orders 18, inventory alerts 4."}}],
            }

        response = await run_chat(
            ChatRequest(
                prompt="show me dashboard overview",
                userId="usr-dashboard-prefetch-fail",
                username="admin",
                permissions=["reports.view", "inventory.view", "finance.view", "orders.view"],
            ),
            config=self.config,
            node_bridge=self.node_stub,
            rag=self.rag_stub,
            model_requester=fake_request_deepseek,
        )

        self.assertEqual(response.reply, "Dashboard loaded: orders 18, inventory alerts 4.")
        self.assertEqual([item["name"] for item in self.node_stub.executed_tools], ["get_dashboard_overview"])
        self.assertEqual([item.name for item in response.toolCalls], ["get_dashboard_overview"])
        self.assertTrue(any("small read-tool prefetch unavailable" in item for item in response.trace))
        self.assertTrue(any("deterministic fallback triggered tool get_dashboard_overview" in item for item in response.trace))

    def test_build_runtime_initializes_components(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config = AgentConfig(
                deepseek_api_key="test-key",
                data_root=Path(tmpdir),
                rag_lancedb_dir=Path(tmpdir) / "rag" / "lancedb",
            )
            runtime = build_runtime(config)
        self.assertIs(runtime.config, config)
        self.assertIsNotNone(runtime.node_bridge)
        self.assertIsNotNone(runtime.rag)
        self.assertIsNotNone(runtime.profile_memory)
        self.assertIsNotNone(runtime.episodic_memory)
        self.assertIsNotNone(runtime.embedding)


if __name__ == "__main__":
    unittest.main()
