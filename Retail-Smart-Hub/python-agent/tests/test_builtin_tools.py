from __future__ import annotations

from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

from app.builtin_tools import build_builtin_tool_definitions, execute_builtin_tool, has_builtin_tool
from app.common import AgentConfig


class BuiltinToolsTests(IsolatedAsyncioTestCase):
    def test_web_search_definition_only_exists_when_tavily_is_configured(self) -> None:
        disabled = AgentConfig(tavily_api_key="")
        enabled = AgentConfig(tavily_api_key="test-key")

        self.assertFalse(has_builtin_tool(disabled, "web_search"))
        self.assertEqual(build_builtin_tool_definitions(disabled), [])

        definitions = build_builtin_tool_definitions(enabled)
        self.assertTrue(has_builtin_tool(enabled, "web_search"))
        self.assertEqual(len(definitions), 1)
        self.assertEqual(definitions[0]["function"]["name"], "web_search")

    async def test_execute_web_search_returns_normalized_tavily_payload(self) -> None:
        config = AgentConfig(tavily_api_key="test-key")
        with patch(
            "app.builtin_tools._search_tavily",
            return_value={
                "answer": "Market demand remains resilient.",
                "results": [
                    {
                        "title": "Demand report",
                        "url": "https://example.com/report",
                        "content": "Demand rose year over year.",
                        "score": 0.92,
                    }
                ],
            },
        ):
            result = await execute_builtin_tool(config, "web_search", '{"query":"warehouse demand"}')

        self.assertEqual(result["toolCall"]["name"], "web_search")
        self.assertEqual(result["toolCall"]["status"], "completed")
        self.assertIn("Market demand", result["toolCall"]["summary"])
        self.assertEqual(result["result"]["code"], "ok")
        self.assertEqual(result["result"]["data"]["query"], "warehouse demand")
        self.assertEqual(len(result["result"]["data"]["results"]), 1)

    async def test_execute_web_search_rejects_missing_query(self) -> None:
        config = AgentConfig(tavily_api_key="test-key")
        result = await execute_builtin_tool(config, "web_search", "{}")

        self.assertEqual(result["toolCall"]["status"], "disabled")
        self.assertEqual(result["result"]["code"], "invalid_arguments")
