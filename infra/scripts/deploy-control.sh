#!/usr/bin/env bash
# 控制面部署脚本（在 GitHub Actions 里跑）。只打印自己的 marker 行，绝不打印任何密钥值。
set -uo pipefail
cd "$(dirname "$0")/../.."          # repo root
cd packages/control-plane

echo "STEP ensure-d1-kv"
wrangler d1 create opus8cf-db >/dev/null 2>&1 || true
wrangler kv namespace create OPUS8_KV >/dev/null 2>&1 || true

DBID=$(wrangler d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const x=a.find(r=>r.name==="opus8cf-db");process.stdout.write(x?(x.uuid||x.database_id||""):"")}catch(e){process.stdout.write("")}})')
KVID=$(wrangler kv namespace list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const x=a.find(r=>r.title&&r.title.includes("OPUS8_KV"));process.stdout.write(x?x.id:"")}catch(e){process.stdout.write("")}})')

if [ -z "$DBID" ] || [ -z "$KVID" ]; then
  echo "ERROR resolve-id-failed (token 可能缺少 D1/KV 编辑权限)"
  exit 10
fi
echo "OK ids-resolved d1=${DBID:0:8}… kv=${KVID:0:8}…"

cat > wrangler.toml <<EOF
name = "opus8cf-control"
main = "dist/index.js"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "opus8cf-db"
database_id = "$DBID"

[[kv_namespaces]]
binding = "KV"
id = "$KVID"
EOF

echo "STEP apply-schema"
if ! wrangler d1 execute opus8cf-db --remote --file=schema.sql >/tmp/schema.log 2>&1; then
  echo "ERROR schema-failed"; tail -n 3 /tmp/schema.log | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'; exit 11
fi
echo "OK schema-applied"

echo "STEP bundle"
if ! esbuild src/index.ts --bundle --format=esm --outfile=dist/index.js --alias:@opus8-cf/shared=../shared/src/index.ts >/tmp/bundle.log 2>&1; then
  echo "ERROR bundle-failed"; tail -n 5 /tmp/bundle.log; exit 12
fi
echo "OK bundled"

echo "STEP deploy"
if ! wrangler deploy >/tmp/wd.log 2>&1; then
  echo "ERROR deploy-failed"; tail -n 6 /tmp/wd.log | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'; exit 13
fi
URL=$(grep -oE 'https://[a-z0-9._-]+workers\.dev' /tmp/wd.log | head -n1 || true)
echo "OK deployed url=$URL"

echo "STEP secrets"
printf '%s' "${ADMIN_PASSWORD:-}"   | wrangler secret put ADMIN_PASSWORD   >/dev/null 2>&1 && echo "OK secret ADMIN_PASSWORD"
printf '%s' "${JWT_SECRET:-}"       | wrangler secret put JWT_SECRET       >/dev/null 2>&1 && echo "OK secret JWT_SECRET"
printf '%s' "${NODE_HMAC_SECRET:-}" | wrangler secret put NODE_HMAC_SECRET >/dev/null 2>&1 && echo "OK secret NODE_HMAC_SECRET"
if [ -n "${ROOT_DOMAIN:-}" ]; then printf '%s' "$ROOT_DOMAIN" | wrangler secret put ROOT_DOMAIN >/dev/null 2>&1 && echo "OK secret ROOT_DOMAIN"; fi

echo "DONE url=$URL"
