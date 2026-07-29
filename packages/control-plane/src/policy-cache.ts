import {
  hmacSign,
  nodeSignatureMessageV1,
  nodeSignatureMessageV2,
  SIGN_HEADERS,
} from "@opus8-cf/shared";
import { type Env, listNodes } from "./db";
import { legacyNodeAllowed } from "./node-auth";

const POLICY_VERSION_KEY = "edge_policy_version";
const INVALIDATION_PATH = "/__opus8/policy/invalidate";
const INVALIDATION_TIMEOUT_MS = 3_000;

export interface PolicyInvalidationSummary {
  attempted: number;
  acknowledged: number;
  acknowledgedNodes: string[];
  failedNodes: string[];
}

/** Advance the authoritative edge-policy version after a committed policy change. */
export async function advanceEdgePolicyVersion(env: Env): Promise<number> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?1, ?2, ?2)
     ON CONFLICT(key) DO UPDATE SET
       value=MAX(runtime_state.value + 1, excluded.value),
       updated_at=excluded.updated_at`,
  ).bind(POLICY_VERSION_KEY, now).run();
  return getEdgePolicyVersion(env);
}

export async function getEdgePolicyVersion(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT value FROM runtime_state WHERE key=?1",
  ).bind(POLICY_VERSION_KEY).first<{ value: number }>();
  return Math.max(1, Number(row?.value) || 1);
}

function validNodeHostname(value: string): string | null {
  const hostname = String(value || "").trim().toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    !hostname.includes(".") ||
    !/^[a-z0-9.-]+$/.test(hostname)
  ) return null;
  return hostname;
}

async function invalidateNode(
  env: Env,
  nodeId: string,
  hostname: string,
  version: number,
): Promise<boolean> {
  const body = JSON.stringify({ version });
  const timestamp = String(Date.now());
  const legacyWindowOpen =
    Number(env.HMAC_V1_ACCEPT_UNTIL || 0) >= Number(timestamp) &&
    legacyNodeAllowed(env, nodeId);
  const legacySignature = legacyWindowOpen
    ? await hmacSign(
        env.NODE_HMAC_SECRET,
        nodeSignatureMessageV1(timestamp, nodeId, body),
      )
    : null;
  const signatureV2 = await hmacSign(
    env.NODE_HMAC_SECRET,
    nodeSignatureMessageV2(
      timestamp,
      nodeId,
      "POST",
      INVALIDATION_PATH,
      body,
    ),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INVALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(`https://${hostname}${INVALIDATION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGN_HEADERS.ts]: timestamp,
        [SIGN_HEADERS.node]: nodeId,
        [SIGN_HEADERS.signV2]: signatureV2,
        // Old edge nodes use v1 only inside the bounded rollout window.
        ...(legacySignature
          ? { [SIGN_HEADERS.sign]: legacySignature }
          : {}),
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const result = await response.json().catch(() => null) as {
      ok?: boolean;
      version?: number;
    } | null;
    return result?.ok === true && Number(result.version) >= version;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Push cache invalidation to all registered nodes. Failure is tolerated because
 * node-local policy caches have a short TTL and will then refresh by polling.
 */
export async function invalidateEdgePolicyCaches(
  env: Env,
  version: number,
): Promise<PolicyInvalidationSummary> {
  const targets = (await listNodes(env))
    .filter((node) => node.enabled === 1)
    .map((node) => ({
      id: node.id,
      hostname: validNodeHostname(node.hostname),
    }))
    .filter((node): node is { id: string; hostname: string } => Boolean(node.hostname));
  const results = await Promise.all(
    targets.map(async (node) => ({
      id: node.id,
      acknowledged: await invalidateNode(env, node.id, node.hostname, version),
    })),
  );
  const acknowledgedNodes = results
    .filter((result) => result.acknowledged)
    .map((result) => result.id);
  const failedNodes = results
    .filter((result) => !result.acknowledged)
    .map((result) => result.id);
  return {
    attempted: targets.length,
    acknowledged: acknowledgedNodes.length,
    acknowledgedNodes,
    failedNodes,
  };
}

export async function publishEdgePolicyChange(
  env: Env,
): Promise<{ version: number; invalidation: PolicyInvalidationSummary }> {
  const version = await advanceEdgePolicyVersion(env);
  const invalidation = await invalidateEdgePolicyCaches(env, version);
  return { version, invalidation };
}
