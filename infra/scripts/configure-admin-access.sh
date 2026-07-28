#!/usr/bin/env bash
# Idempotently protect the production admin Pages hostname with Cloudflare Access.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${ACCESS_ADMIN_EMAIL:?ACCESS_ADMIN_EMAIL is required}"

ACCESS_HOSTNAME="${ACCESS_HOSTNAME:-opus8cf-admin.pages.dev}"
ACCESS_VERIFY_HOSTNAME="${ACCESS_VERIFY_HOSTNAME:-$ACCESS_HOSTNAME}"
ACCESS_VERIFY_HOSTNAME="${ACCESS_VERIFY_HOSTNAME#https://}"
ACCESS_VERIFY_HOSTNAME="${ACCESS_VERIFY_HOSTNAME%%/*}"
ACCESS_APP_NAME="${ACCESS_APP_NAME:-Opus8 Admin (${ACCESS_HOSTNAME})}"
ACCESS_POLICY_NAME="${ACCESS_POLICY_NAME:-Opus8 administrator email}"
ACCESS_SESSION_DURATION="${ACCESS_SESSION_DURATION:-8h}"
CF_ZERO_TRUST_TEAM="${CF_ZERO_TRUST_TEAM:-}"

if ! printf '%s' "$ACCESS_HOSTNAME" | grep -qE '^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$'; then
  echo "ERROR invalid-access-hostname"
  exit 10
fi
if ! printf '%s' "$ACCESS_VERIFY_HOSTNAME" | grep -qE '^[a-z0-9.-]+\.[a-z]{2,}$'; then
  echo "ERROR invalid-access-verify-hostname"
  exit 10
fi
if ! printf '%s' "$ACCESS_ADMIN_EMAIL" | grep -qE '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'; then
  echo "ERROR invalid-admin-email"
  exit 11
fi

API_BASE="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

api_call() {
  local method="$1"
  local path="$2"
  local output="$3"
  local payload="${4:-}"
  local status
  local -a args=(
    --silent
    --show-error
    --request "$method"
    --output "$output"
    --write-out '%{http_code}'
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
    --header 'Content-Type: application/json'
  )
  if [ -n "$payload" ]; then
    args+=(--data-binary "@${payload}")
  fi

  status="$(curl "${args[@]}" "${API_BASE}/${path}")"
  if ! [[ "$status" =~ ^2[0-9][0-9]$ ]] || ! jq -e '.success == true' "$output" >/dev/null 2>&1; then
    local message
    message="$(jq -r '[.errors[]?.message] | map(select(length > 0)) | join("; ")' "$output" 2>/dev/null || true)"
    if [ "$status" = "403" ]; then
      echo "ERROR access-api-permission-denied permission=Access:Apps-and-Policies-Write"
    else
      echo "ERROR cloudflare-api method=${method} path=${path} status=${status} message=${message:-unknown}"
    fi
    return 1
  fi
}

echo "STEP access-api"
APPS_JSON="${TMP_DIR}/apps.json"
api_call GET "access/apps?per_page=100" "$APPS_JSON"
echo "OK access-api-authorized"

APP_ID="$(
  jq -r --arg host "$ACCESS_HOSTNAME" '
    .result[]
    | select(
        .domain == $host
        or any(.destinations[]?; .type == "public" and .uri == $host)
      )
    | .id
  ' "$APPS_JSON" | head -n1
)"

if [ -z "$APP_ID" ]; then
  echo "STEP create-access-application"
  APP_BODY="${TMP_DIR}/app-body.json"
  jq -n \
    --arg name "$ACCESS_APP_NAME" \
    --arg host "$ACCESS_HOSTNAME" \
    --arg duration "$ACCESS_SESSION_DURATION" \
    '{
      name: $name,
      type: "self_hosted",
      domain: $host,
      destinations: [{type: "public", uri: $host}],
      session_duration: $duration,
      app_launcher_visible: false,
      allow_authenticate_via_warp: false
    }' > "$APP_BODY"
  APP_JSON="${TMP_DIR}/app.json"
  api_call POST "access/apps" "$APP_JSON" "$APP_BODY"
  APP_ID="$(jq -r '.result.id' "$APP_JSON")"
  echo "OK access-application-created"
