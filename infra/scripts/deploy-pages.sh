#!/usr/bin/env bash
# 构建并部署管理站(admin-ui)到 Cloudflare Pages。只打印 marker 行，不打印任何密钥。
set -uo pipefail
cd "$(dirname "$0")/../.."          # repo root
REPO_ROOT="$PWD"
PAGES_PROJECT_NAME="${PAGES_PROJECT_NAME:-opus8cf-admin}"
ADMIN_CUSTOM_DOMAIN="${ADMIN_CUSTOM_DOMAIN:-}"
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
    exit 14
  fi
  echo "OK pages-custom-domain-active"
fi

cd "$REPO_ROOT"
echo "DONE url=${ADMIN_CANONICAL_URL}"
