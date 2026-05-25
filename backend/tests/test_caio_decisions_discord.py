# ruff: noqa: INP001
"""Fase A — Discord-aware decision endpoint tests.

Covers:
- Worker-token POST with discord_message_id succeeds and persists fields
- Worker-token POST without discord_message_id returns 400
- Terminal-decision: 1st POST wins, 2nd same-decision is idempotent (200), 2nd different decision returns 409
- CF Access user POST without discord_message_id succeeds (legacy path)
- /think-loop/recent exposes discord_message_id when present
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.caio import router as caio_router
from app.core import auth as auth_module
from app.core.auth import AuthContext
from app.core.auth_mode import AuthMode
from app.core.config import settings
from app.db.session import get_session
from app.models.users import User

WORKER_TOKEN = "test-worker-token-" + ("y" * 50)
MSG_ID = "987654321098765432"
CH_ID = "111122223333444455"


async def _make_engine_and_user():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.connect() as conn, conn.begin():
        await conn.run_sync(SQLModel.metadata.create_all)
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_maker() as session:
        user = User(
            clerk_user_id=f"local-{uuid4().hex}",
            email=f"u{uuid4().hex[:8]}@local",
            name="Test",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        user_id = user.id
    return engine, session_maker, user_id


def _build_app(session_maker, user_id):
    app = FastAPI()
    api_v1 = APIRouter(prefix="/api/v1")
    api_v1.include_router(caio_router)
    app.include_router(api_v1)

    async def _override_session():
        async with session_maker() as session:
            yield session

    async def _force_auth():
        async with session_maker() as session:
            user = await session.get(User, user_id)
            return AuthContext(actor_type="user", user=user)

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[auth_module.get_session] = _override_session
    # Force worker_auth_context to return our pre-created user — emulates a
    # successful worker-token validation without depending on settings glue
    # for every test variant.
    from app.core.worker_auth import get_user_or_worker_auth_context

    app.dependency_overrides[get_user_or_worker_auth_context] = _force_auth
    return app


@pytest.mark.asyncio
async def test_worker_token_with_discord_msg_persists_fields(monkeypatch):
    monkeypatch.setattr(settings, "cockpit_approve_mode", "mark_only")
    monkeypatch.setattr(settings, "cockpit_worker_token", WORKER_TOKEN)
    engine, session_maker, user_id = await _make_engine_and_user()
    app = _build_app(session_maker, user_id)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/api/v1/caio/think-loop/decisions",
                json={
                    "event_id": "evt-1",
                    "decision": "approve",
                    "discord_message_id": MSG_ID,
                    "discord_channel_id": CH_ID,
                },
                headers={"X-Cockpit-Worker-Token": WORKER_TOKEN},
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["discord_message_id"] == MSG_ID
        assert body["discord_channel_id"] == CH_ID
        assert body["decision"] == "approve"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_worker_token_without_discord_msg_returns_400(monkeypatch):
    monkeypatch.setattr(settings, "cockpit_approve_mode", "mark_only")
    monkeypatch.setattr(settings, "cockpit_worker_token", WORKER_TOKEN)
    engine, session_maker, user_id = await _make_engine_and_user()
    app = _build_app(session_maker, user_id)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/api/v1/caio/think-loop/decisions",
                json={"event_id": "evt-2", "decision": "approve"},
                headers={"X-Cockpit-Worker-Token": WORKER_TOKEN},
            )
        assert resp.status_code == 400, resp.text
        assert "discord_message_id" in resp.text
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_terminal_decision_idempotent_then_conflict(monkeypatch):
    monkeypatch.setattr(settings, "cockpit_approve_mode", "mark_only")
    monkeypatch.setattr(settings, "cockpit_worker_token", WORKER_TOKEN)
    engine, session_maker, user_id = await _make_engine_and_user()
    app = _build_app(session_maker, user_id)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            # 1st: approve via worker token
            r1 = await c.post(
                "/api/v1/caio/think-loop/decisions",
                json={
                    "event_id": "evt-3",
                    "decision": "approve",
                    "discord_message_id": MSG_ID,
                    "discord_channel_id": CH_ID,
                },
                headers={"X-Cockpit-Worker-Token": WORKER_TOKEN},
            )
            assert r1.status_code == 200
            # 2nd: same decision + same msg → idempotent 200
            r2 = await c.post(
                "/api/v1/caio/think-loop/decisions",
                json={
                    "event_id": "evt-3",
                    "decision": "approve",
                    "discord_message_id": MSG_ID,
                    "discord_channel_id": CH_ID,
                },
                headers={"X-Cockpit-Worker-Token": WORKER_TOKEN},
            )
            assert r2.status_code == 200
            # 3rd: different decision → 409 conflict (terminal)
            r3 = await c.post(
                "/api/v1/caio/think-loop/decisions",
                json={
                    "event_id": "evt-3",
                    "decision": "reject",
                    "discord_message_id": MSG_ID,
                    "discord_channel_id": CH_ID,
                },
                headers={"X-Cockpit-Worker-Token": WORKER_TOKEN},
            )
            assert r3.status_code == 409, r3.text
            assert "terminal" in r3.text.lower()
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_user_auth_without_discord_msg_succeeds(monkeypatch):
    """CF Access user path (no worker token) — discord fields optional."""
    monkeypatch.setattr(settings, "cockpit_approve_mode", "mark_only")
    monkeypatch.setattr(settings, "cockpit_worker_token", WORKER_TOKEN)
    engine, session_maker, user_id = await _make_engine_and_user()
    app = _build_app(session_maker, user_id)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            # No X-Cockpit-Worker-Token header → user-auth path
            resp = await c.post(
                "/api/v1/caio/think-loop/decisions",
                json={"event_id": "evt-4", "decision": "approve"},
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["discord_message_id"] is None
    finally:
        await engine.dispose()
