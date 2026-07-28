#!/usr/bin/env bash
# Discover Cloudflare anycast candidates, then publish only addresses that pass
# real VLESS-over-WebSocket checks from both GitHub and the landing VPS.
set -euo pipefail

WS="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$WS"

: "${CONTROL_PLANE_URL:?CONTROL_PLANE_URL is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
: "${VPS_HOST:?VPS_HOST is required for two-vantage validation}"
: "${VPS_SSH_USER:?VPS_SSH_USER is required for two-vantage validation}"
: "${VPS_SSH_PASSWORD:?VPS_SSH_PASSWORD is required for two-vantage validation}"

VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
WORK_DIR="$(mktemp -d)"
ADMIN_TOKEN=""
USER_ID=""
REMOTE_READY=0
REMOTE_SMOKE_PATH=""
SSH_BASE=()
SCP_BASE=()

cleanup() {
  if [ -n "$USER_ID" ] && [ -n "$ADMIN_TOKEN" ]; then
    curl -fsS --max-time 20 -X DELETE \
      "$CONTROL_PLANE_URL/api/users/$USER_ID" \
      -H "authorization: Bearer $ADMIN_TOKEN" >/dev/null 2>&1 || true
  fi
  if [ "$REMOTE_READY" = "1" ] && [ -n "$REMOTE_SMOKE_PATH" ]; then
    "${SSH_BASE[@]}" "rm -f -- '$REMOTE_SMOKE_PATH'" >/dev/null 2>&1 || true
  fi
  case "$WORK_DIR" in
    /tmp/*) rm -rf -- "$WORK_DIR" ;;
  esac
}
trap cleanup EXIT

echo "STEP prepare-vantages"
command -v sshpass >/dev/null 2>&1 || {
  echo "ERROR sshpass-not-installed"
  exit 10
}
export SSHPASS="$VPS_SSH_PASSWORD"
SSH_BASE=(
  sshpass -e ssh
  -p "$VPS_SSH_PORT"
  -o ConnectTimeout=12
  -o StrictHostKeyChecking=accept-new
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=2
  "$VPS_SSH_USER@$VPS_HOST"
)
SCP_BASE=(
  sshpass -e scp
  -P "$VPS_SSH_PORT"
  -o ConnectTimeout=12
  -o StrictHostKeyChecking=accept-new
)
REMOTE_TAG="$(printf '%s' "${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}" |
  tr -cd 'A-Za-z0-9._-')"
REMOTE_SMOKE_PATH="/tmp/opus8-optimize-smoke-${REMOTE_TAG}.py"
if ! "${SSH_BASE[@]}" 'command -v python3 >/dev/null' >/dev/null 2>&1 ||
  ! "${SCP_BASE[@]}" infra/scripts/smoke-vless.py \
    "$VPS_SSH_USER@$VPS_HOST:$REMOTE_SMOKE_PATH" >/dev/null 2>&1; then
  echo "ERROR landing-vps-vantage-unavailable"
  exit 10
fi
REMOTE_READY=1
echo "OK vantages=github-runner,landing-vps"

echo "STEP login"
LOGIN_RESPONSE="$(curl -fsS --max-time 20 -X POST \
  "$CONTROL_PLANE_URL/api/admin/login" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg password "$ADMIN_PASSWORD" '{password:$password}')")"
ADMIN_TOKEN="$(printf '%s' "$LOGIN_RESPONSE" | jq -er '.token')"
echo "::add-mask::$ADMIN_TOKEN"
echo "OK login"

echo "STEP representative-nodes"
NODES_RESPONSE="$(curl -fsS --max-time 20 "$CONTROL_PLANE_URL/api/nodes" \
  -H "authorization: Bearer $ADMIN_TOKEN")"
mapfile -t REPRESENTATIVES < <(
  printf '%s' "$NODES_RESPONSE" |
    jq -er '
      [.nodes[] | select(.enabled == 1 and .health != "banned")] |
      sort_by(.account_alias,.id) |
      group_by(.account_alias) |
      map(.[0]) |
      .[] |
      [.id,.hostname] | @tsv'
)
if [ "${#REPRESENTATIVES[@]}" -lt 2 ]; then
  echo "ERROR fewer-than-two-account-representatives"
  exit 11
fi
REPRESENTATIVE_IDS="$(
  printf '%s\n' "${REPRESENTATIVES[@]}" |
    cut -f1 |
    jq -R . |
    jq -sc .
)"
echo "OK representative-nodes count=${#REPRESENTATIVES[@]}"

echo "STEP create-isolated-probe-user"
PROBE_USERNAME="__optimize__-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
CREATE_RESPONSE="$(curl -fsS --max-time 30 -X POST \
  "$CONTROL_PLANE_URL/api/users" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data "$(jq -nc \
    --arg username "$PROBE_USERNAME" \
    --argjson nodeGroup "$REPRESENTATIVE_IDS" \
    '{username:$username,nodeGroup:$nodeGroup,durationDays:1,unlock:false,deviceLimit:20,ipLimit24h:100}')")"
USER_ID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.user.id')"
PROBE_UUID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.user.uuid')"
echo "::add-mask::$USER_ID"
echo "::add-mask::$PROBE_UUID"
echo "OK probe-user-created"
sleep 8

echo "STEP discover-candidates"
RAW_IPS="$WORK_DIR/raw-ips.txt"
if [ -s "$WS/infra/optimized-ips.txt" ]; then
  sed 's/#.*//' "$WS/infra/optimized-ips.txt" >"$RAW_IPS"
  echo "OK candidate-source=custom-list"
else
  if ! curl -fsSL \
    https://github.com/XIU2/CloudflareSpeedTest/releases/latest/download/cfst_linux_amd64.tar.gz \
    -o "$WORK_DIR/cfst.tgz"; then
    echo "ERROR cfst-download"
    exit 12
  fi
  mkdir -p "$WORK_DIR/cfst"
  tar xzf "$WORK_DIR/cfst.tgz" -C "$WORK_DIR/cfst"
  BIN="$(find "$WORK_DIR/cfst" -maxdepth 3 -type f |
    grep -iE '(cloudflarest|cfst)$' |
    head -n1 || true)"
  if [ -z "$BIN" ]; then
    echo "ERROR cfst-binary-not-found"
    find "$WORK_DIR/cfst" -maxdepth 3 -type f -printf 'INFO archive-file=%P\n' |
      head -n 20
    exit 12
  fi
  chmod +x "$BIN"
  if ! curl -fsSL https://www.cloudflare.com/ips-v4 \
    -o "$WORK_DIR/cfst/ip.txt"; then
    echo "ERROR cloudflare-ip-ranges-download"
    exit 13
  fi
  if ! (
    cd "$WORK_DIR/cfst"
    "$BIN" -dd -tp 443 -n 200 -t 4 -o result.csv
  ) >"$WORK_DIR/cfst.log" 2>&1; then
    echo "ERROR speedtest"
    tail -n 5 "$WORK_DIR/cfst.log"
    exit 13
  fi
  tail -n +2 "$WORK_DIR/cfst/result.csv" | cut -d, -f1 >"$RAW_IPS"
  echo "OK candidate-source=cfst"
