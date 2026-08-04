import {
  randomHex,
  randomToken,
  randomUuid,
  type UserDeviceRecord,
  type UserRecord,
} from "@opus8-cf/shared";

export const WEBMASTER_BENEFIT_CAMPAIGN_ID = "webmaster-benefit-v1";

export const WEBMASTER_BENEFIT_POLICY = Object.freeze({
  trafficLimitBytes: 30 * 1024 * 1024 * 1024,
  durationDays: 15,
  deviceLimit: 2,
  ipLimit24h: 2,
  hwidMode: "required" as const,
  credentialMode: "static" as const,
  unlock: 0,
  nodeGroup: null,
});

export interface WebmasterBenefitClaimRecord {
  externalClaimId: string;
  integrationId: "freedompost";
  campaignId: typeof WEBMASTER_BENEFIT_CAMPAIGN_ID;
  userId: string;
  deviceId: string;
  createdAt: number;
}

export interface WebmasterBenefitProvisioning {
  claim: WebmasterBenefitClaimRecord;
  user: UserRecord;
  device: UserDeviceRecord;
  limits: {
    deviceLimit: number;
    ipLimit24h: number;
    trafficLimitBytes: number;
  };
}

export interface WebmasterBenefitStore {
  get(externalClaimId: string): Promise<WebmasterBenefitProvisioning | null>;
  createAtomic(provisioning: WebmasterBenefitProvisioning): Promise<boolean>;
}

export interface WebmasterBenefitProvisionResult {
  provisioning: WebmasterBenefitProvisioning;
  created: boolean;
}

function normalizeExternalClaimId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized,
  )
    ? normalized
    : null;
}

export function buildWebmasterBenefitProvisioning(
  externalClaimId: string,
  now = Date.now(),
): WebmasterBenefitProvisioning {
  const normalizedClaimId = normalizeExternalClaimId(externalClaimId);
  if (!normalizedClaimId) throw new Error("Invalid external claim id");
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid creation time");

  const userId = randomHex(8);
  const deviceId = `benefit-${randomHex(8)}`;
  const subscriptionToken = randomToken();
  const user: UserRecord = {
    id: userId,
    username: `webmaster-${normalizedClaimId}`,
    uuid: randomUuid(),
    plan_id: null,
    node_group: WEBMASTER_BENEFIT_POLICY.nodeGroup,
    unlock: WEBMASTER_BENEFIT_POLICY.unlock,
    sub_token: subscriptionToken,
    expire_at:
      now + WEBMASTER_BENEFIT_POLICY.durationDays * 24 * 60 * 60 * 1000,
    enabled: 1,
    created_at: now,
  };
  const device: UserDeviceRecord = {
    id: deviceId,
    user_id: userId,
    name: "Webmaster benefit device",
    base_uuid: randomUuid(),
    sub_token: subscriptionToken,
    credential_mode: WEBMASTER_BENEFIT_POLICY.credentialMode,
    hwid_mode: WEBMASTER_BENEFIT_POLICY.hwidMode,
    hwid_hash: null,
    hwid_bound_at: null,
    enabled: 1,
    created_at: now,
    updated_at: now,
  };

  return {
    claim: {
      externalClaimId: normalizedClaimId,
      integrationId: "freedompost",
      campaignId: WEBMASTER_BENEFIT_CAMPAIGN_ID,
      userId,
      deviceId,
      createdAt: now,
    },
    user,
    device,
    limits: {
      deviceLimit: WEBMASTER_BENEFIT_POLICY.deviceLimit,
      ipLimit24h: WEBMASTER_BENEFIT_POLICY.ipLimit24h,
      trafficLimitBytes: WEBMASTER_BENEFIT_POLICY.trafficLimitBytes,
    },
  };
}

export async function provisionWebmasterBenefit(
  store: WebmasterBenefitStore,
  externalClaimId: string,
  now = Date.now(),
): Promise<WebmasterBenefitProvisionResult> {
  const normalizedClaimId = normalizeExternalClaimId(externalClaimId);
  if (!normalizedClaimId) throw new Error("Invalid external claim id");

  const existing = await store.get(normalizedClaimId);
  if (existing) return { provisioning: existing, created: false };

  const candidate = buildWebmasterBenefitProvisioning(normalizedClaimId, now);
  if (await store.createAtomic(candidate)) {
    return { provisioning: candidate, created: true };
  }

  const winner = await store.get(normalizedClaimId);
  if (!winner) {
    throw new Error("Benefit claim conflict could not be recovered");
  }
  return { provisioning: winner, created: false };
}
