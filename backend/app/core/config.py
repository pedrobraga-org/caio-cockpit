"""Application settings and environment configuration loading."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Self
from urllib.parse import urlparse

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.core.auth_mode import AuthMode
from app.core.rate_limit_backend import RateLimitBackend

BACKEND_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ENV_FILE = BACKEND_ROOT / ".env"
LOCAL_AUTH_TOKEN_MIN_LENGTH = 50
LOCAL_AUTH_TOKEN_PLACEHOLDERS = frozenset(
    {
        "change-me",
        "changeme",
        "replace-me",
        "replace-with-strong-random-token",
    },
)
COCKPIT_WORKER_TOKEN_MIN_LENGTH = 50
_TEAM_DOMAIN_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


class Settings(BaseSettings):
    """Typed runtime configuration sourced from environment variables."""

    model_config = SettingsConfigDict(
        # Load `backend/.env` regardless of current working directory.
        # (Important when running uvicorn from repo root or via a process manager.)
        env_file=[DEFAULT_ENV_FILE, ".env"],
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: str = "dev"
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/openclaw_agency"

    # Auth mode: "clerk" for Clerk JWT auth, "local" for shared bearer token
    # auth, "cf_access" for Cloudflare Access JWT validation.
    auth_mode: AuthMode
    local_auth_token: str = ""

    # Clerk auth (auth only; roles stored in DB)
    clerk_secret_key: str = ""
    clerk_api_url: str = "https://api.clerk.com"
    clerk_verify_iat: bool = True
    clerk_leeway: float = 10.0

    # Cloudflare Access (used when AUTH_MODE=cf_access)
    cf_access_team_domain: str = ""
    cf_access_audience: str = ""
    cf_access_allowed_emails: str = ""  # comma-separated, case-insensitive
    cf_access_jwks_cache_ttl_s: int = 3600
    cf_access_jwks_refresh_cooldown_s: int = 60
    cf_access_jwks_fetch_timeout_s: float = 3.0

    # Service-to-service token for cockpit_bridge worker calling
    # /think-loop/decisions/{id}/start and /complete. Required when
    # AUTH_MODE=cf_access (worker can't obtain a CF Access JWT directly).
    # Header: X-Cockpit-Worker-Token: <value>
    cockpit_worker_token: str = ""

    @field_validator("cf_access_team_domain")
    @classmethod
    def _validate_team_domain(cls, v: str) -> str:
        if v and not _TEAM_DOMAIN_RE.fullmatch(v):
            raise ValueError(
                "CF_ACCESS_TEAM_DOMAIN must be a Cloudflare team slug "
                "(lowercase alphanumeric + hyphens, e.g. 'my-team-slug') — "
                "not a full URL or hostname.",
            )
        return v

    @property
    def cf_access_allowed_emails_set(self) -> frozenset[str]:
        return frozenset(
            e.strip().lower()
            for e in self.cf_access_allowed_emails.split(",")
            if e.strip()
        )

    cors_origins: str = ""
    base_url: str = ""

    # Security response headers (set to blank to disable a specific header)
    security_header_x_content_type_options: str = "nosniff"
    security_header_x_frame_options: str = "DENY"
    security_header_referrer_policy: str = "strict-origin-when-cross-origin"
    security_header_permissions_policy: str = ""

    # Webhook payload size limit in bytes (default 1 MB).
    webhook_max_payload_bytes: int = 1_048_576

    # Rate limiting
    rate_limit_backend: RateLimitBackend = RateLimitBackend.MEMORY
    rate_limit_redis_url: str = ""

    # Trusted reverse-proxy IPs/CIDRs for client-IP extraction from
    # Forwarded / X-Forwarded-For headers.  Comma-separated.
    # Leave empty to always use the direct peer address.
    trusted_proxies: str = ""

    # Database lifecycle
    db_auto_migrate: bool = False

    # RQ queueing / dispatch
    rq_redis_url: str = "redis://localhost:6379/0"
    rq_queue_name: str = "default"
    rq_dispatch_throttle_seconds: float = 15.0
    rq_dispatch_max_retries: int = 3
    rq_dispatch_retry_base_seconds: float = 10.0
    rq_dispatch_retry_max_seconds: float = 120.0

    # OpenClaw gateway runtime compatibility
    gateway_min_version: str = "2026.02.9"

    # Caio operational data bridges (read-only)
    # Path inside the container where ~/.openclaw/state is bind-mounted.
    # Empty string disables all Caio bridges (and the /api/v1/caio/* endpoints
    # degrade gracefully with status="disabled").
    caio_state_dir: str = ""
    caio_bridge_events_enabled: bool = True
    caio_bridge_critiques_enabled: bool = True
    caio_bridge_timeout_s: float = 2.0

    # Caio BRAIN runtime bridge (read-only). This is a local-first read model
    # over the runtime contract; empty runtime_dir disables /caio/brain/*.
    caio_brain_runtime_dir: str = ""
    caio_bridge_brain_enabled: bool = True
    caio_bridge_brain_timeout_s: float = 2.0
    caio_brain_audit_script_path: str = ""
    caio_brain_lcm_db_path: str = ""
    caio_brain_facts_path: str = ""

    # WhatsApp pipeline V3 Postgres bridge (read-only). The DSN must point at
    # a SELECT-only role (``cockpit_ro``); see docs/cockpit_ro.sql for the
    # bootstrap script. Empty string disables the bridge and the /wa/*
    # endpoints degrade to ``status=disabled``.
    webhook_database_url: str = ""
    caio_bridge_wa_enabled: bool = True
    caio_bridge_wa_timeout_s: float = 3.0

    # V1.1 Cockpit approve/reject mode. Hard-locked to "mark_only": writing a
    # decision only updates the Cockpit DB and NEVER dispatches downstream into
    # Caio's pipelines (#wa-aprovacoes, OpenClaw gateway, events.sqlite, etc).
    # V2 will introduce "mark_and_execute" behind an idempotency + audit guard.
    cockpit_approve_mode: str = "mark_only"

    # Logging
    log_level: str = "INFO"
    log_format: str = "text"
    log_use_utc: bool = False
    request_log_slow_ms: int = Field(default=1000, ge=0)
    request_log_include_health: bool = False

    @model_validator(mode="after")
    def _defaults(self) -> Self:
        if self.auth_mode == AuthMode.CLERK:
            if not self.clerk_secret_key.strip():
                raise ValueError(
                    "CLERK_SECRET_KEY must be set and non-empty when AUTH_MODE=clerk.",
                )
        elif self.auth_mode == AuthMode.LOCAL:
            token = self.local_auth_token.strip()
            if (
                not token
                or len(token) < LOCAL_AUTH_TOKEN_MIN_LENGTH
                or token.lower() in LOCAL_AUTH_TOKEN_PLACEHOLDERS
            ):
                raise ValueError(
                    "LOCAL_AUTH_TOKEN must be at least 50 characters and non-placeholder when AUTH_MODE=local.",
                )
        elif self.auth_mode == AuthMode.CF_ACCESS:
            if not self.cf_access_team_domain:
                raise ValueError(
                    "CF_ACCESS_TEAM_DOMAIN must be set when AUTH_MODE=cf_access.",
                )
            if not self.cf_access_audience.strip():
                raise ValueError(
                    "CF_ACCESS_AUDIENCE must be set when AUTH_MODE=cf_access.",
                )
            if not self.cf_access_allowed_emails_set:
                raise ValueError(
                    "CF_ACCESS_ALLOWED_EMAILS must list at least one email "
                    "when AUTH_MODE=cf_access.",
                )
            worker_token = self.cockpit_worker_token.strip()
            if not worker_token or len(worker_token) < COCKPIT_WORKER_TOKEN_MIN_LENGTH:
                raise ValueError(
                    "COCKPIT_WORKER_TOKEN must be at least 50 characters when "
                    "AUTH_MODE=cf_access. Used by the cockpit_bridge worker "
                    "to call /think-loop/decisions/{id}/start and /complete. "
                    "Generate via: python -c 'import secrets; "
                    "print(secrets.token_urlsafe(48))'",
                )

        base_url = self.base_url.strip()
        if not base_url:
            raise ValueError("BASE_URL must be set and non-empty.")
        parsed_base_url = urlparse(base_url)
        if parsed_base_url.scheme not in {"http", "https"} or not parsed_base_url.netloc:
            raise ValueError(
                "BASE_URL must be an absolute http(s) URL (e.g. http://localhost:8000).",
            )
        self.base_url = base_url.rstrip("/")

        # Rate-limit: fall back to rq_redis_url if using redis backend
        # with no explicit rate-limit URL. If both are blank, fail fast
        # with a clear configuration error.
        if (
            self.rate_limit_backend == RateLimitBackend.REDIS
            and not self.rate_limit_redis_url.strip()
        ):
            fallback_url = self.rq_redis_url.strip()
            if not fallback_url:
                raise ValueError(
                    "RATE_LIMIT_REDIS_URL or RQ_REDIS_URL must be set and non-empty "
                    "when RATE_LIMIT_BACKEND=redis.",
                )
            self.rate_limit_redis_url = fallback_url

        # In dev, default to applying Alembic migrations at startup to avoid
        # schema drift (e.g. missing newly-added columns).
        if "db_auto_migrate" not in self.model_fields_set and self.environment == "dev":
            self.db_auto_migrate = True
        return self


settings = Settings()
