from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List

try:
    from app.common import AgentConfig
    from app.evidence_pack import add_context_evidence, init_evidence_pack
    from app.orchestration_helpers import ContextBundle, build_model_messages
    from app.planner_executor_sm import (
        PlannerState,
        _build_deterministic_tool_args,
        _pick_deterministic_tool_name,
        run_planner_executor,
    )
    from app.router_gate import route_request
    from app.small_context_engine import build_small_context
    from app.models import AttachmentBlock, AttachmentInput, AttachmentLocator, AttachmentSheet, ChatRequest

    IMPORT_ERROR: Exception | None = None
except ModuleNotFoundError as error:  # pragma: no cover
    AgentConfig = None  # type: ignore[assignment]
    ContextBundle = None  # type: ignore[assignment]
    ChatRequest = None  # type: ignore[assignment]
    AttachmentInput = None  # type: ignore[assignment]
    AttachmentSheet = None  # type: ignore[assignment]
    AttachmentBlock = None  # type: ignore[assignment]
    AttachmentLocator = None  # type: ignore[assignment]
    build_model_messages = None  # type: ignore[assignment]
    route_request = None  # type: ignore[assignment]
    build_small_context = None  # type: ignore[assignment]
    run_planner_executor = None  # type: ignore[assignment]
    init_evidence_pack = None  # type: ignore[assignment]
    add_context_evidence = None  # type: ignore[assignment]
    PlannerState = None  # type: ignore[assignment]
    _build_deterministic_tool_args = None  # type: ignore[assignment]
    _pick_deterministic_tool_name = None  # type: ignore[assignment]
    IMPORT_ERROR = error


def _build_context(chunks: List[Dict[str, Any]] | None = None) -> ContextBundle:
    return ContextBundle(
        profile_payload={"profile": {}, "records": []},
        profile_context="No profile facts",
        chunks=chunks or [],
        citations=[str(item.get("citation", "")) for item in (chunks or []) if item.get("citation")],
        knowledge_context=" ".join(str(item.get("content", "")) for item in (chunks or [])),
        attachment_context="No attachments",
        skill_context="No skills",
        matched_skill_names=[],
        tools=[],
        retrieval_mode="hybrid",
    )


def _is_plan_probe(messages: List[Dict[str, Any]], tools: List[Dict[str, Any]] | None) -> bool:
    if tools:
        return False
    for item in messages:
        if item.get("role") != "user":
            continue
        if "MODE=PLAN" in str(item.get("content", "")):
            return True
    return False


def _mock_plan_response() -> Dict[str, Any]:
    return {
        "model": "mock-model",
        "choices": [
            {
                "message": {
                    "content": (
                        '{"objective":"test objective","steps":["s1","s2"],'
                        '"tool_policy":"tools when missing evidence",'
                        '"evidence_targets":["gap-web-evidence"],'
                        '"confidence":0.7,"fallback":"local","final_answer_allowed":false}'
                    )
                }
            }
        ],
    }


