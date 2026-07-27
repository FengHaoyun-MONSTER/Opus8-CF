import type { NodeRecord, UserRecord } from "@opus8-cf/shared";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
  NODE_HMAC_SECRET: string;
  DEFAULT_UNLOCK_HOSTS?: string;
  ROOT_DOMAIN?: string;
  SUB_BASE?: string;
  USE_OPTIMIZED_IPS?: string;
}

export async function listNodes(env: Env): Promise<NodeRecord[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM nodes ORDER BY created_at DESC",
  ).all<NodeRecord>();
  return results ?? [];
}

export async function upsertNode(env: Env, n: NodeRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO nodes (id, account_alias, hostname, region, capabilities, preferred_ip, health, enabled, last_seen, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,?9)
     ON CONFLICT(id) DO UPDATE SET
       account_alias=excluded.account_alias, hostname=excluded.hostname, region=excluded.region,
       capabilities=excluded.capabilities, preferred_ip=excluded.preferred_ip,
       health=excluded.health, last_seen=excluded.last_seen`,
  )
    .bind(
      n.id, n.account_alias, n.hostname, n.region, n.capabilities,
      n.preferred_ip, n.health, n.last_seen, n.created_at,
    )
    .run();
}

export async function touchNode(
  env: Env, id: string, health: NodeRecord["health"], preferredIp: string | null, ts: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE nodes SET last_seen=?2, health=?3, preferred_ip=COALESCE(?4, preferred_ip) WHERE id=?1",
  ).bind(id, ts, health, preferredIp).run();
}

export async function listUsers(env: Env): Promise<UserRecord[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM users ORDER BY created_at DESC",
  ).all<UserRecord>();
  return results ?? [];
}

export async function getUserByToken(env: Env, token: string): Promise<UserRecord | null> {
  return env.DB.prepare("SELECT * FROM users WHERE sub_token=?1").bind(token).first<UserRecord>();
}

export async function insertUser(env: Env, u: UserRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, username, uuid, plan_id, node_group, unlock, sub_token, expire_at, enabled, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9)`,
  )
    .bind(
      u.id, u.username, u.uuid, u.plan_id, u.node_group, u.unlock,
      u.sub_token, u.expire_at, u.created_at,
    )
    .run();
}

export async function deleteUser(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM users WHERE id=?1").bind(id).run();
}

export async function updateUserPolicy(
  env: Env,
  id: string,
  changes: { unlock?: boolean; enabled?: boolean },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users
     SET unlock=COALESCE(?2, unlock), enabled=COALESCE(?3, enabled)
     WHERE id=?1`,
  ).bind(
    id,
    changes.unlock === undefined ? null : (changes.unlock ? 1 : 0),
    changes.enabled === undefined ? null : (changes.enabled ? 1 : 0),
  ).run();
}

/** 当前有效用户及其落地权限：启用中且未过期。 */
export async function activeUserPolicy(
  env: Env,
): Promise<{ uuids: string[]; unlockUuids: string[] }> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT uuid, unlock FROM users WHERE enabled=1 AND (expire_at IS NULL OR expire_at > ?1)",
  ).bind(now).all<{ uuid: string; unlock: number }>();
  const active = results ?? [];
  return {
    uuids: active.map((r) => r.uuid),
    unlockUuids: active.filter((r) => r.unlock === 1).map((r) => r.uuid),
  };
}
