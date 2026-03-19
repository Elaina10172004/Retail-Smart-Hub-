from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from app.common import AgentConfig
    from app.models import AttachmentInput, ChatRequest, HistoryItem
    from app.node_bridge import NodeToolBridge, _build_tool_history
    IMPORT_ERROR: Exception | None = None
except ModuleNotFoundError as error:  # pragma: no cover
    AgentConfig = None  # type: ignore[assignment]
    AttachmentInput = None  # type: ignore[assignment]
    ChatRequest = None  # type: ignore[assignment]
    HistoryItem = None  # type: ignore[assignment]
    NodeToolBridge = None  # type: ignore[assignment]
    _build_tool_history = None  # type: ignore[assignment]
    IMPORT_ERROR = error


class CaptureBridge(NodeToolBridge):
    def __init__(self, config: AgentConfig) -> None:
        super().__init__(config)
        self.last_path: Optional[str] = None
        self.last_body: Optional[Dict[str, Any]] = None

    async def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        self.last_path = path
        self.last_body = body
        if path == "/tools/execute":
            return {
                "execution": {
                    "toolCall": {"name": "list_orders", "status": "completed", "summary": "ok"},
                    "result": {"ok": True},
                }
            }
        if path == "/document/handle":
            return {"result": {"handled": False}}
        if path == "/document/context":
            return {"context": ""}
        return {}


class NodeBridgePayloadTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if IMPORT_ERROR is not None:
            raise unittest.SkipTest(f"python-agent dependencies are missing: {IMPORT_ERROR}")

    async def asyncSetUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        config = AgentConfig(
            deepseek_api_key="test-key",
            data_root=Path(self.tmpdir.name),
            rag_lancedb_dir=Path(self.tmpdir.name) / "rag" / "lancedb",
        )
        self.bridge = CaptureBridge(config)

    async def asyncTearDown(self) -> None:
        self.tmpdir.cleanup()

    async def test_build_tool_history_omits_blank_content_and_invalid_tool_calls(self) -> None:
        request = ChatRequest(
            prompt="next",
            userId="u-1",
            username="tester",
            history=[
                HistoryItem(role="assistant", content="   "),
                HistoryItem(
                    role="assistant",
                    content="previous answer",
                    toolCalls=[
                        {"name": "list_orders", "status": "completed", "summary": "done"},
                        {"name": "bad", "status": "unknown", "summary": "x"},
                        {"name": "", "status": "completed", "summary": "x"},
                    ],
                    pendingActionStatus="pending",
                ),
            ],
        )

        history = _build_tool_history(request)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["content"], "previous answer")
        self.assertEqual(len(history[0].get("toolCalls", [])), 1)
        self.assertEqual(history[0]["toolCalls"][0]["name"], "list_orders")
        self.assertEqual(history[0]["pendingActionStatus"], "pending")

    async def test_execute_tool_payload_does_not_include_none_fields(self) -> None:
        request = ChatRequest(
            prompt="query orders",
            userId="u-2",
            username="tester",
            history=[
                HistoryItem(role="user", content="show orders"),
                HistoryItem(role="assistant", content="  "),
            ],
        )

        await self.bridge.execute_tool("list_orders", '{"limit":1}', request)
        assert self.bridge.last_body is not None
        payload_history = self.bridge.last_body["request"]["history"]
        self.assertEqual(len(payload_history), 1)
        self.assertEqual(payload_history[0]["content"], "show orders")
        self.assertNotIn("toolCalls", payload_history[0])
        self.assertNotIn("pendingActionId", payload_history[0])

    async def test_document_bridge_payload_omits_attachment_none_fields(self) -> None:
        request = ChatRequest(
            prompt="import this",
            userId="u-3",
            username="tester",
            attachments=[
                AttachmentInput(
                    fileName="customers.csv",
                    target="customer",
                    rows=[{"customerName": "A"}],
                )
            ],
        )

        await self.bridge.handle_document_skill(request)
        assert self.bridge.last_body is not None
        self.assertEqual(self.bridge.last_path, "/document/handle")
        first_attachment = self.bridge.last_body["attachments"][0]
        self.assertNotIn("id", first_attachment)
        self.assertEqual(first_attachment["fileName"], "customers.csv")

    async def test_document_bridge_payload_preserves_document_blocks_and_sheets(self) -> None:
        request = ChatRequest(
            prompt="analyze attachments",
            userId="u-4",
            username="tester",
            attachments=[
                AttachmentInput(
                    id="att-doc-1",
                    fileName="handbook.pdf",
                    kind="document",
                    textContent="Warehouse handbook overview",
                    blocks=[
                        {
                            "blockId": "page-1",
                            "type": "page",
                            "text": "Receiving checklist on page 1",
                            "locator": {"page": 1},
                        }
                    ],
                ),
                AttachmentInput(
                    fileName="inventory.xlsx",
                    kind="workbook",
                    sheetCount=2,
                    sheets=[
                        {
                            "name": "Stock",
                            "rowCount": 1,
                            "headers": ["sku", "quantity"],
                            "rows": [{"sku": "SKU-1001", "quantity": 12}],
                        }
                    ],
                ),
            ],
        )

        await self.bridge.build_document_context(request)
        assert self.bridge.last_body is not None
        self.assertEqual(self.bridge.last_path, "/document/context")
        attachments = self.bridge.last_body["attachments"]
        self.assertEqual(attachments[0]["blocks"][0]["locator"]["page"], 1)
        self.assertEqual(attachments[1]["sheets"][0]["name"], "Stock")
        self.assertEqual(attachments[1]["kind"], "workbook")