class LayeredRuntimeTests(unittest.IsolatedAsyncioTestCase):
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
            ai_layered_agent_enabled=True,
            ai_layered_max_execute_rounds=3,
            ai_layered_context_char_budget=12000,
        )
        self.request = ChatRequest(
            prompt="please analyze revenue and booked revenue",
            userId="u-layered",
            username="tester",
        )

    async def asyncTearDown(self) -> None:
        self.tmpdir.cleanup()

    async def test_plan_phase_has_no_tool_calls(self) -> None:
        context = _build_context()
        decision = route_request(self.request, rag_chunk_count=0, has_attachments=False)
        small = build_small_context(request=self.request, context=context, decision=decision, char_budget=12000)
        pack = init_evidence_pack(request=self.request, decision=decision, small_context=small)
        add_context_evidence(pack, context=context, small_context=small)

        async def model_requester(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            if _is_plan_probe(messages, tools):
                return _mock_plan_response()
            return {"model": "mock-model", "choices": [{"message": {"content": "final"}}]}

        async def tool_executor(tool_name: str, raw_arguments: str, request: ChatRequest) -> Dict[str, Any]:
            raise RuntimeError("should not execute tool")

        messages = build_model_messages(
            self.request,
            small.profile_context,
            small.knowledge_context,
            small.attachment_context,
            small.skill_context,
            history_messages_override=small.history,
        )
        runtime_state = await run_planner_executor(
            request=self.request,
            config=self.config,
            model_requester=model_requester,
            tool_executor=tool_executor,
            decision=decision,
            small_context=small,
            messages=messages,
            tools=[],
            evidence_pack=pack,
            trace=[],
        )

        self.assertEqual(runtime_state.phase, PlannerState.DONE)
        self.assertEqual(runtime_state.tool_state.tool_calls, [])
        self.assertTrue(any("PLAN phase" in item for item in runtime_state.trace))

    async def test_execute_only_runs_tools_for_missing_or_weak_evidence(self) -> None:
        tool_exec_count = 0

        async def model_requester(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            if _is_plan_probe(messages, tools):
                return _mock_plan_response()
            if tools:
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
                                        "function": {"name": "web_search", "arguments": "{\"q\":\"booked revenue\"}"},
                                    }
                                ],
                            }
                        }
                    ],
                }
            return {"model": "mock-model", "choices": [{"message": {"content": "done"}}]}

        async def tool_executor(tool_name: str, raw_arguments: str, request: ChatRequest) -> Dict[str, Any]:
            nonlocal tool_exec_count
            tool_exec_count += 1
            return {
                "toolCall": {"name": tool_name, "status": "completed", "summary": "ok"},
                "result": {"ok": True, "code": "ok", "summary": "resolved", "context": "resolved", "data": {"ok": True}},
            }

        tools = [{"type": "function", "function": {"name": "web_search"}}]
        context = _build_context(
            [
                {
                    "docTitle": "KB",
                    "citation": "docs/rag/knowledge/业务规则与接口说明.md",
                    "content": "booked revenue definition",
                    "score": 0.95,
                }
            ]
        )
        decision = route_request(self.request, rag_chunk_count=1, has_attachments=False)
        small = build_small_context(request=self.request, context=context, decision=decision, char_budget=12000)
        small.missing_evidence = []
        small.retrieval_diagnostics["kb_quality"] = 0.95
        pack = init_evidence_pack(request=self.request, decision=decision, small_context=small)
        add_context_evidence(pack, context=context, small_context=small)
        messages = build_model_messages(
            self.request,
            small.profile_context,
            small.knowledge_context,
            small.attachment_context,
            small.skill_context,
            history_messages_override=small.history,
        )

        runtime_state_strong = await run_planner_executor(
            request=self.request,
            config=self.config,
            model_requester=model_requester,
            tool_executor=tool_executor,
            decision=decision,
            small_context=small,
            messages=messages,
            tools=tools,
            evidence_pack=pack,
            trace=[],
        )
        self.assertEqual(tool_exec_count, 0)
        self.assertEqual(runtime_state_strong.phase, PlannerState.DONE)
        self.assertFalse(runtime_state_strong.tool_state.tool_calls)

        weak_small = small.model_copy(deep=True)
        weak_small.missing_evidence = [
            {
                "gap_id": "gap-web-evidence",
                "question": "need authoritative mapping",
                "priority": "high",
                "recommended_tool": "web_search",
            }
        ]
        weak_small.retrieval_diagnostics["kb_quality"] = 0.3
        weak_pack = init_evidence_pack(request=self.request, decision=decision, small_context=weak_small)
        add_context_evidence(weak_pack, context=context, small_context=weak_small)
        weak_messages = build_model_messages(
            self.request,
            weak_small.profile_context,
            weak_small.knowledge_context,
            weak_small.attachment_context,
            weak_small.skill_context,
            history_messages_override=weak_small.history,
        )

        runtime_state_weak = await run_planner_executor(
            request=self.request,
            config=self.config,
            model_requester=model_requester,
            tool_executor=tool_executor,
            decision=decision,
            small_context=weak_small,
            messages=weak_messages,
            tools=tools,
            evidence_pack=weak_pack,
            trace=[],
        )
        self.assertGreater(tool_exec_count, 0)
        self.assertGreaterEqual(len(runtime_state_weak.tool_state.tool_calls), 1)

    async def test_attachment_evidence_uses_locator_backed_document_and_table_sources(self) -> None:
        request = ChatRequest(
            prompt="summarize uploaded files",
            userId="u-layered",
            username="tester",
            attachments=[
                AttachmentInput(
                    id="att-doc-1",
                    fileName="warehouse-manual.pdf",
                    kind="document",
                    blocks=[
                        AttachmentBlock(
                            blockId="page-1",
                            type="page",
                            text="Receiving checklist: verify carton count before putaway.",
                            locator=AttachmentLocator(page=1, blockId="page-1"),
                        )
                    ],
                ),
                AttachmentInput(
                    id="att-xlsx-1",
                    fileName="inventory.xlsx",
                    kind="workbook",
                    sheetCount=2,
                    sheets=[
                        AttachmentSheet(
                            name="Stock",
                            rowCount=1,
                            headers=["sku", "quantity"],
                            rows=[{"sku": "SKU-1001", "quantity": 12}],
                        ),
                        AttachmentSheet(
                            name="Reorder",
                            rowCount=1,
                            headers=["sku", "reorderPoint"],
                            rows=[{"sku": "SKU-1001", "reorderPoint": 8}],
                        ),
                    ],
                ),
            ],
        )
        context = _build_context()
        decision = route_request(request, rag_chunk_count=0, has_attachments=True)
        small = build_small_context(request=request, context=context, decision=decision, char_budget=12000)
        pack = init_evidence_pack(request=request, decision=decision, small_context=small)
        add_context_evidence(pack, context=context, small_context=small)

        self.assertTrue(small.attachment_evidence)
        self.assertTrue(any(source.source_type == "attachment_document" for source in pack.sources))
        self.assertTrue(any(source.source_type == "attachment_table" for source in pack.sources))
        self.assertTrue(any(source.locator.get("page") == 1 for source in pack.sources if source.source_type == "attachment_document"))
        self.assertTrue(any(source.locator.get("sheet_name") == "Stock" for source in pack.sources if source.source_type == "attachment_table"))
        self.assertTrue(any(item.support_type == "attachment_block" for item in pack.evidence_items))
        self.assertTrue(any(item.support_type == "attachment_table_view" for item in pack.evidence_items))

    async def test_missing_evidence_survives_empty_results(self) -> None:
        context = _build_context()
        decision = route_request(self.request, rag_chunk_count=1, has_attachments=False)
        small = build_small_context(request=self.request, context=context, decision=decision, char_budget=12000)
        small.missing_evidence = [
            {
                "gap_id": "gap-web-evidence",
                "question": "need authoritative mapping",
                "priority": "high",
                "recommended_tool": "web_search",
            }
        ]
        pack = init_evidence_pack(request=self.request, decision=decision, small_context=small)
        add_context_evidence(pack, context=context, small_context=small)

        call_count = 0

        async def model_requester(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            if _is_plan_probe(messages, tools):
                return _mock_plan_response()
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
                                        "id": "call-empty",
                                        "type": "function",
                                        "function": {"name": "web_search", "arguments": "{\"q\":\"definition\"}"},
                                    }
                                ],
                            }
                        }
                    ],
                }
            return {"model": "mock-model", "choices": [{"message": {"content": "done"}}]}

        async def tool_executor(tool_name: str, raw_arguments: str, request: ChatRequest) -> Dict[str, Any]:
            return {
                "toolCall": {"name": tool_name, "status": "completed", "summary": "empty"},
                "result": {"ok": True, "code": "ok", "summary": "empty", "context": "", "data": {}},
            }

        messages = build_model_messages(
            self.request,
            small.profile_context,
            small.knowledge_context,
            small.attachment_context,
            small.skill_context,
            history_messages_override=small.history,
        )
        runtime_state = await run_planner_executor(
            request=self.request,
            config=self.config,
            model_requester=model_requester,
            tool_executor=tool_executor,
            decision=decision,
            small_context=small,
            messages=messages,
            tools=[{"type": "function", "function": {"name": "web_search"}}],
            evidence_pack=pack,
            trace=[],
        )

        self.assertTrue(runtime_state.evidence_pack.missing_evidence)
        self.assertTrue(any("missing_evidence unresolved" in item for item in runtime_state.trace))

    async def test_missing_evidence_can_trigger_deterministic_fallback_when_model_skips_tool_call(self) -> None:
        context = _build_context()
        decision = route_request(self.request, rag_chunk_count=0, has_attachments=False)
        decision.route = "web_only"
        decision.web_fallback_allowed = True
        small = build_small_context(request=self.request, context=context, decision=decision, char_budget=12000)
        small.missing_evidence = [
            {
                "gap_id": "gap-web-evidence",
                "question": "need authoritative mapping",
                "priority": "high",
                "recommended_tool": "web_search",
            }
        ]
        pack = init_evidence_pack(request=self.request, decision=decision, small_context=small)
        add_context_evidence(pack, context=context, small_context=small)

        tool_exec_count = 0

        async def model_requester(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            if _is_plan_probe(messages, tools):
                return _mock_plan_response()
            if tools:
                return {"model": "mock-model", "choices": [{"message": {"content": ""}}]}
            return {"model": "mock-model", "choices": [{"message": {"content": "done"}}]}

        async def tool_executor(tool_name: str, raw_arguments: str, request: ChatRequest) -> Dict[str, Any]:
            nonlocal tool_exec_count
            tool_exec_count += 1
            return {
                "toolCall": {"name": tool_name, "status": "completed", "summary": "resolved"},
                "result": {"ok": True, "code": "ok", "summary": "resolved", "context": "resolved", "data": {"ok": True}},
            }

        messages = build_model_messages(
            self.request,
            small.profile_context,
            small.knowledge_context,
            small.attachment_context,
            small.skill_context,
            history_messages_override=small.history,
        )
        runtime_state = await run_planner_executor(
            request=self.request,
            config=self.config,
            model_requester=model_requester,
            tool_executor=tool_executor,
            decision=decision,
            small_context=small,
            messages=messages,
            tools=[{"type": "function", "function": {"name": "web_search"}}],
            evidence_pack=pack,
            trace=[],
        )

        self.assertGreaterEqual(tool_exec_count, 1)
        self.assertTrue(any("deterministic fallback triggered" in item for item in runtime_state.trace))

    async def test_dashboard_deterministic_fallback_uses_empty_args_for_optional_schema(self) -> None:
        context = _build_context()
        decision = route_request(self.request, rag_chunk_count=0, has_attachments=False)
        small = build_small_context(request=self.request, context=context, decision=decision, char_budget=12000)

        args = _build_deterministic_tool_args(
            "get_dashboard_overview",
            small,
            [
                {
                    "type": "function",
                    "function": {
                        "name": "get_dashboard_overview",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "focus": {"type": "string"},
                            },
                        },
                    },
                }
            ],
        )

        self.assertEqual(args, "{}")

    async def test_deterministic_fallback_can_identify_web_tool_candidate(self) -> None:
        tool_name = _pick_deterministic_tool_name(
            missing_evidence=[
                {
                    "gap_id": "gap-web-evidence",
                    "question": "Need fresh evidence from web/official sources.",
                    "priority": "high",
                    "recommended_tool": "web_search",
                }
            ],
            tools=[{"type": "function", "function": {"name": "web_search"}}],
            web_fallback_allowed=False,
        )

        self.assertEqual(tool_name, "web_search")

    async def test_image_missing_evidence_does_not_fallback_to_text_web_search(self) -> None:
        request = ChatRequest(
            prompt="图片内容是什么",
            userId="u-image-fallback",
            username="tester",
            attachments=[
                AttachmentInput(
                    id="img-1",
                    fileName="witch.webp",
                    kind="image",
                    mimeType="image/webp",
                    imageWidth=576,
                    imageHeight=1080,
                    imageDataUrl="data:image/webp;base64,QUJD",
                )
            ],
        )
        context = _build_context()
        decision = route_request(request, rag_chunk_count=0, has_attachments=True)
        small = build_small_context(request=request, context=context, decision=decision, char_budget=12000)
        small.missing_evidence = [
            {
                "gap_id": "gap-image-analysis",
                "question": "need image understanding or OCR before final answer",
                "priority": "high",
                "recommended_tool": "image_understanding",
            }
        ]
        pack = init_evidence_pack(request=request, decision=decision, small_context=small)
        add_context_evidence(pack, context=context, small_context=small)

        tool_exec_count = 0

        async def model_requester(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            if _is_plan_probe(messages, tools):
                return _mock_plan_response()
            return {"model": "mock-model", "choices": [{"message": {"content": "answer from existing image evidence"}}]}

        async def tool_executor(tool_name: str, raw_arguments: str, request: ChatRequest) -> Dict[str, Any]:
            nonlocal tool_exec_count
            tool_exec_count += 1
            return {
                "toolCall": {"name": tool_name, "status": "completed", "summary": "resolved"},
                "result": {"ok": True, "code": "ok", "summary": "resolved", "context": "resolved", "data": {"ok": True}},
            }

        messages = build_model_messages(
            request,
            small.profile_context,
            small.knowledge_context,
            small.attachment_context,
            small.skill_context,
            history_messages_override=small.history,
        )
        runtime_state = await run_planner_executor(
            request=request,
            config=self.config,
            model_requester=model_requester,
            tool_executor=tool_executor,
            decision=decision,
            small_context=small,
            messages=messages,
            tools=[{"type": "function", "function": {"name": "web_search"}}],
            evidence_pack=pack,
            trace=[],
        )

        self.assertEqual(tool_exec_count, 0)
        self.assertEqual(runtime_state.tool_state.reply, "answer from existing image evidence")
        self.assertTrue(
            any("image-related evidence gaps may not use text web search" in item for item in runtime_state.trace)
        )

    async def test_high_noise_tool_output_is_repacked(self) -> None:
        context = _build_context()
        decision = route_request(self.request, rag_chunk_count=1, has_attachments=False)
        small = build_small_context(request=self.request, context=context, decision=decision, char_budget=12000)
        small.missing_evidence = [
            {
                "gap_id": "gap-web-evidence",
                "question": "need authoritative mapping",
                "priority": "high",
                "recommended_tool": "web_search",
            }
        ]
        pack = init_evidence_pack(request=self.request, decision=decision, small_context=small)
        add_context_evidence(pack, context=context, small_context=small)

        call_count = 0

        async def model_requester(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            if _is_plan_probe(messages, tools):
                return _mock_plan_response()
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
                                        "id": "call-noise",
                                        "type": "function",
                                        "function": {"name": "web_search", "arguments": "{\"q\":\"definition\"}"},
                                    }
                                ],
                            }
                        }
                    ],
                }
            return {"model": "mock-model", "choices": [{"message": {"content": "done"}}]}

        async def tool_executor(tool_name: str, raw_arguments: str, request: ChatRequest) -> Dict[str, Any]:
            noisy_context = "line\n" * 300
            return {
                "toolCall": {"name": tool_name, "status": "completed", "summary": noisy_context},
                "result": {
                    "ok": True,
                    "code": "ok",
                    "summary": noisy_context,
                    "context": noisy_context,
                    "data": {"raw": noisy_context},
                },
            }

        messages = build_model_messages(
            self.request,
            small.profile_context,
            small.knowledge_context,
            small.attachment_context,
            small.skill_context,
            history_messages_override=small.history,
        )
        runtime_state = await run_planner_executor(
            request=self.request,
            config=self.config,
            model_requester=model_requester,
            tool_executor=tool_executor,
            decision=decision,
            small_context=small,
            messages=messages,
            tools=[{"type": "function", "function": {"name": "web_search"}}],
            evidence_pack=pack,
            trace=[],
        )

        self.assertTrue(any("repacked" in item.lower() for item in runtime_state.trace))
        tool_evidence = [item for item in runtime_state.evidence_pack.evidence_items if item.support_type == "tool_result"]
        self.assertTrue(tool_evidence)
        self.assertTrue(any(bool(item.metadata.get("repacked")) for item in tool_evidence))

    async def test_high_noise_tool_output_uses_planner_mode_and_emits_answer_meta(self) -> None:
        context = _build_context()
        decision = route_request(self.request, rag_chunk_count=1, has_attachments=False)
        small = build_small_context(request=self.request, context=context, decision=decision, char_budget=12000)
        small.missing_evidence = [
            {
                "gap_id": "gap-web-evidence",
                "question": "need authoritative mapping",
                "priority": "high",
                "recommended_tool": "web_search",
            }
        ]
        pack = init_evidence_pack(request=self.request, decision=decision, small_context=small)
        add_context_evidence(pack, context=context, small_context=small)

        call_count = 0
        roles: List[str] = []
        events: List[tuple[str, Dict[str, Any]]] = []

        async def model_requester(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
            role: str | None = None,
        ) -> Dict[str, Any]:
            if _is_plan_probe(messages, tools):
                roles.append(role or "large")
                return _mock_plan_response()
            nonlocal call_count
            call_count += 1
            roles.append(role or "large")
            if call_count == 1:
                return {
                    "model": "mock-model",
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "call-noise",
                                        "type": "function",
                                        "function": {"name": "web_search", "arguments": "{\"q\":\"definition\"}"},
                                    }
                                ],
                            }
                        }
                    ],
                }
            return {"model": "mock-model", "choices": [{"message": {"content": "done"}}]}

        async def tool_executor(tool_name: str, raw_arguments: str, request: ChatRequest) -> Dict[str, Any]:
            noisy_context = "line\n" * 300
            return {
                "toolCall": {"name": tool_name, "status": "completed", "summary": noisy_context},
                "result": {
                    "ok": True,
                    "code": "ok",
                    "summary": noisy_context,
                    "context": noisy_context,
                    "data": {"raw": noisy_context},
                },
            }

        def debug_hook(event: str, payload: Dict[str, Any]) -> None:
            events.append((event, dict(payload)))

        messages = build_model_messages(
            self.request,
            small.profile_context,
            small.knowledge_context,
            small.attachment_context,
            small.skill_context,
            history_messages_override=small.history,
        )
        runtime_state = await run_planner_executor(
            request=self.request,
            config=self.config,
            model_requester=model_requester,
            tool_executor=tool_executor,
            decision=decision,
            small_context=small,
            messages=messages,
            tools=[{"type": "function", "function": {"name": "web_search"}}],
            evidence_pack=pack,
            trace=[],
            debug_hook=debug_hook,
        )

        self.assertEqual(runtime_state.phase, PlannerState.DONE)
        self.assertTrue(runtime_state.plan)
        self.assertTrue(all(item.startswith("PLAN phase:") for item in runtime_state.plan))
        self.assertTrue(any("PLAN phase" in item for item in runtime_state.trace))
        self.assertTrue(any("ANSWER phase" in item for item in runtime_state.trace))
        self.assertTrue(any("repacked" in item.lower() for item in runtime_state.trace))
        self.assertTrue(events)
        self.assertEqual(events[0][0], "plan")
        self.assertEqual(events[-1][0], "answer")
        self.assertNotIn("reply_preview", events[0][1])
        answer_meta = events[-1][1]
        self.assertIn("reply_preview", answer_meta)
        self.assertIn("tool_calls", answer_meta)
        self.assertIn("remaining_gaps", answer_meta)
        self.assertGreaterEqual(int(answer_meta["tool_calls"]), 1)
        self.assertEqual(roles[0], "large")
        self.assertIn("small", roles)
        self.assertEqual(roles.count("small"), 1)
        self.assertGreaterEqual(roles.count("large"), 2)

    async def test_malformed_tool_payload_becomes_execution_error(self) -> None:
        context = _build_context()
        decision = route_request(self.request, rag_chunk_count=1, has_attachments=False)
        small = build_small_context(request=self.request, context=context, decision=decision, char_budget=12000)
        small.missing_evidence = [
            {
                "gap_id": "gap-tool",
                "question": "need tool result",
                "priority": "high",
                "recommended_tool": "web_search",
            }
        ]
        pack = init_evidence_pack(request=self.request, decision=decision, small_context=small)
        add_context_evidence(pack, context=context, small_context=small)

        call_count = 0

        async def model_requester(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            if _is_plan_probe(messages, tools):
                return _mock_plan_response()
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
                                        "function": {"name": "web_search", "arguments": "{\"q\":\"x\"}"},
                                    }
                                ],
                            }
                        }
                    ],
                }
            return {"model": "mock-model", "choices": [{"message": {"content": "done"}}]}

        async def tool_executor(tool_name: str, raw_arguments: str, request: ChatRequest) -> Dict[str, Any]:
            return {"bad": "payload"}

        messages = build_model_messages(
            self.request,
            small.profile_context,
            small.knowledge_context,
            small.attachment_context,
            small.skill_context,
            history_messages_override=small.history,
        )
        runtime_state = await run_planner_executor(
            request=self.request,
            config=self.config,
            model_requester=model_requester,
            tool_executor=tool_executor,
            decision=decision,
            small_context=small,
            messages=messages,
            tools=[{"type": "function", "function": {"name": "web_search"}}],
            evidence_pack=pack,
            trace=[],
        )

        self.assertTrue(runtime_state.tool_state.tool_calls)
        self.assertEqual(runtime_state.tool_state.tool_calls[0].status, "disabled")
        self.assertIn("execution", runtime_state.tool_state.tool_calls[0].summary.lower())

    async def test_schema_failure_blocks_execution_and_records_fallback_diagnostic(self) -> None:
        context = _build_context()
        decision = route_request(self.request, rag_chunk_count=0, has_attachments=False)
        small = build_small_context(request=self.request, context=context, decision=decision, char_budget=12000)
        small.missing_evidence = [
            {
                "gap_id": "gap-schema",
                "question": "need schema to run tool",
                "priority": "high",
                "recommended_tool": "web_search",
            }
        ]
        pack = init_evidence_pack(request=self.request, decision=decision, small_context=small)
        add_context_evidence(pack, context=context, small_context=small)

        call_count = 0

        async def model_requester(
            config: AgentConfig,
            messages: List[Dict[str, Any]],
            *,
            tools: List[Dict[str, Any]] | None = None,
            tool_choice: str | None = None,
        ) -> Dict[str, Any]:
            if _is_plan_probe(messages, tools):
                return _mock_plan_response()
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
                                        "id": "call-schema",
                                        "type": "function",
                                        "function": {"name": "web_search", "arguments": "{\"q\":\"x\"}"},
                                    }
                                ],
                            }
                        }
                    ],
                }
            return {"model": "mock-model", "choices": [{"message": {"content": "done"}}]}

        async def tool_executor(tool_name: str, raw_arguments: str, request: ChatRequest) -> Dict[str, Any]:
            raise RuntimeError("should not execute when schema is unavailable")

        messages = build_model_messages(
            self.request,
            small.profile_context,
            small.knowledge_context,
            small.attachment_context,
            small.skill_context,
            history_messages_override=small.history,
        )
        runtime_state = await run_planner_executor(
            request=self.request,
            config=self.config,
            model_requester=model_requester,
            tool_executor=tool_executor,
            decision=decision,
            small_context=small,
            messages=messages,
            tools=[],
            evidence_pack=pack,
            trace=["Tool schema fetch failed: schema unavailable"],
        )

        self.assertEqual(runtime_state.tool_state.tool_calls, [])
        self.assertTrue(any("Tool schema fetch failed" in item for item in runtime_state.trace))
        self.assertTrue(any("tool_calls ignored" in item for item in runtime_state.trace))


if __name__ == "__main__":
    unittest.main()
