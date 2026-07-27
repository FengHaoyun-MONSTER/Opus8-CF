#!/usr/bin/env bash
# Deploy an authenticated Dante SOCKS5 ingress on port 40008 and chain every
# accepted TCP CONNECT through the Cloudflare One Client local proxy on 40000.
# The Opus8 edge decides which destination domains are sent to this landing.
set -euo pipefail

: "${SOCKS_USER:?SOCKS_USER is required}"
: "${SOCKS_PASSWORD:?SOCKS_PASSWORD is required}"

DANTE_PORT="${DANTE_PORT:-40008}"
WARP_PROXY_PORT="${WARP_PROXY_PORT:-40000}"
CONFIG_PATH="/etc/danted-opus8.conf"
UNIT_PATH="/etc/systemd/system/opus8-dante.service"
ROLLED_FORWARDER_BACK=0
DEPLOY_OK=0

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR root-required"
  exit 2
fi
if ! [[ "$SOCKS_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]]; then
  echo "ERROR invalid-socks-username"
  exit 3
fi
if [ "$SOCKS_USER" = "root" ]; then
  echo "ERROR refusing-root-socks-account"
  exit 4
fi

rollback() {
  if [ "$DEPLOY_OK" = "1" ]; then return; fi
  echo "ROLLBACK deployment-failed"
  systemctl stop opus8-dante.service >/dev/null 2>&1 || true
  if [ "$ROLLED_FORWARDER_BACK" = "1" ] && command -v socat >/dev/null 2>&1; then
    nohup socat "TCP-LISTEN:${DANTE_PORT},bind=0.0.0.0,fork" \
      "TCP:127.0.0.1:${WARP_PROXY_PORT}" >/var/log/opus8-socat.log 2>&1 &
    echo "ROLLBACK restored-legacy-forwarder"
  fi
}
trap rollback EXIT

echo "STEP verify-warp-local-proxy"
if ! curl -4fsS --max-time 20 --proxy "socks5h://127.0.0.1:${WARP_PROXY_PORT}" \
  https://api.ipify.org >/dev/null; then
  echo "ERROR warp-local-proxy-unavailable"
  exit 10
fi
echo "OK warp-local-proxy"

echo "STEP inspect-current-listener"
LISTENER=$(ss -H -lntup 2>/dev/null | awk -v p=":${DANTE_PORT}" '$5 ~ p"$" {print; exit}')
if [ -n "$LISTENER" ]; then
  if echo "$LISTENER" | grep -q '"socat"'; then
    SOCAT_PID=$(echo "$LISTENER" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p')
    SOCAT_CMD=$(tr '\0' ' ' < "/proc/${SOCAT_PID}/cmdline" 2>/dev/null || true)
    if ! echo "$SOCAT_CMD" | grep -Eq \
      "^socat TCP-LISTEN:${DANTE_PORT},bind=0\\.0\\.0\\.0,fork TCP:127\\.0\\.0\\.1:${WARP_PROXY_PORT} ?$"; then
      echo "ERROR refusing-to-replace-unknown-socat"
      exit 11
    fi
    kill "$SOCAT_PID"
    for _ in $(seq 1 20); do
      kill -0 "$SOCAT_PID" >/dev/null 2>&1 || break
      sleep 0.25
    done
    if kill -0 "$SOCAT_PID" >/dev/null 2>&1; then
      echo "ERROR legacy-forwarder-did-not-stop"
      exit 12
    fi
    ROLLED_FORWARDER_BACK=1
    echo "OK legacy-forwarder-stopped"
  elif echo "$LISTENER" | grep -Eq '"danted"|"sockd"'; then
    echo "INFO dante-already-listening"
    systemctl stop opus8-dante.service >/dev/null 2>&1 || true
  else
    echo "ERROR port-${DANTE_PORT}-owned-by-unknown-process"
    exit 13
  fi
else
  echo "OK port-${DANTE_PORT}-free"
fi

echo "STEP install-dante"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq dante-server curl ca-certificates
systemctl disable --now danted.service >/dev/null 2>&1 || true
echo "OK dante-installed"

echo "STEP configure-account"
if id "$SOCKS_USER" >/dev/null 2>&1; then
  if [ "$(id -u "$SOCKS_USER")" -eq 0 ]; then
    echo "ERROR socks-account-resolves-to-root"
    exit 20
  fi
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SOCKS_USER"
fi
printf '%s:%s\n' "$SOCKS_USER" "$SOCKS_PASSWORD" | chpasswd
passwd -u "$SOCKS_USER" >/dev/null 2>&1 || true
echo "OK socks-account-ready"

EXTERNAL_IF=$(ip -o route show default | awk 'NR==1{print $5}')
if [ -z "$EXTERNAL_IF" ]; then
  echo "ERROR default-interface-not-found"
  exit 21
fi

echo "STEP configure-dante"
install -m 0600 /dev/null "$CONFIG_PATH"
cat > "$CONFIG_PATH" <<EOF
logoutput: syslog
internal: 0.0.0.0 port = ${DANTE_PORT}
external: ${EXTERNAL_IF}

clientmethod: none
socksmethod: username

user.privileged: root
user.notprivileged: nobody

timeout.negotiate: 30
timeout.connect: 30
timeout.io: 0

client pass {
  from: 0.0.0.0/0 to: 0.0.0.0/0
  log: connect disconnect error
}

socks pass {
  from: 0.0.0.0/0 to: 0.0.0.0/0
  command: connect
  protocol: tcp
  proxyprotocol: socks_v5
  socksmethod: username
  user: ${SOCKS_USER}
  log: connect disconnect error
}

route {
  from: 0.0.0.0/0 to: 0.0.0.0/0 via: 127.0.0.1 port = ${WARP_PROXY_PORT}
  command: connect
  protocol: tcp
  proxyprotocol: socks_v5
  method: none
}
EOF

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Opus8 authenticated Dante to Cloudflare WARP
After=network-online.target warp-svc.service
Wants=network-online.target
Requires=warp-svc.service

[Service]
Type=simple
ExecStart=/usr/sbin/danted -f ${CONFIG_PATH}
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=2s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now opus8-dante.service
sleep 2
if ! systemctl is-active --quiet opus8-dante.service; then
  journalctl -u opus8-dante.service --no-pager -n 30
  echo "ERROR dante-service-not-active"
  exit 22
fi
echo "OK dante-active"

echo "STEP verify-authenticated-chain"
AUTH_EXIT=$(curl -4fsS --max-time 25 \
  --proxy "socks5h://127.0.0.1:${DANTE_PORT}" \
  --proxy-user "${SOCKS_USER}:${SOCKS_PASSWORD}" \
  https://api.ipify.org || true)
WARP_EXIT=$(curl -4fsS --max-time 25 \
  --proxy "socks5h://127.0.0.1:${WARP_PROXY_PORT}" \
  https://api.ipify.org || true)
if [ -z "$AUTH_EXIT" ] || [ -z "$WARP_EXIT" ] || [ "$AUTH_EXIT" != "$WARP_EXIT" ]; then
  echo "ERROR authenticated-chain-egress-mismatch"
  exit 23
fi
if curl -4fsS --max-time 8 --proxy "socks5h://127.0.0.1:${DANTE_PORT}" \
  https://api.ipify.org >/dev/null 2>&1; then
  echo "ERROR unauthenticated-access-still-allowed"
  exit 24
fi
if curl -4fsS --max-time 8 --proxy "socks5h://127.0.0.1:${DANTE_PORT}" \
  --proxy-user "${SOCKS_USER}:definitely-wrong-password" \
  https://api.ipify.org >/dev/null 2>&1; then
  echo "ERROR wrong-password-still-allowed"
  exit 25
fi
echo "OK auth-required-and-warp-egress"

DEPLOY_OK=1
trap - EXIT
echo "DONE dante_port=${DANTE_PORT} warp_proxy_port=${WARP_PROXY_PORT}"
