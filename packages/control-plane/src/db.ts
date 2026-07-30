import type {
  NodeRecord,
  UserAccessPolicy,
  UserRecord,
} from "@opus8-cf/shared";
import {
  evaluateAccessStatus,
  type AccessSeverity,
  type AccessState,
} from "./access-status";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
  JWT_SECRET_PREVIOUS?: string;
  NODE_HMAC_SECRET: string;
  NODE_HMAC_SECRET_PREVIOUS?: string;
  LANDING_CONFIG_KEY: string;
  LANDING_CONFIG_KEY_PREVIOUS?: string;
  DEFAULT_UNLOCK_HOSTS?: string;
  ROOT_DOMAIN?: string;
  SUB_BASE?: string;
  USE_OPTIMIZED_IPS?: string;
  OPUS8_BUILD_ID?: string;
  ADMIN_UI_ORIGINS?: string;
  HMAC_V1_ACCEPT_UNTIL?: string;
  HMAC_V1_NODE_IDS?: string;
  SUB_RATE_LIMIT_REQUIRED?: string;
  COMPLIANCE_PROXY_ALLOWED?: string;
  COMPLIANCE_ENFORCEMENT_MODE?: string;
  COMPLIANCE_POLICY_ID?: string;
  COMPLIANCE_MAINTENANCE_NODE_IDS?: string;
  SUB_SOURCE_RATE_LIMITER?: RateLimit;
  SUB_TOKEN_RATE_LIMITER?: RateLimit;
}

export interface AdminUserRecord extends UserRecord {
  device_limit: number;
  ip_limit_24h: number;
  traffic_limit_bytes: number;
  bytes_up: number;
  bytes_down: number;
  connections: number;
  active_ips: number;
  recent_ips: number;
  access_state: AccessState;
  access_severity: AccessSeverity;
  access_reason: string;
}

export interface UserLimitInput {
  deviceLimit?: number;
  ipLimit24h?: number;
  trafficLimitBytes?: number;
}

export async function getUserLimits(
  env: Env,
  id: string,
): Promise<{
  deviceLimit: number;
  ipLimit24h: number;
  trafficLimitBytes: number;
  enabled: number;
  unlock: number;
} | null> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(l.device_limit,2) AS device_limit,
            COALESCE(l.ip_limit_24h,5) AS ip_limit_24h,
            COALESCE(l.traffic_limit_bytes,0) AS traffic_limit_bytes,
            u.enabled AS enabled,
            u.unlock AS unlock
     FROM users u LEFT JOIN user_limits l ON l.user_id=u.id
     WHERE u.id=?1`,
  )
    .bind(id)
    .first<{
      device_limit: number;
      ip_limit_24h: number;
      traffic_limit_bytes: number;
      enabled: number;
      unlock: number;
    }>();
  return row
    ? {
        deviceLimit: Number(row.device_limit),
        ipLimit24h: Number(row.ip_limit_24h),
        trafficLimitBytes: Number(row.traffic_limit_bytes),
        enabled: Number(row.enabled),
        unlock: Number(row.unlock),
      }
    : null;
}

export async function listNodes(env: Env): Promise<NodeRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT n.*,
       COALESCE(h.consecutive_failures,0) AS health_consecutive_failures,
       COALESCE(h.consecutive_successes,0) AS health_consecutive_successes,
       h.direct_ok AS health_direct_ok,
       h.landing_ok AS health_landing_ok,
       h.direct_latency_ms AS health_direct_latency_ms,
       h.landing_latency_ms AS health_landing_latency_ms,
       h.last_checked AS health_last_checked,
       h.last_success AS health_last_success,
       h.last_failure AS health_last_failure,
       h.last_error AS health_last_error,
       h.last_run_id AS health_last_run_id
     FROM nodes n
     LEFT JOIN node_health_state h ON h.node_id=n.id
     ORDER BY n.created_at DESC`,
  ).all<NodeRecord>();
  return results ?? [];
}

export async function getNode(
  env: Env,
  id: string,
): Promise<NodeRecord | null> {
  return (
    (await env.DB.prepare("SELECT * FROM nodes WHERE id=?1")
      .bind(id)
      .first<NodeRecord>()) ?? null
  );
}

