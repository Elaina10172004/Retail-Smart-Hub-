from __future__ import annotations

from app.api import create_app, run_chat
from app.model_client import request_deepseek
from app.runtime import AgentRuntime, build_runtime

app = create_app()

__all__ = [
    "AgentRuntime",
    "app",
    "build_runtime",
    "create_app",
    "request_deepseek",
    "run_chat",
]


if __name__ == "__main__":
    import uvicorn

    runtime = build_runtime()
    uvicorn.run(
        create_app(runtime=runtime, model_requester=request_deepseek),
        host=runtime.config.host,
        port=runtime.config.port,
        reload=False,
        log_level="info",
    )
