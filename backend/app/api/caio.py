"""Read-only Cockpit endpoints surfacing Caio operational data + mark_only decisions.

Per plano canônico V1.1 the Cockpit is **read-only** against Caio's pipelines.
Approve/reject here is ``mark_only``: it records Pedro's verdict in the Cockpit
DB and never dispatches anything to Caio's events.sqlite, the WhatsApp webhook
V3 Postgres, or the OpenClaw gateway.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from hmac import compare_digest

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.auth import AuthContext, get_auth_context
from app.core.config import settings
from app.core.logging import get_logger
from app.core.worker_auth import get_user_or_worker_auth_context
from app.db.session import get_session
from app.models.caio_decisions import CaioEventDecision
from app.schemas.caio import (
    CaioCritiqueItem,
    CaioCritiquesWindow,
    CaioDecisionRequest,
    CaioDecisionResponse,
    CaioEventDecisionRead,
    CaioEventItem,
    CaioRecentCritiquesResponse,
    CaioRecentEventsResponse,
    CaioWaApprovalsResponse,
    CaioWaContactStats,
    CaioWaWindow,
)
from app.services.caio_bridge import (
    CritiquesSqliteReader,
    EventsSqliteReader,
    WebhookPostgresReader,
)

logger = get_logger(__name__)
router = APIRouter(prefix="/caio", tags=["caio"])

AUTH_CONTEXT_DEP = Depends(get_auth_context)
# /think-loop/decisions/{id}/start and /complete accept EITHER a CF Access JWT
# (user) OR an X-Cockpit-Worker-Token header (cockpit_bridge worker). In
# cf_access mode the worker can't obtain a CF Access JWT, so this widened
# dependency is the only auth path mounted on those 2 endpoints.
WORKER_AUTH_DEP = Depends(get_user_or_worker_auth_context)
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


@lru_cache(maxsize=1)
def _critiques_reader() -> CritiquesSqliteReader:
    state_dir = settings.caio_state_dir.strip()
    enabled = settings.caio_bridge_critiques_enabled and bool(state_dir)
    db_path = (
        Path(state_dir) / "critiques.sqlite"
        if state_dir
        else Path("/dev/null/critiques.sqlite")
    )
    return CritiquesSqliteReader(
        db_path=db_path,
        enabled=enabled,
        timeout_s=settings.caio_bridge_timeout_s,
    )


SINCE_DAYS_QUERY = Query(default=30, ge=1, le=365)
CRITIQUES_LIMIT_QUERY = Query(default=50, ge=1, le=500)

WA_DAYS_QUERY = Query(default=7, ge=1, le=365)
WA_MIN_INTERACTIONS_QUERY = Query(default=1, ge=1, le=1000)
WA_LIMIT_QUERY = Query(default=50, ge=1, le=500)


@lru_cache(maxsize=1)
def _wa_reader() -> WebhookPostgresReader:
    dsn = settings.webhook_database_url.strip()
    enabled = settings.caio_bridge_wa_enabled and bool(dsn)
    return WebhookPostgresReader(
        dsn=dsn,
        enabled=enabled,
        timeout_s=settings.caio_bridge_wa_timeout_s,
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
        started_at=row.started_at,
        completed_at=row.completed_at,
        discord_message_id=row.discord_message_id,
        discord_channel_id=row.discord_channel_id,
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
    request: Request,
    payload: CaioDecisionRequest,
    auth: AuthContext = WORKER_AUTH_DEP,
    session: AsyncSession = SESSION_DEP,
) -> CaioDecisionResponse:
    """Record Pedro's verdict on a Caio Think Loop event.

    Auth: accepts both CF Access user (Cockpit UI) AND
    ``X-Cockpit-Worker-Token`` (Discord ``#caio-aprovacoes`` reaction bot).
    Fase A treats decisions as **terminal**: first call wins. Same-decision
    re-POSTs are idempotent. Conflicting re-POSTs return ``409``. When the
    worker token is used (bot path), ``discord_message_id`` is required.
    """
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

    # Detect bot path: if the request authenticated via the worker token
    # header, require Discord metadata. CF Access (user) path may omit it.
    presented_worker_token = (
        request.headers.get("X-Cockpit-Worker-Token") or ""
    ).strip()
    expected_worker_token = (settings.cockpit_worker_token or "").strip()
    via_worker_token = bool(
        presented_worker_token
        and expected_worker_token
        and compare_digest(presented_worker_token, expected_worker_token)
    )
    if via_worker_token and not payload.discord_message_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "discord_message_id is required when calling /decisions with "
                "the worker token (bot path)."
            ),
        )

    # INSERT-first: UNIQUE(event_id) makes terminal-decision atomic. If INSERT
    # succeeds we kept the first decision. On IntegrityError, re-SELECT and
    # apply Fase A's first-wins rule: idempotent on match, 409 on conflict.
    row: CaioEventDecision = CaioEventDecision(
        event_id=payload.event_id,
        decision=payload.decision,
        decided_by_user_id=auth.user.id,
        note=payload.note,
        discord_message_id=payload.discord_message_id,
        discord_channel_id=payload.discord_channel_id,
    )
    session.add(row)
    try:
        await session.commit()
        await session.refresh(row)
    except IntegrityError:
        await session.rollback()
        existing = (
            await session.exec(
                select(CaioEventDecision).where(
                    col(CaioEventDecision.event_id) == payload.event_id,
                ),
            )
        ).one_or_none()
        if existing is None:
            # The IntegrityError was NOT the event_id unique conflict; re-raise
            # so the framework returns an honest 500.
            raise
        same_decision = existing.decision == payload.decision
        # Compatible discord metadata: incoming None never conflicts; both None
        # is fine; both equal is fine. Differing non-null values conflict.
        compatible_msg = (
            payload.discord_message_id is None
            or existing.discord_message_id is None
            or existing.discord_message_id == payload.discord_message_id
        )
        if same_decision and compatible_msg:
            row = existing
        else:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"event_id={payload.event_id!r} already has terminal "
                    f"decision={existing.decision!r}"
                    + (
                        f" via discord_message_id={existing.discord_message_id}"
                        if existing.discord_message_id
                        else ""
                    )
                    + ". Fase A treats first decision as terminal."
                ),
            )

    logger.info(
        "caio.decision.marked event_id=%s decision=%s user_id=%s via=%s mode=%s",
        row.event_id,
        row.decision,
        row.decided_by_user_id,
        "worker_token" if via_worker_token else "user_auth",
        settings.cockpit_approve_mode,
    )

    return CaioDecisionResponse(
        event_id=row.event_id,
        decision=row.decision,  # type: ignore[arg-type]
        decided_at=row.decided_at,
        decided_by_user_id=row.decided_by_user_id,
        note=row.note,
        started_at=row.started_at,
        completed_at=row.completed_at,
        discord_message_id=row.discord_message_id,
        discord_channel_id=row.discord_channel_id,
    )


@router.post(
    "/think-loop/decisions/{event_id}/start",
    response_model=CaioDecisionResponse,
    summary="Caio reports it picked up an approved action (To Do -> In Progress)",
    description=(
        "Called by Caio's runtime (not by Pedro) when it begins working on an "
        "approved Cockpit decision. Idempotent: re-POSTing for an already-"
        "started event is a no-op. 409 if no decision exists or the decision "
        "is not 'approve'. Still mark_only at the Cockpit layer; the actual "
        "real-world side effect belongs to Caio's own pipelines."
    ),
)
async def start_think_loop_decision(
    event_id: str,
    auth: AuthContext = WORKER_AUTH_DEP,
    session: AsyncSession = SESSION_DEP,
) -> CaioDecisionResponse:
    if auth.user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    existing = (
        await session.exec(
            select(CaioEventDecision).where(
                col(CaioEventDecision.event_id) == event_id,
            ),
        )
    ).one_or_none()

    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No decision exists for this event_id; approve it first.",
        )
    if existing.decision != "approve":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Cannot start: recorded decision is "
                f"{existing.decision!r}, not 'approve'."
            ),
        )

    if existing.started_at is None:
        existing.started_at = datetime.now(tz=timezone.utc)
        session.add(existing)
        await session.commit()
        await session.refresh(existing)

    logger.info(
        "caio.decision.started event_id=%s user_id=%s",
        existing.event_id,
        existing.decided_by_user_id,
    )

    return CaioDecisionResponse(
        event_id=existing.event_id,
        decision=existing.decision,  # type: ignore[arg-type]
        decided_at=existing.decided_at,
        decided_by_user_id=existing.decided_by_user_id,
        note=existing.note,
        started_at=existing.started_at,
        completed_at=existing.completed_at,
    )


@router.post(
    "/think-loop/decisions/{event_id}/complete",
    response_model=CaioDecisionResponse,
    summary="Mark an approved Caio decision as actually done in the real world",
    description=(
        "Pedro approved a Caio event (e.g. 'send this reply on WhatsApp') and "
        "has now finished doing it himself. This flips ``completed_at`` so the "
        "UI moves the card from the To Do bucket to Done. Still mark_only — "
        "nothing is dispatched. Idempotent: re-POSTing for an already-completed "
        "event is a no-op and returns the existing row. 409 if no decision "
        "exists, or if the recorded decision is not 'approve'."
    ),
)
async def complete_think_loop_decision(
    event_id: str,
    auth: AuthContext = WORKER_AUTH_DEP,
    session: AsyncSession = SESSION_DEP,
) -> CaioDecisionResponse:
    if auth.user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    existing = (
        await session.exec(
            select(CaioEventDecision).where(
                col(CaioEventDecision.event_id) == event_id,
            ),
        )
    ).one_or_none()

    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No decision exists for this event_id; approve it first.",
        )
    if existing.decision != "approve":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Cannot complete: recorded decision is "
                f"{existing.decision!r}, not 'approve'."
            ),
        )

    if existing.completed_at is None:
        existing.completed_at = datetime.now(tz=timezone.utc)
        session.add(existing)
        await session.commit()
        await session.refresh(existing)

    logger.info(
        "caio.decision.completed event_id=%s user_id=%s",
        existing.event_id,
        existing.decided_by_user_id,
    )

    return CaioDecisionResponse(
        event_id=existing.event_id,
        decision=existing.decision,  # type: ignore[arg-type]
        decided_at=existing.decided_at,
        decided_by_user_id=existing.decided_by_user_id,
        note=existing.note,
        started_at=existing.started_at,
        completed_at=existing.completed_at,
    )


@router.get(
    "/wa/recent-approvals",
    response_model=CaioWaApprovalsResponse,
    summary="Per-contact engagement stats from the WhatsApp approval log",
    description=(
        "Returns engagement per contact (approved / replaced / manual_override "
        "vs rejected / blocked) over the last ``days`` days. The numbers come "
        "from ``caio_approval_log`` in the WhatsApp pipeline V3 Postgres via a "
        "SELECT-only ``cockpit_ro`` role. Read-only and append-safe: the "
        "Cockpit never writes here. The ``window`` block carries a roll-up "
        "over all interactions in the period so totals make sense even when "
        "``min_interactions`` filters out noisy contacts from ``contacts``."
    ),
)
async def wa_recent_approvals(
    days: int = WA_DAYS_QUERY,
    min_interactions: int = WA_MIN_INTERACTIONS_QUERY,
    limit: int = WA_LIMIT_QUERY,
    _auth: AuthContext = AUTH_CONTEXT_DEP,
) -> CaioWaApprovalsResponse:
    reader = _wa_reader()
    result = await reader.recent_approvals(
        days=days, min_interactions=min_interactions, limit=limit
    )
    if result.status != "ok" or not result.data:
        return CaioWaApprovalsResponse(
            status=result.status,
            error_class=result.error_class,
            latency_ms=result.latency_ms,
            window=None,
            contacts=[],
        )
    payload = result.data
    window = CaioWaWindow(**payload["window"])
    contacts = [CaioWaContactStats(**row) for row in payload["contacts"]]
    return CaioWaApprovalsResponse(
        status=result.status,
        error_class=result.error_class,
        latency_ms=result.latency_ms,
        window=window,
        contacts=contacts,
    )


@router.get(
    "/reflexion/critiques",
    response_model=CaioRecentCritiquesResponse,
    summary="Caio Reflexion-loop critiques (read-only)",
    description=(
        "Returns Caio's Reflexion-loop critiques — the weekly self-review of "
        "past WhatsApp approvals (replaced / rejected / manual_override). Each "
        "item carries Caio's **miss** (what his suggestion got wrong), Pedro's "
        "**hit** (what he did better in the real response), the **pattern** "
        "Caio extracted, and Caio's self-rated confidence (0-1). This endpoint "
        "is **read-only**: there is no decision to record because patterns are "
        "insight, not actionable verdicts. Window defaults to the last 30 days "
        "so the UI keeps something to show between weekly Reflexion runs "
        "(Sundays 18:00 SP)."
    ),
)
async def reflexion_critiques(
    since_days: int = SINCE_DAYS_QUERY,
    limit: int = CRITIQUES_LIMIT_QUERY,
    _auth: AuthContext = AUTH_CONTEXT_DEP,
) -> CaioRecentCritiquesResponse:
    reader = _critiques_reader()
    since = datetime.now(tz=timezone.utc) - timedelta(days=since_days)
    since_iso = since.isoformat()
    result = await reader.recent_critiques(limit=limit, since_iso=since_iso)
    raw_items: list[dict[str, Any]] = (
        list(result.data) if result.status == "ok" and result.data else []
    )
    items = [CaioCritiqueItem(**item) for item in raw_items]
    return CaioRecentCritiquesResponse(
        status=result.status,
        error_class=result.error_class,
        latency_ms=result.latency_ms,
        items=items,
        window=CaioCritiquesWindow(
            since_days=since_days,
            since_iso=since_iso,
            total_returned=len(items),
        ),
    )
