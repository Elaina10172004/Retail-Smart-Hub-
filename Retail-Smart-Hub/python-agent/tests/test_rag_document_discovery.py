from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

try:
    from app.common import AgentConfig
    from app.memory import EpisodicMemoryStore
    from app.rag import EmbeddingClient, RagEngine
    from app.rag_document_utils import discover_documents

    IMPORT_ERROR: Exception | None = None
except ModuleNotFoundError as error:  # pragma: no cover
    AgentConfig = None  # type: ignore[assignment]
    EpisodicMemoryStore = None  # type: ignore[assignment]
    EmbeddingClient = None  # type: ignore[assignment]
    RagEngine = None  # type: ignore[assignment]
    discover_documents = None  # type: ignore[assignment]
    IMPORT_ERROR = error


class RagDocumentDiscoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if IMPORT_ERROR is not None:
            raise unittest.SkipTest(f"python-agent dependencies are missing: {IMPORT_ERROR}")

    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tmpdir.name) / "workspace"
        self.data_root = Path(self.tmpdir.name) / "data"
        (self.workspace / "docs" / "rag" / "knowledge").mkdir(parents=True, exist_ok=True)
        (self.workspace / "docs" / "development").mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def test_discover_documents_supports_all_text_like_knowledge_extensions(self) -> None:
        supported = [
            "docs/rag/knowledge/a.md",
            "docs/rag/knowledge/a.txt",
            "docs/rag/knowledge/a.csv",
            "docs/rag/knowledge/a.json",
            "docs/rag/knowledge/a.yml",
            "docs/rag/knowledge/a.yaml",
        ]
        ignored = [
            "docs/rag/knowledge/a.pdf",
            "docs/rag/knowledge/a.docx",
        ]

        for relative in supported:
            path = self.workspace / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("sample content", encoding="utf-8")

        for relative in ignored:
            path = self.workspace / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("ignored", encoding="utf-8")

        discovered = [
            str(path.relative_to(self.workspace)).replace("\\", "/")
            for path in discover_documents(self.workspace)
        ]

        self.assertEqual(sorted(discovered), sorted(supported))

    def test_doc_chunks_follow_workspace_root_env_and_include_opt_in_docs(self) -> None:
        default_doc = self.workspace / "docs" / "rag" / "knowledge" / "policy.txt"
        default_doc.write_text("inventory policy and reorder thresholds", encoding="utf-8")

        opt_in_doc = self.workspace / "docs" / "development" / "layered-runtime.md"
        opt_in_doc.write_text("layered runtime design and evidence contract", encoding="utf-8")

        rag_root = self.data_root / "rag"
        rag_root.mkdir(parents=True, exist_ok=True)
        (rag_root / "knowledge-document-settings.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "updatedAt": "",
                    "includeInAssistant": {
                        "docs/development/layered-runtime.md": True,
                    },
                }
            ),
            encoding="utf-8",
        )

        previous_workspace_root = os.environ.get("RETAIL_SMART_HUB_WORKSPACE_ROOT")
        os.environ["RETAIL_SMART_HUB_WORKSPACE_ROOT"] = str(self.workspace)
        try:
            config = AgentConfig(
                deepseek_api_key="test-key",
                data_root=self.data_root,
                rag_lancedb_dir=self.data_root / "rag" / "lancedb",
            )
            rag = RagEngine(config, EmbeddingClient(config), EpisodicMemoryStore(config))
            chunks, _signatures, _file_name_map = rag._doc_chunks()
        finally:
            if previous_workspace_root is None:
                os.environ.pop("RETAIL_SMART_HUB_WORKSPACE_ROOT", None)
            else:
                os.environ["RETAIL_SMART_HUB_WORKSPACE_ROOT"] = previous_workspace_root

        citations = [chunk.citation for chunk in chunks]
        self.assertTrue(any("docs/rag/knowledge/policy.txt" in item for item in citations))
        self.assertTrue(any("docs/development/layered-runtime.md" in item for item in citations))
