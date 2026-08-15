import {
  hmacSign,
  normalizeTransportPath,
  randomHex,
  randomUuid,
  type NodeRecord,
  type RegisterRequest,
} from "@opus8-cf/shared";
import { getNode, upsertNode, type Env } from "./db";

const ENROLLMENT_TTL_MS = 15 * 60_000;
const MAX_ENROLLMENT_TTL_MS = 60 * 60_000;

export type NodeAuthMode = "legacy" | "isolated" | "revoked";
export type NodeEnrollmentKind = "provision" | "migrate" | "rotate";
export type NodeEnrollmentStatus =
  | "pending"
  | "issued"
  | "activated"
  | "revoked";

interface NodeCredentialRow {
  node_id: string;
  auth_mode: NodeAuthMode;
  current_salt: string | null;
  previous_salt: string | null;
  legacy_fallback: number;
}

export interface NodeEnrollmentRow {
  id: string;
  node_id: string;
  kind: NodeEnrollmentKind;
  status: NodeEnrollmentStatus;
  account_alias: string;
  account_id: string;
  hostname: string;
  region: string | null;
  capabilities: string;
  preferred_ip: string | null;
  transport_path: string;
  token_hash: string;
  secret_salt: string;
  expires_at: number;
  issued_at: number | null;
  activated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PublicNodeEnrollment {
  id: string;
  nodeId: string;
  kind: NodeEnrollmentKind;
  status: NodeEnrollmentStatus | "expired";
  accountAlias: string;
  accountId: string;
  hostname: string;
  region: string | null;
  capabilities: string[];
  preferredIp: string | null;
  transportPath: string;
  expiresAt: number;
  issuedAt: number | null;
  activatedAt: number | null;
  createdAt: number;
}

export interface CreateNodeEnrollmentInput {
  nodeId?: unknown;
  accountAlias?: unknown;
  accountId?: unknown;
  hostname?: unknown;
  region?: unknown;
  capabilities?: unknown;
  preferredIp?: unknown;
  transportPath?: unknown;
  ttlSeconds?: unknown;
}

export interface NodeAuthSecretCandidate {
  secret: string;
  authKind:
    | "isolated-current"
    | "isolated-previous"
    | "enrollment"
    | "legacy";
  rootSlot: "current" | "previous";
  enrollmentId?: string;
}

export class NodeEnrollmentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NodeEnrollmentError";
  }
}

function rootCandidates(
  env: Pick<Env, "NODE_HMAC_SECRET" | "NODE_HMAC_SECRET_PREVIOUS">,
): Array<{ secret: string; slot: "current" | "previous" }> {
  const values: Array<{ secret: string; slot: "current" | "previous" }> = [
    { secret: env.NODE_HMAC_SECRET, slot: "current" },
  ];
  if (
    env.NODE_HMAC_SECRET_PREVIOUS &&
    env.NODE_HMAC_SECRET_PREVIOUS !== env.NODE_HMAC_SECRET
  ) {
    values.push({ secret: env.NODE_HMAC_SECRET_PREVIOUS, slot: "previous" });
  }
  return values;
}

export async function deriveNodeSecret(
  rootSecret: string,
  nodeId: string,
  salt: string,
): Promise<string> {
  return hmacSign(rootSecret, "opus8-node-key-v1\n" + nodeId + "\n" + salt);
}

async function enrollmentTokenHash(
  rootSecret: string,
  token: string,
): Promise<string> {
  return hmacSign(rootSecret, "opus8-enrollment-token-v1\n" + token);
}

function validNodeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._:-]{1,80}$/.test(value)
  );
}

function normalizeAccountAlias(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const alias = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(alias) ? alias : null;
}

function normalizeAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const accountId = value.trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(accountId) ? accountId : null;
}

function normalizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    hostname.length < 4 ||
    hostname.length > 253 ||
    !hostname.includes(".") ||
    !/^[a-z0-9.-]+$/.test(hostname)
  ) {
    return null;
  }
  const labels = hostname.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return null;
  }
  return hostname;
}

