"""Manual Gemini smoke check.

This script is intentionally not named test_*.py because it performs live
network calls and can consume provider quota. Run it explicitly when needed:

    python tests/manual_gemini_model_check.py [optional-image-path]
"""
from __future__ import annotations

import asyncio
import base64
import os
import sys
from pathlib import Path

import httpx


def _image_part(path: Path) -> dict[str, object]:
    mime_type = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return {
        "inlineData": {
            "mimeType": mime_type,
            "data": base64.b64encode(path.read_bytes()).decode("ascii"),
        }
    }


async def main() -> int:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        print("GEMINI_API_KEY is required for the manual smoke check.")
        return 2

    model = os.environ.get("GEMINI_VISION_MODEL") or os.environ.get("GEMINI_SMALL_MODEL") or "gemini-2.5-flash"
    image_path = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else None
    parts: list[dict[str, object]] = [{"text": "Reply with one short sentence confirming this request works."}]
    if image_path and image_path.exists():
        parts.append(_image_part(image_path))
        parts[0] = {"text": "What document or object is visible? Reply in one short sentence."}

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            url,
            params={"key": api_key},
            json={"contents": [{"role": "user", "parts": parts}], "generationConfig": {"maxOutputTokens": 80}},
        )

    print(f"status={response.status_code} model={model}")
    if response.status_code != 200:
        print(response.text[:1000])
        return 1

    payload = response.json()
    text = (
        payload.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text", "")
    )
    print(text.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
