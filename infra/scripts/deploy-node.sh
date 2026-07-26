#!/usr/bin/env bash
# 部署单个边缘节点：构建补丁版 worker、探测落地机端口、部署、设密钥、注册、验证。
# 需要环境变量：
#   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
#   CONTROL_PLANE_URL / NODE_HMAC_SECRET / NODE_ID / NODE_ACCOUNT_ALIAS / NODE_REGION
#   SERVICES_IP / SERVICES_USER / SERVICES_CODE  (落地机，可缺省 -> 纯 CF 出口)
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
cd packages/edge-node

: "${NODE_ID:?}"; : "${NODE_ACCOUNT_ALIAS:?}"; : "${CONTROL_PLANE_URL:?}"; : "${NODE_HMAC_SECRET:?}"
NODE_REGION="${NODE_REGION:-}"
WORKER_NAME="opus8cf-node-${NODE_ID}"

echo "STEP build"
if ! node build/build.mjs >/tmp/nb.log 2>&1; then echo "ERROR build"; tail -n 8 /tmp/nb.log; exit 10; fi
echo "OK built ($(cat /tmp/nb.log))"

echo "STEP probe-landing"
PORT=""; LAND=""
if [ -n "${SERVICES_IP:-}" ]; then
  for p in 1080 1081 1088 1090 7890 7891 7892 8388 3128 8080 10808 10809 20170 40000 42000 9050 1024 5000 443 8443; do
    out=$(curl -s --connect-timeout 5 --max-time 10 --socks5-hostname "${SERVICES_USER:-}:${SERVICES_CODE:-}@${SERVICES_IP}:$p" https://api.ipify.org 2>/dev/null || true)
    if echo "$out" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then PORT=$p; echo "OK landing-port=$p exit=$out"; break; fi
  done
  if [ -n "$PORT" ]; then
    if [ -n "${SERVICES_USER:-}" ]; then LAND="${SERVICES_USER}:${SERVICES_CODE}@${SERVICES_IP}:${PORT}"; else LAND="${SERVICES_IP}:${PORT}"; fi
  else
    echo "INFO landing-no-port (节点将走纯 CF 出口，无解锁)"
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

NODE_UUID=$(cat /proc/sys/kernel/random/uuid)

cat > wrangler.toml <<EOF
name = "${WORKER_NAME}"
main = "dist/index.js"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]
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
EOF

echo "STEP deploy"
if ! wrangler deploy >/tmp/nd.log 2>&1; then echo "ERROR deploy"; tail -n 8 /tmp/nd.log | sed 's/[A-Za-z0-9_-]\{24,\}/<redacted>/g'; exit 12; fi
URL=$(grep -oE 'https://[a-z0-9._-]+workers\.dev' /tmp/nd.log | head -n1)
HOST=$(printf '%s' "$URL" | sed 's#https://##')
echo "OK deployed url=$URL"

echo "STEP secrets"
printf '%s' "$NODE_HMAC_SECRET" | wrangler secret put NODE_HMAC_SECRET >/dev/null 2>&1 && echo "OK secret hmac"
printf '%s' "$NODE_UUID"        | wrangler secret put UUID            >/dev/null 2>&1 && echo "OK secret uuid"
if [ -n "$LAND" ]; then
  printf '%s' "$LAND" | wrangler secret put SOCKS5 >/dev/null 2>&1 && echo "OK secret socks5-landing(解锁已启用)"
fi

echo "STEP register"
TS=$(date +%s)000
BODY=$(H="$HOST" node -e "process.stdout.write(JSON.stringify({nodeId:process.env.NODE_ID,accountAlias:process.env.NODE_ACCOUNT_ALIAS,hostname:process.env.H,region:process.env.NODE_REGION||null,capabilities:['vless-ws','xhttp','grpc'].concat(process.env.HASLAND?['unlock']:[])}))" HASLAND="$LAND")
SIG=$(printf '%s' "${TS}.${NODE_ID}.${BODY}" | openssl dgst -sha256 -hmac "$NODE_HMAC_SECRET" -r | cut -d' ' -f1)
RCODE=$(curl -s -o /tmp/reg.json -w '%{http_code}' --max-time 20 -X POST "$CONTROL_PLANE_URL/api/nodes/register" \
  -H "x-opus8-ts: $TS" -H "x-opus8-node: $NODE_ID" -H "x-opus8-sign: $SIG" -H 'content-type: application/json' -d "$BODY")
if [ "$RCODE" = "200" ]; then echo "OK registered host=$HOST"; else echo "ERROR register http=$RCODE"; fi

echo "STEP verify"
NC=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/" || echo 000)
echo "OK node-http=$NC"
TS2=$(date +%s)000
SIG2=$(printf '%s' "${TS2}.${NODE_ID}." | openssl dgst -sha256 -hmac "$NODE_HMAC_SECRET" -r | cut -d' ' -f1)
UC=$(curl -s --max-time 15 "$CONTROL_PLANE_URL/api/nodes/$NODE_ID/uuids" \
  -H "x-opus8-ts: $TS2" -H "x-opus8-node: $NODE_ID" -H "x-opus8-sign: $SIG2" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j.uuids||[]).length))}catch(e){process.stdout.write("err")}})')
echo "OK uuids-endpoint-count=$UC"
[ -n "$LAND" ] && echo "OK unlock=on(AI域名走落地)" || echo "INFO unlock=off"

echo "DONE url=$URL"
