import type { Env } from "./db";
import { deviceCredentialUuids } from "./device-credentials";
import { userAssignedToNode } from "./node-assignment";

const LEASE_TTL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const MAX_EVENT_BYTES = 1024 * 1024 * 1024;

export interface AdmissionInput {
  nodeId: string;
  userId?: string;
  uuid: string;
  leaseId: string;
  ipHash: string;
}

export interface UsageEventInput {
  id: string;
  userId?: string;
  uuid: string;
  connections: number;
  bytesUp: number;
  bytesDown: number;
  tsBucket: number;
}

function validToken(value: unknown, max = 128): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && /^[A-Za-z0-9:._-]+$/.test(value);
}

function boundedInt(value: unknown, max: number): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
}

async function resolveAuthorizedCredentialOwner(
  env: Env,
  nodeId: string,
  requestedUserId: string | undefined,
  credentialUuid: string,
  now: number,
): Promise<string | null> {
  const node = await env.DB.prepare(
    "SELECT id,account_alias,enabled FROM nodes WHERE id=?1",
  )
    .bind(nodeId)
    .first<{ id: string; account_alias: string; enabled: number }>();
  if (!node || Number(node.enabled) !== 1) return null;

  if (!requestedUserId) {
    const owner = await env.DB.prepare(
      "SELECT u.id,u.node_group FROM users u " +
        "JOIN user_devices d ON d.user_id=u.id " +
        "WHERE d.base_uuid=?1 AND d.credential_mode='static' " +
        "AND d.enabled=1 AND u.enabled=1 " +
        "AND (u.expire_at IS NULL OR u.expire_at>?2) LIMIT 1",
    )
      .bind(credentialUuid, now)
      .first<{ id: string; node_group: string | null }>();
    return owner &&
      userAssignedToNode(owner.node_group, node.id, node.account_alias)
      ? owner.id
      : null;
  }

  const { results } = await env.DB.prepare(
    "SELECT u.id,u.node_group,d.base_uuid,d.credential_mode " +
      "FROM users u JOIN user_devices d ON d.user_id=u.id " +
      "WHERE u.id=?1 AND u.enabled=1 " +
      "AND (u.expire_at IS NULL OR u.expire_at>?2) AND d.enabled=1",
  )
    .bind(requestedUserId, now)
    .all<{
      id: string;
      node_group: string | null;
      base_uuid: string;
      credential_mode: "static" | "rotating";
    }>();
  const devices = results || [];
  if (
    devices.length === 0 ||
    !userAssignedToNode(
      devices[0].node_group,
      node.id,
      node.account_alias,
    )
  ) {
    return null;
  }
  for (const device of devices) {
    const candidates = await deviceCredentialUuids(
      env.NODE_HMAC_SECRET,
      device.base_uuid,
      device.credential_mode,
      now,
    );
    if (candidates.includes(credentialUuid.toLowerCase())) return device.id;
  }
  return null;
}

