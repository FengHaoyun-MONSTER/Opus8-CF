#!/usr/bin/env bash
# 控制面部署脚本（在 GitHub Actions 里跑）。只打印自己的 marker 行，绝不打印任何密钥值。
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root
cd packages/control-plane

: "${ROOT_DOMAIN:?ROOT_DOMAIN is required for production custom domains}"
: "${LANDING_CONFIG_KEY:?LANDING_CONFIG_KEY is required}"
ROOT_DOMAIN="${ROOT_DOMAIN#https://}"
ROOT_DOMAIN="${ROOT_DOMAIN#http://}"
ROOT_DOMAIN="${ROOT_DOMAIN%%/*}"
API_HOST="api.${ROOT_DOMAIN}"
SUB_HOST="sub.${ROOT_DOMAIN}"
API_URL="https://${API_HOST}"
SUB_URL="https://${SUB_HOST}"
DEFAULT_UNLOCK_HOSTS=$(grep -E '^[A-Za-z0-9.-]+$' ../../infra/ai-unlock.txt | tr '[:upper:]' '[:lower:]' | paste -sd, -)
OPUS8_BUILD_ID="${GITHUB_SHA:-manual}-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}"

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
OPUS8_BUILD_ID = "$OPUS8_BUILD_ID"
USE_OPTIMIZED_IPS = "1"

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
if ! esbuild src/index.ts --bundle --format=esm --external:cloudflare:sockets --outfile=dist/index.js --alias:@opus8-cf/shared=../shared/src/index.ts >/tmp/bundle.log 2>&1; then
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
printf '%s' "$LANDING_CONFIG_KEY"     | wrangler secret put LANDING_CONFIG_KEY >/dev/null 2>&1 && echo "OK secret LANDING_CONFIG_KEY"
printf '%s' "$ROOT_DOMAIN" | wrangler secret put ROOT_DOMAIN >/dev/null 2>&1 && echo "OK secret ROOT_DOMAIN"
printf '%s' "$SUB_URL"     | wrangler secret put SUB_BASE    >/dev/null 2>&1 && echo "OK secret SUB_BASE"

echo "STEP wait-deployed-version"
VERSION_READY=0
for n in $(seq 1 36); do
  CUSTOM_BUILD=$(curl -fsS --max-time 12 "$API_URL/__opus8/build" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).buildId||""))}catch(e){}})' || true)
  WORKERS_BUILD="$OPUS8_BUILD_ID"
  if [ -n "$WORKERS_URL" ]; then
    WORKERS_BUILD=$(curl -fsS --max-time 12 "$WORKERS_URL/__opus8/build" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).buildId||""))}catch(e){}})' || true)
  fi
  if [ "$CUSTOM_BUILD" = "$OPUS8_BUILD_ID" ] && [ "$WORKERS_BUILD" = "$OPUS8_BUILD_ID" ]; then
    VERSION_READY=1
    break
  fi
  sleep 5
done
if [ "$VERSION_READY" != "1" ]; then
  echo "ERROR deployed-version-not-active"
  exit 14
fi
echo "OK deployed-version-active custom=1 workers=1"

echo "STEP wait-custom-domain"
CUSTOM_OK=0
for n in $(seq 1 24); do
  if curl -fsS --max-time 15 "$API_URL/health" | grep -q '"ok":true'; then CUSTOM_OK=1; break; fi
  sleep 10
done
if [ "$CUSTOM_OK" != "1" ]; then echo "ERROR custom-domain-unreachable"; exit 15; fi
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

