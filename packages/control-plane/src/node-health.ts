import type { NodeRecord } from "@opus8-cf/shared";
import { listNodes, type Env } from "./db";

export const NODE_FAILURE_THRESHOLD = 3;
export const NODE_RECOVERY_THRESHOLD = 2;
const EVENT_RETENTION_MS = 7 * 86_400_000;

export interface NodeProbeResultInput {
  nodeId: string;
  directOk: boolean;
  landingOk: boolean;
  directLatencyMs?: number;
  landingLatencyMs?: number;
  directError?: string;
  landingError?: string;
  vantages?: unknown;
}

export interface NodeHealthReportInput {
  runId: string;
  checkedAt?: number;
  results: NodeProbeResultInput[];
}

interface NormalizedProbeResult {
  nodeId: string;
  directOk: boolean;
  landingOk: boolean;
  directLatencyMs: number | null;
  landingLatencyMs: number | null;
  directError: string | null;
  landingError: string | null;
  vantages: Record<string, unknown> | null;
}

function boundedLatency(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 300_000) {
    throw new Error("探测延迟必须位于 0 到 300000 毫秒之间");
  }
  return Math.round(parsed);
}

function cleanError(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("探测错误必须是字符串");
  return value.replace(/\s+/g, " ").trim().slice(0, 500) || null;
}

function cleanVantages(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("探测视角详情必须是对象");
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > 4_000) throw new Error("探测视角详情过大");
  return JSON.parse(encoded) as Record<string, unknown>;
}

function normalizeReport(input: NodeHealthReportInput): {
  runId: string;
  checkedAt: number;
  results: NormalizedProbeResult[];
} {
  const runId =
    typeof input?.runId === "string" ? input.runId.trim().slice(0, 128) : "";
  if (!runId || !/^[A-Za-z0-9._:-]+$/.test(runId)) {
    throw new Error("runId 无效");
  }
  if (!input || !Array.isArray(input.results) || input.results.length === 0) {
    throw new Error("results 不能为空");
  }
  if (input.results.length > 50) throw new Error("单次最多报告 50 个节点");
  const checkedAt = Number(input.checkedAt || Date.now());
  if (
    !Number.isSafeInteger(checkedAt) ||
    Math.abs(Date.now() - checkedAt) > 15 * 60_000
  ) {
    throw new Error("checkedAt 超出允许时间窗口");
  }

  const seen = new Set<string>();
  const results = input.results.map((item) => {
    const nodeId =
      typeof item?.nodeId === "string" ? item.nodeId.trim().slice(0, 128) : "";
    if (!nodeId || !/^[A-Za-z0-9._:-]+$/.test(nodeId)) {
      throw new Error("nodeId 无效");
    }
    if (seen.has(nodeId)) throw new Error(`节点 ${nodeId} 重复`);
    seen.add(nodeId);
    if (
      typeof item.directOk !== "boolean" ||
      typeof item.landingOk !== "boolean"
    ) {
      throw new Error(`节点 ${nodeId} 缺少布尔探测结果`);
    }
    return {
      nodeId,
      directOk: item.directOk,
      landingOk: item.landingOk,
      directLatencyMs: boundedLatency(item.directLatencyMs),
      landingLatencyMs: boundedLatency(item.landingLatencyMs),
      directError: cleanError(item.directError),
      landingError: cleanError(item.landingError),
      vantages: cleanVantages(item.vantages),
    };
  });
  return { runId, checkedAt, results };
}

function summary(nodes: NodeRecord[]) {
  return {
    total: nodes.length,
    healthy: nodes.filter(
      (node) => Number(node.enabled) === 1 && node.health === "healthy",
    ).length,
    degraded: nodes.filter(
      (node) => Number(node.enabled) === 1 && node.health === "degraded",
    ).length,
    banned: nodes.filter(
      (node) => Number(node.enabled) === 1 && node.health === "banned",
    ).length,
    disabled: nodes.filter((node) => Number(node.enabled) !== 1).length,
  };
}

export async function nodeHealthOverview(env: Env) {
  const nodes = await listNodes(env);
  const { results } = await env.DB.prepare(
    `SELECT run_id,node_id,checked_at,direct_ok,landing_ok,
       direct_latency_ms,landing_latency_ms,error,details
     FROM node_health_events
     ORDER BY checked_at DESC,node_id
     LIMIT 80`,
  ).all<{
    run_id: string;
    node_id: string;
    checked_at: number;
    direct_ok: number;
    landing_ok: number;
    direct_latency_ms: number | null;
    landing_latency_ms: number | null;
    error: string | null;
    details: string | null;
  }>();
  return {
    generatedAt: Date.now(),
    thresholds: {
      failure: NODE_FAILURE_THRESHOLD,
      recovery: NODE_RECOVERY_THRESHOLD,
    },
    summary: summary(nodes),
    nodes,
    events: (results ?? []).map((event) => ({
      runId: event.run_id,
      nodeId: event.node_id,
      checkedAt: event.checked_at,
      directOk: Number(event.direct_ok) === 1,
      landingOk: Number(event.landing_ok) === 1,
      directLatencyMs: event.direct_latency_ms,
      landingLatencyMs: event.landing_latency_ms,
      error: event.error,
      details: (() => {
        try {
          return event.details ? JSON.parse(event.details) : null;
        } catch {
          return null;
        }
      })(),
    })),
  };
}

