import { randomHex } from "@opus8-cf/shared";
import type { Env } from "./db";

export type AdminAuthentication = "password-jwt" | "automation-hmac";

export interface AdminAuditEntry {
  id: string;
  actor: string;
  authentication: AdminAuthentication;
  method: string;
  path: string;
  status: number;
  requestId: string;
  createdAt: number;
}

export interface AdminAuditInput {
  actor: string;
  authentication: AdminAuthentication;
  method: string;
  path: string;
  status: number;
  requestId?: string;
  createdAt?: number;
}

function safeValue(value: string, fallback: string, maxLength: number): string {
  const cleaned = value.trim();
  return /^[A-Za-z0-9._:/-]+$/.test(cleaned) && cleaned.length <= maxLength
    ? cleaned
    : fallback;
}

export async function recordAdminAudit(
  env: Env,
  input: AdminAuditInput,
): Promise<void> {
  const createdAt = input.createdAt ?? Date.now();
  await env.DB.prepare(
    `INSERT INTO admin_audit_log
       (id, actor, authentication, method, path, status, request_id, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
  )
    .bind(
      randomHex(16),
      safeValue(input.actor, "unknown", 64),
      input.authentication,
      safeValue(input.method.toUpperCase(), "UNKNOWN", 12),
      safeValue(input.path, "/redacted", 240),
      Math.max(100, Math.min(599, Math.trunc(input.status))),
      safeValue(input.requestId || randomHex(12), randomHex(12), 128),
      createdAt,
    )
    .run();
}

export async function listAdminAudit(
  env: Env,
  limit = 50,
  before = Number.MAX_SAFE_INTEGER,
): Promise<AdminAuditEntry[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const safeBefore = Number.isSafeInteger(before) && before > 0
    ? before
    : Number.MAX_SAFE_INTEGER;
  const { results } = await env.DB.prepare(
    `SELECT id, actor, authentication, method, path, status,
            request_id AS requestId, created_at AS createdAt
     FROM admin_audit_log
     WHERE created_at < ?1
     ORDER BY created_at DESC
     LIMIT ?2`,
  )
    .bind(safeBefore, safeLimit)
    .all<AdminAuditEntry>();
  return results ?? [];
}
