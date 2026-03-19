from __future__ import annotations

from dataclasses import dataclass

from .common import AgentConfig, build_config
from .memory import EpisodicMemoryStore, ProfileMemoryStore
from .node_bridge import NodeToolBridge
from .rag import EmbeddingClient, RagEngine


@dataclass
class AgentRuntime:
    config: AgentConfig
    node_bridge: NodeToolBridge
    rag: RagEngine
    profile_memory: ProfileMemoryStore
    episodic_memory: EpisodicMemoryStore
    embedding: EmbeddingClient


def build_runtime(config: AgentConfig | None = None) -> AgentRuntime:
    resolved_config = config or build_config()
    profile_memory = ProfileMemoryStore(resolved_config)
    episodic_memory = EpisodicMemoryStore(resolved_config)
    embedding = EmbeddingClient(resolved_config)
    rag = RagEngine(resolved_config, embedding, episodic_memory)
    node_bridge = NodeToolBridge(resolved_config)
    return AgentRuntime(
        config=resolved_config,
        node_bridge=node_bridge,
        rag=rag,
        profile_memory=profile_memory,
        episodic_memory=episodic_memory,
        embedding=embedding,
    )
