#!/usr/bin/env bash
# 构建并部署管理站(admin-ui)到 Cloudflare Pages。只打印 marker 行，不打印任何密钥。
set -uo pipefail
cd "$(dirname "$0")/../.."          # repo root
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
wrangler pages project create opus8cf-admin --production-branch main >/dev/null 2>&1 || true

echo "STEP deploy"
if ! wrangler pages deploy dist --project-name opus8cf-admin --branch main >/tmp/pages.log 2>&1; then
  echo "ERROR pages-deploy"; tail -n 10 /tmp/pages.log | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'; exit 12
fi
DURL=$(grep -oE 'https://[a-z0-9-]+\.opus8cf-admin\.pages\.dev' /tmp/pages.log | tail -n1 || true)
echo "OK deployed deploy=$DURL"
echo "DONE url=https://opus8cf-admin.pages.dev"
