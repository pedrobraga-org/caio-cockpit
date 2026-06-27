# ruff: noqa: INP001
"""Read-only BRAIN bridge tests.

The bridge is a read model over Caio's local-first runtime contract. These
tests use fixture runtime directories only; they must not touch Pedro's real
runtime state.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import stat
from pathlib import Path
from typing import Any

import pytest
from fastapi import APIRouter, FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.caio import router as caio_router
from app.core import auth as auth_module
from app.core.auth import AuthContext, get_auth_context
from app.core.config import settings
from app.services.caio_bridge import BrainRuntimeReader

LONG_SECRET = "sk-proj-" + ("A" * 80)
TOKEN_SECRET = "ghp_" + ("B" * 40)


async def _force_auth() -> AuthContext:
    return AuthContext(actor_type="user", user=None)


def _build_app() -> FastAPI:
    app = FastAPI()
    api_v1 = APIRouter(prefix="/api/v1")
    api_v1.include_router(caio_router)
    app.include_router(api_v1)
    app.dependency_overrides[get_auth_context] = _force_auth
    app.dependency_overrides[auth_module.get_auth_context] = _force_auth
    return app


def _write(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def _make_runtime(tmp_path: Path) -> Path:
    runtime = tmp_path / "caio-runtime"
    _write(
        runtime / "BRAIN_RUNTIME.md",
        """
# Caio Brain Runtime Contract

