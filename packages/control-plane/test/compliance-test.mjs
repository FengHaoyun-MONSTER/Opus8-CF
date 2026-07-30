import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  evaluateCompliance,
  validatePolicy,
} from "../../../infra/scripts/compliance-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const policy = JSON.parse(
  await readFile(join(repoRoot, "infra", "compliance-policy.json"), "utf8"),
);

validatePolicy(policy);
assert.equal(
  policy.legacyNodeCompatibility.expiresAt,
  "2027-07-29T00:00:00.000Z",
);
assert.deepEqual(policy.legacyNodeCompatibility.nodeIds, [
  "acc1-n1",
  "acc1-n2",
  "acc2-n1",
  "acc2-n2",
]);
const widenedLegacyPolicy = structuredClone(policy);
widenedLegacyPolicy.legacyNodeCompatibility.allowedTargets.push(
  "POST /api/nodes/register",
);
assert.throws(
  () => validatePolicy(widenedLegacyPolicy),
  /fixed runtime allowlist/,
);
const observeOnly = evaluateCompliance(policy, {
  mode: "node-provision",
  now: new Date("2026-07-29T12:00:00.000Z"),
  nodeId: "acc1-n1",
  accountAlias: "acc1",
  workerName: "opus8cf-node-acc1-n1-v2",
});
assert.equal(observeOnly.operationAllowed, true);
assert.equal(observeOnly.proxyProvisioningAllowed, true);
assert.equal(observeOnly.enforcementMode, "observe-only");
assert(observeOnly.warnings.includes("written_permission_pending"));
assert.deepEqual(observeOnly.reasons, []);

const enforcedPolicy = structuredClone(policy);
enforcedPolicy.enforcement.mode = "enforce";
const blocked = evaluateCompliance(enforcedPolicy, {
  mode: "node-provision",
  now: new Date("2026-07-29T12:00:00.000Z"),
  nodeId: "acc1-n1",
  accountAlias: "acc1",
  workerName: "opus8cf-node-acc1-n1-v2",
});
assert.equal(blocked.operationAllowed, false);
assert.equal(blocked.proxyProvisioningAllowed, false);
assert(blocked.reasons.includes("written_permission_pending"));
assert.equal(
  blocked.legacyNodeCompatibilityUntil,
  Date.parse("2027-07-29T00:00:00.000Z"),
);

const maintenance = evaluateCompliance(policy, {
  mode: "node-maintenance",
  now: new Date("2026-07-29T12:00:00.000Z"),
  nodeId: "acc1-n1",
  accountAlias: "acc1",
  workerName: "opus8cf-node-acc1-n1-v2",
});
assert.equal(maintenance.operationAllowed, true);
assert.equal(maintenance.proxyProvisioningAllowed, true);
assert.deepEqual(maintenance.reasons, []);
assert(maintenance.warnings.includes("written_permission_pending"));
assert(
  maintenance.warnings.includes(
    "permission_scope_does_not_cover_current_topology",
  ),
);

for (const [field, value, reason] of [
  ["nodeId", "new-node", "node_not_in_declared_topology"],
  ["accountAlias", "acc2", "node_account_mismatch"],
  ["workerName", "renamed-worker", "node_worker_name_mismatch"],
]) {
  const options = {
    mode: "node-maintenance",
    now: new Date("2026-07-29T12:00:00.000Z"),
    nodeId: "acc1-n1",
    accountAlias: "acc1",
    workerName: "opus8cf-node-acc1-n1-v2",
    [field]: value,
  };
  const mismatch = evaluateCompliance(policy, options);
  assert.equal(mismatch.operationAllowed, false);
  assert(mismatch.reasons.includes(reason));
}
const bulkMaintenance = evaluateCompliance(policy, {
  mode: "node-maintenance",
  now: new Date("2026-07-29T12:00:00.000Z"),
  allCurrentNodes: true,
});
assert.equal(bulkMaintenance.operationAllowed, false);
assert(
  bulkMaintenance.reasons.includes("maintenance_requires_single_declared_node"),
);