function normalizeRegion(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new NodeEnrollmentError("节点地区无效", 400);
  }
  const region = value.trim();
  if (!region || region.length > 32 || !/^[A-Za-z0-9 ._-]+$/.test(region)) {
    throw new NodeEnrollmentError("节点地区无效", 400);
  }
  return region;
}

function normalizeCapabilities(value: unknown, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(entry),
    )
  ) {
    throw new NodeEnrollmentError("节点能力列表无效", 400);
  }
  return [...new Set(value.map((entry) => String(entry).toLowerCase()))];
}

function parseCapabilities(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizePreferredIp(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^[0-9a-fA-F:.]+$/.test(value)
  ) {
    throw new NodeEnrollmentError("优选 IP 无效", 400);
  }
  return value;
}

function enrollmentStatus(
  row: NodeEnrollmentRow,
  now = Date.now(),
): PublicNodeEnrollment["status"] {
  return (
    (row.status === "pending" || row.status === "issued") &&
    row.expires_at <= now
  )
    ? "expired"
    : row.status;
}

function publicEnrollment(
  row: NodeEnrollmentRow,
  now = Date.now(),
): PublicNodeEnrollment {
  return {
    id: row.id,
    nodeId: row.node_id,
    kind: row.kind,
    status: enrollmentStatus(row, now),
    accountAlias: row.account_alias,
    accountId: row.account_id,
    hostname: row.hostname,
    region: row.region,
    capabilities: parseCapabilities(row.capabilities),
    preferredIp: row.preferred_ip,
    transportPath: row.transport_path,
    expiresAt: row.expires_at,
    issuedAt: row.issued_at,
    activatedAt: row.activated_at,
    createdAt: row.created_at,
  };
}

export async function createNodeEnrollment(
  env: Env,
  input: CreateNodeEnrollmentInput,
  allowProvision: boolean,
  now = Date.now(),
): Promise<{ enrollment: PublicNodeEnrollment; token: string }> {
  if (!validNodeId(input.nodeId)) {
    throw new NodeEnrollmentError("Node ID 无效", 400);
  }
  const nodeId = input.nodeId;
  const accountAlias = normalizeAccountAlias(input.accountAlias);
  const accountId = normalizeAccountId(input.accountId);
  const hostname = normalizeHostname(input.hostname);
  if (!accountAlias || !accountId || !hostname) {
    throw new NodeEnrollmentError("Cloudflare 账户或节点域名无效", 400);
  }

  const existing = await getNode(env, nodeId);
  const credential = await env.DB.prepare(
    "SELECT * FROM node_credentials WHERE node_id=?1",
  )
    .bind(nodeId)
    .first<NodeCredentialRow>();
  if (!existing && !allowProvision) {
    throw new NodeEnrollmentError(
      "当前合规策略不允许创建新的 Cloudflare 代理节点",
      403,
    );
  }
  if (
    existing &&
    (existing.account_alias !== accountAlias ||
      normalizeHostname(existing.hostname) !== hostname)
  ) {
    throw new NodeEnrollmentError(
      "已有节点只能使用原账户别名和原域名轮换凭据",
      409,
    );
  }

  const pending = await env.DB.prepare(
    "SELECT id FROM node_enrollments " +
      "WHERE node_id=?1 AND status IN ('pending','issued') AND expires_at>?2 " +
      "LIMIT 1",
  )
    .bind(nodeId, now)
    .first<{ id: string }>();
  if (pending) {
    throw new NodeEnrollmentError(
      "该节点已有未过期的注册任务，请先撤销或等待过期",
      409,
    );
  }

  const fallbackCapabilities = parseCapabilities(existing?.capabilities);
  const capabilities = normalizeCapabilities(
    input.capabilities,
    fallbackCapabilities,
  );
  const requestedPath =
    input.transportPath === undefined
      ? existing?.transport_path || "/ws/" + randomHex(12)
      : String(input.transportPath);
  const transportPath = normalizeTransportPath(requestedPath);
  if (!transportPath) {
    throw new NodeEnrollmentError("节点传输路径无效或命中保留路径", 400);
  }

  const ttlSeconds =
    input.ttlSeconds === undefined
      ? ENROLLMENT_TTL_MS / 1000
      : Number(input.ttlSeconds);
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds * 1000 > MAX_ENROLLMENT_TTL_MS
  ) {
    throw new NodeEnrollmentError("注册令牌有效期必须在 60 到 3600 秒之间", 400);
  }

  const kind: NodeEnrollmentKind = !existing
    ? "provision"
    : credential?.auth_mode === "isolated"
      ? "rotate"
      : "migrate";
  const token = randomHex(32);
  const row: NodeEnrollmentRow = {
    id: randomUuid(),
    node_id: nodeId,
    kind,
    status: "pending",
    account_alias: accountAlias,
    account_id: accountId,
    hostname,
    region: normalizeRegion(input.region ?? existing?.region),
    capabilities: JSON.stringify(capabilities),
    preferred_ip: normalizePreferredIp(
      input.preferredIp ?? existing?.preferred_ip,
    ),
    transport_path: transportPath,
    token_hash: await enrollmentTokenHash(env.NODE_HMAC_SECRET, token),
    secret_salt: randomHex(24),
    expires_at: now + ttlSeconds * 1000,
    issued_at: null,
    activated_at: null,
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    "INSERT INTO node_enrollments " +
      "(id,node_id,kind,status,account_alias,account_id,hostname,region," +
      "capabilities,preferred_ip,transport_path,token_hash,secret_salt," +
      "expires_at,issued_at,activated_at,created_at,updated_at) " +
      "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,NULL,NULL,?15,?15)",
  )
    .bind(
      row.id,
      row.node_id,
      row.kind,
      row.status,
      row.account_alias,
      row.account_id,
      row.hostname,
      row.region,
      row.capabilities,
      row.preferred_ip,
      row.transport_path,
      row.token_hash,
      row.secret_salt,
      row.expires_at,
      now,
    )
    .run();
  return { enrollment: publicEnrollment(row, now), token };
}

