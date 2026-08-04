import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const bundled = await build({
  entryPoints: [join(controlRoot, "src", "webmaster-benefit.ts")],
  alias: {
    "@opus8-cf/shared": join(controlRoot, "..", "shared", "src", "index.ts"),
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const moduleUrl =
  "data:text/javascript;base64,"
  + Buffer.from(bundled.outputFiles[0].text).toString("base64");
const {
  WEBMASTER_BENEFIT_CAMPAIGN_ID,
  WEBMASTER_BENEFIT_POLICY,
  provisionWebmasterBenefit,
} = await import(moduleUrl);

const schema = readFileSync(join(controlRoot, "schema.sql"), "utf8");

function assert(value, message) {
  if (!value) throw new Error(message);
}

assert(
  /CREATE TABLE IF NOT EXISTS integration_claims\s*\([\s\S]*external_claim_id TEXT PRIMARY KEY[\s\S]*FOREIGN KEY \(user_id\) REFERENCES users\(id\)[\s\S]*FOREIGN KEY \(device_id\) REFERENCES user_devices\(id\)/.test(
    schema,
  ),
  "D1 schema must persist the external claim id with user and device ownership",
);

class MemoryBenefitStore {
  constructor({ yieldBeforeCreate = false } = {}) {
    this.records = new Map();
    this.createCalls = 0;
    this.yieldBeforeCreate = yieldBeforeCreate;
  }

  async get(externalClaimId) {
    return this.records.get(externalClaimId) ?? null;
  }

  async createAtomic(provisioning) {
    this.createCalls += 1;
    if (this.yieldBeforeCreate) await new Promise((resolve) => setImmediate(resolve));
    if (this.records.has(provisioning.claim.externalClaimId)) return false;
    this.records.set(provisioning.claim.externalClaimId, provisioning);
    return true;
  }
}

const claimId = "ef545e54-c513-4817-baa2-2590f9f60659";
const now = 1_786_000_000_000;
const store = new MemoryBenefitStore();
const first = await provisionWebmasterBenefit(store, claimId, now);

assert(first.created === true, "the first claim must create a provisioning record");
assert(
  first.provisioning.claim.externalClaimId === claimId
    && first.provisioning.claim.integrationId === "freedompost"
    && first.provisioning.claim.campaignId === WEBMASTER_BENEFIT_CAMPAIGN_ID,
  "claim ownership must be fixed to the FreedomPost webmaster campaign",
);
assert(
  WEBMASTER_BENEFIT_POLICY.trafficLimitBytes === 30 * 1024 * 1024 * 1024
    && WEBMASTER_BENEFIT_POLICY.durationDays === 15
    && WEBMASTER_BENEFIT_POLICY.deviceLimit === 2
    && WEBMASTER_BENEFIT_POLICY.ipLimit24h === 2
    && WEBMASTER_BENEFIT_POLICY.hwidMode === "required"
    && WEBMASTER_BENEFIT_POLICY.credentialMode === "static"
    && WEBMASTER_BENEFIT_POLICY.unlock === 0
    && WEBMASTER_BENEFIT_POLICY.nodeGroup === null,
  "the server-side webmaster benefit policy must remain fixed",
);
assert(
  first.provisioning.user.expire_at === now + 15 * 86_400_000
    && first.provisioning.user.unlock === 0
    && first.provisioning.user.node_group === null,
  "the provisioned user must receive exactly the fixed expiry and route policy",
);
assert(
  first.provisioning.device.user_id === first.provisioning.user.id
    && first.provisioning.device.credential_mode === "static"
    && first.provisioning.device.hwid_mode === "required"
    && first.provisioning.device.sub_token === first.provisioning.user.sub_token,
  "one required-HWID static device must own the subscription token",
);
assert(
  first.provisioning.limits.deviceLimit === 2
    && first.provisioning.limits.ipLimit24h === 2
    && first.provisioning.limits.trafficLimitBytes === 32_212_254_720,
  "the user limits must be 2 active IPs, 2 daily IPs, and 30 GiB",
);

const repeated = await provisionWebmasterBenefit(store, claimId, now + 10_000);
assert(repeated.created === false, "a serial retry must restore the existing claim");
assert(store.createCalls === 1, "a serial retry must not execute another atomic create");
assert(
  repeated.provisioning.user.id === first.provisioning.user.id
    && repeated.provisioning.device.id === first.provisioning.device.id
    && repeated.provisioning.device.sub_token === first.provisioning.device.sub_token,
  "a serial retry must return the same user, device, and subscription token",
);

const concurrentStore = new MemoryBenefitStore({ yieldBeforeCreate: true });
const concurrentId = "7023132e-d376-48c7-802d-bba41e180861";
const concurrent = await Promise.all([
  provisionWebmasterBenefit(concurrentStore, concurrentId, now),
  provisionWebmasterBenefit(concurrentStore, concurrentId, now),
]);
assert(
  concurrent.filter((item) => item.created).length === 1,
  "concurrent claims must have exactly one atomic creator",
);
assert(
  concurrent[0].provisioning.user.id === concurrent[1].provisioning.user.id
    && concurrent[0].provisioning.device.id === concurrent[1].provisioning.device.id
    && concurrentStore.records.size === 1,
  "concurrent claims must converge on one user and one device",
);

let invalidRejected = false;
try {
  await provisionWebmasterBenefit(store, "not-a-uuid", now);
} catch {
  invalidRejected = true;
}
assert(invalidRejected, "invalid external claim ids must be rejected before database writes");

console.log("OK webmaster benefit provisioning tests");