else
  echo "OK access-application-exists"
fi

echo "STEP access-policy"
POLICIES_JSON="${TMP_DIR}/policies.json"
api_call GET "access/apps/${APP_ID}/policies?per_page=100" "$POLICIES_JSON"
POLICY_ID="$(
  jq -r --arg name "$ACCESS_POLICY_NAME" \
    '.result[] | select(.name == $name) | .id' "$POLICIES_JSON" | head -n1
)"

CONFLICT_COUNT="$(
  jq --arg name "$ACCESS_POLICY_NAME" '
    [.result[] | select(.name != $name and (.decision == "allow" or .decision == "bypass" or .decision == "non_identity"))]
    | length
  ' "$POLICIES_JSON"
)"
if [ "$CONFLICT_COUNT" -ne 0 ]; then
  echo "ERROR conflicting-permissive-access-policy count=${CONFLICT_COUNT}"
  exit 12
fi

POLICY_BODY="${TMP_DIR}/policy-body.json"
jq -n \
  --arg name "$ACCESS_POLICY_NAME" \
  --arg email "$ACCESS_ADMIN_EMAIL" \
  '{
    name: $name,
    decision: "allow",
    precedence: 1,
    include: [{email: {email: $email}}],
    exclude: [],
    require: []
  }' > "$POLICY_BODY"

POLICY_JSON="${TMP_DIR}/policy.json"
if [ -z "$POLICY_ID" ]; then
  api_call POST "access/apps/${APP_ID}/policies" "$POLICY_JSON" "$POLICY_BODY"
  POLICY_ID="$(jq -r '.result.id' "$POLICY_JSON")"
  echo "OK access-policy-created"
else
  api_call PUT "access/apps/${APP_ID}/policies/${POLICY_ID}" "$POLICY_JSON" "$POLICY_BODY"
  echo "OK access-policy-updated"
fi

echo "STEP verify-access-configuration"
VERIFY_APP_JSON="${TMP_DIR}/verify-app.json"
VERIFY_POLICY_JSON="${TMP_DIR}/verify-policy.json"
api_call GET "access/apps/${APP_ID}" "$VERIFY_APP_JSON"
api_call GET "access/apps/${APP_ID}/policies/${POLICY_ID}" "$VERIFY_POLICY_JSON"
jq -e --arg host "$ACCESS_HOSTNAME" '
  .result.type == "self_hosted"
  and (
    .result.domain == $host
    or any(.result.destinations[]?; .type == "public" and .uri == $host)
  )
' "$VERIFY_APP_JSON" >/dev/null
jq -e --arg email "$ACCESS_ADMIN_EMAIL" '
  .result.decision == "allow"
  and any(.result.include[]?; .email.email == $email)
' "$VERIFY_POLICY_JSON" >/dev/null
echo "OK access-configuration-verified"

echo "STEP verify-access-challenge"
CHALLENGE_OK=0
for attempt in $(seq 1 30); do
  HEADERS="${TMP_DIR}/challenge-${attempt}.headers"
  STATUS="$(
    curl --silent --show-error \
      --output /dev/null \
      --dump-header "$HEADERS" \
      --write-out '%{http_code}' \
      "https://${ACCESS_VERIFY_HOSTNAME}/"
  )"
  LOCATION="$(tr -d '\r' < "$HEADERS" | awk 'BEGIN{IGNORECASE=1} /^location:/{sub(/^[^:]+:[[:space:]]*/, ""); print; exit}')"
  if [ "$STATUS" = "302" ] \
    && printf '%s' "$LOCATION" | grep -qE '^https://[^/]+\.cloudflareaccess\.com/'; then
    if [ -z "$CF_ZERO_TRUST_TEAM" ] \
      || printf '%s' "$LOCATION" | grep -q "https://${CF_ZERO_TRUST_TEAM}.cloudflareaccess.com/"; then
      CHALLENGE_OK=1
      break
    fi
  fi
  sleep 5
done

if [ "$CHALLENGE_OK" -ne 1 ]; then
  echo "ERROR access-challenge-not-active"
  exit 13
fi

echo "OK access-challenge-active"
echo "DONE hostname=${ACCESS_HOSTNAME} policy=email-only session=${ACCESS_SESSION_DURATION}"
