# Caio BRAIN Cockpit Operations

This runbook covers the read-only BRAIN surface exposed by the Cockpit backend.

## Contract

- Source of truth is the local-first Caio runtime governed by
  `BRAIN_RUNTIME.md` in the runtime root.
- AI consumers must use structured `BrainRead` semantics: every useful read is
  represented with `provenance` and `freshness`. Do not scrape Obsidian, iCloud,
  vault directories, `active-memory`, or `memory-wiki`.
- Markdown is a projection/cache/contract artifact for humans and bounded
  previews. It is not the primary BRAIN API.
- The Cockpit is read-only. It exposes `GET /api/v1/caio/brain/status` and
  `GET /api/v1/caio/brain/summary`; both return the same safe envelope. There
  is no BRAIN write path.
- If BRAIN is unavailable, diagnose the bridge status. Do not fall back to
  iCloud, Obsidian, vault scraping, `active-memory`, or `memory-wiki`.

## Configure

For Docker Compose, bind only the Caio runtime root, read-only:

```bash
export CAIO_BRAIN_RUNTIME_HOST_DIR="$HOME/.openclaw/workspaces/caio-runtime"
export CAIO_BRAIN_RUNTIME_DIR="/data/caio-brain-runtime"
export CAIO_BRIDGE_BRAIN_ENABLED=true
```

The compose service mounts:

```text
${CAIO_BRAIN_RUNTIME_HOST_DIR:-/dev/null}:/data/caio-brain-runtime:ro
```

Do not mount broader `~/.openclaw` directories just to make BRAIN work.

## Audit

Run the runtime audit against the real local-first runtime:

```bash
bash ~/.openclaw/tools/brain-runtime-audit.sh \
  --root "$HOME/.openclaw/workspaces/caio-runtime"
```

Exit `0` means the contract, boundary terms, allowlist, backup-critical areas,
and denied fallback references passed. Non-zero output is an operator finding;
fix the runtime contract/state rather than adding Cockpit fallbacks.

## Local Smoke

Fixture smoke, no real runtime access:

```bash
make brain-smoke
```

Real runtime smoke through the in-process backend app:

```bash
make brain-smoke \
  BRAIN_SMOKE_ARGS="--runtime-dir $HOME/.openclaw/workspaces/caio-runtime"
```

Running backend smoke:

```bash
export BRAIN_SMOKE_BEARER_TOKEN="$LOCAL_AUTH_TOKEN"
make brain-smoke BRAIN_SMOKE_ARGS="--base-url http://127.0.0.1:${BACKEND_PORT:-8000}"
```

The smoke fetches `/api/v1/caio/brain/summary`. Fixture mode proves the response
has `BrainRead` records with `provenance` and `freshness`, and that secrets in
fixture free text are redacted.

## Status Meanings

| Status | Meaning | Operator action |
| --- | --- | --- |
| `ok` | Runtime is enabled and the read envelope was built. | Review `contract`, `inventory`, `reads`, `audit`, and `limits`. |
| `disabled` | Bridge flag is off or no runtime dir is configured. | Set `CAIO_BRIDGE_BRAIN_ENABLED=true` and `CAIO_BRAIN_RUNTIME_DIR` if BRAIN should be visible. |
| `error` | Enabled bridge hit an I/O/contract/audit error. HTTP still returns 200 with `error_class`. | Inspect `error_class`, run the audit, and verify the read-only mount points at the runtime root. |
| `timeout` | The bridge exceeded `CAIO_BRIDGE_BRAIN_TIMEOUT_S`. | Check filesystem/audit latency before raising the timeout. |
| `circuit_open` | Repeated recent failures opened the per-bridge circuit breaker. | Fix the underlying failures; the breaker closes after its window. |

## Container Proof

The backend image runs as `appuser`, not root. With a real runtime mounted
read-only:

```bash
export AUTH_MODE=local
export LOCAL_AUTH_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export BASE_URL=http://localhost:8000
export CAIO_BRAIN_RUNTIME_HOST_DIR="$HOME/.openclaw/workspaces/caio-runtime"

docker compose -f compose.yml --env-file .env up -d --build backend

docker compose -f compose.yml --env-file .env exec backend sh -lc '
  test "$(id -u)" != "0"
  test ! -w /data/caio-brain-runtime
'
```

To prove diagnostic degradation without a 500, point the mount at `/dev/null`
or another non-directory and fetch the summary:

```bash
export AUTH_MODE=local
export LOCAL_AUTH_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export BASE_URL=http://localhost:8000
export CAIO_BRAIN_RUNTIME_HOST_DIR=/dev/null

docker compose -f compose.yml --env-file .env up -d --build backend

curl -sS -H "Authorization: Bearer $LOCAL_AUTH_TOKEN" \
  "http://127.0.0.1:${BACKEND_PORT:-8000}/api/v1/caio/brain/summary?limit=5" |
  python3 -m json.tool
```

Expected result is HTTP `200` with `status="error"` and an `error_class` such
as `NotADirectoryError`, not a backend `500`.
