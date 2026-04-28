from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

class HistoryItem(BaseModel):
    role: str
    content: str
    toolCalls: Optional[List[Dict[str, Any]]] = None
    pendingActionId: Optional[str] = None
    pendingActionName: Optional[str] = None
    pendingActionStatus: Optional[str] = None


class ResumeInput(BaseModel):
    interruptionId: str
    optionId: str
    prompt: Optional[str] = None


class AttachmentLocator(BaseModel):
    attachmentId: Optional[str] = None
    fileName: Optional[str] = None
    kind: Optional[str] = None
    page: Optional[int] = None
    paragraph: Optional[int] = None
    sectionTitle: Optional[str] = None
    headingPath: List[str] = Field(default_factory=list)
    blockId: Optional[str] = None
    sheetName: Optional[str] = None
    rowStart: Optional[int] = None
    rowEnd: Optional[int] = None
    columnStart: Optional[int] = None
    columnEnd: Optional[int] = None
    cellRange: Optional[str] = None
    charStart: Optional[int] = None
    charEnd: Optional[int] = None


class AttachmentBlock(BaseModel):
    blockId: str
    type: str = "paragraph"
    text: str
    title: Optional[str] = None
    locator: AttachmentLocator = Field(default_factory=AttachmentLocator)


class AttachmentSheet(BaseModel):
    name: str
    rowCount: int = 0
    headers: List[str] = Field(default_factory=list)
    rows: List[Dict[str, Any]] = Field(default_factory=list)


class AttachmentInput(BaseModel):
    id: Optional[str] = None
    fileName: str
    target: str = "auto"
    kind: Optional[str] = None
    mimeType: Optional[str] = None
    imageDataUrl: Optional[str] = None
    imageWidth: Optional[int] = None
    imageHeight: Optional[int] = None
    rowCount: int = 0
    rows: List[Dict[str, Any]] = Field(default_factory=list)
    sheetCount: int = 0
    sheets: List[AttachmentSheet] = Field(default_factory=list)
    textContent: Optional[str] = None
    blocks: List[AttachmentBlock] = Field(default_factory=list)


class ChatRequest(BaseModel):
    prompt: str = ""
    conversationId: Optional[str] = None
    resume: Optional[ResumeInput] = None
    userId: str
    tenantId: Optional[str] = None
    username: str
    roles: List[str] = Field(default_factory=list)
    permissions: List[str] = Field(default_factory=list)
    token: str = ""
    attachments: List[AttachmentInput] = Field(default_factory=list)
    history: List[HistoryItem] = Field(default_factory=list)
    conversationMessages: Optional[List[Dict[str, Any]]] = None


class AgentPlan(BaseModel):
    objective: str = ""
    mode: str = "answer"
    needs_tools: bool = False
    needs_confirmation: bool = False
    tool_names: List[str] = Field(default_factory=list)
    steps: List[str] = Field(default_factory=list)
    missing_evidence: List[str] = Field(default_factory=list)


class ToolCallRecord(BaseModel):
    name: str
    status: str
    summary: str


class MemoryCaptureOutcome(BaseModel):
    captured: bool
    owner: str
    reason: Optional[str] = None
    error: Optional[str] = None


class AnswerMeta(BaseModel):
    used_evidence_ids: List[str] = Field(default_factory=list)
    unresolved_gaps: List[str] = Field(default_factory=list)
    confidence: str = "low"
    confidence_score: float = 0.0


class ClarificationOption(BaseModel):
    id: str
    label: str
    prompt: str
    description: Optional[str] = None


class ClarificationCard(BaseModel):
    title: str
    message: str
    options: List[ClarificationOption] = Field(default_factory=list)


class InterruptionState(BaseModel):
    id: str
    kind: str = "clarification"
    status: str = "awaiting_user"
    title: str
    message: str
    options: List[ClarificationOption] = Field(default_factory=list)


class WebSource(BaseModel):
    title: str
    url: str
    snippet: Optional[str] = None
    sourceType: Optional[str] = None
    publishedDate: Optional[str] = None
    score: Optional[float] = None


class ChatResponse(BaseModel):
    reply: str
    toolCalls: List[ToolCallRecord] = Field(default_factory=list)
    citations: List[str] = Field(default_factory=list)
    webSources: List[WebSource] = Field(default_factory=list)
    pendingAction: Optional[Dict[str, Any]] = None
    approval: Optional[Dict[str, Any]] = None
    clarification: Optional[ClarificationCard] = None
    interruption: Optional[InterruptionState] = None
    memoryCapture: Optional[MemoryCaptureOutcome] = None
    answer_meta: Optional[AnswerMeta] = None
    reasoningContent: Optional[str] = None
    configured: bool = False
    provider: str = "deepseek"
    model: str = ""
    note: Optional[str] = None
    trace: List[str] = Field(default_factory=list)
    conversationMessages: Optional[List[Dict[str, Any]]] = None


class RagRebuildRequest(BaseModel):
    force: bool = False
    incremental: bool = True


class MemoryProfileQuery(BaseModel):
    token: str = ""
    scope: str = "effective"
    tenantId: Optional[str] = None
    userId: Optional[str] = None
    sessionId: Optional[str] = None


class MemoryFactsQuery(BaseModel):
    token: str = ""
    scope: str = "user"
    tenantId: Optional[str] = None
    userId: Optional[str] = None
    sessionId: Optional[str] = None
    limit: int = 30


class MemoryProfilePatchRequest(BaseModel):
    token: str = ""
    scope: str
    tenantId: Optional[str] = None
    userId: Optional[str] = None
    sessionId: Optional[str] = None
    patch: Dict[str, Any] = Field(default_factory=dict)
    updatedBy: str = "system"


class MemoryFactDeleteRequest(BaseModel):
    token: str = ""
    id: str
    scope: str = "user"
    tenantId: Optional[str] = None
    userId: Optional[str] = None
    sessionId: Optional[str] = None


class StatusRequest(BaseModel):
    token: str = ""

