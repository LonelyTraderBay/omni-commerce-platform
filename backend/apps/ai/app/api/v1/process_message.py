import hmac
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.config import settings
from app.domain.orchestrator import ProcessMessageOrchestrator
from app.infra.core import CoreKnowledgeClient
from app.infra.embeddings.factory import create_embedding_provider
from app.infra.llm.factory import create_llm_provider
from app.infra.llm.spend import LlmSpendTracker

router = APIRouter(prefix="/internal/v1")

orchestrator = ProcessMessageOrchestrator(
    embedding_provider=create_embedding_provider(),
    retriever=CoreKnowledgeClient(),
    llm_provider=create_llm_provider(),
    quota_client=CoreKnowledgeClient(),
    core_tools_client=CoreKnowledgeClient(),
    spend_budget=LlmSpendTracker(),
)


class ProcessMessageRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    org_id: UUID = Field(alias="orgId")
    message: str = Field(min_length=1, max_length=10_000)
    top_k: int = Field(default=5, alias="topK", ge=1, le=20)
    model: str | None = Field(default=None, max_length=100)
    conversation_id: UUID | None = Field(default=None, alias="conversationId")
    contact_id: UUID | None = Field(default=None, alias="contactId")
    message_id: UUID | None = Field(default=None, alias="messageId")
    channel: str | None = Field(default=None, max_length=64)
    channel_connection_id: UUID | None = Field(
        default=None,
        alias="channelConnectionId",
    )


@router.post("/ai/process-message")
def process_message(
    body: ProcessMessageRequest,
    x_service_key: str | None = Header(default=None),
):
    if not hmac.compare_digest(x_service_key or "", settings.service_m2m_key):
        raise HTTPException(status_code=401, detail="invalid service key")

    try:
        return orchestrator.process_message(
            org_id=str(body.org_id),
            message=body.message,
            top_k=body.top_k,
            model=body.model,
            conversation_id=str(body.conversation_id) if body.conversation_id else None,
            contact_id=str(body.contact_id) if body.contact_id else None,
            message_id=str(body.message_id) if body.message_id else None,
            channel=body.channel,
            channel_connection_id=(
                str(body.channel_connection_id) if body.channel_connection_id else None
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
