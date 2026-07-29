import type { Env } from "./db";

const LEASE_TTL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const MAX_EVENT_BYTES = 1024 * 1024 * 1024;

export interface AdmissionInput {
  nodeId: string;
  uuid: string;
  leaseId: string;
  ipHash: string;
}

export interface UsageEventInput {
  id: string;
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

export async function admitConnection(
  env: Env,
  input: AdmissionInput,
  signedAt = Date.now(),
) {
  if (
    !validToken(input.nodeId, 80)
    || !validToken(input.uuid, 64)
    || !validToken(input.leaseId, 128)
    || !validToken(input.ipHash, 128)
  ) {
    throw new Error("invalid admission payload");
  }

  if (!Number.isSafeInteger(signedAt)) {
    throw new Error("invalid admission timestamp");
  }
  const now = signedAt;
  const dayAgo = now - DAY_MS;
  const expiresAt = now + LEASE_TTL_MS;
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM active_leases
       WHERE user_id=(SELECT id FROM users WHERE uuid=?1) AND expires_at<=?2`,
    ).bind(input.uuid, now),
    env.DB.prepare(
      `DELETE FROM ip_history
       WHERE user_id=(SELECT id FROM users WHERE uuid=?1) AND last_seen<=?2`,
    ).bind(input.uuid, dayAgo),
    env.DB.prepare(
      `INSERT INTO active_leases
       (user_id, uuid, node_id, ip_hash, lease_id, first_seen, last_seen, expires_at)
       SELECT u.id, u.uuid, ?2, ?3, ?4, ?5, ?5, ?6
       FROM users u
       LEFT JOIN user_limits l ON l.user_id=u.id
       WHERE u.uuid=?1
         AND u.enabled=1
         AND (u.expire_at IS NULL OR u.expire_at>?5)
         AND (
           COALESCE(l.traffic_limit_bytes,0)=0 OR
           COALESCE((SELECT SUM(x.bytes_up+x.bytes_down) FROM usage x WHERE x.user_id=u.id),0)
             < l.traffic_limit_bytes
         )
         AND (
           EXISTS(SELECT 1 FROM active_leases a
                  WHERE a.user_id=u.id AND a.ip_hash=?3 AND a.expires_at>?5)
           OR (
             (SELECT COUNT(*) FROM active_leases a
              WHERE a.user_id=u.id AND a.expires_at>?5)
               < COALESCE(l.device_limit,2)
             AND (
               EXISTS(SELECT 1 FROM ip_history h
                      WHERE h.user_id=u.id AND h.ip_hash=?3 AND h.last_seen>?7)
               OR (SELECT COUNT(*) FROM ip_history h
                   WHERE h.user_id=u.id AND h.last_seen>?7)
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
       FROM active_leases WHERE uuid=?1 AND ip_hash=?3
       ON CONFLICT(user_id,ip_hash) DO UPDATE SET
         last_seen=MAX(ip_history.last_seen,excluded.last_seen)`,
    ).bind(input.uuid, now, input.ipHash),
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
       WHERE u.uuid=?1`,
    ).bind(input.uuid, now, dayAgo),
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
      uuid: item.uuid.toLowerCase(),
      connections,
      bytesUp,
      bytesDown,
      tsBucket,
    });
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const event of events) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO usage_events
         (event_id,user_id,node_id,ts_bucket,connections,bytes_up,bytes_down,applied,created_at)
         SELECT ?1,u.id,?2,?3,?4,?5,?6,0,?7 FROM users u WHERE u.uuid=?8
         ON CONFLICT(event_id) DO NOTHING`,
      ).bind(
        event.id,
        nodeId,
        event.tsBucket,
        event.connections,
        event.bytesUp,
        event.bytesDown,
        now,
        event.uuid,
      ),
      env.DB.prepare(
        `INSERT INTO usage (user_id,node_id,ts_bucket,connections,bytes_up,bytes_down)
         SELECT user_id,node_id,ts_bucket,connections,bytes_up,bytes_down
         FROM usage_events WHERE event_id=?1 AND applied=0
         ON CONFLICT(user_id,node_id,ts_bucket) DO UPDATE SET
           connections=connections+excluded.connections,
           bytes_up=bytes_up+excluded.bytes_up,
           bytes_down=bytes_down+excluded.bytes_down`,
      ).bind(event.id),
      env.DB.prepare(
        "UPDATE usage_events SET applied=1 WHERE event_id=?1 AND applied=0",
      ).bind(event.id),
    );
  }
  if (statements.length === 0) return { accepted: 0 };
  // 幂等事件只需覆盖节点的短时重试窗口，避免事件明细无限增长。
  statements.push(
    env.DB.prepare("DELETE FROM usage_events WHERE created_at<=?1")
      .bind(now - 2 * DAY_MS),
  );
  const results = await env.DB.batch(statements);
  let accepted = 0;
  for (let index = 0; index < events.length; index += 1) {
    accepted += Number(results[index * 3]?.meta?.changes || 0);
  }
  return { accepted };
}
