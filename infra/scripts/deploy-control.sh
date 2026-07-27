#!/usr/bin/env bash
# 控制面部署脚本（在 GitHub Actions 里跑）。只打印自己的 marker 行，绝不打印任何密钥值。
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root
cd packages/control-plane

: "${ROOT_DOMAIN:?ROOT_DOMAIN is required for production custom domains}"
ROOT_DOMAIN="${ROOT_DOMAIN#https://}"
ROOT_DOMAIN="${ROOT_DOMAIN#http://}"
ROOT_DOMAIN="${ROOT_DOMAIN%%/*}"
API_HOST="api.${ROOT_DOMAIN}"
SUB_HOST="sub.${ROOT_DOMAIN}"
API_URL="https://${API_HOST}"
SUB_URL="https://${SUB_HOST}"
DEFAULT_UNLOCK_HOSTS=$(grep -E '^[A-Za-z0-9.-]+$' ../../infra/ai-unlock.txt | tr '[:upper:]' '[:lower:]' | paste -sd, -)

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

[vars]
DEFAULT_UNLOCK_HOSTS = "$DEFAULT_UNLOCK_HOSTS"

[[d1_databases]]
binding = "DB"
database_name = "opus8cf-db"
database_id = "$DBID"

[[kv_namespaces]]
binding = "KV"
id = "$KVID"

[[routes]]
pattern = "$API_HOST"
custom_domain = true

[[routes]]
pattern = "$SUB_HOST"
custom_domain = true
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
WORKERS_URL=$(grep -oE 'https://[a-z0-9._-]+workers\.dev' /tmp/wd.log | head -n1 || true)
echo "OK deployed workers=${WORKERS_URL:-unreported} custom=$API_URL"

echo "STEP secrets"
printf '%s' "${ADMIN_PASSWORD:-}"   | wrangler secret put ADMIN_PASSWORD   >/dev/null 2>&1 && echo "OK secret ADMIN_PASSWORD"
printf '%s' "${JWT_SECRET:-}"       | wrangler secret put JWT_SECRET       >/dev/null 2>&1 && echo "OK secret JWT_SECRET"
printf '%s' "${NODE_HMAC_SECRET:-}" | wrangler secret put NODE_HMAC_SECRET >/dev/null 2>&1 && echo "OK secret NODE_HMAC_SECRET"
printf '%s' "$ROOT_DOMAIN" | wrangler secret put ROOT_DOMAIN >/dev/null 2>&1 && echo "OK secret ROOT_DOMAIN"
printf '%s' "$SUB_URL"     | wrangler secret put SUB_BASE    >/dev/null 2>&1 && echo "OK secret SUB_BASE"

echo "STEP wait-custom-domain"
CUSTOM_OK=0
for n in $(seq 1 24); do
  if curl -fsS --max-time 15 "$API_URL/health" | grep -q '"ok":true'; then CUSTOM_OK=1; break; fi
  sleep 10
done
if [ "$CUSTOM_OK" != "1" ]; then echo "ERROR custom-domain-unreachable"; exit 14; fi
echo "OK custom-domain-ready api=$API_URL sub=$SUB_URL"

echo "STEP smoke"
if curl -fsS --max-time 15 "$API_URL/health" | grep -q '"ok":true'; then echo "OK smoke-health"; else echo "ERROR smoke-health"; exit 15; fi
TOK=""
for n in $(seq 1 18); do
  LOGIN=$(curl -s --max-time 15 -X POST "$API_URL/api/admin/login" -H 'content-type: application/json' -d "{\"password\":\"${ADMIN_PASSWORD:-}\"}" || true)
  TOK=$(printf '%s' "$LOGIN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch(e){process.stdout.write("")}})')
  if [ -n "$TOK" ]; then
    MECODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$API_URL/api/admin/me" -H "authorization: Bearer $TOK" || true)
    [ "$MECODE" = "200" ] && break
    TOK=""
  fi
  sleep 5
done
if [ -n "$TOK" ]; then echo "OK smoke-login"; else echo "ERROR smoke-login"; exit 16; fi
ROUTES=$(curl -fsS --max-time 15 "$API_URL/api/settings/unlock-hosts" -H "authorization: Bearer $TOK")
RCOUNT=$(printf '%s' "$ROUTES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).hosts||[]).length))}catch(e){process.stdout.write("0")}})')
if [ "$RCOUNT" -gt 0 ]; then echo "OK smoke-unlock-hosts count=$RCOUNT"; else echo "ERROR smoke-unlock-hosts-empty"; exit 17; fi
ORPH=$(curl -fsS --max-time 15 "$API_URL/api/users" -H "authorization: Bearer $TOK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const u=JSON.parse(s).users||[];process.stdout.write(u.filter(x=>x.username==="__smoke__").map(x=>x.id).join(" "))}catch(e){}})')
for id in $ORPH; do curl -fsS --max-time 15 -X DELETE "$API_URL/api/users/$id" -H "authorization: Bearer $TOK" >/dev/null; done
[ -n "$ORPH" ] && echo "OK smoke-cleaned-orphans" || true
CU=$(curl -fsS --max-time 15 -X POST "$API_URL/api/users" -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"username":"__smoke__","durationDays":1}')
SUID=$(printf '%s' "$CU" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).user.id||"")}catch(e){process.stdout.write("")}})')
SUB=$(printf '%s' "$CU" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).subUrl||"")}catch(e){process.stdout.write("")}})')
if [ -n "$SUID" ]; then echo "OK smoke-create-user(D1-write)"; else echo "ERROR smoke-create-user"; exit 18; fi
SUBBODY=$(curl -fsS --max-time 20 "$SUB")
if [ -n "$SUBBODY" ]; then echo "OK smoke-subscription"; else echo "ERROR smoke-subscription"; exit 19; fi
if printf '%s' "$SUBBODY" | base64 -d 2>/dev/null | grep -q 'vless://'; then echo "OK smoke-sub-has-node"; else echo "ERROR smoke-sub-no-node"; exit 20; fi
if printf '%s' "$SUBBODY" | base64 -d 2>/dev/null | grep -qE 'vless://[^@]+@[0-9]{1,3}\.[0-9]{1,3}\.'; then
  echo "ERROR smoke-sub-still-uses-unverified-ip"; exit 21
else
  echo "OK smoke-sub-hostname-only"
fi
if curl -fsS --max-time 15 -X DELETE "$API_URL/api/users/$SUID" -H "authorization: Bearer $TOK" | grep -q '"ok":true'; then echo "OK smoke-cleanup"; else echo "ERROR smoke-cleanup"; exit 22; fi

echo "DONE url=$API_URL"