echo "STEP ensure-default-landing"
LANDINGS=$(curl -fsS --max-time 15 "$API_URL/api/landings" -H "authorization: Bearer $TOK")
LCOUNT=$(printf '%s' "$LANDINGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).landings||[]).length))}catch(e){process.stdout.write("0")}})')
if [ "$LCOUNT" -eq 0 ]; then
  if [ -z "${SERVICES_IP:-}" ] || [ -z "${SERVICES_USER:-}" ] || [ -z "${SERVICES_CODE:-}" ]; then
    echo "ERROR default-landing-secrets-missing"
    exit 17
  fi
  LANDING_SEED=$(node -e 'process.stdout.write(JSON.stringify({name:"默认落地机",hostname:process.env.SERVICES_IP,port:40008,username:process.env.SERVICES_USER,password:process.env.SERVICES_CODE,region:"default",matchHosts:[],priority:100,enabled:true}))')
  CREATE_CODE=000
  for n in $(seq 1 8); do
    CREATE_CODE=$(curl -sS -o /tmp/landing-create.json -w '%{http_code}' --max-time 20 -X POST "$API_URL/api/landings" -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d "$LANDING_SEED" || true)
    if [ "$CREATE_CODE" = "201" ]; then break; fi
    # 首次写入 Worker Secret 后各边缘位置可能短暂仍读到旧配置；同时检查是否已写入，避免超时重试产生重复记录。
    LANDINGS=$(curl -fsS --max-time 15 "$API_URL/api/landings" -H "authorization: Bearer $TOK" || true)
    LCOUNT=$(printf '%s' "$LANDINGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).landings||[]).length))}catch(e){process.stdout.write("0")}})')
    if [ "$LCOUNT" -gt 0 ]; then CREATE_CODE=existing; break; fi
    sleep 3
  done
  if [ "$CREATE_CODE" != "201" ] && [ "$CREATE_CODE" != "existing" ]; then
    CREATE_ERROR=$(node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync("/tmp/landing-create.json","utf8"));process.stdout.write(String(j.error||"unknown").slice(0,200))}catch(e){process.stdout.write("invalid response")}')
    echo "ERROR default-landing-create http=$CREATE_CODE reason=$CREATE_ERROR" | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'
    exit 18
  fi
  if [ "$CREATE_CODE" = "201" ]; then
    CREATED=$(cat /tmp/landing-create.json)
    CREATED_ID=$(printf '%s' "$CREATED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).landing.id||"")}catch(e){}})')
    if [ -z "$CREATED_ID" ]; then echo "ERROR default-landing-create"; exit 18; fi
  fi
  echo "OK default-landing-imported"
  LANDINGS=$(curl -fsS --max-time 15 "$API_URL/api/landings" -H "authorization: Bearer $TOK")
  LCOUNT=$(printf '%s' "$LANDINGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).landings||[]).length))}catch(e){process.stdout.write("0")}})')
fi
echo "OK smoke-landings count=$LCOUNT"
LANDING_ID=$(printf '%s' "$LANDINGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).landings||[])[0]?.id||"")}catch(e){}})')
if [ -n "$LANDING_ID" ]; then
  TEST_CODE=$(curl -sS -o /tmp/landing-test.json -w '%{http_code}' --max-time 25 -X POST "$API_URL/api/landings/$LANDING_ID/test" -H "authorization: Bearer $TOK" || true)
  if [ "$TEST_CODE" = "200" ]; then
    echo "OK smoke-landing-socks5"
  else
    echo "ERROR smoke-landing-socks5 http=$TEST_CODE"
    exit 19
  fi
fi

ROUTES=$(curl -fsS --max-time 15 "$API_URL/api/settings/unlock-hosts" -H "authorization: Bearer $TOK")
RCOUNT=$(printf '%s' "$ROUTES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).hosts||[]).length))}catch(e){process.stdout.write("0")}})')
if [ "$RCOUNT" -gt 0 ]; then echo "OK smoke-unlock-hosts count=$RCOUNT"; else echo "ERROR smoke-unlock-hosts-empty"; exit 20; fi
ORPH=$(curl -fsS --max-time 15 "$API_URL/api/users" -H "authorization: Bearer $TOK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const u=JSON.parse(s).users||[];process.stdout.write(u.filter(x=>x.username==="__smoke__").map(x=>x.id).join(" "))}catch(e){}})')
for id in $ORPH; do curl -fsS --max-time 15 -X DELETE "$API_URL/api/users/$id" -H "authorization: Bearer $TOK" >/dev/null; done
[ -n "$ORPH" ] && echo "OK smoke-cleaned-orphans" || true
CU=$(curl -fsS --max-time 15 -X POST "$API_URL/api/users" -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"username":"__smoke__","durationDays":1}')
SUID=$(printf '%s' "$CU" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).user.id||"")}catch(e){process.stdout.write("")}})')
SUB=$(printf '%s' "$CU" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).subUrl||"")}catch(e){process.stdout.write("")}})')
SUUID=$(printf '%s' "$CU" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).user.uuid||"")}catch(e){process.stdout.write("")}})')
if [ -n "$SUID" ] && [ -n "$SUUID" ]; then echo "OK smoke-create-user(D1-write)"; else echo "ERROR smoke-create-user"; exit 21; fi

signed_node_post() {
  local path="$1" body="$2" output="$3" ts sig
  ts=$(date +%s)000
  sig=$(printf '%s' "${ts}.smoke-node.${body}" | openssl dgst -sha256 -hmac "$NODE_HMAC_SECRET" -r | cut -d' ' -f1)
  curl -fsS --max-time 20 -X POST "$API_URL$path" \
    -H "x-opus8-ts: $ts" \
    -H "x-opus8-node: smoke-node" \
    -H "x-opus8-sign: $sig" \
    -H 'content-type: application/json' \
    --data "$body" > "$output"
}

for suffix in a b c; do
  ADMISSION_BODY=$(SUUID="$SUUID" SUFFIX="$suffix" node -e 'process.stdout.write(JSON.stringify({nodeId:"smoke-node",uuid:process.env.SUUID,leaseId:"smoke-lease-"+process.env.SUFFIX,ipHash:"smoke-ip-"+process.env.SUFFIX}))')
  signed_node_post "/api/nodes/admission" "$ADMISSION_BODY" "/tmp/admission-$suffix.json"
