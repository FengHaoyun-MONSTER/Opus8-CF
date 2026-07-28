export type AccessState =
  | "active"
  | "disabled"
  | "expired"
  | "traffic_quota_exceeded"
  | "active_ip_limit_reached"
  | "ip_churn_limit_reached"
  | "traffic_near_quota"
  | "expiring_soon";

export type AccessSeverity = "healthy" | "warning" | "danger";

interface AccessStatusInput {
  enabled: number;
  expire_at: number | null;
  device_limit: number;
  ip_limit_24h: number;
  traffic_limit_bytes: number;
  bytes_up: number;
  bytes_down: number;
  active_ips: number;
  recent_ips: number;
}

export interface AccessStatus {
  state: AccessState;
  severity: AccessSeverity;
  reason: string;
}

const THREE_DAYS_MS = 3 * 86_400_000;

export function evaluateAccessStatus(
  user: AccessStatusInput,
  now = Date.now(),
): AccessStatus {
  const usedBytes = Number(user.bytes_up || 0) + Number(user.bytes_down || 0);
  if (Number(user.enabled) !== 1) {
    return { state: "disabled", severity: "danger", reason: "管理员已停用" };
  }
  if (user.expire_at && Number(user.expire_at) <= now) {
    return { state: "expired", severity: "danger", reason: "账号已过期" };
  }
  if (
    Number(user.traffic_limit_bytes) > 0 &&
    usedBytes >= Number(user.traffic_limit_bytes)
  ) {
    return {
      state: "traffic_quota_exceeded",
      severity: "danger",
      reason: "流量额度已用尽",
    };
  }
  if (Number(user.active_ips) >= Number(user.device_limit)) {
    return {
      state: "active_ip_limit_reached",
      severity: "warning",
      reason: "同时在线 IP 已满，新设备会被拒绝",
    };
  }
  if (Number(user.recent_ips) >= Number(user.ip_limit_24h)) {
    return {
      state: "ip_churn_limit_reached",
      severity: "warning",
      reason: "24 小时 IP 数已达上限",
    };
  }
  if (
    Number(user.traffic_limit_bytes) > 0 &&
    usedBytes >= Number(user.traffic_limit_bytes) * 0.9
  ) {
    return {
      state: "traffic_near_quota",
      severity: "warning",
      reason: "流量额度已使用 90% 以上",
    };
  }
  if (
    user.expire_at &&
    Number(user.expire_at) > now &&
    Number(user.expire_at) - now <= THREE_DAYS_MS
  ) {
    return {
      state: "expiring_soon",
      severity: "warning",
      reason: "将在 3 天内到期",
    };
  }
  return { state: "active", severity: "healthy", reason: "运行正常" };
}
