"""Local BRAIN smoke for the read-only Cockpit bridge.

The default fixture mode builds a temporary Caio runtime and fetches
``/api/v1/caio/brain/summary`` through FastAPI's ASGI transport. It never reads
Pedro's real runtime unless ``--runtime-dir`` or ``--base-url`` is provided.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import stat
import sys
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if BACKEND_ROOT.as_posix() not in sys.path:
    sys.path.insert(0, BACKEND_ROOT.as_posix())

os.environ.setdefault("AUTH_MODE", "local")
os.environ.setdefault("LOCAL_AUTH_TOKEN", "brain-smoke-token-0123456789-0123456789-0123456789x")
os.environ.setdefault("BASE_URL", "http://localhost:8000")

import httpx  # noqa: E402
from fastapi import APIRouter, FastAPI  # noqa: E402
from httpx import ASGITransport  # noqa: E402

from app.api.caio import router as caio_router  # noqa: E402
from app.core import auth as auth_module  # noqa: E402
from app.core.auth import AuthContext, get_auth_context  # noqa: E402
from app.core.config import settings  # noqa: E402

SUMMARY_PATH = "/api/v1/caio/brain/summary"
LONG_SECRET = "sk-proj-" + ("A" * 80)
TOKEN_SECRET = "ghp_" + ("B" * 40)
DIAGNOSTIC_STATUSES = {"disabled", "error", "timeout", "circuit_open"}


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


def _make_fixture_runtime(root: Path) -> Path:
    runtime = root / "caio-runtime"
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
  "required_terms": ["BrainRead", "BrainWrite", "local-first"],
  "critical_backup_areas": ["workspaces/caio-runtime/memory/"],
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
            f"Fixture free text includes OpenAI token {LONG_SECRET} for redaction.\n"
            + ("bounded payload line\n" * 120)
        ),
    )
    _write(runtime / "USER.md", "# User\nFixture user projection.\n")
    _write(
        runtime / "memory" / "PEDRO_VIDA.md",
        f"# Vida\n\nFixture projection with token: {TOKEN_SECRET}\n",
    )
    _write(runtime / "memory" / "2026-06-27.md", "# Recent\nFixture memory projection.\n")
    _write(runtime / "Braindump" / "idea.md", "# Idea\nFixture braindump projection.\n")
    _write(runtime / "contatos" / "ana.md", "# Ana\nFixture contact projection.\n")
    (runtime / "memory" / "main.sqlite").write_bytes(b"sqlite fixture")
    (runtime / "lcm.db").write_bytes(b"lcm fixture")
    _write(runtime / "caio_pedro_facts", '{"kind": "fixture"}\n')

    audit_script = root / "brain-runtime-audit.sh"
    audit_script.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "IFS=$'\\n\\t'\n"
        "printf 'audit ok; token: ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\\n'\n",
        encoding="utf-8",
    )
    audit_script.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    settings.caio_brain_audit_script_path = audit_script.as_posix()
    return runtime


def _snapshot_tree(root: Path) -> dict[str, tuple[int, int, str]]:
    snapshot: dict[str, tuple[int, int, str]] = {}
    for path in sorted(p for p in root.rglob("*") if p.is_file() and not p.is_symlink()):
        rel = path.relative_to(root).as_posix()
        data = path.read_bytes()
        snapshot[rel] = (path.stat().st_mtime_ns, len(data), hashlib.sha256(data).hexdigest())
    return snapshot


def _as_mapping(value: object, name: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise AssertionError(f"{name} must be an object")
    return value


def _as_list(value: object, name: str) -> list[object]:
    if not isinstance(value, list):
        raise AssertionError(f"{name} must be a list")
    return value


def _validate_read(read: object) -> None:
    item = _as_mapping(read, "read")
    provenance = _as_mapping(item.get("provenance"), "read.provenance")
    freshness = _as_mapping(item.get("freshness"), "read.freshness")
    if (
        not provenance.get("store")
        or not provenance.get("key")
        or not provenance.get("observed_at")
    ):
        raise AssertionError("read provenance must include store, key, and observed_at")
    if not freshness.get("status") or not freshness.get("observed_at"):
        raise AssertionError("read freshness must include status and observed_at")


def _validate_payload(
    payload: Mapping[str, Any],
    *,
    raw: str,
    require_ok: bool,
    require_fixture_redaction: bool,
) -> str:
    status = payload.get("status")
    if status == "ok":
        contract = _as_mapping(payload.get("contract"), "contract")
        if contract.get("runtime_truth") != "local-first":
            raise AssertionError("contract.runtime_truth must be local-first")
        reads = _as_list(payload.get("reads"), "reads")
        if not reads:
            raise AssertionError("ok BRAIN smoke must include at least one BrainRead record")
        _validate_read(reads[0])
    elif require_ok or status not in DIAGNOSTIC_STATUSES:
        raise AssertionError(f"unexpected BRAIN status: {status!r}")

    if require_fixture_redaction:
        if LONG_SECRET in raw or TOKEN_SECRET in raw:
            raise AssertionError("fixture secret leaked in BRAIN summary response")
        if "[REDACTED]" not in raw:
            raise AssertionError("fixture response did not prove redaction")
    return str(status)


async def _fetch_inprocess(runtime_dir: Path, *, limit: int) -> tuple[Mapping[str, Any], str]:
    settings.caio_brain_runtime_dir = runtime_dir.as_posix()
    settings.caio_bridge_brain_enabled = True
    settings.caio_bridge_brain_timeout_s = 2.0
    from app.api import caio as caio_api

    caio_api._brain_reader.cache_clear()
    app = _build_app()
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://brain-smoke",
    ) as client:
        response = await client.get(SUMMARY_PATH, params={"limit": limit})
    if response.status_code != 200:
        raise AssertionError(
            f"{SUMMARY_PATH} returned HTTP {response.status_code}: {response.text}"
        )
    return _as_mapping(response.json(), "response"), response.text


async def _fetch_remote(base_url: str, *, limit: int) -> tuple[Mapping[str, Any], str]:
    headers: dict[str, str] = {}
    bearer = os.environ.get("BRAIN_SMOKE_BEARER_TOKEN", "").strip()
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    url = f"{base_url.rstrip('/')}{SUMMARY_PATH}"
    async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
        response = await client.get(url, params={"limit": limit})
    if response.status_code != 200:
        raise AssertionError(f"{url} returned HTTP {response.status_code}: {response.text}")
    return _as_mapping(response.json(), "response"), response.text


async def _run(args: argparse.Namespace) -> int:
    limit = max(1, min(int(args.limit), 50))
    if args.base_url:
        payload, raw = await _fetch_remote(str(args.base_url), limit=limit)
        status = _validate_payload(
            payload,
            raw=raw,
            require_ok=False,
            require_fixture_redaction=False,
        )
    elif args.runtime_dir:
        payload, raw = await _fetch_inprocess(Path(str(args.runtime_dir)), limit=limit)
        status = _validate_payload(
            payload,
            raw=raw,
            require_ok=False,
            require_fixture_redaction=False,
        )
    else:
        with tempfile.TemporaryDirectory(prefix="caio-brain-smoke-") as tmp:
            runtime = _make_fixture_runtime(Path(tmp))
            before = _snapshot_tree(runtime)
            payload, raw = await _fetch_inprocess(runtime, limit=limit)
            if _snapshot_tree(runtime) != before:
                raise AssertionError("fixture runtime changed during read-only smoke")
        status = _validate_payload(
            payload,
            raw=raw,
            require_ok=True,
            require_fixture_redaction=True,
        )

    print(f"BRAIN smoke ok: {SUMMARY_PATH} status={status}")
    return 0


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke check the read-only Caio BRAIN bridge.")
    source = parser.add_mutually_exclusive_group()
    source.add_argument(
        "--fixture",
        action="store_true",
        help="Use an isolated fixture runtime (default).",
    )
    source.add_argument(
        "--runtime-dir",
        help="Use a local runtime directory read-only through the in-process app.",
    )
    source.add_argument(
        "--base-url",
        help="Fetch a running backend, for example http://127.0.0.1:8000.",
    )
    parser.add_argument("--limit", type=int, default=5, help="Collection/read limit, 1..50.")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        return asyncio.run(_run(args))
    except Exception as exc:
        print(f"BRAIN smoke failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