export async function listNodeEnrollments(
  env: Env,
  now = Date.now(),
): Promise<PublicNodeEnrollment[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM node_enrollments ORDER BY created_at DESC LIMIT 100",
  ).all<NodeEnrollmentRow>();
  return (results || []).map((row) => publicEnrollment(row, now));
}

export async function revokeNodeEnrollment(
  env: Env,
  id: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE node_enrollments SET status='revoked',updated_at=?2 " +
      "WHERE id=?1 AND status IN ('pending','issued')",
  )
    .bind(id, now)
    .run();
  return Number(result.meta.changes || 0) > 0;
}

export async function exchangeNodeEnrollment(
  env: Env,
  input: { token?: unknown; nodeId?: unknown; accountId?: unknown },
  now = Date.now(),
): Promise<{
  enrollment: PublicNodeEnrollment;
  nodeSecret: string;
}> {
  if (
    typeof input.token !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(input.token) ||
    !validNodeId(input.nodeId)
  ) {
    throw new NodeEnrollmentError("注册凭据无效", 401);
  }
  const accountId = normalizeAccountId(input.accountId);
  if (!accountId) throw new NodeEnrollmentError("注册凭据无效", 401);

  const hashes = await Promise.all(
    rootCandidates(env).map((candidate) =>
      enrollmentTokenHash(candidate.secret, input.token as string),
    ),
  );
  const row = await env.DB.prepare(
    "SELECT * FROM node_enrollments " +
      "WHERE token_hash=?1 OR token_hash=?2 LIMIT 1",
  )
    .bind(hashes[0], hashes[1] || hashes[0])
    .first<NodeEnrollmentRow>();
  if (
    !row ||
    row.status !== "pending" ||
    row.expires_at <= now ||
    row.node_id !== input.nodeId ||
    row.account_id !== accountId
  ) {
    throw new NodeEnrollmentError("注册令牌无效、已使用或已过期", 401);
  }
  const claimed = await env.DB.prepare(
    "UPDATE node_enrollments SET status='issued',issued_at=?2,updated_at=?2 " +
      "WHERE id=?1 AND status='pending' AND expires_at>?2",
  )
    .bind(row.id, now)
    .run();
  if (Number(claimed.meta.changes || 0) !== 1) {
    throw new NodeEnrollmentError("注册令牌已被使用", 409);
  }
  row.status = "issued";
  row.issued_at = now;
  row.updated_at = now;
  return {
    enrollment: publicEnrollment(row, now),
    nodeSecret: await deriveNodeSecret(
      env.NODE_HMAC_SECRET,
      row.node_id,
      row.secret_salt,
    ),
  };
}

