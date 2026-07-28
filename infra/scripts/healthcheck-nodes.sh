#!/usr/bin/env bash
# Real end-to-end VLESS checks. Direct failures can remove a node from
# subscriptions; landing-only failures are reported as degraded.
set -euo pipefail

cd "$(dirname "$0")/../.."

: "${ROOT_DOMAIN:?ROOT_DOMAIN is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

ROOT_DOMAIN="${ROOT_DOMAIN#https://}"
ROOT_DOMAIN="${ROOT_DOMAIN#http://}"
ROOT_DOMAIN="${ROOT_DOMAIN%%/*}"
CONTROL_API="${CONTROL_PLANE_URL:-https://api.${ROOT_DOMAIN}}"
RUN_ID="gh-${GITHUB_RUN_ID:-manual-$(date +%s)}-${GITHUB_RUN_ATTEMPT:-1}"
WORK_DIR="$(mktemp -d)"
USER_ID=""
ADMIN_TOKEN=""

cleanup() {
  if [ -n "$USER_ID" ] && [ -n "$ADMIN_TOKEN" ]; then
    curl -fsS --max-time 20 -X DELETE \
      "$CONTROL_API/api/users/$USER_ID" \
      -H "authorization: Bearer $ADMIN_TOKEN" >/dev/null 2>&1 || true
  fi
  case "$WORK_DIR" in
    /tmp/*) rm -rf -- "$WORK_DIR" ;;
  esac
}
trap cleanup EXIT

echo "STEP login"
LOGIN_RESPONSE="$(curl -fsS --max-time 20 -X POST \
  "$CONTROL_API/api/admin/login" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg password "$ADMIN_PASSWORD" '{password:$password}')")"
ADMIN_TOKEN="$(printf '%s' "$LOGIN_RESPONSE" | jq -er '.token')"
echo "::add-mask::$ADMIN_TOKEN"
echo "OK login"

echo "STEP create-isolated-probe-user"
PROBE_USERNAME="__healthcheck__-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
CREATE_RESPONSE="$(curl -fsS --max-time 30 -X POST \
  "$CONTROL_API/api/users" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data "$(jq -nc \
    --arg username "$PROBE_USERNAME" \
    '{username:$username,durationDays:1,unlock:true,deviceLimit:20,ipLimit24h:100}')")"
USER_ID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.user.id')"
PROBE_UUID="$(printf '%s' "$CREATE_RESPONSE" | jq -er '.user.uuid')"
echo "::add-mask::$USER_ID"
echo "::add-mask::$PROBE_UUID"
echo "OK probe-user-created"

# User mutations publish cache invalidations to every registered node. A short
# grace period also covers eventual propagation between Cloudflare locations.
sleep 8

NODES_RESPONSE="$(curl -fsS --max-time 20 "$CONTROL_API/api/nodes" \
  -H "authorization: Bearer $ADMIN_TOKEN")"
mapfile -t NODES < <(
  printf '%s' "$NODES_RESPONSE" |
    jq -er '.nodes[] | select(.enabled == 1) | [.id,.hostname] | @tsv'
)
if [ "${#NODES[@]}" -eq 0 ]; then
  echo "ERROR no-enabled-nodes"
  exit 10
fi
echo "OK enabled-nodes count=${#NODES[@]}"

probe() {
  local node_id="$1" probe_name="$2" host="$3" target="$4"
  local attempt started ended code log_file
  PROBE_OK=false
  PROBE_LATENCY=null
  PROBE_ERROR=""
  log_file="$WORK_DIR/probe.log"

  for attempt in 1 2; do
    started="$(date +%s%3N)"
    set +e
    python3 infra/scripts/smoke-vless.py \
      --url "wss://${host}/?ed=2560" \
      --uuid "$PROBE_UUID" \
      --target "$target" \
      --target-port 80 \
      --expect-status 0 \
      --timeout 18 >"$log_file" 2>&1
    code=$?
    set -e
    ended="$(date +%s%3N)"
    if [ "$code" -eq 0 ]; then
      PROBE_OK=true
      PROBE_LATENCY=$((ended - started))
      PROBE_ERROR=""
      echo "OK probe node=$node_id route=$probe_name latencyMs=$PROBE_LATENCY"
      return
    fi
    PROBE_ERROR="$(tail -n 1 "$log_file" | tr '\r\n\t' ' ' | cut -c1-300)"
    [ "$attempt" -eq 1 ] && sleep 2
  done
  echo "WARN probe node=$node_id route=$probe_name reason=$PROBE_ERROR"
}

RESULTS='[]'
for entry in "${NODES[@]}"; do
  IFS=$'\t' read -r NODE_ID NODE_HOST <<<"$entry"

  probe "$NODE_ID" direct "$NODE_HOST" example.com
  DIRECT_OK="$PROBE_OK"
  DIRECT_LATENCY="$PROBE_LATENCY"
  DIRECT_ERROR="$PROBE_ERROR"

  probe "$NODE_ID" landing "$NODE_HOST" openai.com
  LANDING_OK="$PROBE_OK"
  LANDING_LATENCY="$PROBE_LATENCY"
  LANDING_ERROR="$PROBE_ERROR"

  RESULTS="$(printf '%s' "$RESULTS" | jq -c \
    --arg nodeId "$NODE_ID" \
    --argjson directOk "$DIRECT_OK" \
    --argjson landingOk "$LANDING_OK" \
    --argjson directLatencyMs "$DIRECT_LATENCY" \
    --argjson landingLatencyMs "$LANDING_LATENCY" \
    --arg directError "$DIRECT_ERROR" \
    --arg landingError "$LANDING_ERROR" \
    '. + [{
      nodeId:$nodeId,
      directOk:$directOk,
      landingOk:$landingOk,
      directLatencyMs:$directLatencyMs,
      landingLatencyMs:$landingLatencyMs,
      directError:(if $directError == "" then null else $directError end),
      landingError:(if $landingError == "" then null else $landingError end)
    }]')"
done

echo "STEP report-health"
REPORT_BODY="$(jq -nc \
  --arg runId "$RUN_ID" \
  --argjson checkedAt "$(date +%s)000" \
  --argjson results "$RESULTS" \
  '{runId:$runId,checkedAt:$checkedAt,results:$results}')"
REPORT_RESPONSE="$(curl -fsS --max-time 30 \
  --retry 4 --retry-delay 2 --retry-all-errors -X POST \
  "$CONTROL_API/api/operations/node-health/report" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data "$REPORT_BODY")"
printf '%s' "$REPORT_RESPONSE" | jq -e '.ok == true' >/dev/null
echo "OK health-reported run=$RUN_ID"

HEALTHY="$(printf '%s' "$REPORT_RESPONSE" | jq -r '.summary.healthy')"
DEGRADED="$(printf '%s' "$REPORT_RESPONSE" | jq -r '.summary.degraded')"
BANNED="$(printf '%s' "$REPORT_RESPONSE" | jq -r '.summary.banned')"
TRANSITIONS="$(printf '%s' "$REPORT_RESPONSE" | jq -r '.transitions | length')"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Opus8 node health"
    echo
    echo "- Run: \`$RUN_ID\`"
    echo "- Healthy: $HEALTHY"
    echo "- Degraded: $DEGRADED"
    echo "- Removed from subscriptions: $BANNED"
    echo "- State transitions: $TRANSITIONS"
    echo
    echo "| Node | Direct | Landing / WARP | State |"
    echo "| --- | --- | --- | --- |"
    printf '%s' "$REPORT_RESPONSE" | jq -r '
      .nodes[] |
      "| \(.id) | " +
      (if .health_direct_ok == 1 then "OK \(.health_direct_latency_ms // \"-\") ms" else "FAIL" end) +
      " | " +
      (if .health_landing_ok == 1 then "OK \(.health_landing_latency_ms // \"-\") ms" else "FAIL" end) +
      " | \(.health) |"'
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$BANNED" -gt 0 ]; then
  echo "::warning::$BANNED node(s) are currently removed from subscriptions"
elif [ "$DEGRADED" -gt 0 ]; then
  echo "::warning::$DEGRADED node(s) are currently degraded"
fi
echo "DONE healthy=$HEALTHY degraded=$DEGRADED banned=$BANNED"