export async function applyNodeHealthReport(
  env: Env,
  input: NodeHealthReportInput,
) {
  const report = normalizeReport(input);
  const duplicate = await env.DB.prepare(
    "SELECT run_id FROM node_health_runs WHERE run_id=?1",
  )
    .bind(report.runId)
    .first<{ run_id: string }>();
  if (duplicate) {
    const nodes = await listNodes(env);
    return {
      ok: true,
      idempotent: true,
      runId: report.runId,
      summary: summary(nodes),
      transitions: [],
      nodes,
    };
  }

  const nodes = await listNodes(env);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const unknown = report.results
    .filter((result) => !byId.has(result.nodeId))
    .map((result) => result.nodeId);
  if (unknown.length > 0) {
    throw new Error(`存在未注册节点: ${unknown.join(", ")}`);
  }

  const transitions: Array<{
    nodeId: string;
    from: NodeRecord["health"];
    to: NodeRecord["health"];
    reason: string;
  }> = [];
  const statements = [
    env.DB.prepare(
      "INSERT INTO node_health_runs (run_id,checked_at,received_at) VALUES (?1,?2,?3)",
    ).bind(report.runId, report.checkedAt, Date.now()),
  ];

  for (const result of report.results) {
    const node = byId.get(result.nodeId)!;
    const previousFailures = Number(node.health_consecutive_failures || 0);
    const previousSuccesses = Number(node.health_consecutive_successes || 0);
    let failures = previousFailures;
    let successes = previousSuccesses;
    let nextHealth: NodeRecord["health"];
    let reason: string;
    let lastSuccess = node.health_last_success ?? null;
    let lastFailure = node.health_last_failure ?? null;

    if (!result.directOk) {
      failures += 1;
      successes = 0;
      lastFailure = report.checkedAt;
      nextHealth =
        failures >= NODE_FAILURE_THRESHOLD ? "banned" : "degraded";
      reason = result.directError
        ? `直连探测失败：${result.directError}`
        : "直连 VLESS 探测失败";
    } else {
      failures = 0;
      successes += 1;
      lastSuccess = report.checkedAt;
      if (node.health === "banned" && successes < NODE_RECOVERY_THRESHOLD) {
        nextHealth = "banned";
        reason = `恢复验证中（${successes}/${NODE_RECOVERY_THRESHOLD}）`;
      } else if (!result.landingOk) {
        nextHealth = "degraded";
        reason = result.landingError
          ? `落地/WARP 探测失败：${result.landingError}`
          : "落地/WARP 探测失败";
      } else {
        nextHealth = "healthy";
        reason = "直连与落地/WARP 探测正常";
      }
    }

    if (node.health !== nextHealth) {
      transitions.push({
        nodeId: node.id,
        from: node.health,
        to: nextHealth,
        reason,
      });
    }

    const eventError = !result.directOk
      ? result.directError || "direct probe failed"
      : !result.landingOk
        ? result.landingError || "landing probe failed"
        : null;
    const details = JSON.stringify({
      directError: result.directError,
      landingError: result.landingError,
      vantages: result.vantages,
    });
    statements.push(
      env.DB.prepare(
        `INSERT INTO node_health_events
         (run_id,node_id,checked_at,direct_ok,landing_ok,direct_latency_ms,
          landing_latency_ms,error,details)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
      ).bind(
        report.runId,
        node.id,
        report.checkedAt,
        result.directOk ? 1 : 0,
        result.landingOk ? 1 : 0,
        result.directLatencyMs,
        result.landingLatencyMs,
        eventError,
        details,
      ),
      env.DB.prepare(
        `INSERT INTO node_health_state
         (node_id,consecutive_failures,consecutive_successes,direct_ok,landing_ok,
          direct_latency_ms,landing_latency_ms,last_checked,last_success,last_failure,
          last_error,last_run_id,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(node_id) DO UPDATE SET
           consecutive_failures=excluded.consecutive_failures,
           consecutive_successes=excluded.consecutive_successes,
           direct_ok=excluded.direct_ok,
           landing_ok=excluded.landing_ok,
           direct_latency_ms=excluded.direct_latency_ms,
           landing_latency_ms=excluded.landing_latency_ms,
           last_checked=excluded.last_checked,
           last_success=excluded.last_success,
           last_failure=excluded.last_failure,
           last_error=excluded.last_error,
           last_run_id=excluded.last_run_id,
           updated_at=excluded.updated_at`,
      ).bind(
        node.id,
        failures,
        successes,
        result.directOk ? 1 : 0,
        result.landingOk ? 1 : 0,
        result.directLatencyMs,
        result.landingLatencyMs,
        report.checkedAt,
        lastSuccess,
        lastFailure,
        nextHealth === "healthy" ? null : reason,
        report.runId,
        Date.now(),
      ),
      env.DB.prepare("UPDATE nodes SET health=?2 WHERE id=?1").bind(
        node.id,
        nextHealth,
      ),
    );
  }

  const retentionStart = report.checkedAt - EVENT_RETENTION_MS;
  statements.push(
    env.DB.prepare("DELETE FROM node_health_events WHERE checked_at<?1").bind(
      retentionStart,
    ),
    env.DB.prepare("DELETE FROM node_health_runs WHERE checked_at<?1").bind(
      retentionStart,
    ),
  );
  await env.DB.batch(statements);

  const updatedNodes = await listNodes(env);
  return {
    ok: true,
    idempotent: false,
    runId: report.runId,
    summary: summary(updatedNodes),
    transitions,
    nodes: updatedNodes,
  };
}
