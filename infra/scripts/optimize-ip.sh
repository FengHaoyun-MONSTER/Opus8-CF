#!/usr/bin/env bash
# 用 CloudflareSpeedTest 选优质 CF IP，写入控制面优选IP池。
# 需要：CONTROL_PLANE_URL / ADMIN_PASSWORD
# 可选：infra/optimized-ips.txt（自定义优选IP，一行一个）优先于测速。
set -uo pipefail
WS="$(cd "$(dirname "$0")/../.." && pwd)"
: "${CONTROL_PLANE_URL:?}"; : "${ADMIN_PASSWORD:?}"

IPS=""
if [ -s "$WS/infra/optimized-ips.txt" ]; then
  IPS=$(grep -E '^[0-9a-fA-F:.]' "$WS/infra/optimized-ips.txt" | head -10 | tr '\n' ' ')
  echo "OK using-custom-list"
else
  echo "STEP fetch-cfst"
  if ! curl -fsSL https://github.com/XIU2/CloudflareSpeedTest/releases/latest/download/CloudflareST_linux_amd64.tar.gz -o /tmp/cfst.tgz; then echo "ERROR cfst-download"; exit 10; fi
  mkdir -p /tmp/cfst && tar xzf /tmp/cfst.tgz -C /tmp/cfst
  cd /tmp/cfst && chmod +x CloudflareST
  echo "OK cfst-ready"
  echo "STEP speedtest"
  if ! ./CloudflareST -dd -tp 443 -n 200 -t 4 -o result.csv >/tmp/cfst.log 2>&1; then echo "ERROR speedtest"; tail -5 /tmp/cfst.log; exit 11; fi
  IPS=$(tail -n +2 result.csv | head -10 | cut -d, -f1 | grep -E '^[0-9]' | tr '\n' ' ')
fi
echo "OK ips:${IPS:- none}"
[ -z "$IPS" ] && { echo "ERROR no-ips"; exit 12; }

echo "STEP push-to-control"
TOK=$(curl -s --max-time 15 -X POST "$CONTROL_PLANE_URL/api/admin/login" -H 'content-type: application/json' -d "{\"password\":\"$ADMIN_PASSWORD\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch(e){}})')
[ -z "$TOK" ] && { echo "ERROR admin-login"; exit 13; }
BODY=$(printf '%s\n' $IPS | jq -R . | jq -sc '{ips: map(select(length>0))}')
RES=$(curl -s --max-time 15 -X POST "$CONTROL_PLANE_URL/api/optimized-ips" -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d "$BODY")
echo "OK pushed:$RES"
echo "DONE"