fi

mapfile -t CANDIDATES < <(
  python3 - "$RAW_IPS" <<'PY'
import ipaddress
import sys

seen = set()
for raw in open(sys.argv[1], encoding="utf-8"):
    candidate = raw.strip()
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        continue
    if address.version != 4 or candidate in seen:
        continue
    seen.add(candidate)
    print(candidate)
    if len(seen) >= 5:
        break
PY
)
if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "ERROR no-valid-candidates"
  exit 14
fi
echo "OK candidates count=${#CANDIDATES[@]}"

local_candidate_ok() {
  local ip="$1" entry node_id node_host reason
  for entry in "${REPRESENTATIVES[@]}"; do
    IFS=$'\t' read -r node_id node_host <<<"$entry"
    if ! python3 infra/scripts/smoke-vless.py \
      --url "wss://${node_host}/?ed=2560" \
      --connect-host "$ip" \
      --uuid "$PROBE_UUID" \
      --target example.com \
      --target-port 80 \
      --expect-status 0 \
      --timeout 12 >"$WORK_DIR/local-candidate.log" 2>&1; then
      reason="$(tail -n 1 "$WORK_DIR/local-candidate.log" |
        tr '\r\n\t' ' ' |
        cut -c1-300)"
      echo "WARN candidate=$ip vantage=github-runner node=$node_id reason=$reason"
      return 1
    fi
  done
}

remote_candidate_ok() {
  local ip="$1" entry node_id node_host remote_command reason
  for entry in "${REPRESENTATIVES[@]}"; do
    IFS=$'\t' read -r node_id node_host <<<"$entry"
    printf -v remote_command '%q ' \
      python3 "$REMOTE_SMOKE_PATH" \
      --url "wss://${node_host}/?ed=2560" \
      --connect-host "$ip" \
      --uuid "$PROBE_UUID" \
      --target example.com \
      --target-port 80 \
      --expect-status 0 \
      --timeout 12
    if ! "${SSH_BASE[@]}" "$remote_command" >"$WORK_DIR/remote-candidate.log" 2>&1; then
      reason="$(tail -n 1 "$WORK_DIR/remote-candidate.log" |
        tr '\r\n\t' ' ' |
        cut -c1-300)"
      echo "WARN candidate=$ip vantage=landing-vps node=$node_id reason=$reason"
      return 1
    fi
  done
}

echo "STEP validate-candidates"
VALIDATED=()
for ip in "${CANDIDATES[@]}"; do
  if local_candidate_ok "$ip" && remote_candidate_ok "$ip"; then
    VALIDATED+=("$ip")
    echo "OK candidate=$ip vantages=2 representatives=${#REPRESENTATIVES[@]}"
  fi
  [ "${#VALIDATED[@]}" -ge 3 ] && break
done
if [ "${#VALIDATED[@]}" -eq 0 ]; then
  echo "ERROR no-candidate-passed-two-vantage-vless"
  exit 15
fi

echo "STEP push-to-control"
NOW_MS="$(date +%s%3N)"
EXPIRES_MS=$((NOW_MS + 8 * 60 * 60 * 1000))
IPS_JSON="$(printf '%s\n' "${VALIDATED[@]}" | jq -R . | jq -sc .)"
BODY="$(jq -nc \
  --argjson ips "$IPS_JSON" \
  --argjson validatedAt "$NOW_MS" \
  --argjson expiresAt "$EXPIRES_MS" \
  --argjson nodeIds "$REPRESENTATIVE_IDS" \
  '{
    version:2,
    ips:$ips,
    validatedAt:$validatedAt,
    expiresAt:$expiresAt,
    vantages:["github-runner","landing-vps"],
    nodeIds:$nodeIds
  }')"
RESPONSE="$(curl -fsS --max-time 20 -X POST \
  "$CONTROL_PLANE_URL/api/optimized-ips" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data "$BODY")"
printf '%s' "$RESPONSE" | jq -e '.ok == true' >/dev/null
echo "OK pushed count=${#VALIDATED[@]} expiresHours=8"
echo "DONE"
