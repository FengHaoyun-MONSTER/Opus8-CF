#!/usr/bin/env bash
# 构建并部署管理站(admin-ui)到 Cloudflare Pages。只打印 marker 行，不打印任何密钥。
set -uo pipefail
cd "$(dirname "$0")/../.."          # repo root
REPO_ROOT="$PWD"
PAGES_PROJECT_NAME="${PAGES_PROJECT_NAME:-opus8cf-admin}"
ADMIN_CUSTOM_DOMAIN="${ADMIN_CUSTOM_DOMAIN:-}"
ADMIN_CUSTOM_ZONE="${ADMIN_CUSTOM_ZONE:-}"
ADMIN_CANONICAL_URL="${ADMIN_CANONICAL_URL:-https://${PAGES_PROJECT_NAME}.pages.dev}"
cd packages/admin-ui

echo "STEP install"
if ! npm install --no-audit --no-fund >/tmp/ui-install.log 2>&1; then
  echo "ERROR npm-install"; tail -n 8 /tmp/ui-install.log; exit 10
fi
echo "OK installed"

echo "STEP build"
if ! npx vite build >/tmp/ui-build.log 2>&1; then
  echo "ERROR build"; tail -n 12 /tmp/ui-build.log; exit 11
fi
echo "OK built"

echo "STEP pages-project"
wrangler pages project create "$PAGES_PROJECT_NAME" --production-branch main >/dev/null 2>&1 || true

echo "STEP deploy"
if ! wrangler pages deploy dist --project-name "$PAGES_PROJECT_NAME" --branch main >/tmp/pages.log 2>&1; then
  echo "ERROR pages-deploy"; tail -n 10 /tmp/pages.log | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'; exit 12
fi
DURL=$(grep -oE "https://[a-z0-9-]+\\.${PAGES_PROJECT_NAME}\\.pages\\.dev" /tmp/pages.log | tail -n1 || true)
echo "OK deployed deploy=$DURL"

