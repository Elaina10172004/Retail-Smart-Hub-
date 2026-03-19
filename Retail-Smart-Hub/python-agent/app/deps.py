from __future__ import annotations

from typing import Optional

from fastapi import Depends, Header, HTTPException, Request

from .runtime import AgentRuntime


def get_runtime(request: Request) -> AgentRuntime:
    runtime = getattr(request.app.state, "runtime", None)
    if runtime is None:
        raise HTTPException(status_code=500, detail="runtime not initialized")
    return runtime


def require_agent_key(
    x_agent_key: Optional[str] = Header(default=None),
    runtime: AgentRuntime = Depends(get_runtime),
) -> None:
    if not x_agent_key or x_agent_key != runtime.config.shared_key:
        raise HTTPException(status_code=403, detail="invalid agent key")
