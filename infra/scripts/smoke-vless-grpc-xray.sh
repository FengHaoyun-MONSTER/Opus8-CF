#!/usr/bin/env bash
# 使用固定版本的官方 Xray-core 对 VLESS gRPC 做真实端到端灰度验证。
set -euo pipefail

HOST="${1:-}"
USER_UUID="${2:-}"
[[ "$HOST" =~ ^[A-Za-z0-9.-]+$ ]] || {
  echo "usage: $0 <hostname> <uuid>" >&2
  exit 2
}
[[ "$USER_UUID" =~ ^[0-9a-fA-F-]{36}$ ]] || {
  echo "usage: $0 <hostname> <uuid>" >&2
  exit 2
}
for dependency in curl jq sha256sum unzip; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing dependency: $dependency" >&2
    exit 2
  }
done

XRAY_VERSION="v26.3.27"
XRAY_SHA256="23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae"
XRAY_USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
XRAY_DIR="/tmp/opus8-xray-${XRAY_VERSION}"
XRAY_BIN="$XRAY_DIR/xray"
mkdir -p "$XRAY_DIR"
if [ ! -x "$XRAY_BIN" ]; then
  ARCHIVE="$XRAY_DIR/Xray-linux-64.zip"
  curl -fsSL --retry 3 \
    "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip" \
    -o "$ARCHIVE"
  printf '%s  %s\n' "$XRAY_SHA256" "$ARCHIVE" | sha256sum -c - >/dev/null
  unzip -oq "$ARCHIVE" -d "$XRAY_DIR"
  chmod 700 "$XRAY_BIN"
fi

SOCKS_PORT=$((20000 + RANDOM % 20000))
CONFIG="/tmp/opus8-xray-grpc-${SOCKS_PORT}.json"
LOG="/tmp/opus8-xray-grpc-${SOCKS_PORT}.log"
RESPONSE="/tmp/opus8-xray-grpc-${SOCKS_PORT}.response"

jq -n \
  --arg host "$HOST" \
  --arg uuid "$USER_UUID" \
  --arg userAgent "$XRAY_USER_AGENT" \
  --argjson port "$SOCKS_PORT" \
  '{
    log:{loglevel:"info"},
    inbounds:[{
      tag:"socks-in",
      listen:"127.0.0.1",
      port:$port,
      protocol:"socks",
      settings:{udp:false}
    }],
    outbounds:[{
      tag:"proxy",
      protocol:"vless",
      settings:{vnext:[{
        address:$host,
        port:443,
        users:[{id:$uuid,encryption:"none"}]
      }]},
      streamSettings:{
        network:"grpc",
        security:"tls",
        tlsSettings:{
          serverName:$host,
          allowInsecure:false,
          alpn:["h2"],
          fingerprint:"chrome"
        },
        grpcSettings:{
          authority:$host,
          serviceName:"grpc",
          multiMode:false,
          user_agent:$userAgent
        }
      }
    }]
  }' > "$CONFIG"

"$XRAY_BIN" run -config "$CONFIG" >"$LOG" 2>&1 &
XRAY_PID=$!
cleanup() {
  kill "$XRAY_PID" >/dev/null 2>&1 || true
  wait "$XRAY_PID" >/dev/null 2>&1 || true
  rm -f "$CONFIG" "$RESPONSE"
}
trap cleanup EXIT

for attempt in 1 2 3 4; do
  if ! kill -0 "$XRAY_PID" >/dev/null 2>&1; then
    break
  fi
  CODE="000"
  if CODE=$(curl -sS -o "$RESPONSE" \
      -w '%{http_code}' --max-time 12 \
      --socks5-hostname "127.0.0.1:${SOCKS_PORT}" \
      http://example.com/); then
    CURL_EXIT=0
  else
    CURL_EXIT=$?
  fi
  if [ "$CODE" = "200" ]; then
    echo "OK xray-grpc-egress"
    exit 0
  fi
  echo "INFO xray-grpc-attempt=$attempt curl-exit=$CURL_EXIT http=$CODE" >&2
  sleep 2
done

echo "xray-grpc smoke failed" >&2
tail -n 40 "$LOG" \
  | sed -E 's/[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}/<uuid-redacted>/g' >&2 \
  || true
exit 1
