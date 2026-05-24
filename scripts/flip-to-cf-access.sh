#!/usr/bin/env bash
# Flip the running cockpit stack from AUTH_MODE=local to AUTH_MODE=cf_access.
#
# What it does:
#   1. Triggers cloudflared access login (browser opens — log in once).
#   2. Reads the JWT and extracts the AUD claim (the per-app audience tag).
#   3. Updates ~/dev/caio-cockpit/.env with CF_ACCESS_* + COCKPIT_WORKER_TOKEN.
#   4. Rebuilds + restarts backend & frontend containers.
#   5. Updates the launchd plist of the cockpit-decision-worker with the new
#      COCKPIT_WORKER_TOKEN and reloads it.
#   6. Prints a smoke test you can run from the iPhone.
#
# Idempotent: re-run safely.

set -euo pipefail

ENV_FILE="$HOME/dev/caio-cockpit/.env"
COMPOSE_DIR="$HOME/dev/caio-cockpit"
WORKER_PLIST="$HOME/Library/LaunchAgents/ai.openclaw.cockpit-decision-worker.plist"
ALLOWED_EMAILS="${CF_ACCESS_ALLOWED_EMAILS:-pedro.braga.2007@gmail.com}"
APP_URL="https://cockpit-spike.ocaio.app"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

# --- 1 + 2: get AUD from a CF Access JWT --------------------------------------

echo "→ Triggering cloudflared access login (browser opens; log in once)…"
cloudflared access login "$APP_URL/" >/dev/null 2>&1 || {
  echo "WARN: cloudflared login returned non-zero; will try to read existing token anyway."
}

TOKEN="$(cloudflared access token --app "$APP_URL/" 2>/dev/null | tr -d '\n')"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: could not obtain CF Access token. Run 'cloudflared access login $APP_URL/' manually first." >&2
  exit 2
fi

decode_b64url() {
  local p="${1//-/+}"
  p="${p//_//}"
  local pad=$(( (4 - ${#p} % 4) % 4 ))
  for ((i=0; i<pad; i++)); do p="${p}="; done
  printf '%s' "$p" | base64 -D 2>/dev/null || printf '%s' "$p" | base64 -d
}

PAYLOAD_B64="$(printf '%s' "$TOKEN" | cut -d. -f2)"
PAYLOAD_JSON="$(decode_b64url "$PAYLOAD_B64")"
AUD="$(printf '%s' "$PAYLOAD_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); a=d["aud"]; print(a[0] if isinstance(a,list) else a)')"
TEAM_DOMAIN="$(printf '%s' "$PAYLOAD_JSON" | python3 -c 'import json,sys,urllib.parse as u; d=json.load(sys.stdin); h=u.urlparse(d["iss"]).hostname; print(h.split(".",1)[0])')"

if [[ -z "$AUD" || -z "$TEAM_DOMAIN" ]]; then
  echo "ERROR: parsed empty AUD ('$AUD') or team_domain ('$TEAM_DOMAIN'). Payload: $PAYLOAD_JSON" >&2
  exit 3
fi
echo "  ✓ team_domain=$TEAM_DOMAIN"
echo "  ✓ aud=$AUD"

# --- 3: update .env -----------------------------------------------------------

# Generate worker token if not already set in .env
if ! grep -q '^COCKPIT_WORKER_TOKEN=.\{50,\}' "$ENV_FILE"; then
  WORKER_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  echo "  ✓ generated COCKPIT_WORKER_TOKEN ($(echo -n "$WORKER_TOKEN" | wc -c | tr -d ' ') chars)"
else
  WORKER_TOKEN="$(grep '^COCKPIT_WORKER_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  echo "  ✓ keeping existing COCKPIT_WORKER_TOKEN from .env"
fi

# Backup .env once per day
cp -n "$ENV_FILE" "${ENV_FILE}.pre-cf-access-$(date +%Y%m%d)" 2>/dev/null || true

upsert_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # macOS sed -i requires '' as the in-place backup arg
    sed -i '' "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

upsert_env AUTH_MODE cf_access
upsert_env CF_ACCESS_TEAM_DOMAIN "$TEAM_DOMAIN"
upsert_env CF_ACCESS_AUDIENCE "$AUD"
upsert_env CF_ACCESS_ALLOWED_EMAILS "$ALLOWED_EMAILS"
upsert_env COCKPIT_WORKER_TOKEN "$WORKER_TOKEN"

echo "  ✓ .env updated (AUTH_MODE=cf_access, CF_ACCESS_*, COCKPIT_WORKER_TOKEN)"

# --- 4: rebuild + restart stack ----------------------------------------------

echo "→ Restarting backend + frontend containers…"
(
  cd "$COMPOSE_DIR"
  docker compose up -d --build backend frontend
) >/dev/null
echo "  ✓ containers up"

# --- 5: update worker plist + reload -----------------------------------------

if [[ -f "$WORKER_PLIST" ]]; then
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:COCKPIT_WORKER_TOKEN $WORKER_TOKEN" "$WORKER_PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:COCKPIT_WORKER_TOKEN string $WORKER_TOKEN" "$WORKER_PLIST"
  launchctl bootout "gui/$(id -u)" "$WORKER_PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$WORKER_PLIST"
  echo "  ✓ worker plist updated + reloaded"
else
  echo "  ⚠ worker plist not found at $WORKER_PLIST — skip worker reload"
fi

# --- 6: smoke ----------------------------------------------------------------

cat <<EOF

✅ Flip complete.

Smoke test:
  • iPhone Safari (cellular):  $APP_URL/caio
    Expect: CF Access magic-link prompt if cookie expired; then /caio loads
    WITHOUT any bearer-paste prompt. 3 tabs render normally.
  • Worker self-test:
      curl -s -X POST -H "X-Cockpit-Worker-Token: $WORKER_TOKEN" \\
        http://127.0.0.1:8001/api/v1/caio/think-loop/decisions/__nope__/start -i | head -2
    Expect 409 ('no decision exists') or 401 if config not picked up.
  • Backend logs:
      docker logs openclaw-mission-control-backend-1 --since 1m | grep -iE 'cf_access|auth'

To roll back:
  sed -i '' 's|^AUTH_MODE=cf_access|AUTH_MODE=local|' $ENV_FILE
  (cd $COMPOSE_DIR && docker compose up -d backend frontend)
EOF