export async function nodeAuthSecretCandidates(
  env: Pick<
    Env,
    "DB" | "NODE_HMAC_SECRET" | "NODE_HMAC_SECRET_PREVIOUS"
  >,
  nodeId: string,
  allowEnrollment: boolean,
  now = Date.now(),
): Promise<NodeAuthSecretCandidate[]> {
  const credential = await env.DB.prepare(
    "SELECT * FROM node_credentials WHERE node_id=?1",
  )
    .bind(nodeId)
    .first<NodeCredentialRow>();
  const roots = rootCandidates(env);
  const values: NodeAuthSecretCandidate[] = [];

  if (credential?.auth_mode === "isolated" && credential.current_salt) {
    for (const root of roots) {
      values.push({
        secret: await deriveNodeSecret(
          root.secret,
          nodeId,
          credential.current_salt,
        ),
        authKind: "isolated-current",
        rootSlot: root.slot,
      });
      if (credential.previous_salt) {
        values.push({
          secret: await deriveNodeSecret(
            root.secret,
            nodeId,
            credential.previous_salt,
          ),
          authKind: "isolated-previous",
          rootSlot: root.slot,
        });
      }
    }
    if (Number(credential.legacy_fallback) === 1) {
      for (const root of roots) {
        values.push({
          secret: root.secret,
          authKind: "legacy",
          rootSlot: root.slot,
        });
      }
    }
  } else if (credential?.auth_mode === "legacy") {
    for (const root of roots) {
      values.push({
        secret: root.secret,
        authKind: "legacy",
        rootSlot: root.slot,
      });
    }
  }

  if (allowEnrollment) {
    const { results } = await env.DB.prepare(
      "SELECT * FROM node_enrollments " +
        "WHERE node_id=?1 AND status='issued' AND expires_at>?2 " +
        "ORDER BY issued_at DESC LIMIT 2",
    )
      .bind(nodeId, now)
      .all<NodeEnrollmentRow>();
    for (const enrollment of results || []) {
      for (const root of roots) {
        values.push({
          secret: await deriveNodeSecret(
            root.secret,
            nodeId,
            enrollment.secret_salt,
          ),
          authKind: "enrollment",
          rootSlot: root.slot,
          enrollmentId: enrollment.id,
        });
      }
    }
  }

  const deduplicated = new Map<string, NodeAuthSecretCandidate>();
  for (const value of values) {
    if (!deduplicated.has(value.secret)) deduplicated.set(value.secret, value);
  }
  return [...deduplicated.values()];
}