export async function upsertNode(env: Env, n: NodeRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO nodes (id, account_alias, hostname, region, capabilities, preferred_ip, transport_path, health, enabled, last_seen, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,COALESCE(?7,'/'),?8,1,?9,?10)
     ON CONFLICT(id) DO UPDATE SET
       account_alias=CASE WHEN excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.account_alias ELSE nodes.account_alias END,
       hostname=CASE WHEN excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.hostname ELSE nodes.hostname END,
       region=CASE WHEN excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.region ELSE nodes.region END,
       capabilities=CASE WHEN excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.capabilities ELSE nodes.capabilities END,
       preferred_ip=CASE WHEN excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.preferred_ip ELSE nodes.preferred_ip END,
       transport_path=CASE
         WHEN ?7 IS NOT NULL
          AND excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.transport_path ELSE nodes.transport_path END,
       health=CASE
         WHEN nodes.health='unknown'
          AND excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.health ELSE nodes.health END,
       last_seen=MAX(COALESCE(nodes.last_seen,0),excluded.last_seen)`,
  )
    .bind(
      n.id,
      n.account_alias,
      n.hostname,
      n.region,
      n.capabilities,
      n.preferred_ip,
      n.transport_path,
      n.health,
      n.last_seen,
      n.created_at,
    )
    .run();
}

export async function touchNode(
  env: Env,
  id: string,
  _health: NodeRecord["health"],
  preferredIp: string | null,
  ts: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE nodes SET
       preferred_ip=CASE WHEN ?2>=COALESCE(last_seen,0)
         THEN COALESCE(?3,preferred_ip) ELSE preferred_ip END,
       last_seen=MAX(COALESCE(last_seen,0),?2)
     WHERE id=?1`,
  )
    .bind(id, ts, preferredIp)
    .run();
}

export async function listUsers(env: Env): Promise<AdminUserRecord[]> {
  const now = Date.now();
  const dayAgo = now - 86_400_000;
  const { results } = await env.DB.prepare(
    `SELECT u.*,
       COALESCE(l.device_limit, 2) AS device_limit,
       COALESCE(l.ip_limit_24h, 5) AS ip_limit_24h,
       COALESCE(l.traffic_limit_bytes, 0) AS traffic_limit_bytes,
       COALESCE((SELECT SUM(x.bytes_up) FROM usage x WHERE x.user_id=u.id), 0) AS bytes_up,
       COALESCE((SELECT SUM(x.bytes_down) FROM usage x WHERE x.user_id=u.id), 0) AS bytes_down,
       COALESCE((SELECT SUM(x.connections) FROM usage x WHERE x.user_id=u.id), 0) AS connections,
       COALESCE((SELECT COUNT(*) FROM active_leases a
                 WHERE a.user_id=u.id AND a.expires_at>?1), 0) AS active_ips,
       COALESCE((SELECT COUNT(*) FROM ip_history h
                 WHERE h.user_id=u.id AND h.last_seen>?2), 0) AS recent_ips
     FROM users u
     LEFT JOIN user_limits l ON l.user_id=u.id
     ORDER BY u.created_at DESC`,
  )
    .bind(now, dayAgo)
    .all<AdminUserRecord>();
  return (results ?? []).map((user) => {
    const access = evaluateAccessStatus(user, now);
    return {
      ...user,
      access_state: access.state,
      access_severity: access.severity,
      access_reason: access.reason,
    };
  });
}

export async function getUserByToken(
  env: Env,
  token: string,
): Promise<UserRecord | null> {
  return env.DB.prepare("SELECT * FROM users WHERE sub_token=?1")
    .bind(token)
    .first<UserRecord>();
}

