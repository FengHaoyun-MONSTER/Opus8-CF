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
const blocked = evaluateCompliance(policy, {
  mode: "node-deploy",
  now: new Date("2026-07-29T12:00:00.000Z"),
  nodeId: "acc1-n1",
  accountAlias: "acc1",
  workerName: "opus8cf-node-acc1-n1-v2",
});
assert.equal(blocked.proxyProvisioningAllowed, false);
assert(blocked.reasons.includes("written_permission_pending"));
assert.equal(
  blocked.legacyNodeCompatibilityUntil,
  Date.parse("2027-07-29T00:00:00.000Z"),
);

const approved = structuredClone(policy);
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
  mode: "node-deploy",
  now: new Date("2026-07-29T12:00:00.000Z"),
  permissionReference,
  nodeId: "acc1-n1",
  accountAlias: "acc1",
  workerName: "opus8cf-node-acc1-n1-v2",
});
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
  partialControlPermission.reasons.includes(
    "permission_scope_does_not_cover_current_topology",
  ),
);
const wrongReference = evaluateCompliance(approved, {
  mode: "node-deploy",
  now: new Date("2026-07-29T12:00:00.000Z"),
  permissionReference: "wrong",
  nodeId: "acc1-n1",
  accountAlias: "acc1",
  workerName: "opus8cf-node-acc1-n1-v2",
});
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
  proxyProvisioningAllowed,
  trafficLimitIncreases,
} = await import(moduleUrl);

assert.equal(proxyProvisioningAllowed({}), false);
assert.equal(complianceStatus({ COMPLIANCE_PROXY_ALLOWED: "0" }).enforcement, "fail-closed");
assert.equal(proxyProvisioningAllowed({ COMPLIANCE_PROXY_ALLOWED: "1" }), true);
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