done
if node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync("/tmp/admission-a.json"));const b=JSON.parse(fs.readFileSync("/tmp/admission-b.json"));const c=JSON.parse(fs.readFileSync("/tmp/admission-c.json"));process.exit(a.allowed&&b.allowed&&!c.allowed&&c.reason==="active_ip_limit_exceeded"?0:1)'; then
  echo "OK smoke-active-ip-limit"
else
  echo "ERROR smoke-active-ip-limit"; exit 22
fi

BUCKET=$(( $(date +%s) / 3600 * 3600 * 1000 ))
USAGE_BODY=$(SUUID="$SUUID" BUCKET="$BUCKET" node -e 'process.stdout.write(JSON.stringify({nodeId:"smoke-node",events:[{id:"smoke-node:usage-event",uuid:process.env.SUUID,connections:1,bytesUp:111,bytesDown:222,tsBucket:Number(process.env.BUCKET)}]}))')
signed_node_post "/api/nodes/usage" "$USAGE_BODY" /tmp/usage-1.json
signed_node_post "/api/nodes/usage" "$USAGE_BODY" /tmp/usage-2.json
USERS_AFTER=$(curl -fsS --max-time 15 "$API_URL/api/users" -H "authorization: Bearer $TOK")
if printf '%s' "$USERS_AFTER" | SUID="$SUID" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=(JSON.parse(s).users||[]).find(x=>x.id===process.env.SUID);process.exit(u&&u.bytes_up===111&&u.bytes_down===222&&u.connections===1?0:1)})'; then
  echo "OK smoke-idempotent-usage"
else
  echo "ERROR smoke-idempotent-usage"; exit 23
fi

OVERVIEW=$(curl -fsS --max-time 20 "$API_URL/api/operations/overview" -H "authorization: Bearer $TOK")
if printf '%s' "$OVERVIEW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.exit(x.summary&&x.summary.totalUsers>=1&&Array.isArray(x.series)&&x.series.length===24&&Array.isArray(x.topUsers)&&Array.isArray(x.alerts)?0:1)})'; then
  echo "OK smoke-operations-overview"
else
  echo "ERROR smoke-operations-overview"; exit 24
fi

NODE_HEALTH=""
for n in $(seq 1 12); do
  if NODE_HEALTH=$(curl -fsS --max-time 20 "$API_URL/api/operations/node-health" -H "authorization: Bearer $TOK" 2>/dev/null); then
    break
  fi
  sleep 5
done
if printf '%s' "$NODE_HEALTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.exit(x.thresholds?.failure===3&&x.thresholds?.recovery===2&&x.summary&&Array.isArray(x.nodes)&&Array.isArray(x.events)?0:1)})'; then
  echo "OK smoke-node-health-overview"
else
  echo "ERROR smoke-node-health-overview"; exit 24
fi

ACTIVITY=$(curl -fsS --max-time 20 "$API_URL/api/users/$SUID/activity" -H "authorization: Bearer $TOK")
if printf '%s' "$ACTIVITY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.exit(x.user&&Array.isArray(x.activeLeases)&&Array.isArray(x.recentFingerprints)&&Array.isArray(x.usageByNode)&&x.usageByNode.some(y=>y.nodeId==="smoke-node"&&y.bytesUp===111&&y.bytesDown===222)?0:1)})'; then
  echo "OK smoke-user-activity"
else
  echo "ERROR smoke-user-activity"; exit 25
fi

SUBBODY=$(curl -fsS -D /tmp/sub.headers --max-time 20 "$SUB")
if [ -n "$SUBBODY" ]; then echo "OK smoke-subscription"; else echo "ERROR smoke-subscription"; exit 22; fi
if grep -qiE '^subscription-userinfo:.*upload=111;.*download=222;' /tmp/sub.headers; then
  echo "OK smoke-subscription-usage"
else
  echo "ERROR smoke-subscription-usage"; exit 24
fi
if printf '%s' "$SUBBODY" | base64 -d 2>/dev/null | grep -q 'vless://'; then echo "OK smoke-sub-has-node"; else echo "ERROR smoke-sub-no-node"; exit 23; fi
if printf '%s' "$SUBBODY" | base64 -d 2>/dev/null | grep -qE 'vless://[^@]+@[0-9]{1,3}\.[0-9]{1,3}\.'; then
  echo "ERROR smoke-sub-still-uses-unverified-ip"; exit 24
else
  echo "OK smoke-sub-hostname-only"
fi
if curl -fsS --max-time 15 -X DELETE "$API_URL/api/users/$SUID" -H "authorization: Bearer $TOK" | grep -q '"ok":true'; then echo "OK smoke-cleanup"; else echo "ERROR smoke-cleanup"; exit 25; fi

echo "DONE url=$API_URL"