export async function admitConnection(
  env: Env,
  input: AdmissionInput,
  signedAt = Date.now(),
) {
  if (
    !validToken(input.nodeId, 80)
    || (input.userId !== undefined && !validToken(input.userId, 80))
    || !validToken(input.uuid, 64)
    || !validToken(input.leaseId, 128)
    || !validToken(input.ipHash, 128)
  ) {
    throw new Error("invalid admission payload");
  }

  if (!Number.isSafeInteger(signedAt)) {
    throw new Error("invalid admission timestamp");
  }
  const now = Date.now();
  const dayAgo = now - DAY_MS;
  const expiresAt = now + LEASE_TTL_MS;
  const userId = await resolveAuthorizedCredentialOwner(
    env,
    input.nodeId,
    input.userId,
    input.uuid.toLowerCase(),
    now,
  );
  if (!userId) throw new Error("credential is not authorized for this node");
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM active_leases
       WHERE user_id=?1 AND expires_at<=?2`,
    ).bind(userId, now),
    env.DB.prepare(
      `DELETE FROM ip_history
       WHERE user_id=?1 AND last_seen<=?2`,
    ).bind(userId, dayAgo),
    env.DB.prepare(
      `INSERT INTO active_leases
       (user_id, uuid, node_id, ip_hash, lease_id, first_seen, last_seen, expires_at)
       SELECT u.id, ?2, ?3, ?4, ?5, ?6, ?6, ?7
       FROM users u
       LEFT JOIN user_limits l ON l.user_id=u.id
       WHERE u.id=?1
          AND u.enabled=1
          AND (u.expire_at IS NULL OR u.expire_at>?6)
          AND (
            COALESCE(l.traffic_limit_bytes,0)=0 OR
            COALESCE((SELECT SUM(x.bytes_up+x.bytes_down) FROM usage x WHERE x.user_id=u.id),0)
             < l.traffic_limit_bytes
          )
          AND (
            EXISTS(SELECT 1 FROM active_leases a
                   WHERE a.user_id=u.id AND a.ip_hash=?4 AND a.expires_at>?6)
            OR (
              (SELECT COUNT(*) FROM active_leases a
               WHERE a.user_id=u.id AND a.expires_at>?6)
                < COALESCE(l.device_limit,2)
              AND (
                EXISTS(SELECT 1 FROM ip_history h
                       WHERE h.user_id=u.id AND h.ip_hash=?4 AND h.last_seen>?8)
                OR (SELECT COUNT(*) FROM ip_history h
                    WHERE h.user_id=u.id AND h.last_seen>?8)
                     < COALESCE(l.ip_limit_24h,5)
              )
           )
         )
       ON CONFLICT(user_id,ip_hash) DO UPDATE SET
         node_id=CASE WHEN excluded.last_seen>=active_leases.last_seen
           THEN excluded.node_id ELSE active_leases.node_id END,
         lease_id=CASE WHEN excluded.last_seen>=active_leases.last_seen
           THEN excluded.lease_id ELSE active_leases.lease_id END,
         last_seen=MAX(active_leases.last_seen,excluded.last_seen),
         expires_at=MAX(active_leases.expires_at,excluded.expires_at)`,
    ).bind(
      userId,
      input.uuid,
      input.nodeId,
      input.ipHash,
      input.leaseId,
      now,
      expiresAt,
      dayAgo,
    ),
    env.DB.prepare(
      `INSERT INTO ip_history (user_id, ip_hash, first_seen, last_seen)
       SELECT user_id, ip_hash, ?2, ?2
       FROM active_leases WHERE user_id=?1 AND ip_hash=?3
       ON CONFLICT(user_id,ip_hash) DO UPDATE SET
         last_seen=MAX(ip_history.last_seen,excluded.last_seen)`,
    ).bind(userId, now, input.ipHash),
    env.DB.prepare(
      `SELECT u.id,
         u.enabled,
         u.expire_at,
         COALESCE(l.device_limit,2) AS device_limit,
         COALESCE(l.ip_limit_24h,5) AS ip_limit_24h,
         COALESCE(l.traffic_limit_bytes,0) AS traffic_limit_bytes,
         COALESCE((SELECT SUM(x.bytes_up+x.bytes_down) FROM usage x WHERE x.user_id=u.id),0) AS used_bytes,
         COALESCE((SELECT COUNT(*) FROM active_leases a
                   WHERE a.user_id=u.id AND a.expires_at>?2),0) AS active_ips,
         COALESCE((SELECT COUNT(*) FROM ip_history h
                   WHERE h.user_id=u.id AND h.last_seen>?3),0) AS recent_ips
       FROM users u LEFT JOIN user_limits l ON l.user_id=u.id
       WHERE u.id=?1`,
    ).bind(userId, now, dayAgo),
  ]);

  const allowed = Number(results[2]?.meta?.changes || 0) > 0;
  const state = (results[4]?.results?.[0] || null) as {
    enabled: number;
    expire_at: number | null;
    device_limit: number;
    ip_limit_24h: number;
    traffic_limit_bytes: number;
    used_bytes: number;
    active_ips: number;
    recent_ips: number;
  } | null;

  let reason = "allowed";
  if (!allowed) {
    if (!state || state.enabled !== 1 || (state.expire_at && state.expire_at <= now)) {
      reason = "account_unavailable";
    } else if (state.traffic_limit_bytes > 0 && state.used_bytes >= state.traffic_limit_bytes) {
      reason = "traffic_quota_exceeded";
    } else if (state.active_ips >= state.device_limit) {
      reason = "active_ip_limit_exceeded";
    } else {
      reason = "ip_churn_limit_exceeded";
    }
  }

  return {
    allowed,
    reason,
    leaseTtlMs: LEASE_TTL_MS,
    activeIps: Number(state?.active_ips || 0),
    recentIps: Number(state?.recent_ips || 0),
    deviceLimit: Number(state?.device_limit || 0),
    ipLimit24h: Number(state?.ip_limit_24h || 0),
    trafficLimitBytes: Number(state?.traffic_limit_bytes || 0),
    usedBytes: Number(state?.used_bytes || 0),
  };
}

export async function recordUsage(
  env: Env,
  nodeId: string,
  rawEvents: unknown,
): Promise<{ accepted: number }> {
  if (!validToken(nodeId, 80) || !Array.isArray(rawEvents) || rawEvents.length > 20) {
    throw new Error("invalid usage payload");
  }

  const events: UsageEventInput[] = [];
  for (const raw of rawEvents) {
    const item = raw as Partial<UsageEventInput>;
    const connections = boundedInt(item.connections, 1);
    const bytesUp = boundedInt(item.bytesUp, MAX_EVENT_BYTES);
    const bytesDown = boundedInt(item.bytesDown, MAX_EVENT_BYTES);
    const tsBucket = boundedInt(item.tsBucket, Number.MAX_SAFE_INTEGER);
    if (
      !validToken(item.id, 128)
      || (item.userId !== undefined && !validToken(item.userId, 80))
      || !validToken(item.uuid, 64)
      || connections === null
      || bytesUp === null
      || bytesDown === null
      || tsBucket === null
    ) {
      throw new Error("invalid usage event");
    }
    events.push({
      id: item.id,
      userId: item.userId,
      uuid: item.uuid.toLowerCase(),
      connections,
      bytesUp,
      bytesDown,
      tsBucket,
    });
  }

  const now = Date.now();
  for (const event of events) {
    const owner = await resolveAuthorizedCredentialOwner(
      env,
      nodeId,
      event.userId,
      event.uuid,
      now,
    );
    if (!owner) {
      throw new Error("usage credential is not authorized for this node");
    }
    event.userId = owner;
  }
  const statements: D1PreparedStatement[] = [];
  for (const event of events) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO usage_events
         (event_id,user_id,node_id,ts_bucket,connections,bytes_up,bytes_down,applied,created_at)
         SELECT ?1,u.id,?2,?3,?4,?5,?6,0,?7
         FROM users u
         JOIN user_limits l ON l.user_id=u.id
         WHERE (
           (?8<>'' AND u.id=?8)
           OR (
             ?8=''
             AND EXISTS(
               SELECT 1 FROM user_devices d
               WHERE d.user_id=u.id
                 AND d.base_uuid=?9
                 AND d.credential_mode='static'
             )
           )
         )
           AND l.traffic_limit_bytes>0
         ON CONFLICT(event_id) DO NOTHING`,
      ).bind(
        event.id,
        nodeId,
        event.tsBucket,
        event.connections,
        event.bytesUp,
        event.bytesDown,
        now,
        event.userId || "",
        event.uuid,
      ),
    );
  }
  if (statements.length === 0) return { accepted: 0 };
  const eventPlaceholders = events.map((_, index) => `?${index + 1}`).join(",");
  const eventIds = events.map((event) => event.id);
  statements.push(
    env.DB.prepare(
      `INSERT INTO usage (user_id,node_id,ts_bucket,connections,bytes_up,bytes_down)
       SELECT user_id,node_id,ts_bucket,
         SUM(connections),SUM(bytes_up),SUM(bytes_down)
       FROM usage_events
       WHERE applied=0 AND event_id IN (${eventPlaceholders})
       GROUP BY user_id,node_id,ts_bucket
       ON CONFLICT(user_id,node_id,ts_bucket) DO UPDATE SET
         connections=usage.connections+excluded.connections,
         bytes_up=usage.bytes_up+excluded.bytes_up,
         bytes_down=usage.bytes_down+excluded.bytes_down`,
    ).bind(...eventIds),
    env.DB.prepare(
      `UPDATE usage_events SET applied=1
       WHERE applied=0 AND event_id IN (${eventPlaceholders})`,
    ).bind(...eventIds),
  );
  // 幂等事件只需覆盖节点的短时重试窗口，避免事件明细无限增长。
  statements.push(
    env.DB.prepare("DELETE FROM usage_events WHERE created_at<=?1")
      .bind(now - 2 * DAY_MS),
  );
  const results = await env.DB.batch(statements);
  let accepted = 0;
  for (let index = 0; index < events.length; index += 1) {
    accepted += Number(results[index]?.meta?.changes || 0);
  }
  return { accepted };
}
