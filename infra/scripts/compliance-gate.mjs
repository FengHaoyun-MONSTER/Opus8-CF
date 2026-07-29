#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultPolicyPath = resolve(here, "..", "compliance-policy.json");
const DATA_PLANE_MODES = new Set(["node-deploy", "data-plane-test"]);
const LEGACY_ALLOWED_TARGETS = [
  "POST /api/nodes/heartbeat",
  "POST /api/nodes/admission",
  "POST /api/nodes/usage",
  "GET /api/nodes/{nodeId}/uuids",
];

function fail(message) {
  const error = new Error(message);
  error.code = "POLICY_INVALID";
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireIsoDate(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail(`${field} must be an ISO date`);
  }
  return Date.parse(value);
}

function requireStringArray(value, field) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    fail(`${field} must be a string array`);
  }
  return value;
}

function requirePositiveNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${field} must be a positive number`);
  }
}

export function validatePolicy(policy) {
  if (!isRecord(policy) || policy.schemaVersion !== 1) {
    fail("unsupported compliance policy schema");
  }
  if (policy.policyId !== "cloudflare-data-plane-v1") {
    fail("unexpected compliance policy id");
  }
  requireIsoDate(policy.reviewedAt, "reviewedAt");
  requirePositiveNumber(policy.reviewMaxAgeDays, "reviewMaxAgeDays");

  const sources = policy.sources;
  if (
    !isRecord(sources) ||
    sources.selfServeSubscriptionAgreement?.url !==
      "https://www.cloudflare.com/terms/" ||
    sources.selfServeSubscriptionAgreement?.section !== "2.2.1(j)" ||
    sources.developerPlatformTerms?.url !==
      "https://www.cloudflare.com/service-specific-terms-developer-platform/" ||
    sources.workersLimits?.url !==
      "https://developers.cloudflare.com/workers/platform/limits/" ||
    sources.workersAnalytics?.url !==
      "https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/"
  ) {
    fail("official Cloudflare compliance sources are missing or changed");
  }

  const permission = policy.writtenPermission;
  if (
    !isRecord(permission) ||
    !["pending", "approved", "denied", "expired"].includes(permission.status)
  ) {
    fail("writtenPermission.status is invalid");
  }
  requireStringArray(permission.accountAliases, "writtenPermission.accountAliases");
  requireStringArray(permission.nodeIds, "writtenPermission.nodeIds");

  const accounts = policy.currentTopology?.accounts;
  if (!isRecord(accounts) || Object.keys(accounts).length === 0) {
    fail("currentTopology.accounts is required");
  }
  const nodeIds = new Set();
  const workerNames = new Set();
  for (const [alias, account] of Object.entries(accounts)) {
    if (!/^[a-z0-9-]+$/.test(alias) || !isRecord(account)) {
      fail(`invalid account topology: ${alias}`);
    }
    const workers = requireStringArray(
      account.workerNames,
      `currentTopology.accounts.${alias}.workerNames`,
    );
    if (!Array.isArray(account.nodes)) fail(`nodes missing for ${alias}`);
    for (const workerName of workers) {
      if (!/^[a-z0-9-]+$/.test(workerName) || workerNames.has(workerName)) {
        fail(`invalid or duplicate worker name: ${workerName}`);
      }
      workerNames.add(workerName);
    }
    for (const node of account.nodes) {
      if (
        !isRecord(node) ||
        typeof node.id !== "string" ||
        typeof node.workerName !== "string" ||
        nodeIds.has(node.id) ||
        !workers.includes(node.workerName)
      ) {
        fail(`invalid or duplicate node topology under ${alias}`);
      }
      nodeIds.add(node.id);
    }
    const budget = policy.resourceBudgets?.perAccount?.[alias];
    if (!isRecord(budget)) fail(`resource budget missing for ${alias}`);
    requirePositiveNumber(budget.maxRequests, `${alias}.maxRequests`);
    requirePositiveNumber(budget.maxErrorRate, `${alias}.maxErrorRate`);
    requirePositiveNumber(
      budget.maxCpuP99Microseconds,
      `${alias}.maxCpuP99Microseconds`,
    );
    requirePositiveNumber(
      budget.maxSubrequestsPerRequest,
      `${alias}.maxSubrequestsPerRequest`,
    );
  }
  const legacy = policy.legacyNodeCompatibility;
  if (!isRecord(legacy) || legacy.status !== "temporary") {
    fail("legacyNodeCompatibility must be an explicit temporary policy");
  }
  const legacyExpiresAt = requireIsoDate(
    legacy.expiresAt,
    "legacyNodeCompatibility.expiresAt",
  );
  if (legacyExpiresAt <= Date.parse(policy.reviewedAt)) {
    fail("legacy node compatibility must expire after the policy review");
  }
  const legacyNodeIds = requireStringArray(
    legacy.nodeIds,
    "legacyNodeCompatibility.nodeIds",
  );
  if (
    legacyNodeIds.length === 0 ||
    new Set(legacyNodeIds).size !== legacyNodeIds.length ||
    legacyNodeIds.some((id) => !nodeIds.has(id))
  ) {
    fail("legacy compatibility nodes must be unique current-topology nodes");
  }
  const legacyTargets = requireStringArray(
    legacy.allowedTargets,
    "legacyNodeCompatibility.allowedTargets",
  );
  if (
    legacyTargets.length !== LEGACY_ALLOWED_TARGETS.length ||
    LEGACY_ALLOWED_TARGETS.some((target) => !legacyTargets.includes(target))
  ) {
    fail("legacy compatibility targets exceed the fixed runtime allowlist");
  }
  requirePositiveNumber(
    policy.resourceBudgets?.windowHours,
    "resourceBudgets.windowHours",
  );
  if (
    policy.incidentResponse?.sopPath !==
      "docs/P6.8-CLOUDFLARE-COMPLIANCE.md" ||
    policy.incidentResponse?.externalNotifications !== false ||
    policy.incidentResponse?.analyticsWrites !==
      "github-actions-summary-only"
  ) {
    fail("incident response or low-write analytics policy is invalid");
  }
  return policy;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function topologyNode(policy, nodeId) {
  for (const [accountAlias, account] of Object.entries(
    policy.currentTopology.accounts,
  )) {
    const node = account.nodes.find((item) => item.id === nodeId);
    if (node) return { ...node, accountAlias };
  }
  return null;
}

export function evaluateCompliance(
  policy,
  {
    now = new Date(),
    permissionReference = "",
    mode = "audit",
    nodeId = "",
    accountAlias = "",
    workerName = "",
    allCurrentNodes = false,
  } = {},
) {
  validatePolicy(policy);
  if (!["audit", "control-maintenance", ...DATA_PLANE_MODES].includes(mode)) {
    fail(`unsupported gate mode: ${mode}`);
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) fail("invalid evaluation time");

  const reviewedAt = Date.parse(policy.reviewedAt);
  const reviewAgeDays = Math.floor((nowMs - reviewedAt) / 86_400_000);
  const reasons = [];
  if (reviewAgeDays < 0 || reviewAgeDays > policy.reviewMaxAgeDays) {
    reasons.push("policy_review_stale");
  }

  const permission = policy.writtenPermission;
  if (permission.status !== "approved") {
    reasons.push(`written_permission_${permission.status}`);
  } else {
    if (!/^[a-f0-9]{64}$/.test(permission.referenceSha256 || "")) {
      reasons.push("permission_reference_hash_missing");
    } else if (
      !permissionReference ||
      sha256(permissionReference) !== permission.referenceSha256
    ) {
      reasons.push("permission_reference_mismatch");
    }
    const approvedAt = Date.parse(permission.approvedAt || "");
    const expiresAt = Date.parse(permission.expiresAt || "");
    if (!Number.isFinite(approvedAt) || approvedAt > nowMs) {
      reasons.push("permission_approval_date_invalid");
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
      reasons.push("permission_expired");
    }
  }

  if (mode === "control-maintenance" || DATA_PLANE_MODES.has(mode)) {
    const topologyAliases = Object.keys(policy.currentTopology.accounts);
    const topologyNodes = topologyAliases.flatMap((alias) =>
      policy.currentTopology.accounts[alias].nodes.map((node) => node.id),
    );
    if (
      topologyAliases.some(
        (alias) => !permission.accountAliases.includes(alias),
      ) ||
      topologyNodes.some((id) => !permission.nodeIds.includes(id))
    ) {
      reasons.push("permission_scope_does_not_cover_current_topology");
    }
    if (DATA_PLANE_MODES.has(mode) && !allCurrentNodes) {
      const registered = topologyNode(policy, nodeId);
      if (!registered) {
        reasons.push("node_not_in_declared_topology");
      } else {
        if (accountAlias && registered.accountAlias !== accountAlias) {
          reasons.push("node_account_mismatch");
        }
        if (workerName && registered.workerName !== workerName) {
          reasons.push("node_worker_name_mismatch");
        }
        if (!permission.accountAliases.includes(registered.accountAlias)) {
          reasons.push("account_outside_permission_scope");
        }
        if (!permission.nodeIds.includes(registered.id)) {
          reasons.push("node_outside_permission_scope");
        }
      }
    }
  }

  const allowed = reasons.length === 0;
  return {
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    reviewedAt: policy.reviewedAt,
    reviewAgeDays,
    permissionStatus: permission.status,
    proxyProvisioningAllowed: allowed,
    legacyNodeCompatibilityUntil: Date.parse(
      policy.legacyNodeCompatibility.expiresAt,
    ),
    legacyNodeIds: [...policy.legacyNodeCompatibility.nodeIds],
    mode,
    reasons: [...new Set(reasons)],
  };
}

function parseArgs(argv) {
  const options = {
    mode: "audit",
    policyPath: defaultPolicyPath,
    format: "human",
    nodeId: "",
    accountAlias: "",
    workerName: "",
    allCurrentNodes: false,
    now: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) fail(`missing value for ${arg}`);
      index += 1;
      return next;
    };
    if (arg === "--mode") options.mode = value();
    else if (arg === "--policy") options.policyPath = resolve(value());
    else if (arg === "--format") options.format = value();
    else if (arg === "--node-id") options.nodeId = value();
    else if (arg === "--account-alias") options.accountAlias = value();
    else if (arg === "--worker-name") options.workerName = value();
    else if (arg === "--now") options.now = value();
    else if (arg === "--all-current-nodes") options.allCurrentNodes = true;
    else fail(`unknown argument: ${arg}`);
  }
  if (!["human", "json", "env"].includes(options.format)) {
    fail(`unsupported output format: ${options.format}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const policy = JSON.parse(await readFile(options.policyPath, "utf8"));
  const result = evaluateCompliance(policy, {
    ...options,
    now: options.now ? new Date(options.now) : new Date(),
    permissionReference:
      process.env.CLOUDFLARE_PROXY_PERMISSION_REF || "",
  });
  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (options.format === "env") {
    process.stdout.write(
      `COMPLIANCE_PROXY_ALLOWED=${result.proxyProvisioningAllowed ? "1" : "0"}\n` +
        `COMPLIANCE_POLICY_ID=${result.policyId}\n` +
        `HMAC_V1_ACCEPT_UNTIL=${result.legacyNodeCompatibilityUntil}\n` +
        `HMAC_V1_NODE_IDS=${result.legacyNodeIds.join(",")}\n`,
    );
  } else {
    const label = result.proxyProvisioningAllowed ? "ALLOW" : "BLOCK";
    process.stdout.write(
      `${label} compliance mode=${result.mode} permission=${result.permissionStatus}` +
        ` reasons=${result.reasons.join(",") || "none"}\n`,
    );
  }
  if (
    DATA_PLANE_MODES.has(options.mode) &&
    !result.proxyProvisioningAllowed
  ) {
    process.exitCode = 3;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ERROR compliance-policy ${error.message}\n`);
    process.exitCode = 2;
  });
}
