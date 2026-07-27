#!/usr/bin/env bash
# Enroll an existing Cloudflare One Client into a Zero Trust organization while
# preserving Local Proxy mode. On failure, restore a functional consumer WARP
# registration so the production landing remains available.
set -euo pipefail

: "${CF_ZERO_TRUST_TEAM:?CF_ZERO_TRUST_TEAM is required}"

MDM_SOURCE="${MDM_SOURCE:-/tmp/opus8-mdm.xml}"
MDM_DIR="/var/lib/cloudflare-warp"
MDM_PATH="${MDM_DIR}/mdm.xml"
BACKUP_PATH="${MDM_DIR}/mdm.xml.opus8-backup"
ABSENT_MARKER="${MDM_DIR}/mdm.xml.opus8-was-absent"
WARP_PROXY_PORT="${WARP_PROXY_PORT:-40000}"
ENROLL_OK=0

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR root-required"
  exit 2
fi
if [ ! -s "$MDM_SOURCE" ]; then
  echo "ERROR mdm-source-missing"
  exit 3
fi

warp_status() {
  timeout 12 warp-cli --accept-tos status 2>&1 || true
}

warp_settings() {
  timeout 12 warp-cli --accept-tos settings 2>&1 || true
}

proxy_works() {
  curl -4fsS --max-time 20 \
    --proxy "socks5h://127.0.0.1:${WARP_PROXY_PORT}" \
    https://api.ipify.org >/dev/null 2>&1
}

managed_team_visible() {
  warp_settings | grep -Eiq \
    "(Daemon Team|Organization|Team).*[=:][[:space:]]*${CF_ZERO_TRUST_TEAM}([[:space:]]|$)"
}

wait_for_managed_proxy() {
  local attempt
  for attempt in $(seq 1 36); do
    if warp_status | grep -q "Status update: Connected" \
      && managed_team_visible \
      && proxy_works; then
      return 0
    fi
    sleep 5
  done
  return 1
}

restore_consumer_proxy() {
  echo "ROLLBACK restoring-previous-warp-mode"
  if [ -f "$ABSENT_MARKER" ]; then
    rm -f "$MDM_PATH"
  elif [ -f "$BACKUP_PATH" ]; then
    cp -a "$BACKUP_PATH" "$MDM_PATH"
  fi
  systemctl restart warp-svc.service
  sleep 4
  if ! proxy_works; then
    warp-cli --accept-tos registration new >/dev/null 2>&1 || true
    warp-cli --accept-tos mode proxy >/dev/null 2>&1 || true
    warp-cli --accept-tos proxy port "$WARP_PROXY_PORT" >/dev/null 2>&1 || true
    warp-cli --accept-tos connect >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 18); do
    proxy_works && {
      echo "ROLLBACK consumer-warp-proxy-restored"
      return 0
    }
    sleep 5
  done
  echo "ERROR rollback-could-not-restore-warp"
  return 1
}

rollback_on_failure() {
  if [ "$ENROLL_OK" = "1" ]; then return; fi
  restore_consumer_proxy || true
}
trap rollback_on_failure EXIT

echo "STEP backup-current-mdm"
install -d -m 0755 "$MDM_DIR"
rm -f "$ABSENT_MARKER"
if [ -f "$MDM_PATH" ]; then
  cp -a "$MDM_PATH" "$BACKUP_PATH"
  chmod 0600 "$BACKUP_PATH"
  echo "OK existing-mdm-backed-up"
else
  install -m 0600 /dev/null "$ABSENT_MARKER"
  echo "OK no-existing-mdm"
fi

echo "STEP install-managed-mdm"
install -m 0600 "$MDM_SOURCE" "$MDM_PATH"
rm -f "$MDM_SOURCE"
systemctl restart warp-svc.service
sleep 5

if wait_for_managed_proxy; then
  ENROLL_OK=1
  trap - EXIT
  echo "DONE zero-trust-enrolled team=${CF_ZERO_TRUST_TEAM} mode=proxy port=${WARP_PROXY_PORT}"
  exit 0
fi

echo "INFO existing-registration-did-not-adopt-organization"
echo "STEP force-managed-reregistration"
warp-cli --accept-tos disconnect >/dev/null 2>&1 || true
warp-cli --accept-tos registration delete >/dev/null 2>&1 || true
systemctl restart warp-svc.service
sleep 5
warp-cli --accept-tos connect >/dev/null 2>&1 || true

if wait_for_managed_proxy; then
  ENROLL_OK=1
  trap - EXIT
  echo "DONE zero-trust-enrolled team=${CF_ZERO_TRUST_TEAM} mode=proxy port=${WARP_PROXY_PORT}"
  exit 0
fi

echo "ERROR managed-enrollment-failed"
echo "HINT ensure the service token is included in Device enrollment permissions with action Service Auth"
exit 20