export async function activateNodeEnrollment(
  env: Env,
  enrollmentId: string,
  request: RegisterRequest,
  authTimestamp: number,
): Promise<NodeRecord> {
  const enrollment = await env.DB.prepare(
    "SELECT * FROM node_enrollments " +
      "WHERE id=?1 AND status='issued' AND expires_at>?2",
  )
    .bind(enrollmentId, Date.now())
    .first<NodeEnrollmentRow>();
  if (!enrollment) {
    throw new NodeEnrollmentError("节点注册任务不存在或已经过期", 409);
  }
  const hostname = normalizeHostname(request.hostname);
  const accountAlias = normalizeAccountAlias(request.accountAlias);
  const transportPath = normalizeTransportPath(request.transportPath);
  if (
    request.nodeId !== enrollment.node_id ||
    hostname !== enrollment.hostname ||
    accountAlias !== enrollment.account_alias ||
    transportPath !== enrollment.transport_path
  ) {
    throw new NodeEnrollmentError("节点注册信息与预注册任务不匹配", 409);
  }
  if (
    enrollment.region &&
    request.region &&
    enrollment.region !== request.region
  ) {
    throw new NodeEnrollmentError("节点地区与预注册任务不匹配", 409);
  }

  const record: NodeRecord = {
    id: enrollment.node_id,
    account_alias: enrollment.account_alias,
    hostname: enrollment.hostname,
    region: request.region || enrollment.region,
    capabilities: JSON.stringify(
      normalizeCapabilities(
        request.capabilities,
        parseCapabilities(enrollment.capabilities),
      ),
    ),
    preferred_ip: request.preferredIp || enrollment.preferred_ip,
    transport_path: enrollment.transport_path,
    health: "healthy",
    enabled: 1,
    last_seen: authTimestamp,
    created_at: enrollment.created_at,
  };
  await upsertNode(env, record);
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO node_credentials " +
        "(node_id,auth_mode,current_salt,previous_salt,legacy_fallback," +
        "activated_at,updated_at) " +
        "VALUES (?1,'isolated',?2,NULL,?4,?3,?3) " +
        "ON CONFLICT(node_id) DO UPDATE SET " +
        "auth_mode='isolated'," +
        "previous_salt=CASE WHEN node_credentials.auth_mode='isolated' " +
        "THEN node_credentials.current_salt ELSE NULL END," +
        "legacy_fallback=excluded.legacy_fallback," +
        "current_salt=excluded.current_salt," +
        "activated_at=excluded.activated_at,updated_at=excluded.updated_at",
    ).bind(
      enrollment.node_id,
      enrollment.secret_salt,
      authTimestamp,
      enrollment.kind === "migrate" ? 1 : 0,
    ),
    env.DB.prepare(
      "UPDATE node_enrollments " +
        "SET status='activated',activated_at=?2,updated_at=?2 " +
        "WHERE id=?1 AND status='issued'",
    ).bind(enrollment.id, authTimestamp),
  ]);
  if (Number(results[1]?.meta?.changes || 0) !== 1) {
    throw new NodeEnrollmentError("节点注册任务已被使用", 409);
  }
  return record;
}

export async function revokeNodeCredential(
  env: Env,
  nodeId: string,
  now = Date.now(),
): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE node_credentials SET " +
        "auth_mode='revoked',current_salt=NULL,previous_salt=NULL," +
        "legacy_fallback=0,updated_at=?2 " +
        "WHERE node_id=?1 AND auth_mode!='revoked'",
    ).bind(nodeId, now),
    env.DB.prepare("UPDATE nodes SET enabled=0 WHERE id=?1").bind(nodeId),
    env.DB.prepare(
      "UPDATE node_enrollments SET status='revoked',updated_at=?2 " +
        "WHERE node_id=?1 AND status IN ('pending','issued')",
    ).bind(nodeId, now),
  ]);
  return Number(results[0]?.meta?.changes || 0) > 0;
}

export async function retirePreviousNodeCredential(
  env: Env,
  nodeId: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE node_credentials SET previous_salt=NULL,legacy_fallback=0," +
      "updated_at=?2 WHERE node_id=?1 AND auth_mode='isolated' " +
      "AND (previous_salt IS NOT NULL OR legacy_fallback=1)",
  )
    .bind(nodeId, now)
    .run();
  return Number(result.meta.changes || 0) > 0;
}

export async function deleteNodeRegistration(
  env: Env,
  nodeId: string,
): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM node_enrollments WHERE node_id=?1").bind(nodeId),
    env.DB.prepare("DELETE FROM nodes WHERE id=?1").bind(nodeId),
  ]);
  return Number(results[1]?.meta?.changes || 0) > 0;
}
