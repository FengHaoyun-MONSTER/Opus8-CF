import { listNodes, listUsers, type AdminUserRecord, type Env } from "./db";
import { evaluateAccessStatus } from "./access-status";
import type { NodeRecord } from "@opus8-cf/shared";
import {
  reconcileAlertIncidents,
  type OperationAlert,
} from "./alert-incidents";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NODE_HEALTH_STALE_MS = 30 * 60_000;
const OPTIMIZED_IP_EXPIRY_WARNING_MS = 90 * 60_000;

interface UsageBucket {
  ts: number;
  bytesUp: number;
  bytesDown: number;
  connections: number;
}

function finiteNumber(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function fillHourlySeries(
  rows: Array<{
    ts_bucket: number;
    bytes_up: number;
    bytes_down: number;
    connections: number;
  }>,
  now: number,
): UsageBucket[] {
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const values = new Map(
    rows.map((row) => [
      finiteNumber(row.ts_bucket),
      {
        bytesUp: finiteNumber(row.bytes_up),
        bytesDown: finiteNumber(row.bytes_down),
        connections: finiteNumber(row.connections),
      },
    ]),
  );
  return Array.from({ length: 24 }, (_, index) => {
    const ts = currentHour - (23 - index) * HOUR_MS;
    const value = values.get(ts);
    return {
      ts,
      bytesUp: value?.bytesUp || 0,
      bytesDown: value?.bytesDown || 0,
      connections: value?.connections || 0,
    };
  });
}

function operationalUser(user: AdminUserRecord, now: number) {
  const access = evaluateAccessStatus(user, now);
  const usedBytes = finiteNumber(user.bytes_up) + finiteNumber(user.bytes_down);
  return {
    id: user.id,
    username: user.username,
    enabled: Number(user.enabled),
    expireAt: user.expire_at,
    unlock: Number(user.unlock),
    usedBytes,
    trafficLimitBytes: finiteNumber(user.traffic_limit_bytes),
    connections: finiteNumber(user.connections),
    activeIps: finiteNumber(user.active_ips),
    deviceLimit: finiteNumber(user.device_limit),
    recentIps: finiteNumber(user.recent_ips),
    ipLimit24h: finiteNumber(user.ip_limit_24h),
    accessState: access.state,
    accessSeverity: access.severity,
    accessReason: access.reason,
  };
}

interface OptimizedIpOperations {
  enabled: boolean;
  eligibleNodes: number;
  activeNodes: number;
  fallbackNodes: number;
  totalIps: number;
  generatedAt: number | null;
  earliestExpiresAt: number | null;
  alerts: Array<{
    kind: "optimized_ip";
    severity: "warning" | "danger";
    id: string;
    title: string;
    detail: string;
  }>;
}

async function optimizedIpOperations(
  env: Env,
  nodes: NodeRecord[],
  now: number,
): Promise<OptimizedIpOperations> {
  const eligible = nodes.filter(
    (node) => Number(node.enabled) === 1 && node.health !== "banned",
  );
  const result: OptimizedIpOperations = {
    enabled: env.USE_OPTIMIZED_IPS === "1",
    eligibleNodes: eligible.length,
    activeNodes: 0,
    fallbackNodes: eligible.length,
    totalIps: 0,
    generatedAt: null,
    earliestExpiresAt: null,
    alerts: [],
  };
  if (!result.enabled) {
    if (eligible.length > 0) {
      result.alerts.push({
        kind: "optimized_ip",
        severity: "warning",
        id: "subscription-disabled",
        title: "优选 IP 未启用",
        detail: `${eligible.length} 个可用节点当前全部使用域名连接`,
      });
    }
    return result;
  }

  let value: {
    version?: unknown;
    generatedAt?: unknown;
    nodes?: Record<string, unknown>;
  } | null = null;
  try {
    const raw = await env.KV.get("opus8:opt-ips");
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  if (
    !value ||
    value.version !== 3 ||
    !value.nodes ||
    typeof value.nodes !== "object" ||
    Array.isArray(value.nodes)
  ) {
    if (eligible.length > 0) {
      result.alerts.push({
        kind: "optimized_ip",
        severity: "danger",
        id: "pool-unavailable",
        title: "优选 IP 池不可用",
        detail: `${eligible.length} 个可用节点已安全回退域名，请运行重新优选任务`,
      });
    }
    return result;
  }

  const generatedAt = Number(value.generatedAt);
  result.generatedAt = Number.isSafeInteger(generatedAt) ? generatedAt : null;
  const expiries: number[] = [];
  for (const node of eligible) {
    const entry = value.nodes[node.id] as
      | {
          hostname?: unknown;
          ips?: unknown;
          validatedAt?: unknown;
          expiresAt?: unknown;
          vantages?: unknown;
        }
      | undefined;
    const ips = Array.isArray(entry?.ips)
      ? [
          ...new Set(
            entry.ips.filter(
              (ip): ip is string =>
                typeof ip === "string" &&
                ip.length > 0 &&
                /^[0-9a-fA-F.:]+$/.test(ip),
            ),
          ),
        ]
      : [];
    const vantages = Array.isArray(entry?.vantages)
      ? entry.vantages.filter((item): item is string => typeof item === "string")
      : [];
    const expiresAt = Number(entry?.expiresAt);
    let reason = "";
    if (!entry) reason = "本轮没有通过双视角验证的候选 IP";
    else if (entry.hostname !== node.hostname)
      reason = "优选记录主机名与当前节点不一致";
    else if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
      reason = "优选记录已过期";
    else if (
      !vantages.includes("github-runner") ||
      !vantages.includes("landing-vps")
    )
      reason = "优选记录缺少双视角验证";
    else if (ips.length === 0) reason = "优选记录没有有效 IP";

    if (reason) {
      result.alerts.push({
        kind: "optimized_ip",
        severity: "warning",
        id: node.id,
        title: `${node.id} 使用域名回退`,
        detail: reason,
      });
      continue;
    }
    result.activeNodes += 1;
    result.totalIps += ips.length;
    expiries.push(expiresAt);
  }
  result.fallbackNodes = result.eligibleNodes - result.activeNodes;
  result.earliestExpiresAt =
    expiries.length > 0 ? Math.min(...expiries) : null;
  if (
    result.earliestExpiresAt &&
    result.earliestExpiresAt - now <= OPTIMIZED_IP_EXPIRY_WARNING_MS
  ) {
    result.alerts.push({
      kind: "optimized_ip",
      severity: "warning",
      id: "pool-expiring",
      title: "优选 IP 池即将过期",
      detail: `最早一组记录将在 ${Math.max(
        0,
        Math.ceil((result.earliestExpiresAt - now) / 60_000),
      )} 分钟后过期`,
    });
  }
  if (result.activeNodes === 0 && result.eligibleNodes > 0) {
    result.alerts = result.alerts.filter(
      (alert) => alert.id !== "pool-expiring",
    );
    result.alerts.unshift({
      kind: "optimized_ip",
      severity: "danger",
      id: "zero-coverage",
      title: "优选 IP 覆盖为零",
      detail: "所有可用节点均已安全回退域名，请检查最近一次优选任务",
    });
  }
  return result;
}

export async function operationsOverview(env: Env) {
  const now = Date.now();
  const windowStart = Math.floor((now - 23 * HOUR_MS) / HOUR_MS) * HOUR_MS;
  const [
    users,
    nodes,
    usageResult,
    nodeUsageResult,
    landingResult,
    landingAlertResult,
  ] =
    await Promise.all([
      listUsers(env),
      listNodes(env),
      env.DB.prepare(
        `SELECT ts_bucket,
         SUM(bytes_up) AS bytes_up,
         SUM(bytes_down) AS bytes_down,
         SUM(connections) AS connections
       FROM usage
       WHERE ts_bucket>=?1
       GROUP BY ts_bucket
       ORDER BY ts_bucket`,
      )
        .bind(windowStart)
        .all<{
          ts_bucket: number;
          bytes_up: number;
          bytes_down: number;
          connections: number;
        }>(),
      env.DB.prepare(
        `SELECT node_id,
         SUM(bytes_up) AS bytes_up,
         SUM(bytes_down) AS bytes_down,
         SUM(connections) AS connections
       FROM usage
       WHERE ts_bucket>=?1
       GROUP BY node_id`,
      )
        .bind(windowStart)
        .all<{
          node_id: string | null;
          bytes_up: number;
          bytes_down: number;
          connections: number;
        }>(),
      env.DB.prepare(
        `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN enabled=1 AND health='healthy' THEN 1 ELSE 0 END) AS healthy,
         SUM(CASE WHEN enabled=1 AND health='unhealthy' THEN 1 ELSE 0 END) AS unhealthy
       FROM landings`,
      ).first<{ total: number; healthy: number; unhealthy: number }>(),
      env.DB.prepare(
        `SELECT id,name,enabled,health,last_checked,last_error
         FROM landings
         ORDER BY priority ASC,created_at ASC`,
      ).all<{
        id: string;
        name: string;
        enabled: number;
        health: string;
        last_checked: number | null;
        last_error: string | null;
      }>(),
    ]);

  const series = fillHourlySeries(usageResult.results ?? [], now);
  const operationalUsers = users.map((user) => operationalUser(user, now));
  const topUsers = [...operationalUsers]
    .sort((a, b) => b.usedBytes - a.usedBytes || b.connections - a.connections)
    .slice(0, 8);
  const nodeUsage = new Map(
    (nodeUsageResult.results ?? []).map((row) => [
      row.node_id || "unknown",
      {
        bytesUp: finiteNumber(row.bytes_up),
        bytesDown: finiteNumber(row.bytes_down),
        connections: finiteNumber(row.connections),
      },
    ]),
  );
  const nodeTraffic = nodes.map((node) => {
    const usage = nodeUsage.get(node.id);
    return {
      id: node.id,
      hostname: node.hostname,
      region: node.region,
      health: node.health,
      enabled: Number(node.enabled),
      lastSeen: node.last_seen,
      lastChecked: node.health_last_checked ?? null,
      directOk: node.health_direct_ok ?? null,
      landingOk: node.health_landing_ok ?? null,
      directLatencyMs: node.health_direct_latency_ms ?? null,
      landingLatencyMs: node.health_landing_latency_ms ?? null,
      bytesUp: usage?.bytesUp || 0,
      bytesDown: usage?.bytesDown || 0,
      connections: usage?.connections || 0,
    };
  });
  const optimizedIp = await optimizedIpOperations(env, nodes, now);

  const userAlerts = operationalUsers
    .filter((user) => user.accessSeverity !== "healthy")
    .map((user) => ({
      kind: "user" as const,
      severity: user.accessSeverity,
      id: user.id,
      title: user.username || `用户 ${user.id.slice(0, 8)}`,
      detail: user.accessReason,
    }));
  const nodeAlerts = nodes
    .filter(
      (node) =>
        Number(node.enabled) !== 1 ||
        node.health !== "healthy" ||
        !node.health_last_checked ||
        now - node.health_last_checked > NODE_HEALTH_STALE_MS,
    )
    .map((node) => ({
      kind: "node" as const,
      severity:
        node.health === "banned" ? ("danger" as const) : ("warning" as const),
      id: node.id,
      title: node.hostname || node.id,
      detail:
        Number(node.enabled) !== 1
          ? "节点已停用"
          : !node.health_last_checked
            ? "尚未执行真实 VLESS 探测"
            : now - node.health_last_checked > NODE_HEALTH_STALE_MS
              ? `真实探测已超过 ${Math.round(
                  (now - node.health_last_checked) / 60_000,
                )} 分钟未更新`
              : node.health_last_error || `节点状态：${node.health}`,
    }));
  const landingAlerts = (landingAlertResult.results ?? [])
    .filter(
      (landing) =>
        Number(landing.enabled) === 1 &&
        (landing.health !== "healthy" ||
          !landing.last_checked ||
          now - landing.last_checked > NODE_HEALTH_STALE_MS),
    )
    .map((landing) => ({
      kind: "landing" as const,
      severity:
        landing.health === "unhealthy"
          ? ("danger" as const)
          : ("warning" as const),
      id: landing.id,
      title: `落地机：${landing.name}`,
      detail:
        landing.health === "unhealthy"
          ? landing.last_error || "SOCKS5 真实探测失败"
          : !landing.last_checked
            ? "尚未执行 SOCKS5 真实探测"
            : `落地机探测已超过 ${Math.round(
                (now - landing.last_checked) / 60_000,
              )} 分钟未更新`,
    }));

  const windowTrafficBytes = series.reduce(
    (sum, bucket) => sum + bucket.bytesUp + bucket.bytesDown,
    0,
  );
  const windowConnections = series.reduce(
    (sum, bucket) => sum + bucket.connections,
    0,
  );
  const totalTrafficBytes = operationalUsers.reduce(
    (sum, user) => sum + user.usedBytes,
    0,
  );

  const allAlerts: OperationAlert[] = [
    ...optimizedIp.alerts,
    ...nodeAlerts,
    ...landingAlerts,
    ...userAlerts,
  ]
    .sort((a, b) => Number(b.severity === "danger") - Number(a.severity === "danger"));
  const alerts = allAlerts.slice(0, 50);
  const internalUserIds = new Set(
    users
      .filter((user) => user.username?.startsWith("__"))
      .map((user) => user.id),
  );
  const incidentState = await reconcileAlertIncidents(
    env,
    allAlerts.filter(
      (alert) => alert.kind !== "user" || !internalUserIds.has(alert.id),
    ),
    now,
  );

  return {
    generatedAt: now,
    windowHours: 24,
    summary: {
      totalUsers: users.length,
      activeUsers: operationalUsers.filter(
        (user) =>
          !["disabled", "expired", "traffic_quota_exceeded"].includes(
            user.accessState,
          ),
      ).length,
      blockedUsers: operationalUsers.filter(
        (user) => user.accessSeverity === "danger",
      ).length,
      attentionUsers: operationalUsers.filter(
        (user) => user.accessSeverity === "warning",
      ).length,
      activeIps: operationalUsers.reduce(
        (sum, user) => sum + user.activeIps,
        0,
      ),
      recentIps: operationalUsers.reduce(
        (sum, user) => sum + user.recentIps,
        0,
      ),
      totalTrafficBytes,
      windowTrafficBytes,
      windowConnections,
      totalNodes: nodes.length,
      healthyNodes: nodes.filter(
        (node) => Number(node.enabled) === 1 && node.health === "healthy",
      ).length,
      totalLandings: finiteNumber(landingResult?.total),
      healthyLandings: finiteNumber(landingResult?.healthy),
      unhealthyLandings: finiteNumber(landingResult?.unhealthy),
      dangerAlerts: allAlerts.filter((alert) => alert.severity === "danger").length,
      warningAlerts: allAlerts.filter((alert) => alert.severity === "warning").length,
    },
    series,
    topUsers,
    nodeTraffic,
    optimizedIp: {
      enabled: optimizedIp.enabled,
      eligibleNodes: optimizedIp.eligibleNodes,
      activeNodes: optimizedIp.activeNodes,
      fallbackNodes: optimizedIp.fallbackNodes,
      totalIps: optimizedIp.totalIps,
      generatedAt: optimizedIp.generatedAt,
      earliestExpiresAt: optimizedIp.earliestExpiresAt,
    },
    alertStorage: {
      backend: "d1" as const,
      writes: incidentState.writes,
      kvWrites: 0,
    },
    alertIncidents: incidentState.incidents,
    alerts,
  };
}

export async function userOperationsActivity(env: Env, userId: string) {
  const now = Date.now();
  const user = (await listUsers(env)).find((item) => item.id === userId);
  if (!user) return null;
  const dayAgo = now - DAY_MS;
  const [activeResult, historyResult, usageResult] = await Promise.all([
    env.DB.prepare(
      `SELECT
         SUBSTR(ip_hash,1,16) AS fingerprint,
         node_id,
         first_seen,
         last_seen,
         expires_at
       FROM active_leases
       WHERE user_id=?1 AND expires_at>?2
       ORDER BY last_seen DESC`,
    )
      .bind(userId, now)
      .all<{
        fingerprint: string;
        node_id: string;
        first_seen: number;
        last_seen: number;
        expires_at: number;
      }>(),
    env.DB.prepare(
      `SELECT
         SUBSTR(h.ip_hash,1,16) AS fingerprint,
         h.first_seen,
         h.last_seen,
         CASE WHEN EXISTS(
           SELECT 1 FROM active_leases a
           WHERE a.user_id=h.user_id AND a.ip_hash=h.ip_hash AND a.expires_at>?2
         ) THEN 1 ELSE 0 END AS active
       FROM ip_history h
       WHERE h.user_id=?1 AND h.last_seen>?3
       ORDER BY h.last_seen DESC`,
    )
      .bind(userId, now, dayAgo)
      .all<{
        fingerprint: string;
        first_seen: number;
        last_seen: number;
        active: number;
      }>(),
    env.DB.prepare(
      `SELECT
         COALESCE(node_id,'unknown') AS node_id,
         SUM(bytes_up) AS bytes_up,
         SUM(bytes_down) AS bytes_down,
         SUM(connections) AS connections,
         MAX(ts_bucket) AS last_active
       FROM usage
       WHERE user_id=?1
       GROUP BY COALESCE(node_id,'unknown')
       ORDER BY (SUM(bytes_up)+SUM(bytes_down)) DESC`,
    )
      .bind(userId)
      .all<{
        node_id: string;
        bytes_up: number;
        bytes_down: number;
        connections: number;
        last_active: number;
      }>(),
  ]);
  return {
    generatedAt: now,
    user: operationalUser(user, now),
    activeLeases: (activeResult.results ?? []).map((row) => ({
      fingerprint: row.fingerprint,
      nodeId: row.node_id,
      firstSeen: finiteNumber(row.first_seen),
      lastSeen: finiteNumber(row.last_seen),
      expiresAt: finiteNumber(row.expires_at),
    })),
    recentFingerprints: (historyResult.results ?? []).map((row) => ({
      fingerprint: row.fingerprint,
      firstSeen: finiteNumber(row.first_seen),
      lastSeen: finiteNumber(row.last_seen),
      active: Number(row.active) === 1,
    })),
    usageByNode: (usageResult.results ?? []).map((row) => ({
      nodeId: row.node_id,
      bytesUp: finiteNumber(row.bytes_up),
      bytesDown: finiteNumber(row.bytes_down),
      connections: finiteNumber(row.connections),
      lastActive: finiteNumber(row.last_active),
    })),
  };
}