<!-- brain-runtime-contract:begin -->
```json
{
  "contract_version": 1,
  "runtime_truth": "local-first",
  "icloud_source_of_truth_allowed": false,
  "obsidian_source_of_truth_allowed": false,
  "human_markdown_projection_role": "readability-cache",
  "required_terms": [
    "BrainRead",
    "BrainWrite",
    "local-first",
    "iCloud",
    "Obsidian",
    "SOUL.md",
    "USER.md",
    "memory/PEDRO_VIDA.md",
    "contatos/*.md",
    "Braindump/*.md",
    "memory/*.md",
    "memory/main.sqlite",
    "lcm.db",
    "caio_pedro_facts"
  ],
  "critical_backup_areas": [
    "workspaces/caio-runtime/SOUL.md",
    "workspaces/caio-runtime/USER.md",
    "workspaces/caio-runtime/memory/",
    "workspaces/caio-runtime/contatos/",
    "workspaces/caio-runtime/Braindump/",
    "workspaces/caio-runtime/memory/main.sqlite",
    "lcm.db",
    "caio_pedro_facts"
  ],
  "backup_name_patterns": ["*.bak*", "*.pre-*"],
  "allowlist_required_fields": ["path", "pattern", "reason", "owner", "expires_on"],
  "allowlist_date_format": "YYYY-MM-DD"
}
```
<!-- brain-runtime-contract:end -->
""".strip(),
    )
    _write(
        runtime / "SOUL.md",
        (
            "# Soul\n\n"
            f"Markdown note says the OpenAI token is {LONG_SECRET} and must not leak.\n"
            + ("bounded payload line\n" * 120)
        ),
    )
    _write(runtime / "USER.md", "# User\nPedro profile projection.\n")
    _write(
        runtime / "memory" / "PEDRO_VIDA.md",
        f"# Vida\n\nPersonal projection with token: {TOKEN_SECRET}\n",
    )
    _write(runtime / "memory" / "2026-06-26.md", "# Recent\nMemory projection.\n")
    _write(runtime / "Braindump" / "idea.md", "# Idea\nBraindump projection.\n")
    _write(runtime / "contatos" / "ana.md", "# Ana\nContact projection.\n")
    (runtime / "memory" / "main.sqlite").write_bytes(b"sqlite fixture")
    (runtime / "lcm.db").write_bytes(b"lcm fixture")
    _write(runtime / "caio_pedro_facts", '{"kind": "fixture"}\n')
    return runtime


def _snapshot_tree(root: Path) -> dict[str, tuple[int, int, str]]:
    snapshot: dict[str, tuple[int, int, str]] = {}
    for path in sorted(p for p in root.rglob("*") if p.is_file() and not p.is_symlink()):
        rel = path.relative_to(root).as_posix()
        data = path.read_bytes()
        snapshot[rel] = (path.stat().st_mtime_ns, len(data), hashlib.sha256(data).hexdigest())
    return snapshot


@pytest.mark.asyncio
async def test_brain_status_endpoint_returns_contract_inventory_and_redacted_reads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = _make_runtime(tmp_path)
    audit_script = tmp_path / "brain-runtime-audit.sh"
    audit_script.write_text(
        "#!/usr/bin/env bash\n"
        "printf 'audit ok; token: ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\\n'\n",
        encoding="utf-8",
    )
    audit_script.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    before = _snapshot_tree(runtime)

    monkeypatch.setattr(settings, "caio_brain_runtime_dir", runtime.as_posix())
    monkeypatch.setattr(settings, "caio_bridge_brain_enabled", True)
    monkeypatch.setattr(settings, "caio_bridge_brain_timeout_s", 2.0)
    monkeypatch.setattr(settings, "caio_brain_audit_script_path", audit_script.as_posix())
    from app.api import caio as caio_api

    caio_api._brain_reader.cache_clear()
    app = _build_app()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/caio/brain/status?limit=5")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok"
    assert body["latency_ms"] >= 0
    assert body["contract"]["contract_version"] == 1
    assert body["contract"]["runtime_truth"] == "local-first"
    assert body["contract"]["icloud_source_of_truth_allowed"] is False
    assert body["contract"]["obsidian_source_of_truth_allowed"] is False
    assert "BrainRead" in body["contract"]["required_terms"]
    assert body["audit"]["status"] == "ok"
    assert TOKEN_SECRET not in response.text
    assert LONG_SECRET not in response.text
    assert "[REDACTED]" in response.text

    inventory_by_key = {item["key"]: item for item in body["inventory"]}
    for key in (
        "SOUL.md",
        "USER.md",
        "memory/PEDRO_VIDA.md",
        "memory/main.sqlite",
        "lcm.db",
        "caio_pedro_facts",
    ):
        assert inventory_by_key[key]["exists"] is True
        assert inventory_by_key[key]["freshness"]["observed_at"]
        assert inventory_by_key[key]["payload_metadata"]["size_bytes"] is not None

    reads_by_path = {item["path"]: item for item in body["reads"]}
    soul = reads_by_path["SOUL.md"]
    assert soul["source"] == "local_runtime_contract"
    assert soul["provenance"]["store"] == "caio-brain-runtime"
    assert soul["provenance"]["path"] == "SOUL.md"
    assert soul["provenance"]["observed_at"]
    assert soul["freshness"]["observed_at"]
    assert soul["payload_metadata"]["snippet_chars"] <= body["limits"]["snippet_max_chars"]
    assert soul["payload_metadata"]["snippet_truncated"] is True
    assert soul["payload_metadata"]["snippet_redacted"] is True
    assert soul["snippet"]
    assert LONG_SECRET not in soul["snippet"]

    vida = reads_by_path["memory/PEDRO_VIDA.md"]
    assert vida["source"] == "markdown_projection"
    assert vida["payload_metadata"]["snippet_redacted"] is True
    assert TOKEN_SECRET not in vida["snippet"]

    assert _snapshot_tree(runtime) == before


def test_brain_reader_rejects_path_traversal(tmp_path: Path) -> None:
    runtime = _make_runtime(tmp_path)
    reader = BrainRuntimeReader(runtime_dir=runtime, enabled=True)

    result = asyncio.run(reader.read_artifact("../outside.md"))

    assert result.status == "error"
    assert result.error_class == "PathTraversalError"


def test_brain_reader_rejects_symlink_escape(tmp_path: Path) -> None:
    runtime = _make_runtime(tmp_path)
    outside = tmp_path / "outside-secret.md"
    outside.write_text("outside token: should-not-be-read", encoding="utf-8")
    link = runtime / "memory" / "escape.md"
    os.symlink(outside, link)
    reader = BrainRuntimeReader(runtime_dir=runtime, enabled=True)

    result = asyncio.run(reader.read_artifact("memory/escape.md"))

    assert result.status == "error"
    assert result.error_class == "PathEscapeError"
    assert result.data is None


@pytest.mark.asyncio
async def test_brain_status_missing_or_unconfigured_runtime_degrades_without_500(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "caio_brain_runtime_dir", "")
    monkeypatch.setattr(settings, "caio_bridge_brain_enabled", True)
    from app.api import caio as caio_api

    caio_api._brain_reader.cache_clear()
    app = _build_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        disabled = await client.get("/api/v1/caio/brain/status")
    assert disabled.status_code == 200
    assert disabled.json()["status"] == "disabled"

    monkeypatch.setattr(settings, "caio_brain_runtime_dir", (tmp_path / "missing").as_posix())
    caio_api._brain_reader.cache_clear()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        missing = await client.get("/api/v1/caio/brain/status")
    assert missing.status_code == 200
    assert missing.json()["status"] == "error"
    assert missing.json()["error_class"] == "FileNotFoundError"


@pytest.mark.asyncio
async def test_brain_status_malformed_contract_degrades_without_500(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = tmp_path / "caio-runtime"
    runtime.mkdir()
    monkeypatch.setattr(settings, "caio_brain_runtime_dir", runtime.as_posix())
    monkeypatch.setattr(settings, "caio_bridge_brain_enabled", True)
    from app.api import caio as caio_api

    caio_api._brain_reader.cache_clear()
    app = _build_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        missing_contract = await client.get("/api/v1/caio/brain/status")
    assert missing_contract.status_code == 200
    assert missing_contract.json()["status"] == "error"
    assert missing_contract.json()["error_class"] == "FileNotFoundError"

    _write(runtime / "BRAIN_RUNTIME.md", "# Broken contract\n")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        malformed_contract = await client.get("/api/v1/caio/brain/status")
    assert malformed_contract.status_code == 200
    assert malformed_contract.json()["status"] == "error"
    assert malformed_contract.json()["error_class"] == "BrainRuntimeContractError"


def test_brain_router_exposes_no_write_methods() -> None:
    brain_routes: list[tuple[str, set[str]]] = []
    for route in caio_router.routes:
        path = getattr(route, "path", "")
        methods: set[str] = set(getattr(route, "methods", set()) or set())
        if path.startswith("/brain/") or path.startswith("/caio/brain/"):
            brain_routes.append((path, methods))

    assert brain_routes
    for _path, methods in brain_routes:
        assert methods <= {"GET", "HEAD"}
