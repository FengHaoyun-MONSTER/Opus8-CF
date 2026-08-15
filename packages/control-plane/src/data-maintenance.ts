import type { Env } from "./db";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface DataMaintenanceResult {
  completedAt: number;
  deletedRows: number;
  statements: number;
}

export async function runDataMaintenance(
  env: Env,
  now = Date.now(),
): Promise<DataMaintenanceResult> {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error("invalid maintenance timestamp");
  }
  const statements = [
    env.DB.prepare("DELETE FROM active_leases WHERE expires_at < ?1").bind(now),
    env.DB.prepare("DELETE FROM ip_history WHERE last_seen < ?1").bind(now - 25 * HOUR_MS),
    env.DB.prepare("DELETE FROM usage_events WHERE applied=1 AND created_at < ?1").bind(now - 2 * DAY_MS),
    env.DB.prepare("DELETE FROM node_health_events WHERE checked_at < ?1").bind(now - 7 * DAY_MS),
    env.DB.prepare("DELETE FROM node_health_runs WHERE checked_at < ?1").bind(now - 7 * DAY_MS),
    env.DB.prepare(
      `DELETE FROM node_enrollments
       WHERE (status IN ('activated','revoked') AND updated_at < ?1)
          OR (status IN ('pending','issued') AND expires_at < ?2)`,
    ).bind(now - 90 * DAY_MS, now - 30 * DAY_MS),
    env.DB.prepare(
      "DELETE FROM alert_incidents WHERE status='resolved' AND resolved_at < ?1",
    ).bind(now - 90 * DAY_MS),
    env.DB.prepare("DELETE FROM admin_audit_log WHERE created_at < ?1").bind(now - 180 * DAY_MS),
    env.DB.prepare("DELETE FROM automation_request_nonces WHERE expires_at < ?1").bind(now),
  ];
  const results = await env.DB.batch(statements);
  const deletedRows = results.reduce(
    (total, result) => total + Number(result.meta?.changes || 0),
    0,
  );
  await env.DB.prepare(
    `INSERT INTO runtime_state (key,value,updated_at)
     VALUES ('data_maintenance_last_success',?1,?2)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  )
    .bind(deletedRows, now)
    .run();
  return { completedAt: now, deletedRows, statements: statements.length };
}
