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
    # Caio-owned lifecycle: ``started_at`` set when Caio picks the work up,
    # ``completed_at`` set when Caio finishes the real-world action. The UI
    # routes cards across To Do / In Progress / Done from these timestamps.
    started_at: datetime | None = None
    completed_at: datetime | None = None


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
    started_at: datetime | None = None
    completed_at: datetime | None = None
    # Sanity flag for the UI: confirms the server is in mark_only mode and
    # nothing downstream was dispatched.
    mode: Literal["mark_only"] = "mark_only"


class CaioCritiqueItem(BaseModel):
    """A single Reflexion-loop critique from ``critiques.sqlite``.

    ``action`` is kept as a free ``str`` (not a ``Literal``) so the schema does
    not have to be redeployed if reflexion-tick.sh starts emitting new action
    labels. ``raw_llm_response`` is intentionally omitted: forensic-only column
    that may carry MB of LLM debug output.
    """

    id: int
    generated_at: str = Field(description="ISO-8601 timestamp from the reflexion run.")
    approval_log_id: int
    jid: str | None = None
    action: str = Field(
        description="Caio's classification of the action under review "
        "(e.g. ``replaced``, ``rejected``, ``manual_override``)."
    )
    contact_message: str | None = None
    caio_suggestion: str | None = None
    final_response: str | None = None
    miss: str | None = Field(
        default=None,
        description="What Caio's suggestion got wrong, in his own words.",
    )
    hit: str | None = Field(
        default=None,
        description="What Pedro did better in the actual response.",
    )
    pattern: str | None = Field(
        default=None,
        description="Generalizable rule Caio extracted from the miss/hit gap.",
    )
    confidence: float | None = Field(
        default=None,
        description="Caio's self-rated confidence in the pattern (0-1).",
    )


class CaioCritiquesWindow(BaseModel):
    """Diagnostic info on the time window the response covers."""

    since_days: int
    since_iso: str | None = None
    total_returned: int


class CaioRecentCritiquesResponse(BaseModel):
    """Response envelope: bridge status + items + window diagnostics."""

    status: CaioBridgeStatus
    error_class: str | None = Field(
        default=None,
        description="Set only when ``status`` is ``error`` or ``timeout``.",
    )
    latency_ms: int = 0
    items: list[CaioCritiqueItem] = Field(default_factory=list)
    window: CaioCritiquesWindow


class CaioWaContactStats(BaseModel):
    """Per-contact engagement stats from ``caio_approval_log``."""

    jid: str
    contact_name: str | None = None
    total: int
    approved: int
    replaced: int
    manual_override: int
    rejected: int
    blocked: int
    engaged: int = Field(
        description="approved + replaced + manual_override — Pedro acted on it."
    )
    engagement_rate: float | None = Field(
        default=None,
        description="engaged / total. ``None`` if total is zero (filtered out).",
    )
    avg_approval_time_s: float | None = None
    last_interaction_at: str | None = None


class CaioWaWindow(BaseModel):
    """Roll-up over the queried window (not just the surfaced contacts)."""

    days: int
    min_interactions: int
    total_interactions: int
    engaged_interactions: int
    engagement_rate: float | None = None
    distinct_contacts: int


class CaioWaApprovalsResponse(BaseModel):
    """Response envelope for /api/v1/caio/wa/recent-approvals."""

    status: CaioBridgeStatus
    error_class: str | None = None
    latency_ms: int = 0
    window: CaioWaWindow | None = None
    contacts: list[CaioWaContactStats] = Field(default_factory=list)
