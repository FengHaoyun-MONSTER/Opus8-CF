#!/usr/bin/env bash
# 部署单个边缘节点：构建补丁版 worker、探测落地机端口、部署、设密钥、注册、验证。
# 需要环境变量：
#   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
#   CONTROL_ROOT_DOMAIN / ROOT_DOMAIN / NODE_HMAC_SECRET / NODE_ID / NODE_ACCOUNT_ALIAS / NODE_REGION
#   SERVICES_IP / SERVICES_USER / SERVICES_CODE  (落地机，可缺省 -> 纯 CF 出口)
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
cd packages/edge-node

: "${NODE_ID:?}"; : "${NODE_ACCOUNT_ALIAS:?}"; : "${NODE_HMAC_SECRET:?}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required for the managed canary user}"
: "${ROOT_DOMAIN:?ROOT_DOMAIN is required for production custom domains}"
: "${CONTROL_ROOT_DOMAIN:?CONTROL_ROOT_DOMAIN is required}"
NODE_REGION="${NODE_REGION:-}"
ROOT_DOMAIN="${ROOT_DOMAIN#https://}"; ROOT_DOMAIN="${ROOT_DOMAIN#http://}"; ROOT_DOMAIN="${ROOT_DOMAIN%%/*}"
CONTROL_ROOT_DOMAIN="${CONTROL_ROOT_DOMAIN#https://}"; CONTROL_ROOT_DOMAIN="${CONTROL_ROOT_DOMAIN#http://}"; CONTROL_ROOT_DOMAIN="${CONTROL_ROOT_DOMAIN%%/*}"
CONTROL_PLANE_URL="https://api.${CONTROL_ROOT_DOMAIN}"
CUSTOM_HOST="${NODE_ID}.${ROOT_DOMAIN}"
CUSTOM_URL="https://${CUSTOM_HOST}"
WORKER_NAME="opus8cf-node-${NODE_ID}"

echo "STEP build"
if ! node build/build.mjs >/tmp/nb.log 2>&1; then echo "ERROR build"; tail -n 8 /tmp/nb.log; exit 10; fi
echo "OK built ($(cat /tmp/nb.log))"
if ! node build/policy-test.mjs >/tmp/policy.log 2>&1; then echo "ERROR policy-test"; tail -n 8 /tmp/policy.log; exit 10; fi
echo "OK policy-test"

