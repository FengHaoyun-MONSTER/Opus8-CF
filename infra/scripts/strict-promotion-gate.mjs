import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MIN_AGE_HOURS = 72;
const DEFAULT_HEARTBEAT_MAX_AGE_MINUTES = 20;

export function evaluateStrictPromotion(nodes, now = Date.now(), options = {}) {
  const minAgeHours = Number(options.minAgeHours ?? DEFAULT_MIN_AGE_HOURS);
  const heartbeatMaxAgeMinutes = Number(
    options.heartbeatMaxAgeMinutes ?? DEFAULT_HEARTBEAT_MAX_AGE_MINUTES,
  );
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { allowed: false, reasons: ["no_registered_nodes"], nodes: [] };
  }
  const results = nodes.filter((node) => Number(node.enabled) === 1).map((node) => {
    const reasons = [];
    const activatedAt = Number(node.credential_activated_at || 0);
    const lastSeen = Number(node.last_seen || 0);
    if (node.auth_mode !== "isolated") reasons.push("credential_not_isolated");
    if (Number(node.credential_fallback_pending || 0) !== 0) reasons.push("credential_fallback_pending");
    if (node.health !== "healthy") reasons.push("node_not_healthy");
    if (!Number.isSafeInteger(activatedAt) || now - activatedAt < minAgeHours * 3_600_000) {
      reasons.push("credential_canary_too_young");
    }
    if (
      !Number.isSafeInteger(lastSeen)
      || lastSeen > now + 5 * 60_000
      || now - lastSeen > heartbeatMaxAgeMinutes * 60_000
    ) {
      reasons.push("heartbeat_stale");
    }
    if (typeof node.transport_path !== "string" || node.transport_path === "/") {
      reasons.push("transport_path_not_isolated");
    }
    return { id: String(node.id || "unknown"), reasons };
  });
  if (results.length === 0) return { allowed: false, reasons: ["no_enabled_nodes"], nodes: [] };
  return {
    allowed: results.every((node) => node.reasons.length === 0),
    reasons: [],
    nodes: results,
  };
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input || "{}");
  const result = evaluateStrictPromotion(payload.nodes, Date.now(), {
    minAgeHours: Number(process.env.STRICT_MIN_AGE_HOURS || DEFAULT_MIN_AGE_HOURS),
    heartbeatMaxAgeMinutes: Number(
      process.env.STRICT_HEARTBEAT_MAX_AGE_MINUTES || DEFAULT_HEARTBEAT_MAX_AGE_MINUTES,
    ),
  });
  if (!result.allowed) {
    for (const node of result.nodes) {
      if (node.reasons.length) console.error(`ERROR strict-gate node=${node.id} reasons=${node.reasons.join(",")}`);
    }
    for (const reason of result.reasons) console.error(`ERROR strict-gate reason=${reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK strict-promotion-gate nodes=${result.nodes.length}`);
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`ERROR strict-gate ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
