#!/usr/bin/env bash
# Optional coarse source-IP protection in front of the subscription Worker.
# The mandatory per-token and per-source protection remains the Workers
# Rate Limiting binding because this zone rule cannot protect workers.dev.
set -euo pipefail

MODE="${SUB_WAF_MODE:-optional}"
API="https://api.cloudflare.com/client/v4"
RULE_REF="opus8_subscription_source_v1"
SOURCE_LIMIT=120
PERIOD=60

warn_or_fail() {
  local reason="$1"
  if [ "$MODE" = "required" ]; then
    echo "ERROR subscription-waf $reason"
    exit 1
  fi
  echo "WARN subscription-waf $reason; worker-binding-remains-active"
  exit 0
}

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || warn_or_fail "api-token-missing"
[ -n "${ROOT_DOMAIN:-}" ] || warn_or_fail "root-domain-missing"
command -v jq >/dev/null 2>&1 || warn_or_fail "jq-missing"

ROOT_DOMAIN="${ROOT_DOMAIN#https://}"
ROOT_DOMAIN="${ROOT_DOMAIN#http://}"
ROOT_DOMAIN="${ROOT_DOMAIN%%/*}"
SUB_HOST="sub.${ROOT_DOMAIN}"
WORK_DIR="/tmp/opus8-sub-waf-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"
mkdir -p "$WORK_DIR"
AUTH_HEADER="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

ZONE_CODE=$(curl -sS -o "$WORK_DIR/zone.json" -w '%{http_code}' \
  --get "$API/zones" \
  -H "$AUTH_HEADER" \
  --data-urlencode "name=$ROOT_DOMAIN" \
  --data-urlencode "status=active" || true)
if [ "$ZONE_CODE" != "200" ]; then
  warn_or_fail "zone-lookup-http-$ZONE_CODE"
fi
ZONE_ID=$(jq -r '.result[0].id // empty' "$WORK_DIR/zone.json")
[ -n "$ZONE_ID" ] || warn_or_fail "active-zone-not-found"

RULE_JSON=$(jq -n --arg host "$SUB_HOST" --arg ref "$RULE_REF" \
  --argjson limit "$SOURCE_LIMIT" --argjson period "$PERIOD" '{
    ref: $ref,
    description: "Opus8 coarse subscription source rate limit",
    enabled: true,
    expression: (
      "(http.host eq \"" + $host +
      "\" and http.request.method eq \"GET\" and starts_with(http.request.uri.path, \"/sub/\"))"
    ),
    action: "block",
    ratelimit: {
      characteristics: ["cf.colo.id", "ip.src"],
      period: $period,
      requests_per_period: $limit,
      mitigation_timeout: $period
    }
  }')

ENTRY_URL="$API/zones/$ZONE_ID/rulesets/phases/http_ratelimit/entrypoint"
ENTRY_CODE=$(curl -sS -o "$WORK_DIR/entry.json" -w '%{http_code}' \
  "$ENTRY_URL" -H "$AUTH_HEADER" || true)

if [ "$ENTRY_CODE" = "404" ]; then
  CREATE_JSON=$(jq -n --argjson rule "$RULE_JSON" '{
    name: "Opus8 subscription rate limiting",
    description: "Zone entry point for Opus8 subscription protection",
    kind: "zone",
    phase: "http_ratelimit",
    rules: [$rule]
  }')
  WRITE_CODE=$(curl -sS -o "$WORK_DIR/write.json" -w '%{http_code}' \
    -X POST "$API/zones/$ZONE_ID/rulesets" \
    -H "$AUTH_HEADER" -H 'content-type: application/json' \
    --data "$CREATE_JSON" || true)
elif [ "$ENTRY_CODE" = "200" ]; then
  RULESET_ID=$(jq -r '.result.id // empty' "$WORK_DIR/entry.json")
  [ -n "$RULESET_ID" ] || warn_or_fail "ruleset-id-missing"
  RULE_ID=$(jq -r --arg ref "$RULE_REF" \
    '(.result.rules // []) | map(select(.ref == $ref))[0].id // empty' \
    "$WORK_DIR/entry.json")
  if [ -n "$RULE_ID" ]; then
    WRITE_CODE=$(curl -sS -o "$WORK_DIR/write.json" -w '%{http_code}' \
      -X PATCH "$API/zones/$ZONE_ID/rulesets/$RULESET_ID/rules/$RULE_ID" \
      -H "$AUTH_HEADER" -H 'content-type: application/json' \
      --data "$RULE_JSON" || true)
  else
    WRITE_CODE=$(curl -sS -o "$WORK_DIR/write.json" -w '%{http_code}' \
      -X POST "$API/zones/$ZONE_ID/rulesets/$RULESET_ID/rules" \
      -H "$AUTH_HEADER" -H 'content-type: application/json' \
      --data "$RULE_JSON" || true)
  fi
else
  warn_or_fail "entrypoint-http-$ENTRY_CODE-zone-waf-edit-may-be-missing"
fi

if [[ "$WRITE_CODE" != "200" && "$WRITE_CODE" != "201" ]]; then
  ERROR_CODE=$(jq -r '.errors[0].code // "unknown"' "$WORK_DIR/write.json" 2>/dev/null || true)
  warn_or_fail "write-http-$WRITE_CODE-code-$ERROR_CODE"
fi
if [ "$(jq -r '.success // false' "$WORK_DIR/write.json")" != "true" ]; then
  warn_or_fail "write-result-unsuccessful"
fi

echo "OK subscription-waf host=$SUB_HOST limit=${SOURCE_LIMIT}/${PERIOD}s"
