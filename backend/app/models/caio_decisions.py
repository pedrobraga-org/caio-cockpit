"""Cockpit-local 'mark_only' decisions on Caio Think Loop events.

Per plano canônico V1.1 (CRITICAL #4): the Cockpit *only* records that
Pedro has marked a Caio event as approved or rejected. It does **not**
execute any downstream action against Caio's pipelines, the OpenClaw gateway,
or the #wa-aprovacoes Discord channel. V2 will reintroduce an explicit
``mark_and_execute`` mode behind feature gating, after a proper idempotency +
audit + rollback path is in place.

The ``event_id`` we key on is the Caio event UUID written to
``~/.openclaw/state/events.sqlite`` (the same identifier the
``EventsSqliteReader`` surfaces in ``/api/v1/caio/think-loop/recent``).
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlmodel import Field

from app.core.time import utcnow
from app.models.base import QueryModel


class CaioEventDecision(QueryModel, table=True):
    """Pedro's mark_only verdict on a single Caio Think Loop event."""

    __tablename__ = "caio_event_decisions"  # pyright: ignore[reportAssignmentType]

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    # Caio events.sqlite UUID — globally unique, the natural foreign key
    # we don't enforce at the DB level (cross-database).
    event_id: str = Field(index=True, unique=True)
    # "approve" | "reject" — enforced at the API layer (Literal).
    decision: str
    decided_at: datetime = Field(default_factory=utcnow)
    decided_by_user_id: UUID = Field(foreign_key="users.id", index=True)
    note: str | None = None