const approved = structuredClone(enforcedPolicy);
const permissionReference = "CF-SUPPORT-CASE-EXAMPLE";
approved.writtenPermission = {
  status: "approved",
  referenceSha256: createHash("sha256")
    .update(permissionReference)
    .digest("hex"),
  approvedAt: "2026-07-20T00:00:00.000Z",
  expiresAt: "2026-08-20T00:00:00.000Z",
  accountAliases: ["acc1", "acc2"],
  nodeIds: ["acc1-n1", "acc1-n2", "acc2-n1", "acc2-n2"],
};
const allowed = evaluateCompliance(approved, {
  mode: "node-provision",
  now: new Date("2026-07-29T12:00:00.000Z"),
  permissionReference,
  nodeId: "acc1-n1",
  accountAlias: "acc1",
  workerName: "opus8cf-node-acc1-n1-v2",
});
assert.equal(allowed.operationAllowed, true);
assert.equal(allowed.proxyProvisioningAllowed, true);
assert.deepEqual(allowed.reasons, []);
const partialApproval = structuredClone(approved);
partialApproval.writtenPermission.accountAliases = ["acc1"];
partialApproval.writtenPermission.nodeIds = ["acc1-n1"];
const partialControlPermission = evaluateCompliance(partialApproval, {
  mode: "control-maintenance",
  now: new Date("2026-07-29T12:00:00.000Z"),
  permissionReference,
});
assert.equal(partialControlPermission.proxyProvisioningAllowed, false);
assert(
  partialControlPermission.warnings.includes(
    "permission_scope_does_not_cover_current_topology",
  ),
);
const wrongReference = evaluateCompliance(approved, {
  mode: "node-provision",
  now: new Date("2026-07-29T12:00:00.000Z"),
  permissionReference: "wrong",
  nodeId: "acc1-n1",
  accountAlias: "acc1",
  workerName: "opus8cf-node-acc1-n1-v2",
});
assert.equal(wrongReference.operationAllowed, false);
assert.equal(wrongReference.proxyProvisioningAllowed, false);
assert(wrongReference.reasons.includes("permission_reference_mismatch"));

const bundled = await build({
  entryPoints: [join(repoRoot, "packages", "control-plane", "src", "compliance.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const moduleUrl =
  "data:text/javascript;base64," +
  Buffer.from(bundled.outputFiles[0].text).toString("base64");
const {
  complianceStatus,
  domainScopeIncreases,
  maintenanceNodeAllowed,
  proxyProvisioningAllowed,
  trafficLimitIncreases,
} = await import(moduleUrl);

assert.equal(proxyProvisioningAllowed({}), false);
assert.equal(complianceStatus({ COMPLIANCE_PROXY_ALLOWED: "0" }).enforcement, "fail-closed");
assert.equal(proxyProvisioningAllowed({ COMPLIANCE_PROXY_ALLOWED: "1" }), true);
assert.deepEqual(
  complianceStatus({
    COMPLIANCE_PROXY_ALLOWED: "1",
    COMPLIANCE_ENFORCEMENT_MODE: "observe-only",
  }),
  {
    proxyProvisioningAllowed: true,
    enforcement: "observe-only",
    policyId: "cloudflare-data-plane-v1",
    reason: "operator_override",
  },
);
assert.equal(maintenanceNodeAllowed({}, "acc1-n1"), false);
assert.equal(
  maintenanceNodeAllowed(
    { COMPLIANCE_MAINTENANCE_NODE_IDS: "acc1-n1,acc1-n2" },
    "acc1-n1",
  ),
  true,
);
assert.equal(
  maintenanceNodeAllowed(
    { COMPLIANCE_MAINTENANCE_NODE_IDS: "acc1-n1,acc1-n2" },
    "acc1",
  ),
  false,
);
assert.equal(trafficLimitIncreases(1_000, 2_000), true);
assert.equal(trafficLimitIncreases(1_000, 0), true);
assert.equal(trafficLimitIncreases(0, 5_000), false);
assert.equal(trafficLimitIncreases(1_000, 500), false);
assert.equal(
  domainScopeIncreases(["example.com"], ["api.example.com"]),
  false,
);
assert.equal(
  domainScopeIncreases(["api.example.com"], ["example.com"]),
  true,
);
assert.equal(domainScopeIncreases([], ["example.com"]), true);
assert.equal(domainScopeIncreases([], ["example.com"], true), false);
assert.equal(domainScopeIncreases(["example.com"], [], true), true);

console.log("compliance tests passed");
