import { listNodes, type Env } from "./db";

const HEARTBEAT_MAX_AGE_MS = 20 * 60_000;
const MAINTENANCE_MAX_AGE_MS = 12 * 3_600_000;

export async function operationsSlo(env: Env, now = Date.now()) {
  const [nodes, maintenance] = await Promise.all([
    listNodes(env),
    env.DB.prepare(
      "SELECT value,updated_at FROM runtime_state WHERE key='data_maintenance_last_success'",
    ).first<{ value: number; updated_at: number }>(),
  ]);
  const enabled = nodes.filter((node) => Number(node.enabled) === 1);
  const healthy = enabled.filter(
    (node) => {
      const lastSeen = Number(node.last_seen || 0);
      return node.health === "healthy"
        && lastSeen >= now - HEARTBEAT_MAX_AGE_MS
        && lastSeen <= now + 5 * 60_000;
    },
  );
  const isolated = enabled.filter(
    (node) =>
      node.auth_mode === "isolated"
      && Number(node.credential_fallback_pending || 0) === 0,
  );
  const maintenanceAt = Number(maintenance?.updated_at || 0);
  const checks = {
    nodesRegistered: enabled.length > 0,
    nodesHealthy: enabled.length > 0 && healthy.length === enabled.length,
    credentialsIsolated:
      enabled.length > 0 && isolated.length === enabled.length,
    retentionCurrent:
      maintenanceAt > 0
      && maintenanceAt <= now + 5 * 60_000
      && now - maintenanceAt <= MAINTENANCE_MAX_AGE_MS,
  };
  return {
    generatedAt: now,
    status: Object.values(checks).every(Boolean) ? "ok" : "degraded",
    checks,
    nodes: {
      enabled: enabled.length,
      healthy: healthy.length,
      isolated: isolated.length,
      heartbeatMaxAgeMinutes: HEARTBEAT_MAX_AGE_MS / 60_000,
    },
    retention: {
      lastSuccessAt: maintenanceAt || null,
      lastDeletedRows: maintenance ? Number(maintenance.value || 0) : null,
      maxAgeHours: MAINTENANCE_MAX_AGE_MS / 3_600_000,
    },
  };
}
