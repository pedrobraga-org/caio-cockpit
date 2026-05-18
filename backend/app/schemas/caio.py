"""Response schemas for the read-only Caio bridges API and mark_only decisions."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

CaioBridgeStatus = Literal["ok", "error", "disabled", "circuit_open", "timeout"]
CaioDecisionKind = Literal["approve", "reject"]


class CaioEventDecisionRead(BaseModel):
    """A decision Pedro has marked against a Caio event (mark_only)."""

    decision: CaioDecisionKind
    decided_at: datetime
    decided_by_user_id: UUID
    note: str | None = None


class CaioEventItem(BaseModel):
    """A single Caio Think Loop / Reflexion event from ``events.sqlite``."""

    event_id: str
    occurred_at: str = Field(description="ISO-8601 timestamp from the producer.")
    event_type: str
    source: str
    producer_id: str
    correlation_id: str | None = None
    thread_id: str | None = None
    payload: Any = Field(
        default=None,
        description="Decoded JSON payload. May be ``None`` if the row was unparsable.",
    )
    decision: CaioEventDecisionRead | None = Field(
        default=None,
        description=(
            "Cockpit-local mark_only decision, if Pedro has already marked this "
            "event. Recording a decision NEVER triggers any downstream side effect."
        ),
    )


class CaioRecentEventsResponse(BaseModel):
    """Response envelope: status + diagnostics + items."""

    status: CaioBridgeStatus
    error_class: str | None = Field(
        default=None,
        description="Set only when ``status`` is ``error`` or ``timeout``.",
    )
    latency_ms: int = 0
    items: list[CaioEventItem] = Field(default_factory=list)


class CaioDecisionRequest(BaseModel):
    """Payload for marking a Caio event as approved/rejected (mark_only)."""

    event_id: str = Field(min_length=1, max_length=255)
    decision: CaioDecisionKind
    note: str | None = Field(default=None, max_length=2000)


class CaioDecisionResponse(BaseModel):
    """Outcome of a mark_only decision write."""

    event_id: str
    decision: CaioDecisionKind
    decided_at: datetime
    decided_by_user_id: UUID
    note: str | None = None
    # Sanity flag for the UI: confirms the server is in mark_only mode and
    # nothing downstream was dispatched.
    mode: Literal["mark_only"] = "mark_only"
