"""Read-only Cockpit endpoints surfacing Caio operational data + mark_only decisions.

Per plano canônico V1.1 the Cockpit is **read-only** against Caio's pipelines.
Approve/reject here is ``mark_only``: it records Pedro's verdict in the Cockpit
DB and never dispatches anything to Caio's events.sqlite, the WhatsApp webhook
V3 Postgres, or the OpenClaw gateway.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.auth import AuthContext, get_auth_context
from app.core.config import settings
from app.core.logging import get_logger
from app.db.session import get_session
from app.models.caio_decisions import CaioEventDecision
from app.schemas.caio import (
    CaioDecisionRequest,
    CaioDecisionResponse,
    CaioEventDecisionRead,
    CaioEventItem,
    CaioRecentEventsResponse,
)
from app.services.caio_bridge import EventsSqliteReader

logger = get_logger(__name__)
router = APIRouter(prefix="/caio", tags=["caio"])

AUTH_CONTEXT_DEP = Depends(get_auth_context)
SESSION_DEP = Depends(get_session)
LIMIT_QUERY = Query(default=20, ge=1, le=200)


@lru_cache(maxsize=1)
def _events_reader() -> EventsSqliteReader:
    state_dir = settings.caio_state_dir.strip()
    enabled = settings.caio_bridge_events_enabled and bool(state_dir)
    # When disabled or unconfigured we still construct the reader so the
    # endpoint can report a consistent "disabled" status without 500s.
    db_path = Path(state_dir) / "events.sqlite" if state_dir else Path("/dev/null/events.sqlite")
    return EventsSqliteReader(
        db_path=db_path,
        enabled=enabled,
        timeout_s=settings.caio_bridge_timeout_s,
    )


async def _load_decisions(
    session: AsyncSession,
    event_ids: list[str],
) -> dict[str, CaioEventDecision]:
    """Return ``{event_id: CaioEventDecision}`` for the given ids (empty if none)."""
    if not event_ids:
        return {}
    statement = select(CaioEventDecision).where(
        col(CaioEventDecision.event_id).in_(event_ids),
    )
    rows = (await session.exec(statement)).all()
    return {row.event_id: row for row in rows}


def _decision_read(row: CaioEventDecision) -> CaioEventDecisionRead:
    return CaioEventDecisionRead(
        decision=row.decision,  # type: ignore[arg-type]
        decided_at=row.decided_at,
        decided_by_user_id=row.decided_by_user_id,
        note=row.note,
    )


@router.get(
    "/think-loop/recent",
    response_model=CaioRecentEventsResponse,
    summary="Recent Caio Think Loop events",
    description=(
        "Return the most recent Caio events (Think Loop proposals, policy "
        "decisions, advisor consults, reflexion critiques). Each item is "
        "enriched with the Cockpit-local mark_only decision (if any) so the UI "
        "can render approve/reject state without an extra round trip."
    ),
)
async def recent_think_loop_events(
    limit: int = LIMIT_QUERY,
    _auth: AuthContext = AUTH_CONTEXT_DEP,
    session: AsyncSession = SESSION_DEP,
) -> CaioRecentEventsResponse:
    reader = _events_reader()
    result = await reader.recent_events(limit=limit)

    raw_items: list[dict[str, object]] = (
        list(result.data) if result.status == "ok" and result.data else []
    )
    event_ids = [str(item.get("event_id")) for item in raw_items if item.get("event_id")]
    decisions = await _load_decisions(session, event_ids)

    items: list[CaioEventItem] = []
    for raw in raw_items:
        ev_id = str(raw.get("event_id"))
        decision_row = decisions.get(ev_id)
        items.append(
            CaioEventItem(
                event_id=ev_id,
                occurred_at=str(raw.get("occurred_at", "")),
                event_type=str(raw.get("event_type", "")),
                source=str(raw.get("source", "")),
                producer_id=str(raw.get("producer_id", "")),
                correlation_id=raw.get("correlation_id"),  # type: ignore[arg-type]
                thread_id=raw.get("thread_id"),  # type: ignore[arg-type]
                payload=raw.get("payload"),
                decision=_decision_read(decision_row) if decision_row else None,
            ),
        )

    return CaioRecentEventsResponse(
        status=result.status,
        error_class=result.error_class,
        latency_ms=result.latency_ms,
        items=items,
    )


@router.post(
    "/think-loop/decisions",
    response_model=CaioDecisionResponse,
    status_code=status.HTTP_200_OK,
    summary="Mark a Caio event as approved/rejected (mark_only)",
    description=(
        "Records Pedro's verdict on a Caio Think Loop event in the Cockpit DB. "
        "**No downstream side effects** are dispatched: Caio's events.sqlite, "
        "the WhatsApp webhook V3 Postgres, the OpenClaw gateway, and the "
        "#wa-aprovacoes Discord channel are all untouched. V1.1 enforces "
        "`COCKPIT_APPROVE_MODE=mark_only`; any other value is rejected at "
        "startup. Re-POSTing the same `event_id` updates the existing row "
        "(decision, note, decider) — useful for changing your mind."
    ),
)
async def mark_think_loop_decision(
    payload: CaioDecisionRequest,
    auth: AuthContext = AUTH_CONTEXT_DEP,
    session: AsyncSession = SESSION_DEP,
) -> CaioDecisionResponse:
    # Defense-in-depth: even though the setting is locked to "mark_only" in
    # config, refuse explicitly if someone overrode it via env at runtime.
    if settings.cockpit_approve_mode != "mark_only":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Cockpit V1.1 only supports COCKPIT_APPROVE_MODE=mark_only. "
                f"Got {settings.cockpit_approve_mode!r}."
            ),
        )
    if auth.user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    existing = (
        await session.exec(
            select(CaioEventDecision).where(
                col(CaioEventDecision.event_id) == payload.event_id,
            ),
        )
    ).one_or_none()

    if existing is not None:
        existing.decision = payload.decision
        existing.note = payload.note
        existing.decided_by_user_id = auth.user.id
        # decided_at is *not* refreshed on update: keep the original "first
        # marked" timestamp; UI can show a separate "edited" timestamp later if
        # needed. Keeping it stable avoids feed reshuffling.
        session.add(existing)
        await session.commit()
        await session.refresh(existing)
        row = existing
    else:
        row = CaioEventDecision(
            event_id=payload.event_id,
            decision=payload.decision,
            decided_by_user_id=auth.user.id,
            note=payload.note,
        )
        session.add(row)
        try:
            await session.commit()
        except IntegrityError:
            # Race: someone else inserted between our SELECT and INSERT. Reload
            # and apply the requested decision on top (last-writer-wins).
            await session.rollback()
            existing = (
                await session.exec(
                    select(CaioEventDecision).where(
                        col(CaioEventDecision.event_id) == payload.event_id,
                    ),
                )
            ).one()
            existing.decision = payload.decision
            existing.note = payload.note
            existing.decided_by_user_id = auth.user.id
            session.add(existing)
            await session.commit()
            await session.refresh(existing)
            row = existing
        else:
            await session.refresh(row)

    logger.info(
        "caio.decision.marked event_id=%s decision=%s user_id=%s mode=%s",
        row.event_id,
        row.decision,
        row.decided_by_user_id,
        settings.cockpit_approve_mode,
    )

    return CaioDecisionResponse(
        event_id=row.event_id,
        decision=row.decision,  # type: ignore[arg-type]
        decided_at=row.decided_at,
        decided_by_user_id=row.decided_by_user_id,
        note=row.note,
    )
