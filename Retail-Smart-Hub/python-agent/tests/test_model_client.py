from __future__ import annotations

from unittest import TestCase

from app.model_client import (
    _build_gemini_contents,
    _build_gemini_tools,
    _normalize_openai_messages,
    _summarize_model_io_payload,
    _translate_gemini_response,
)


class ModelClientTests(TestCase):
    def test_normalize_openai_messages_flattens_custom_image_content(self) -> None:
        messages = _normalize_openai_messages(
            [
                {
                    "role": "user",
                    "content": {
                        "text": "Describe this image.",
                        "images": [
                            {
                                "file_name": "shelf.png",
                                "mime_type": "image/png",
                                "data_url": "data:image/png;base64,QUJD",
                            }
                        ],
                    },
                }
            ]
        )

        self.assertEqual(messages[0]["role"], "user")
        self.assertIn("Describe this image.", messages[0]["content"])
        self.assertIn("shelf.png", messages[0]["content"])

    def test_build_gemini_contents_supports_image_and_function_roundtrip(self) -> None:
        contents, system_instruction = _build_gemini_contents(
            [
                {"role": "system", "content": "system prompt"},
                {
                    "role": "user",
                    "content": {
                        "text": "What is shown here?",
                        "images": [
                            {
                                "file_name": "rack.png",
                                "mime_type": "image/png",
                                "data_url": "data:image/png;base64,QUJD",
                            }
                        ],
                    },
                },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": "web_search",
                                "arguments": '{"query":"retail demand"}',
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call-1",
                    "content": '{"ok":true,"summary":"done"}',
                },
            ]
        )

        self.assertEqual(system_instruction, "system prompt")
        self.assertEqual(contents[0]["role"], "user")
        self.assertEqual(contents[0]["parts"][0]["text"], "What is shown here?")
        self.assertEqual(contents[0]["parts"][1]["inlineData"]["mimeType"], "image/png")
        self.assertEqual(contents[1]["parts"][0]["functionCall"]["name"], "web_search")
        self.assertEqual(contents[2]["parts"][0]["functionResponse"]["name"], "web_search")
        self.assertEqual(contents[2]["parts"][0]["functionResponse"]["id"], "call-1")

    def test_translate_gemini_response_maps_function_calls_and_text(self) -> None:
        payload = _translate_gemini_response(
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {"text": "Current stock looks healthy."},
                                {
                                    "functionCall": {
                                        "name": "web_search",
                                        "args": {"query": "warehouse shortage news"},
                                        "id": "tool-7",
                                    }
                                },
                            ]
                        }
                    }
                ]
            },
            model="gemini-2.5-flash",
        )

        choice = payload["choices"][0]["message"]
        self.assertEqual(choice["content"], "Current stock looks healthy.")
        self.assertEqual(choice["tool_calls"][0]["id"], "tool-7")
        self.assertEqual(choice["tool_calls"][0]["function"]["name"], "web_search")
        self.assertIn("warehouse shortage news", choice["tool_calls"][0]["function"]["arguments"])
        self.assertEqual(len(choice["provider_parts"]), 2)

    def test_build_gemini_tools_strips_additional_properties_recursively(self) -> None:
        tools = _build_gemini_tools(
            [
                {
                    "type": "function",
                    "function": {
                        "name": "get_dashboard_overview",
                        "description": "dashboard",
                        "parameters": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "focus": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "properties": {
                                        "name": {"type": "string"},
                                    },
                                }
                            },
                        },
                    },
                }
            ]
        )

        parameters = tools[0]["functionDeclarations"][0]["parameters"]
        self.assertNotIn("additionalProperties", parameters)
        self.assertNotIn("additionalProperties", parameters["properties"]["focus"])

    def test_model_io_summary_omits_tool_schema_and_keeps_chat_preview(self) -> None:
        summary = _summarize_model_io_payload(
            phase="request",
            payload={
                "provider": "gemini",
                "model": "gemini-3-flash-preview",
                "endpoint": "https://example.invalid",
                "message_count": 2,
                "tool_count": 1,
                "tool_choice": "auto",
                "payload": {
                    "contents": [
                        {"role": "user", "parts": [{"text": "帮我看一下仪表盘概览。"}]},
                    ],
                    "systemInstruction": {"parts": [{"text": "Never answer the user."}]},
                    "tools": [
                        {
                            "functionDeclarations": [
                                {
                                    "name": "get_dashboard_overview",
                                    "parameters": {
                                        "type": "object",
                                        "additionalProperties": False,
                                        "properties": {"focus": {"type": "string"}},
                                    },
                                }
                            ]
                        }
                    ],
                },
            },
            max_chars=0,
        )

        self.assertIn("system: Never answer the user.", summary)
        self.assertIn("user: 帮我看一下仪表盘概览。", summary)
        self.assertIn("tools: get_dashboard_overview", summary)
        self.assertNotIn("functionDeclarations", summary)
        self.assertNotIn("additionalProperties", summary)

    def test_model_io_summary_formats_function_calls_without_raw_schema_dump(self) -> None:
        summary = _summarize_model_io_payload(
            phase="response",
            payload={
                "provider": "openai",
                "model": "gpt-5.4",
                "status_code": 200,
                "response": {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "call-1",
                                        "type": "function",
                                        "function": {
                                            "name": "get_dashboard_overview",
                                            "arguments": "{}",
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 5,
                        "total_tokens": 15,
                    },
                },
            },
            max_chars=0,
        )

        self.assertIn("assistant -> tool get_dashboard_overview: {}", summary)
        self.assertIn("finish_reason: tool_calls", summary)
        self.assertIn("usage: prompt=10 completion=5 total=15", summary)
        self.assertNotIn("\"function\"", summary)