export async function insertUser(
  env: Env,
  u: UserRecord,
  limits: Required<UserLimitInput>,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, username, uuid, plan_id, node_group, unlock, sub_token, expire_at, enabled, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9)`,
    ).bind(
      u.id,
      u.username,
      u.uuid,
      u.plan_id,
      u.node_group,
      u.unlock,
      u.sub_token,
      u.expire_at,
      u.created_at,
    ),
    env.DB.prepare(
      `INSERT INTO user_limits
       (user_id, device_limit, ip_limit_24h, traffic_limit_bytes, updated_at)
       VALUES (?1,?2,?3,?4,?5)`,
    ).bind(
      u.id,
      limits.deviceLimit,
      limits.ipLimit24h,
      limits.trafficLimitBytes,
      u.created_at,
    ),
  ]);
}

export async function deleteUser(env: Env, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM usage WHERE user_id=?1").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id=?1").bind(id),
  ]);
}

export async function updateUserPolicy(
  env: Env,
  id: string,
  changes: { unlock?: boolean; enabled?: boolean } & UserLimitInput,
): Promise<void> {
  const statements = [
    env.DB.prepare(
      `UPDATE users
     SET unlock=COALESCE(?2, unlock), enabled=COALESCE(?3, enabled)
     WHERE id=?1`,
    ).bind(
      id,
      changes.unlock === undefined ? null : changes.unlock ? 1 : 0,
      changes.enabled === undefined ? null : changes.enabled ? 1 : 0,
    ),
  ];
  if (
    changes.deviceLimit !== undefined ||
    changes.ipLimit24h !== undefined ||
    changes.trafficLimitBytes !== undefined
  ) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO user_limits
       (user_id, device_limit, ip_limit_24h, traffic_limit_bytes, updated_at)
       VALUES (?1, COALESCE(?2,2), COALESCE(?3,5), COALESCE(?4,0), ?5)
       ON CONFLICT(user_id) DO UPDATE SET
         device_limit=COALESCE(?2,device_limit),
         ip_limit_24h=COALESCE(?3,ip_limit_24h),
         traffic_limit_bytes=COALESCE(?4,traffic_limit_bytes),
         updated_at=?5`,
      ).bind(
        id,
        changes.deviceLimit ?? null,
        changes.ipLimit24h ?? null,
        changes.trafficLimitBytes ?? null,
        Date.now(),
      ),
    );
  }
  await env.DB.batch(statements);
}

/** 当前有效用户及其落地权限：启用中且未过期。 */
export async function activeUserPolicy(env: Env): Promise<{
  uuids: string[];
  unlockUuids: string[];
  accessPolicies: UserAccessPolicy[];
}> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.uuid, u.unlock,
       COALESCE(l.device_limit,2) AS device_limit,
       COALESCE(l.ip_limit_24h,5) AS ip_limit_24h,
       COALESCE(l.traffic_limit_bytes,0) AS traffic_limit_bytes,
       COALESCE((SELECT SUM(x.bytes_up+x.bytes_down) FROM usage x WHERE x.user_id=u.id),0) AS used_bytes
     FROM users u
     LEFT JOIN user_limits l ON l.user_id=u.id
     WHERE u.enabled=1 AND (u.expire_at IS NULL OR u.expire_at>?1)`,
  )
    .bind(now)
    .all<{
      id: string;
      uuid: string;
      unlock: number;
      device_limit: number;
      ip_limit_24h: number;
      traffic_limit_bytes: number;
      used_bytes: number;
    }>();
  const active = results ?? [];
  return {
    uuids: active.map((r) => r.uuid),
    unlockUuids: active.filter((r) => r.unlock === 1).map((r) => r.uuid),
    accessPolicies: active.map((r) => ({
      userId: r.id,
      uuid: r.uuid,
      deviceLimit: r.device_limit,
      ipLimit24h: r.ip_limit_24h,
      trafficLimitBytes: r.traffic_limit_bytes,
      usedBytes: r.used_bytes,
    })),
  };
}

export async function getUserUsage(
  env: Env,
  userId: string,
): Promise<{
  bytesUp: number;
  bytesDown: number;
  connections: number;
  total: number;
  trafficLimitBytes: number;
}> {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(bytes_up),0) AS bytes_up,
       COALESCE(SUM(bytes_down),0) AS bytes_down,
       COALESCE(SUM(connections),0) AS connections,
       COALESCE((SELECT traffic_limit_bytes FROM user_limits WHERE user_id=?1),0)
         AS traffic_limit_bytes
     FROM usage WHERE user_id=?1`,
  )
    .bind(userId)
    .first<{
      bytes_up: number;
      bytes_down: number;
      connections: number;
      traffic_limit_bytes: number;
    }>();
  const bytesUp = Number(row?.bytes_up || 0);
  const bytesDown = Number(row?.bytes_down || 0);
  return {
    bytesUp,
    bytesDown,
    connections: Number(row?.connections || 0),
    total: bytesUp + bytesDown,
    trafficLimitBytes: Number(row?.traffic_limit_bytes || 0),
  };
}

export async function resetUserUsage(env: Env, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM usage_events WHERE user_id=?1").bind(userId),
    env.DB.prepare("DELETE FROM usage WHERE user_id=?1").bind(userId),
  ]);
}

export async function clearUserLeases(env: Env, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM active_leases WHERE user_id=?1").bind(userId),
    env.DB.prepare("DELETE FROM ip_history WHERE user_id=?1").bind(userId),
  ]);
}