echo "STEP probe-landing"
PORT=""; LAND=""; PTYPE=""
if [ -n "${SERVICES_IP:-}" ]; then
  # 快速路径：先试已知/常见端口，命中即跳过全端口扫描
  for p in ${SERVICES_PORT:-} 40008 1080 1081 7890 8388 1088; do
    [ -z "$p" ] && continue
    out=$(curl -s -x "socks5h://${SERVICES_IP}:$p" --proxy-user "${SERVICES_USER:-}:${SERVICES_CODE:-}" --connect-timeout 5 --max-time 10 https://api.ipify.org 2>/dev/null || true)
    if echo "$out" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then PORT=$p; PTYPE=socks5-auth; echo "OK landing-port=$p type=socks5(auth,fast) exit=$out"; break; fi
  done
  OPEN=""
  if [ -z "$PORT" ]; then
    sudo apt-get update >/dev/null 2>&1 || true
    sudo apt-get install -y nmap >/dev/null 2>&1 || true
    if command -v nmap >/dev/null 2>&1; then
      OPEN=$(nmap -Pn -T4 --min-rate 3000 -p- "${SERVICES_IP}" 2>/dev/null | grep -oE '^[0-9]+/tcp[[:space:]]+open' | grep -oE '^[0-9]+' | tr '\n' ' ')
    fi
    echo "INFO tcp-open-ports:${OPEN:- 无}"
  fi
  n=0
  for p in $OPEN; do
    [ -n "$PORT" ] && break
    n=$((n+1)); [ "$n" -gt 20 ] && break
    out=$(curl -s -x "socks5h://${SERVICES_IP}:$p" --proxy-user "${SERVICES_USER:-}:${SERVICES_CODE:-}" --connect-timeout 6 --max-time 12 https://api.ipify.org 2>/dev/null || true)
    if echo "$out" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then PORT=$p; PTYPE=socks5-auth; echo "OK landing-port=$p type=socks5(auth) exit=$out"; break; fi
    outn=$(curl -s -x "socks5h://${SERVICES_IP}:$p" --connect-timeout 6 --max-time 12 https://api.ipify.org 2>/dev/null || true)
    if echo "$outn" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then PORT=$p; PTYPE=socks5-noauth; echo "OK landing-port=$p type=socks5(no-auth) exit=$outn"; break; fi
    outh=$(curl -s -x "http://${SERVICES_IP}:$p" --proxy-user "${SERVICES_USER:-}:${SERVICES_CODE:-}" --connect-timeout 6 --max-time 12 https://api.ipify.org 2>/dev/null || true)
    if echo "$outh" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then echo "INFO port=$p 是 HTTP 代理(非 SOCKS5) exit=$outh"; fi
  done
  if [ -n "$PORT" ]; then
    if [ "$PTYPE" = "socks5-auth" ] && [ -n "${SERVICES_USER:-}" ]; then LAND="${SERVICES_USER}:${SERVICES_CODE}@${SERVICES_IP}:${PORT}"; else LAND="${SERVICES_IP}:${PORT}"; fi
  else
    echo "INFO landing-no-socks5 (纯 CF 出口，无解锁)"
  fi
else
  echo "INFO no-SERVICES_IP (纯 CF 出口)"
fi

echo "STEP kv"
wrangler kv namespace create OPUS8_NODE_KV >/dev/null 2>&1 || true
KVID=$(wrangler kv namespace list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const x=a.find(r=>r.title&&r.title.includes("OPUS8_NODE_KV"));process.stdout.write(x?x.id:"")}catch(e){process.stdout.write("")}})')
if [ -z "$KVID" ]; then echo "ERROR kv-id (token 缺 KV 权限?)"; exit 11; fi
echo "OK kv=${KVID:0:8}…"

# AI 解锁白名单（*<domain> 形式，仅命中这些域名走落地）
GO2=$(sed 's/^/*/' "${REPO_ROOT}/infra/ai-unlock.txt" 2>/dev/null | paste -sd, -)

NODE_UUID_HEX=$(printf 'node-fallback:%s' "$NODE_ID" \
  | openssl dgst -sha256 -hmac "$NODE_HMAC_SECRET" -r \
  | cut -d' ' -f1)
NODE_UUID="${NODE_UUID_HEX:0:8}-${NODE_UUID_HEX:8:4}-4${NODE_UUID_HEX:13:3}-8${NODE_UUID_HEX:17:3}-${NODE_UUID_HEX:20:12}"

cat > wrangler.toml <<EOF
name = "${WORKER_NAME}"
main = "dist/index.js"
compatibility_date = "2025-01-01"
# acc1 节点与控制面同 Zone；强制按公开网络执行跨 Worker fetch，避免 1042。
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
workers_dev = true

[vars]
CONTROL_PLANE_URL = "${CONTROL_PLANE_URL}"
NODE_ID = "${NODE_ID}"
NODE_ACCOUNT_ALIAS = "${NODE_ACCOUNT_ALIAS}"
NODE_REGION = "${NODE_REGION}"
GO2SOCKS5 = "${GO2}"

[[kv_namespaces]]
binding = "KV"
id = "${KVID}"

[[routes]]
pattern = "${CUSTOM_HOST}"
custom_domain = true
EOF

echo "STEP deploy"
if ! wrangler deploy >/tmp/nd.log 2>&1; then echo "ERROR deploy"; tail -n 8 /tmp/nd.log | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'; exit 12; fi
WORKERS_URL=$(grep -oE 'https://[a-z0-9._-]+workers\.dev' /tmp/nd.log | head -n1 || true)
URL="$CUSTOM_URL"
HOST="$CUSTOM_HOST"
echo "OK deployed workers=${WORKERS_URL:-unreported} custom=$URL"

echo "STEP secrets"
printf '%s' "$NODE_HMAC_SECRET" | wrangler secret put NODE_HMAC_SECRET >/dev/null 2>&1 && echo "OK secret hmac"
printf '%s' "$NODE_UUID"        | wrangler secret put UUID            >/dev/null 2>&1 && echo "OK secret uuid"
if [ -n "$LAND" ]; then
  printf '%s' "$LAND" | wrangler secret put SOCKS5 >/dev/null 2>&1 && echo "OK secret socks5-landing(解锁已启用)"
fi

echo "STEP register"
RCODE=000
for n in $(seq 1 18); do
  TS=$(date +%s)000
  BODY=$(H="$HOST" HASLAND="$LAND" node -e "process.stdout.write(JSON.stringify({nodeId:process.env.NODE_ID,accountAlias:process.env.NODE_ACCOUNT_ALIAS,hostname:process.env.H,region:process.env.NODE_REGION||null,capabilities:['vless-ws','anti-share-v1','usage-v1'].concat(process.env.HASLAND?['unlock']:[])}))")
  SIG=$(printf '%s' "${TS}.${NODE_ID}.${BODY}" | openssl dgst -sha256 -hmac "$NODE_HMAC_SECRET" -r | cut -d' ' -f1)
  RCODE=$(curl -s -o /tmp/reg.json -w '%{http_code}' --max-time 20 -X POST "$CONTROL_PLANE_URL/api/nodes/register" \
    -H "x-opus8-ts: $TS" -H "x-opus8-node: $NODE_ID" -H "x-opus8-sign: $SIG" -H 'content-type: application/json' -d "$BODY" || true)
  [ "$RCODE" = "200" ] && break
  sleep 10
done
if [ "$RCODE" = "200" ]; then echo "OK registered host=$HOST"; else echo "ERROR register http=$RCODE"; exit 13; fi

echo "STEP wait-custom-domain"
DOMAIN_OK=0
NC=000
for n in $(seq 1 24); do
  NC=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/" || true)
  if [ -n "$NC" ] && [ "$NC" != "000" ]; then DOMAIN_OK=1; break; fi
  sleep 10
done
if [ "$DOMAIN_OK" != "1" ]; then echo "ERROR node-custom-domain-unreachable"; exit 14; fi
echo "OK custom-domain-ready"

echo "STEP verify"
echo "OK node-tls-http=$NC"
TS2=$(date +%s)000
SIG2=$(printf '%s' "${TS2}.${NODE_ID}." | openssl dgst -sha256 -hmac "$NODE_HMAC_SECRET" -r | cut -d' ' -f1)
if ! UDATA=$(curl -fsS --max-time 20 "$CONTROL_PLANE_URL/api/nodes/$NODE_ID/uuids" \
  -H "x-opus8-ts: $TS2" -H "x-opus8-node: $NODE_ID" -H "x-opus8-sign: $SIG2"); then
  echo "ERROR uuids-endpoint"; exit 15
fi
UC=$(printf '%s' "$UDATA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j.uuids||[]).length))}catch(e){process.stdout.write("err")}})')
echo "OK uuids-endpoint-count=$UC"
HAS_LANDING_BUNDLE=$(printf '%s' "$UDATA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(typeof j.landingBundle==="string"&&j.landingBundle.startsWith("v1.")?"1":"0")}catch(e){process.stdout.write("0")}})')
if [ "$HAS_LANDING_BUNDLE" = "1" ]; then echo "OK landing-bundle-encrypted"; else echo "ERROR landing-bundle-missing"; exit 16; fi

echo "STEP canary-user"
LOGIN_BODY=$(ADMIN_PASSWORD="$ADMIN_PASSWORD" node -e 'process.stdout.write(JSON.stringify({password:process.env.ADMIN_PASSWORD}))')
ADMIN_TOKEN=$(curl -fsS --max-time 20 -X POST "$CONTROL_PLANE_URL/api/admin/login" \
  -H 'content-type: application/json' -d "$LOGIN_BODY" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.token)process.exit(1);process.stdout.write(j.token)})')
echo "::add-mask::$ADMIN_TOKEN"
CANARY_NAME="opus8-node-canary-${NODE_ID}-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
CREATE_BODY=$(CANARY_NAME="$CANARY_NAME" NODE_ID="$NODE_ID" node -e 'process.stdout.write(JSON.stringify({username:process.env.CANARY_NAME,nodeGroup:[process.env.NODE_ID],unlock:false,durationDays:1,deviceLimit:4,ipLimit24h:10,trafficLimitBytes:0}))')
CANARY_USER=$(curl -fsS --max-time 20 -X POST "$CONTROL_PLANE_URL/api/users" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d "$CREATE_BODY")
CANARY_USER_ID=$(printf '%s' "$CANARY_USER" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.user?.id)process.exit(1);process.stdout.write(j.user.id)})')
TEST_UUID=$(printf '%s' "$CANARY_USER" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.user?.uuid)process.exit(1);process.stdout.write(j.user.uuid)})')
echo "::add-mask::$CANARY_USER_ID"
echo "::add-mask::$TEST_UUID"
INVALIDATION_ACKS=$(printf '%s' "$CANARY_USER" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.cacheInvalidation?.acknowledged||0))})')
TARGET_INVALIDATED=$(printf '%s' "$CANARY_USER" | NODE_ID="$NODE_ID" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.cacheInvalidation?.acknowledgedNodes||[]).includes(process.env.NODE_ID)?"1":"0")})')
cleanup_canary_user() {
  curl -fsS --max-time 20 -X DELETE "$CONTROL_PLANE_URL/api/users/$CANARY_USER_ID" \
    -H "authorization: Bearer $ADMIN_TOKEN" >/dev/null 2>&1 || true
}
trap cleanup_canary_user EXIT
echo "OK canary-user-created"
echo "INFO edge-policy-invalidation acknowledged=$INVALIDATION_ACKS target=$TARGET_INVALIDATED"
if [ "$TARGET_INVALIDATED" = "1" ]; then
  sleep 3
else
  echo "WARN target-node-did-not-acknowledge-active-invalidation; using-ttl-fallback"
  sleep 16
fi

echo "STEP vless-smoke"
SMOKE_OK=0
for n in $(seq 1 18); do
  if python3 "$REPO_ROOT/infra/scripts/smoke-vless.py" --url "wss://${HOST}/?ed=2560" --uuid "$TEST_UUID" --expect-status 0 >/tmp/vless.log 2>&1; then
    SMOKE_OK=1
    break
  fi
  sleep 10
done
if [ "$SMOKE_OK" = "1" ]; then
  echo "OK vless-ws-auth-egress"
else
  echo "ERROR vless-smoke"
  tail -n 3 /tmp/vless.log
  exit 17
fi

[ -n "$LAND" ] && echo "OK unlock=on(AI域名走落地)" || echo "INFO unlock=off"

echo "DONE url=$URL"