if [ -n "$ADMIN_CUSTOM_DOMAIN" ]; then
  : "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required for custom domain}"
  : "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required for custom domain}"
  echo "STEP pages-custom-domain"
  DOMAIN_ENDPOINT="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${PAGES_PROJECT_NAME}/domains/${ADMIN_CUSTOM_DOMAIN}"
  DOMAIN_STATUS="$(
    curl --silent --show-error \
      --output /tmp/pages-domain.json \
      --write-out '%{http_code}' \
      --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      "$DOMAIN_ENDPOINT"
  )"
  if [ "$DOMAIN_STATUS" != "200" ] || ! jq -e '.success == true' /tmp/pages-domain.json >/dev/null 2>&1; then
    ADD_STATUS="$(
      jq -n --arg name "$ADMIN_CUSTOM_DOMAIN" '{name: $name}' \
        | curl --silent --show-error \
          --request POST \
          --output /tmp/pages-domain-add.json \
          --write-out '%{http_code}' \
          --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
          --header 'Content-Type: application/json' \
          --data-binary @- \
          "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${PAGES_PROJECT_NAME}/domains"
    )"
    if ! [[ "$ADD_STATUS" =~ ^2[0-9][0-9]$ ]] \
      || ! jq -e '.success == true' /tmp/pages-domain-add.json >/dev/null 2>&1; then
      MESSAGE="$(jq -r '[.errors[]?.message] | join("; ")' /tmp/pages-domain-add.json 2>/dev/null || true)"
      echo "ERROR pages-custom-domain-add status=${ADD_STATUS} message=${MESSAGE:-unknown}"
      exit 13
    fi
    echo "OK pages-custom-domain-added"
  else
    echo "OK pages-custom-domain-exists"
  fi

  if [ -n "$ADMIN_CUSTOM_ZONE" ]; then
    echo "STEP pages-custom-domain-dns"
    ZONE_STATUS="$(
      curl --silent --show-error \
        --output /tmp/pages-zone.json \
        --write-out '%{http_code}' \
        --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        "https://api.cloudflare.com/client/v4/zones?name=${ADMIN_CUSTOM_ZONE}&account.id=${CLOUDFLARE_ACCOUNT_ID}"
    )"
    if [ "$ZONE_STATUS" != "200" ] \
      || ! jq -e '.success == true and (.result | length) == 1' /tmp/pages-zone.json >/dev/null 2>&1; then
      echo "ERROR pages-custom-domain-zone status=${ZONE_STATUS}"
      exit 14
    fi
    ZONE_ID="$(jq -r '.result[0].id' /tmp/pages-zone.json)"
    RECORDS_STATUS="$(
      curl --silent --show-error \
        --output /tmp/pages-dns-records.json \
        --write-out '%{http_code}' \
        --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${ADMIN_CUSTOM_DOMAIN}"
    )"
    if [ "$RECORDS_STATUS" != "200" ] \
      || ! jq -e '.success == true' /tmp/pages-dns-records.json >/dev/null 2>&1; then
      echo "ERROR pages-custom-domain-dns-list status=${RECORDS_STATUS}"
      exit 14
    fi
    RECORD_COUNT="$(jq '.result | length' /tmp/pages-dns-records.json)"
    EXPECTED_TARGET="${PAGES_PROJECT_NAME}.pages.dev"
    if [ "$RECORD_COUNT" -eq 0 ]; then
      DNS_STATUS="$(
        jq -n \
          --arg name "$ADMIN_CUSTOM_DOMAIN" \
          --arg content "$EXPECTED_TARGET" \
          '{type: "CNAME", name: $name, content: $content, proxied: true, ttl: 1}' \
          | curl --silent --show-error \
            --request POST \
            --output /tmp/pages-dns-add.json \
            --write-out '%{http_code}' \
            --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
            --header 'Content-Type: application/json' \
            --data-binary @- \
            "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records"
      )"
      if ! [[ "$DNS_STATUS" =~ ^2[0-9][0-9]$ ]] \
        || ! jq -e '.success == true' /tmp/pages-dns-add.json >/dev/null 2>&1; then
        MESSAGE="$(jq -r '[.errors[]?.message] | join("; ")' /tmp/pages-dns-add.json 2>/dev/null || true)"
        echo "ERROR pages-custom-domain-dns-add status=${DNS_STATUS} message=${MESSAGE:-unknown}"
        exit 14
      fi
      echo "OK pages-custom-domain-dns-added"
    elif [ "$RECORD_COUNT" -eq 1 ] \
      && jq -e \
        --arg target "$EXPECTED_TARGET" \
        '.result[0].type == "CNAME" and .result[0].content == $target and .result[0].proxied == true' \
        /tmp/pages-dns-records.json >/dev/null 2>&1; then
      echo "OK pages-custom-domain-dns-exists"
    else
      echo "ERROR pages-custom-domain-dns-conflict count=${RECORD_COUNT}"
      exit 14
    fi
  fi

  DOMAIN_ACTIVE=0
  for attempt in $(seq 1 36); do
    STATUS="$(
      curl --silent --show-error \
        --output /tmp/pages-domain-check.json \
        --write-out '%{http_code}' \
        --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        "$DOMAIN_ENDPOINT"
    )"
    if [ "$STATUS" = "200" ] \
      && jq -e '.success == true and .result.status == "active"' /tmp/pages-domain-check.json >/dev/null 2>&1; then
      DOMAIN_ACTIVE=1
      break
    fi
    sleep 5
  done
  if [ "$DOMAIN_ACTIVE" -ne 1 ]; then
    DOMAIN_STATE="$(jq -r '.result.status // "unknown"' /tmp/pages-domain-check.json 2>/dev/null || true)"
    echo "ERROR pages-custom-domain-not-active state=${DOMAIN_STATE:-unknown}"
    exit 15
  fi
  echo "OK pages-custom-domain-active"
fi

cd "$REPO_ROOT"
echo "DONE url=${ADMIN_CANONICAL_URL}"
