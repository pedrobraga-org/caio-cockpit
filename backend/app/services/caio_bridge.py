"""Read-only bridges to the Caio operational data sources.

Caio (Pedro's autonomous WhatsApp/Discord agent) writes structured events into a
few local stores on the same host as the OpenClaw gateway:

- ``events.sqlite``: append-only event log for the Think Loop (proposals,
  policy decisions, ticks, dispatches, advisor consults, reflexion critiques).
- ``critiques.sqlite``: Reflexion loop weekly critiques of past approvals.
- A Postgres database used by the WhatsApp webhook V3 pipeline (approval_log
  with the contact/draft/final response history).

The Cockpit only ever *reads* from these stores. Writes belong to Caio's own
processes; mutating these databases from the Cockpit would break Caio's
invariants and the #wa-aprovacoes pipeline.

Resilience guarantees per plano canônico V1.1 (CRITICAL #2):

- SQLite is opened in strict read-only URI mode
  (``file:<path>?mode=ro&uri=true``). The reader **never** sets
  ``PRAGMA journal_mode``; that would mutate the WAL file shared with the
  upstream writer.
- Every call has a hard wall-clock timeout (default 2 s). Timeouts and
  recognized I/O errors trip the per-bridge circuit breaker (open after 3
  failures within 60 s).
- Each bridge has an ``enabled`` feature flag (env var, see settings). When
  disabled, ``safe_read`` returns ``{"data": None, "status": "disabled"}``
  immediately — endpoints can degrade gracefully without raising.
- Callers ALWAYS receive ``BridgeResult`` (data may be ``None``); they never
  observe ``OperationalError`` directly.
"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import subprocess
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

from app.core.logging import get_logger

try:
    # psycopg is an optional driver — only the WebhookPostgresReader needs it.
    # Importing here (instead of inside the reader) lets ``safe_read`` widen
    # its except-clause to include psycopg errors without each reader doing
    # the dance. If psycopg isn't installed we fall back to a sentinel that
    # ``except`` will simply never match.
    from psycopg import Error as _PsycopgError  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - dev environments only
    class _PsycopgError(Exception):  # type: ignore[no-redef]
        """Sentinel: psycopg is not installed in this environment."""

logger = get_logger(__name__)

BridgeStatus = Literal["ok", "error", "disabled", "circuit_open", "timeout"]


class PathTraversalError(OSError):
    """Rejected user-supplied path with ``..`` or an absolute root."""


class PathEscapeError(OSError):
    """Rejected path that resolves outside the configured runtime directory."""


class BrainRuntimeContractError(OSError):
    """The local BRAIN runtime contract exists but is malformed."""


@dataclass(slots=True)
class BridgeResult:
    """Outcome of a single read through a bridge.

    ``status="ok"`` is the only case with usable ``data``. Other statuses carry
    diagnostic info so endpoints can render a "stale data" UI hint without
    leaking internals.
    """

    status: BridgeStatus
    data: Any = None
    error_class: str | None = None
    latency_ms: int = 0


class BridgeBase:
    """Common envelope: feature flag, timeout, circuit breaker, structlog."""

    name: str = "bridge"
    default_timeout_s: float = 2.0
    circuit_failure_window_s: float = 60.0
    circuit_failure_threshold: int = 3

    def __init__(self, *, enabled: bool, timeout_s: float | None = None) -> None:
        self.enabled = enabled
        self.timeout_s = timeout_s or self.default_timeout_s
        self._failure_times: deque[float] = deque()
        self._circuit_open_until: float = 0.0

    # ------------------------------------------------------------------ helpers

    def _now(self) -> float:
        return time.monotonic()

    def _circuit_is_open(self) -> bool:
        return self._now() < self._circuit_open_until

    def _record_failure(self) -> None:
        now = self._now()
        cutoff = now - self.circuit_failure_window_s
        while self._failure_times and self._failure_times[0] < cutoff:
            self._failure_times.popleft()
        self._failure_times.append(now)
        if len(self._failure_times) >= self.circuit_failure_threshold:
            # Trip the breaker for 60s, then close again.
            self._circuit_open_until = now + self.circuit_failure_window_s
            logger.warning(
                "caio_bridge.circuit_open bridge=%s recent_failures=%s window_s=%s",
                self.name,
                len(self._failure_times),
                self.circuit_failure_window_s,
            )

    def _record_success(self) -> None:
        self._failure_times.clear()
        self._circuit_open_until = 0.0

    # ------------------------------------------------------------------ public

    async def safe_read(
        self,
        query: Callable[[], Awaitable[Any]],
    ) -> BridgeResult:
        """Run ``query`` under timeout + circuit breaker; never raises."""
        if not self.enabled:
            return BridgeResult(status="disabled")
        if self._circuit_is_open():
            return BridgeResult(status="circuit_open")
        started = time.perf_counter()
        try:
            data = await asyncio.wait_for(query(), timeout=self.timeout_s)
        except asyncio.TimeoutError:
            self._record_failure()
            return BridgeResult(
                status="timeout",
                error_class="TimeoutError",
                latency_ms=int((time.perf_counter() - started) * 1000),
            )
        except (sqlite3.Error, OSError, _PsycopgError) as exc:
            self._record_failure()
            logger.warning(
                "caio_bridge.read_error bridge=%s error_class=%s",
                self.name,
                type(exc).__name__,
            )
            return BridgeResult(
                status="error",
                error_class=type(exc).__name__,
                latency_ms=int((time.perf_counter() - started) * 1000),
            )
        self._record_success()
        return BridgeResult(
            status="ok",
            data=data,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )


class EventsSqliteReader(BridgeBase):
    """Reads Caio's Think Loop events from ``events.sqlite`` (strict read-only).

    The events table is the canonical append-only log written by Caio's
    Think Loop runtime (``~/.openclaw/state/events.sqlite`` on the host). We
    surface the subset of event types that map naturally to a Cockpit
    "approval/decision" view: ``think_loop.proposal``,
    ``think_loop.policy_decision``, ``think_loop.dispatched``,
    ``advisor.consult_requested``, ``reflexion.critique_generated``.
    """

    name = "events_sqlite"

    DEFAULT_EVENT_TYPES: tuple[str, ...] = (
        "think_loop.proposal",
        "think_loop.policy_decision",
        "think_loop.dispatched",
        "advisor.consult_requested",
        "reflexion.critique_generated",
    )

    def __init__(
        self,
        *,
        db_path: Path,
        enabled: bool,
        timeout_s: float | None = None,
    ) -> None:
        super().__init__(enabled=enabled, timeout_s=timeout_s)
        # Resolve to an absolute path so the read-only URI we hand to SQLite
        # never contains "..". The mount itself is :ro at the docker layer, so
        # this is defense-in-depth (Codex round 1, HIGH #1).
        self._db_path = db_path.expanduser().resolve(strict=False)

    @property
    def db_path(self) -> Path:
        return self._db_path

    def _build_uri(self) -> str:
        # Strict read-only URI: the reader must never mutate the WAL or trigger
        # a journal_mode change. See plano V1.1 CRITICAL #2 (Codex round 2).
        return f"file:{self._db_path.as_posix()}?mode=ro&uri=true"

    def _open_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self._build_uri(),
            uri=True,
            timeout=self.timeout_s,
            isolation_level=None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        # busy_timeout is the inner-loop budget for SQLite-level lock waits.
        # Our outer asyncio.wait_for(...) is the hard cap.
        conn.execute(f"PRAGMA busy_timeout = {int(self.timeout_s * 1000)}")
        return conn

    def _sync_recent_events(
        self,
        limit: int,
        event_types: tuple[str, ...],
    ) -> list[dict[str, Any]]:
        if not self._db_path.exists():
            raise sqlite3.OperationalError(f"events DB not found: {self._db_path}")
        placeholders = ",".join("?" * len(event_types))
        query = (
            "SELECT event_id, occurred_at, event_type, source, producer_id, "
            "correlation_id, thread_id, payload_json "
            "FROM events "
            f"WHERE event_type IN ({placeholders}) "
            "AND deleted_at IS NULL "
            "ORDER BY occurred_at DESC "
            "LIMIT ?"
        )
        with self._open_connection() as conn:
            rows = conn.execute(query, (*event_types, limit)).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            try:
                payload = json.loads(row["payload_json"])
            except (TypeError, ValueError):
                payload = None
            out.append(
                {
                    "event_id": row["event_id"],
                    "occurred_at": row["occurred_at"],
                    "event_type": row["event_type"],
                    "source": row["source"],
                    "producer_id": row["producer_id"],
                    "correlation_id": row["correlation_id"],
                    "thread_id": row["thread_id"],
                    "payload": payload,
                },
            )
        return out

    async def recent_events(
        self,
        *,
        limit: int = 20,
        event_types: tuple[str, ...] | None = None,
    ) -> BridgeResult:
        """Return the latest Caio events as a ``BridgeResult`` (never raises)."""
        types = event_types or self.DEFAULT_EVENT_TYPES
        bounded_limit = max(1, min(int(limit), 200))

        async def _q() -> list[dict[str, Any]]:
            # SQLite is sync; offload to a thread so the event loop stays free.
            return await asyncio.to_thread(self._sync_recent_events, bounded_limit, types)

        return await self.safe_read(_q)


class CritiquesSqliteReader(BridgeBase):
    """Reads Caio's Reflexion-loop critiques from ``critiques.sqlite``.

    The Reflexion loop runs weekly (cron ``ai.openclaw.reflexion``, Sundays
    18:00 SP) and self-reviews a window of past WhatsApp approvals (replaced /
    rejected / manual_override). For each action it emits a structured
    critique: what Caio's suggestion missed (``miss``), what Pedro did better
    in the actual response (``hit``), the generalizable rule that closes the
    gap (``pattern``), plus a self-rated ``confidence`` 0-1.

    This bridge surfaces those critiques to the Cockpit so Pedro can see
    "Caio aprendendo" — patterns growing over time. It is read-only: patterns
    are insight, not actionable decisions, so there is no mark_only on top.

    ``raw_llm_response`` is **never** returned: that column is the raw LLM
    output Caio's reflexion-tick.sh persists for forensic replay and may be
    large; the curated fields above are everything the UI needs.
    """

    name = "critiques_sqlite"

    def __init__(
        self,
        *,
        db_path: Path,
        enabled: bool,
        timeout_s: float | None = None,
    ) -> None:
        super().__init__(enabled=enabled, timeout_s=timeout_s)
        # Defense-in-depth: resolve to abs path so the URI we hand SQLite has no
        # ".." segments. The bind mount is :ro at the docker layer.
        self._db_path = db_path.expanduser().resolve(strict=False)

    @property
    def db_path(self) -> Path:
        return self._db_path

    def _build_uri(self) -> str:
        # Strict read-only URI **plus** ``immutable=1``. Why immutable here but
        # not in EventsSqliteReader: events.sqlite is journal_mode=WAL (carries
        # -wal/-shm sidecars), so ``mode=ro`` is enough — SQLite uses the WAL
        # as the consistency anchor without ever needing to write a journal.
        # critiques.sqlite is journal_mode=DELETE (default rollback journal),
        # which forces SQLite to *probe* for a hot journal on open; on a Docker
        # ``:ro`` bind mount that probe trips EROFS and SQLite surfaces it as
        # "unable to open database file". ``immutable=1`` skips the probe.
        # Trade-off: the connection assumes the file does not change while open
        # — fine here because Caio's reflexion-tick.sh writes once a week and
        # each Cockpit request opens its own short-lived connection.
        return f"file:{self._db_path.as_posix()}?mode=ro&immutable=1"

    def _open_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self._build_uri(),
            uri=True,
            timeout=self.timeout_s,
            isolation_level=None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout = {int(self.timeout_s * 1000)}")
        return conn

    def _sync_recent_critiques(
        self,
        limit: int,
        since_iso: str | None,
    ) -> list[dict[str, Any]]:
        if not self._db_path.exists():
            raise sqlite3.OperationalError(
                f"critiques DB not found: {self._db_path}"
            )
        params: list[Any] = []
        where_clause = ""
        if since_iso:
            where_clause = "WHERE generated_at >= ?"
            params.append(since_iso)
        query = (
            "SELECT id, generated_at, approval_log_id, jid, action, "
            "contact_message, caio_suggestion, final_response, "
            "miss, hit, pattern, confidence "
            f"FROM critiques {where_clause} "
            "ORDER BY generated_at DESC "
            "LIMIT ?"
        )
        params.append(limit)
        with self._open_connection() as conn:
            rows = conn.execute(query, params).fetchall()
        return [
            {
                "id": row["id"],
                "generated_at": row["generated_at"],
                "approval_log_id": row["approval_log_id"],
                "jid": row["jid"],
                "action": row["action"],
                "contact_message": row["contact_message"],
                "caio_suggestion": row["caio_suggestion"],
                "final_response": row["final_response"],
                "miss": row["miss"],
                "hit": row["hit"],
                "pattern": row["pattern"],
                "confidence": row["confidence"],
            }
            for row in rows
        ]

    async def recent_critiques(
        self,
        *,
        limit: int = 50,
        since_iso: str | None = None,
    ) -> BridgeResult:
        """Return the latest critiques as a ``BridgeResult`` (never raises)."""
        bounded_limit = max(1, min(int(limit), 500))

        async def _q() -> list[dict[str, Any]]:
            return await asyncio.to_thread(
                self._sync_recent_critiques, bounded_limit, since_iso
            )

        return await self.safe_read(_q)


class WebhookPostgresReader(BridgeBase):
    """Reads WhatsApp approval log from the V3 webhook Postgres (read-only).

    The webhook V3 pipeline writes every approval card outcome (approved /
    replaced / rejected / manual_override / blocked) to ``caio_approval_log``
    in the ``caio`` database on the Evolution Postgres instance. The Cockpit
    surfaces this so Pedro can see engagement (how often he sends Caio's
    suggestion verbatim vs rewrites it vs blocks it) per contact.

    Resilience guarantees mirror the SQLite readers:
    - DSN must use the ``cockpit_ro`` role (SELECT on ``caio_approval_log``,
      nothing else). The bridge **never** issues writes; the upstream pipeline
      is the only writer.
    - Hard wall-clock timeout via ``BridgeBase.safe_read``. ``psycopg.Error``
      and ``OSError`` trip the per-bridge circuit breaker. Callers always
      receive a ``BridgeResult``.

    The ``approved + replaced + manual_override`` set are the "engaged"
    actions (Pedro acted on the contact, even if he reworded). ``rejected``
    and ``blocked`` are non-engagements. The engagement_rate computed below
    is the fraction of total interactions that landed in the engaged set.
    """

    name = "webhook_postgres"
    default_timeout_s: float = 3.0

    # Caio writes one of these labels per approval card outcome.
    _ENGAGED_ACTIONS: tuple[str, ...] = ("approved", "replaced", "manual_override")
    _NON_ENGAGED_ACTIONS: tuple[str, ...] = ("rejected", "blocked")

    def __init__(
        self,
        *,
        dsn: str,
        enabled: bool,
        timeout_s: float | None = None,
    ) -> None:
        super().__init__(enabled=enabled, timeout_s=timeout_s)
        self._dsn = dsn

    @property
    def dsn(self) -> str:
        return self._dsn

    def _sync_recent_stats(
        self,
        days: int,
        min_interactions: int,
        limit: int,
    ) -> dict[str, Any]:
        """Per-contact engagement stats. Pure SELECTs, no writes."""
        # Lazy import so the rest of the app doesn't pay the cost when the
        # bridge is disabled (or psycopg is unavailable for some reason).
        import psycopg  # type: ignore[import-not-found]

        query = """
            WITH window_rows AS (
                SELECT jid, contact_name, action, approval_time_secs, created_at
                FROM caio_approval_log
                WHERE created_at >= now() - %s::interval
            )
            SELECT
                jid,
                MAX(contact_name) AS contact_name,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE action = 'approved') AS approved,
                COUNT(*) FILTER (WHERE action = 'replaced') AS replaced,
                COUNT(*) FILTER (WHERE action = 'manual_override') AS manual_override,
                COUNT(*) FILTER (WHERE action = 'rejected') AS rejected,
                COUNT(*) FILTER (WHERE action = 'blocked') AS blocked,
                AVG(approval_time_secs) FILTER (WHERE approval_time_secs IS NOT NULL)
                    AS avg_approval_time_s,
                MAX(created_at) AS last_interaction_at
            FROM window_rows
            GROUP BY jid
            HAVING COUNT(*) >= %s
            ORDER BY MAX(created_at) DESC
            LIMIT %s
        """
        interval = f"{int(days)} days"
        with psycopg.connect(
            self._dsn,
            connect_timeout=int(self.timeout_s),
            # psycopg 3 honors statement_timeout via options=.
            options=f"-c statement_timeout={int(self.timeout_s * 1000)}",
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    query,
                    (interval, int(min_interactions), int(limit)),
                )
                rows = cur.fetchall()
                cols = [c.name for c in (cur.description or [])]
                # Roll-up across all surfaced contacts (not the whole table —
                # respects min_interactions filter so noise rows don't skew).
                cur.execute(
                    "SELECT COUNT(*) AS total, "
                    "COUNT(*) FILTER (WHERE action IN ('approved','replaced','manual_override')) AS engaged, "
                    "COUNT(DISTINCT jid) AS contacts "
                    "FROM caio_approval_log "
                    "WHERE created_at >= now() - %s::interval",
                    (interval,),
                )
                roll = cur.fetchone()
        contacts: list[dict[str, Any]] = []
        for raw in rows:
            item = dict(zip(cols, raw))
            total = int(item.get("total") or 0)
            engaged = (
                int(item.get("approved") or 0)
                + int(item.get("replaced") or 0)
                + int(item.get("manual_override") or 0)
            )
            item["engaged"] = engaged
            item["engagement_rate"] = (engaged / total) if total else None
            item["avg_approval_time_s"] = (
                float(item["avg_approval_time_s"])
                if item.get("avg_approval_time_s") is not None
                else None
            )
            if item.get("last_interaction_at") is not None:
                item["last_interaction_at"] = item["last_interaction_at"].isoformat()
            contacts.append(item)

        window_total = int((roll or (0,))[0]) if roll else 0
        window_engaged = int((roll or (0, 0))[1]) if roll else 0
        window_contacts = int((roll or (0, 0, 0))[2]) if roll else 0
        return {
            "window": {
                "days": int(days),
                "min_interactions": int(min_interactions),
                "total_interactions": window_total,
                "engaged_interactions": window_engaged,
                "engagement_rate": (
                    window_engaged / window_total if window_total else None
                ),
                "distinct_contacts": window_contacts,
            },
            "contacts": contacts,
        }

    async def recent_approvals(
        self,
        *,
        days: int = 7,
        min_interactions: int = 1,
        limit: int = 50,
    ) -> BridgeResult:
        """Return per-contact engagement stats over the last ``days`` days."""
        bounded_limit = max(1, min(int(limit), 500))
        bounded_days = max(1, min(int(days), 365))
        bounded_min = max(1, min(int(min_interactions), 1000))

        async def _q() -> dict[str, Any]:
            return await asyncio.to_thread(
                self._sync_recent_stats,
                bounded_days,
                bounded_min,
                bounded_limit,
            )

        return await self.safe_read(_q)


class BrainRuntimeReader(BridgeBase):
    """Read-only bridge over the local-first Caio BRAIN runtime contract.

    This reader intentionally exposes a bounded read model instead of arbitrary
    file browsing. Markdown artifacts are returned as projections/cache with
    redacted snippets; structured stores are surfaced as metadata only.
    """

    name = "brain_runtime"
    snippet_max_chars: int = 1200
    audit_output_max_chars: int = 2000

    _CONTRACT_PATH = "BRAIN_RUNTIME.md"
    _FIXED_MARKDOWN_ARTIFACTS: tuple[tuple[str, str], ...] = (
        ("SOUL.md", "local_runtime_contract"),
        ("USER.md", "local_runtime_contract"),
        ("memory/PEDRO_VIDA.md", "markdown_projection"),
    )
    _STRUCTURED_ARTIFACTS: tuple[tuple[str, str, str], ...] = (
        ("memory/main.sqlite", "sqlite_store", "application/vnd.sqlite3"),
        ("lcm.db", "sqlite_store", "application/vnd.sqlite3"),
        ("caio_pedro_facts", "structured_fact_store", "application/json"),
    )
    _REQUIRED_CONTRACT_FIELDS: tuple[tuple[str, type], ...] = (
        ("contract_version", int),
        ("runtime_truth", str),
        ("icloud_source_of_truth_allowed", bool),
        ("obsidian_source_of_truth_allowed", bool),
        ("human_markdown_projection_role", str),
    )

    def __init__(
        self,
        *,
        runtime_dir: Path,
        enabled: bool,
        timeout_s: float | None = None,
        audit_script_path: Path | None = None,
        lcm_db_path: Path | None = None,
        facts_path: Path | None = None,
    ) -> None:
        super().__init__(enabled=enabled, timeout_s=timeout_s)
        self._runtime_dir = runtime_dir.expanduser().resolve(strict=False)
        self._audit_script_path = (
            audit_script_path.expanduser().resolve(strict=False)
            if audit_script_path is not None
            else None
        )
        self._lcm_db_path = (
            lcm_db_path.expanduser().resolve(strict=False)
            if lcm_db_path is not None
            else None
        )
        self._facts_path = (
            facts_path.expanduser().resolve(strict=False)
            if facts_path is not None
            else None
        )

    @property
    def runtime_dir(self) -> Path:
        return self._runtime_dir

    def limits_payload(self, *, collection_limit: int = 5) -> dict[str, int]:
        return {
            "snippet_max_chars": self.snippet_max_chars,
            "collection_limit": collection_limit,
            "audit_output_max_chars": self.audit_output_max_chars,
        }

    # ------------------------------------------------------------------ paths

    def _safe_runtime_path(self, relative_path: str) -> Path:
        relative = Path(relative_path)
        if relative.is_absolute() or ".." in relative.parts:
            raise PathTraversalError(f"invalid runtime path: {relative_path}")
        candidate = self._runtime_dir / relative
        resolved = candidate.resolve(strict=False)
        try:
            resolved.relative_to(self._runtime_dir)
        except ValueError as exc:
            raise PathEscapeError(f"runtime path escapes root: {relative_path}") from exc
        return candidate

    def _optional_structured_path(self, key: str) -> Path:
        if key == "lcm.db" and self._lcm_db_path is not None:
            return self._lcm_db_path
        if key == "caio_pedro_facts" and self._facts_path is not None:
            return self._facts_path
        return self._safe_runtime_path(key)

    # ------------------------------------------------------------------ payload

    def _now_iso(self) -> str:
        return datetime.now(tz=timezone.utc).isoformat()

    def _content_type_for(self, key: str) -> str:
        if key.endswith(".md"):
            return "text/markdown"
        if key.endswith((".sqlite", ".db")):
            return "application/vnd.sqlite3"
        if key.endswith(".json") or key == "caio_pedro_facts":
            return "application/json"
        return "application/octet-stream"

    def _freshness_for_stat(
        self,
        *,
        observed_at: str,
        st_mtime: float | None,
    ) -> dict[str, Any]:
        if st_mtime is None:
            return {
                "status": "missing",
                "observed_at": observed_at,
                "modified_at": None,
                "age_seconds": None,
            }
        modified = datetime.fromtimestamp(st_mtime, tz=timezone.utc)
        observed = datetime.fromisoformat(observed_at)
        return {
            "status": "observed",
            "observed_at": observed_at,
            "modified_at": modified.isoformat(),
            "age_seconds": max(0, int((observed - modified).total_seconds())),
        }

    def _payload_metadata(
        self,
        *,
        content_type: str,
        size_bytes: int | None = None,
        snippet: str | None = None,
        snippet_truncated: bool = False,
        snippet_redacted: bool = False,
        collection_count: int | None = None,
        recent_paths: list[str] | None = None,
    ) -> dict[str, Any]:
        return {
            "content_type": content_type,
            "size_bytes": size_bytes,
            "sha256": None,
            "snippet_chars": len(snippet or ""),
            "snippet_truncated": snippet_truncated,
            "snippet_redacted": snippet_redacted,
            "collection_count": collection_count,
            "recent_paths": recent_paths or [],
        }

    def _redact_text(self, text: str) -> tuple[str, bool]:
        redacted = re.sub(
            r"(?i)\b((?:api[_ -]?key|token|secret|password|authorization)"
            r"\s*(?:is|=|:)\s*)([^\s`'\"<>]{6,})",
            r"\1[REDACTED]",
            text,
        )
        redacted = re.sub(
            r"(?i)\b(Bearer\s+)([A-Za-z0-9._~+/\-]+=*)",
            r"\1[REDACTED]",
            redacted,
        )
        redacted = re.sub(
            r"\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b",
            "[REDACTED]",
            redacted,
        )
        redacted = re.sub(
            r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b",
            "[REDACTED]",
            redacted,
        )
        return redacted, redacted != text

    def _read_bounded_snippet(self, path: Path) -> tuple[str, bool, bool]:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            raw = handle.read(self.snippet_max_chars + 1)
        truncated = len(raw) > self.snippet_max_chars
        snippet = raw[: self.snippet_max_chars]
        redacted, did_redact = self._redact_text(snippet)
        return redacted, truncated, did_redact

    def _bounded_redacted_output(self, text: str | bytes | None) -> str | None:
        if text is None:
            return None
        raw = (
            text.decode("utf-8", errors="replace")
            if isinstance(text, bytes)
            else text
        )
        bounded = raw[: self.audit_output_max_chars]
        redacted, _did_redact = self._redact_text(bounded)
        return redacted

    # ------------------------------------------------------------------ records

    def _inventory_item(
        self,
        *,
        key: str,
        path: Path,
        source: str,
        observed_at: str,
        content_type: str | None = None,
        display_path: str | None = None,
    ) -> dict[str, Any]:
        content = content_type or self._content_type_for(key)
        try:
            if not path.exists():
                return {
                    "key": key,
                    "path": display_path or key,
                    "source": source,
                    "exists": False,
                    "error_class": None,
                    "freshness": self._freshness_for_stat(
                        observed_at=observed_at, st_mtime=None
                    ),
                    "payload_metadata": self._payload_metadata(content_type=content),
                }
            stat_result = path.stat()
        except OSError as exc:
            return {
                "key": key,
                "path": display_path or key,
                "source": source,
                "exists": False,
                "error_class": type(exc).__name__,
                "freshness": self._freshness_for_stat(
                    observed_at=observed_at, st_mtime=None
                ),
                "payload_metadata": self._payload_metadata(content_type=content),
            }
        return {
            "key": key,
            "path": display_path or key,
            "source": source,
            "exists": True,
            "error_class": None,
            "freshness": self._freshness_for_stat(
                observed_at=observed_at,
                st_mtime=stat_result.st_mtime,
            ),
            "payload_metadata": self._payload_metadata(
                content_type=content,
                size_bytes=stat_result.st_size,
            ),
        }

    def _read_record(
        self,
        *,
        key: str,
        path: Path,
        source: str,
        observed_at: str,
        display_path: str | None = None,
    ) -> dict[str, Any]:
        if not path.exists():
            raise FileNotFoundError(key)
        stat_result = path.stat()
        content_type = self._content_type_for(key)
        snippet: str | None = None
        snippet_truncated = False
        snippet_redacted = False
        if content_type == "text/markdown":
            snippet, snippet_truncated, snippet_redacted = self._read_bounded_snippet(
                path
            )
        freshness = self._freshness_for_stat(
            observed_at=observed_at,
            st_mtime=stat_result.st_mtime,
        )
        out_path = display_path or key
        return {
            "key": key,
            "path": out_path,
            "source": source,
            "provenance": {
                "store": "caio-brain-runtime",
                "key": key,
                "path": out_path,
                "observed_at": observed_at,
                "confidence": None,
            },
            "freshness": freshness,
            "payload_metadata": self._payload_metadata(
                content_type=content_type,
                size_bytes=stat_result.st_size,
                snippet=snippet,
                snippet_truncated=snippet_truncated,
                snippet_redacted=snippet_redacted,
            ),
            "snippet": snippet,
        }

    def _collection_inventory(
        self,
        *,
        key: str,
        source: str,
        entries: list[tuple[str, Path]],
        observed_at: str,
    ) -> dict[str, Any]:
        mtimes: list[float] = []
        for _rel, path in entries:
            try:
                mtimes.append(path.stat().st_mtime)
            except OSError:
                continue
        return {
            "key": key,
            "path": key,
            "source": source,
            "exists": bool(entries),
            "error_class": None,
            "freshness": self._freshness_for_stat(
                observed_at=observed_at,
                st_mtime=max(mtimes) if mtimes else None,
            ),
            "payload_metadata": self._payload_metadata(
                content_type="application/x.caio-brain-collection",
                collection_count=len(entries),
                recent_paths=[rel for rel, _path in entries],
            ),
        }

    # ------------------------------------------------------------------ contract

    def _load_contract_summary(self, observed_at: str) -> dict[str, Any] | None:
        del observed_at
        contract_path = self._safe_runtime_path(self._CONTRACT_PATH)
        if not contract_path.exists():
            raise FileNotFoundError(self._CONTRACT_PATH)
        text = contract_path.read_text(encoding="utf-8", errors="replace")
        match = re.search(
            r"<!--\s*brain-runtime-contract:begin\s*-->\s*```json\s*(.*?)\s*```",
            text,
            flags=re.DOTALL,
        )
        if match is None:
            raise BrainRuntimeContractError("BRAIN_RUNTIME.md contract block missing")
        try:
            payload = json.loads(match.group(1))
        except json.JSONDecodeError as exc:
            raise BrainRuntimeContractError("BRAIN_RUNTIME.md contract JSON invalid") from exc
        if not isinstance(payload, dict):
            raise BrainRuntimeContractError("BRAIN_RUNTIME.md contract JSON is not an object")
        for field_name, field_type in self._REQUIRED_CONTRACT_FIELDS:
            if not isinstance(payload.get(field_name), field_type):
                raise BrainRuntimeContractError(
                    f"BRAIN_RUNTIME.md contract field invalid: {field_name}"
                )
        return payload

    # ------------------------------------------------------------------ discovery

    def _recent_runtime_files(
        self,
        *,
        directory: str,
        pattern: str,
        limit: int,
        exclude_names: set[str] | None = None,
    ) -> list[tuple[str, Path]]:
        base = self._safe_runtime_path(directory)
        if not base.exists() or not base.is_dir():
            return []
        excluded = exclude_names or set()
        entries: list[tuple[str, Path, float]] = []
        for candidate in base.glob(pattern):
            if candidate.name in excluded:
                continue
            try:
                rel = candidate.relative_to(self._runtime_dir).as_posix()
                self._safe_runtime_path(rel)
                mtime = candidate.lstat().st_mtime
            except OSError:
                continue
            if candidate.is_file() or candidate.is_symlink():
                entries.append((rel, candidate, mtime))
        entries.sort(key=lambda item: item[2], reverse=True)
        return [(rel, path) for rel, path, _mtime in entries[:limit]]

    def _discover_audit_script(self) -> Path | None:
        candidates: list[Path] = []
        if self._audit_script_path is not None:
            candidates.append(self._audit_script_path)
        candidates.extend(
            [
                self._runtime_dir / "brain-runtime-audit.sh",
                self._runtime_dir / "tools-dev" / "brain-runtime-audit.sh",
            ]
        )
        parents = list(self._runtime_dir.parents)
        if len(parents) >= 2:
            candidates.append(parents[1] / "tools-dev" / "brain-runtime-audit.sh")
        for candidate in candidates:
            if candidate.exists() and candidate.is_file():
                return candidate
        return None

    def _run_audit(self) -> dict[str, Any]:
        script = self._discover_audit_script()
        if script is None:
            return {
                "status": "unavailable",
                "available": False,
                "exit_code": None,
                "error_class": None,
                "script_path": None,
                "stdout": None,
                "stderr": None,
            }
        command = [
            "bash",
            script.as_posix(),
            "--root",
            self._runtime_dir.as_posix(),
        ]
        try:
            completed = subprocess.run(
                command,
                cwd=self._runtime_dir.as_posix(),
                capture_output=True,
                text=True,
                timeout=max(0.1, self.timeout_s * 0.8),
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            return {
                "status": "timeout",
                "available": True,
                "exit_code": None,
                "error_class": type(exc).__name__,
                "script_path": script.as_posix(),
                "stdout": self._bounded_redacted_output(exc.stdout),
                "stderr": self._bounded_redacted_output(exc.stderr),
            }
        except OSError as exc:
            return {
                "status": "error",
                "available": True,
                "exit_code": None,
                "error_class": type(exc).__name__,
                "script_path": script.as_posix(),
                "stdout": None,
                "stderr": None,
            }
        return {
            "status": "ok" if completed.returncode == 0 else "error",
            "available": True,
            "exit_code": completed.returncode,
            "error_class": None if completed.returncode == 0 else "AuditFailed",
            "script_path": script.as_posix(),
            "stdout": self._bounded_redacted_output(completed.stdout),
            "stderr": self._bounded_redacted_output(completed.stderr),
        }

    # ------------------------------------------------------------------ read API

    def _sync_status(self, limit: int) -> dict[str, Any]:
        if not self._runtime_dir.exists():
            raise FileNotFoundError(self._runtime_dir.as_posix())
        if not self._runtime_dir.is_dir():
            raise NotADirectoryError(self._runtime_dir.as_posix())

        observed_at = self._now_iso()
        inventory: list[dict[str, Any]] = []
        reads: list[dict[str, Any]] = []

        contract_path = self._safe_runtime_path(self._CONTRACT_PATH)
        contract = self._load_contract_summary(observed_at)
        inventory.append(
            self._inventory_item(
                key=self._CONTRACT_PATH,
                path=contract_path,
                source="runtime_contract",
                observed_at=observed_at,
                content_type="text/markdown",
            )
        )

        for key, source in self._FIXED_MARKDOWN_ARTIFACTS:
            path = self._safe_runtime_path(key)
            inventory.append(
                self._inventory_item(
                    key=key,
                    path=path,
                    source=source,
                    observed_at=observed_at,
                )
            )
            if path.exists():
                reads.append(
                    self._read_record(
                        key=key,
                        path=path,
                        source=source,
                        observed_at=observed_at,
                    )
                )

        collections: tuple[tuple[str, str, str, set[str]], ...] = (
            ("memory/*.md", "memory", "*.md", {"PEDRO_VIDA.md"}),
            ("Braindump/*.md", "Braindump", "*.md", set()),
            ("contatos/*.md", "contatos", "*.md", set()),
        )
        for collection_key, directory, pattern, excluded in collections:
            entries = self._recent_runtime_files(
                directory=directory,
                pattern=pattern,
                limit=limit,
                exclude_names=excluded,
            )
            inventory.append(
                self._collection_inventory(
                    key=collection_key,
                    source="markdown_projection",
                    entries=entries,
                    observed_at=observed_at,
                )
            )
            for rel, path in entries:
                inventory.append(
                    self._inventory_item(
                        key=rel,
                        path=path,
                        source="markdown_projection",
                        observed_at=observed_at,
                    )
                )
                reads.append(
                    self._read_record(
                        key=rel,
                        path=path,
                        source="markdown_projection",
                        observed_at=observed_at,
                    )
                )

        for key, source, content_type in self._STRUCTURED_ARTIFACTS:
            path = self._optional_structured_path(key)
            inventory.append(
                self._inventory_item(
                    key=key,
                    path=path,
                    source=source,
                    observed_at=observed_at,
                    content_type=content_type,
                    display_path=key,
                )
            )

        return {
            "contract": contract,
            "inventory": inventory,
            "reads": reads,
            "audit": self._run_audit(),
            "limits": self.limits_payload(collection_limit=limit),
        }

    async def status(self, *, limit: int = 5) -> BridgeResult:
        """Return BRAIN status, contract summary, inventory, reads, and audit."""
        bounded_limit = max(1, min(int(limit), 50))

        async def _q() -> dict[str, Any]:
            return await asyncio.to_thread(self._sync_status, bounded_limit)

        return await self.safe_read(_q)

    async def read_artifact(self, relative_path: str) -> BridgeResult:
        """Read one bounded artifact by runtime-relative path; never raises."""

        async def _q() -> dict[str, Any]:
            observed_at = self._now_iso()
            path = self._safe_runtime_path(relative_path)
            return await asyncio.to_thread(
                self._read_record,
                key=relative_path,
                path=path,
                source="markdown_projection",
                observed_at=observed_at,
            )

        return await self.safe_read(_q)
