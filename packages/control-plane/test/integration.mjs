import crypto from "node:crypto";

const base = process.env.OPUS8_TEST_BASE || "http://127.0.0.1:8787";
const adminPassword = process.env.OPUS8_TEST_ADMIN || "test-admin";
const nodeSecret =
  process.env.OPUS8_TEST_NODE_SECRET || "test-node-hmac-secret-32-bytes!!";
const integrationKeyId =
  process.env.OPUS8_TEST_INTEGRATION_KEY_ID || "freedompost-local";
const integrationSecret =
  process.env.OPUS8_TEST_INTEGRATION_SECRET
  || "test-freedompost-integration-secret-32-bytes";
const benefitPath =
  "/api/integrations/freedompost/benefits/webmaster/claim";
const nodeId = `test-node-${process.pid}-${Date.now()}`;
const nodeHost = `${nodeId}.example.com`;
const transportPath = `/ws/integration-${process.pid}`;
const username = "__limits_integration__";

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function jsonResponse(response) {
  const data = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function signedPost(path, payload, timestamp = String(Date.now())) {
  const body = JSON.stringify(payload);
  const target = new URL(path, base).pathname + new URL(path, base).search;
  const signature = crypto
    .createHmac("sha256", nodeSecret)
    .update([
      "opus8-hmac-v2",
      timestamp,
      nodeId,
      "POST",
      target,
      body,
    ].join("\n"))
    .digest("hex");
  return fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opus8-ts": timestamp,
      "x-opus8-node": nodeId,
      "x-opus8-sign-v2": signature,
    },
    body,
  });
}

async function signedGet(path, timestamp = String(Date.now())) {
  const target = new URL(path, base).pathname + new URL(path, base).search;
  const signature = crypto
    .createHmac("sha256", nodeSecret)
    .update([
      "opus8-hmac-v2",
      timestamp,
      nodeId,
      "GET",
      target,
      "",
    ].join("\n"))
    .digest("hex");
  return fetch(base + path, {
    headers: {
      "x-opus8-ts": timestamp,
      "x-opus8-node": nodeId,
      "x-opus8-sign-v2": signature,
    },
  });
}

async function signedBenefitPost(payload, {
  requestId = `benefit-request-${crypto.randomUUID()}`,
  timestamp = String(Date.now()),
  signedPayload = payload,
} = {}) {
  const body = JSON.stringify(payload);
  const signedBody = JSON.stringify(signedPayload);
  const bodyHash = crypto.createHash("sha256").update(signedBody).digest("hex");
  const signature = crypto
    .createHmac("sha256", integrationSecret)
    .update([
      "opus8-integration-v1",
      timestamp,
      requestId,
      "POST",
      benefitPath,
      bodyHash,
    ].join("\n"))
    .digest("hex");
  return fetch(base + benefitPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opus8-integration-key-id": integrationKeyId,
      "x-opus8-integration-timestamp": timestamp,
      "x-opus8-integration-request-id": requestId,
      "x-opus8-integration-signature": signature,
    },
    body,
  });
}

const login = await jsonResponse(
  await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: adminPassword }),
  }),
);
const adminHeaders = {
  authorization: `Bearer ${login.token}`,
  "content-type": "application/json",
};

const compliance = await jsonResponse(
  await fetch(`${base}/api/operations/compliance`, {
    headers: adminHeaders,
  }),
);
assert(
  compliance.proxyProvisioningAllowed === true &&
    compliance.enforcement === "fail-closed" &&
    compliance.policyId === "cloudflare-data-plane-v1",
  `local integration must explicitly enable provisioning: ${JSON.stringify(compliance)}`,
);

const rotation = await jsonResponse(
  await fetch(`${base}/api/operations/key-rotation`, {
    headers: adminHeaders,
  }),
);
assert(
  rotation.landingCredentials?.total === 0 &&
    rotation.landingCredentials?.unreadable === 0 &&
    rotation.previousSecretsConfigured?.jwt === false &&
    rotation.previousSecretsConfigured?.nodeHmac === false &&
    rotation.previousSecretsConfigured?.landingConfig === false,
  `fresh local worker must expose a safe rotation state: ${JSON.stringify(rotation)}`,
);
const prematureLandingRotation = await fetch(
  `${base}/api/operations/key-rotation/landings`,
  { method: "POST", headers: adminHeaders },
);
assert(
  prematureLandingRotation.status === 409,
  "landing key migration must reject requests without a distinct previous key",
);

const registered = await jsonResponse(
  await signedPost("/api/nodes/register", {
    nodeId,
    accountAlias: "integration",
    hostname: nodeHost,
    region: "test",
    capabilities: ["vless", "ws"],
    transportPath,
  }),
);
assert(
  registered.transportPath === transportPath,
  "node registration must acknowledge the canonical transport path",
);
const reservedTransport = await signedPost("/api/nodes/register", {
  nodeId,
  accountAlias: "integration",
  hostname: nodeHost,
  region: "test",
  capabilities: ["vless", "ws"],
  transportPath: "/__opus8/policy",
});
assert(
  reservedTransport.status === 400,
  "reserved control paths must be rejected during registration",
);

const mismatchedHeartbeat = await signedPost("/api/nodes/heartbeat", {
  nodeId: `${nodeId}-forged`,
  health: "healthy",
});
assert(
  mismatchedHeartbeat.status === 401,
  "signed node identity must match the heartbeat body",
);

const newerHeartbeatAt = Date.now() + 2_000;
await jsonResponse(
  await signedPost(
    "/api/nodes/heartbeat",
    { nodeId, health: "healthy", preferredIp: "198.51.100.2" },
    String(newerHeartbeatAt),
  ),
);
await jsonResponse(
  await signedPost(
    "/api/nodes/heartbeat",
    { nodeId, health: "healthy", preferredIp: "198.51.100.1" },
    String(newerHeartbeatAt - 1_000),
  ),
);
const replaySafeNodes = await jsonResponse(
  await fetch(`${base}/api/nodes`, { headers: adminHeaders }),
);
const replaySafeNode = replaySafeNodes.nodes.find((item) => item.id === nodeId);
assert(
  replaySafeNode?.preferred_ip === "198.51.100.2" &&
    replaySafeNode?.last_seen === newerHeartbeatAt &&
    replaySafeNode?.transport_path === transportPath,
  `older signed heartbeat must not regress node state: ${JSON.stringify(replaySafeNode)}`,
);

const reportNodeHealth = async (runId, directOk, landingOk = true) =>
  jsonResponse(
    await fetch(`${base}/api/operations/node-health/report`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        runId,
        results: [
          {
            nodeId,
            directOk,
            landingOk,
            directLatencyMs: directOk ? 42 : null,
            landingLatencyMs: landingOk ? 84 : null,
            directError: directOk ? null : "integration direct failure",
            landingError: landingOk ? null : "integration landing failure",
            vantages: {
              direct: {
                github: { available: true, ok: directOk, latencyMs: 42 },
                landingVps: { available: true, ok: directOk, latencyMs: 45 },
              },
              landing: {
                github: { available: true, ok: landingOk, latencyMs: 84 },
                landingVps: { available: true, ok: landingOk, latencyMs: 88 },
              },
            },
          },
        ],
      }),
    }),
  );

const initialUsers = await jsonResponse(
  await fetch(`${base}/api/users`, {
    headers: adminHeaders,
  }),
);
for (const user of initialUsers.users.filter(
  (item) => item.username === username,
)) {
  await fetch(`${base}/api/users/${user.id}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
}

const landingName = "__integration_unreachable__";
const initialLandings = await jsonResponse(
  await fetch(`${base}/api/landings`, { headers: adminHeaders }),
);
for (const landing of initialLandings.landings.filter(
  (item) => item.name === landingName,
)) {
  await fetch(`${base}/api/landings/${landing.id}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
}

let userId = "";
let unlimitedUserId = "";
let landingId = "";
const benefitUserIds = [];
try {
  const unsignedBenefit = await fetch(base + benefitPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      externalClaimId: crypto.randomUUID(),
      campaignId: "webmaster-benefit-v1",
    }),
  });
  assert(
    unsignedBenefit.status === 401
      && (unsignedBenefit.headers.get("cache-control") || "").includes("no-store"),
    "the FreedomPost integration endpoint must reject unsigned requests without caching",
  );

  const tamperedClaimId = crypto.randomUUID();
  const tamperedBenefit = await signedBenefitPost(
    {
      externalClaimId: tamperedClaimId,
      campaignId: "webmaster-benefit-v1",
    },
    {
      signedPayload: {
        externalClaimId: crypto.randomUUID(),
        campaignId: "webmaster-benefit-v1",
      },
    },
  );
  assert(
    tamperedBenefit.status === 401,
    "a body changed after signing must be rejected",
  );

  const overrideBenefit = await signedBenefitPost({
    externalClaimId: crypto.randomUUID(),
    campaignId: "webmaster-benefit-v1",
    trafficLimitBytes: 1,
  });
  assert(
    overrideBenefit.status === 400,
    "the integration endpoint must reject attempts to override the fixed policy",
  );
  const invalidClaimIdBenefit = await signedBenefitPost({
    externalClaimId: "not-a-uuid",
    campaignId: "webmaster-benefit-v1",
  });
  assert(
    invalidClaimIdBenefit.status === 400,
    "invalid external claim ids must be rejected as contract errors",
  );

  const benefitClaimId = crypto.randomUUID();
  const firstBenefitResponse = await signedBenefitPost({
    externalClaimId: benefitClaimId,
    campaignId: "webmaster-benefit-v1",
  });
  const firstBenefit = await jsonResponse(firstBenefitResponse);
  benefitUserIds.push(firstBenefit.opusUserId);
  assert(
    firstBenefitResponse.status === 201
      && firstBenefit.created === true
      && firstBenefit.externalClaimId === benefitClaimId
      && firstBenefit.trafficBytes === 32_212_254_720
      && firstBenefit.durationDays === 15
      && firstBenefit.hwidRequired === true
      && firstBenefit.ipLimit === 2
      && typeof firstBenefit.subscriptionUrl === "string"
      && !Object.hasOwn(firstBenefit, "credential"),
    `the first benefit claim must return only the fixed public contract: ${JSON.stringify(firstBenefit)}`,
  );
  assert(
    (firstBenefitResponse.headers.get("cache-control") || "").includes("no-store"),
    "benefit provisioning responses must never be cached",
  );

  const repeatedBenefitResponse = await signedBenefitPost({
    externalClaimId: benefitClaimId,
    campaignId: "webmaster-benefit-v1",
  });
  const repeatedBenefit = await jsonResponse(repeatedBenefitResponse);
  assert(
    repeatedBenefitResponse.status === 200
      && repeatedBenefit.created === false
      && repeatedBenefit.opusUserId === firstBenefit.opusUserId
      && repeatedBenefit.opusDeviceId === firstBenefit.opusDeviceId
      && repeatedBenefit.subscriptionUrl === firstBenefit.subscriptionUrl,
    "a serial HTTP retry must restore the same benefit resources",
  );

  const concurrentClaimId = crypto.randomUUID();
  const concurrentResponses = await Promise.all([
    signedBenefitPost({
      externalClaimId: concurrentClaimId,
      campaignId: "webmaster-benefit-v1",
    }),
    signedBenefitPost({
      externalClaimId: concurrentClaimId,
      campaignId: "webmaster-benefit-v1",
    }),
  ]);
  const concurrentBenefits = await Promise.all(
    concurrentResponses.map((response) => jsonResponse(response)),
  );
  benefitUserIds.push(concurrentBenefits[0].opusUserId);
  assert(
    concurrentResponses.map((response) => response.status).sort().join(",")
      === "200,201"
      && concurrentBenefits.filter((item) => item.created).length === 1
      && concurrentBenefits[0].opusUserId === concurrentBenefits[1].opusUserId
      && concurrentBenefits[0].opusDeviceId === concurrentBenefits[1].opusDeviceId,
    `concurrent HTTP claims must converge on one user and device: ${JSON.stringify(concurrentBenefits)}`,
  );

  const benefitUsers = await jsonResponse(
    await fetch(`${base}/api/users`, { headers: adminHeaders }),
  );
  const benefitRows = benefitUsers.users.filter(
    (item) => benefitUserIds.includes(item.id),
  );
  assert(
    benefitRows.length === 2
      && benefitRows.every(
        (item) => item.device_limit === 2
          && item.ip_limit_24h === 2
          && item.traffic_limit_bytes === 32_212_254_720
          && item.unlock === 0,
      ),
    `D1 must contain exactly the fixed policy for each benefit claim: ${JSON.stringify(benefitRows)}`,
  );
  const benefitDevices = await jsonResponse(
    await fetch(`${base}/api/users/${firstBenefit.opusUserId}/devices`, {
      headers: adminHeaders,
    }),
  );
  assert(
    benefitDevices.devices.length === 1
      && benefitDevices.devices[0].id === firstBenefit.opusDeviceId
      && benefitDevices.devices[0].credential_mode === "static"
      && benefitDevices.devices[0].hwid_mode === "required",
    `the benefit must create exactly one static required-HWID device: ${JSON.stringify(benefitDevices)}`,
  );
  assert(
    (await fetch(firstBenefit.subscriptionUrl)).status === 403,
    "the benefit subscription must reject clients without HWID",
  );
  assert(
    (await fetch(firstBenefit.subscriptionUrl, {
      headers: { "x-hwid": "freedompost-integration-device-a" },
    })).status === 200,
    "the first valid benefit HWID must bind and download",
  );
  assert(
    (await fetch(firstBenefit.subscriptionUrl, {
      headers: { "x-hwid": "freedompost-integration-device-b" },
    })).status === 403,
    "a second benefit HWID must be rejected after binding",
  );

  const created = await jsonResponse(
    await fetch(`${base}/api/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        username,
        durationDays: 1,
        deviceLimit: 1,
        ipLimit24h: 2,
        trafficLimitBytes: 1_048_576,
        hwidMode: "optional",
      }),
    }),
  );
  userId = created.user.id;
  const userUuid = created.user.uuid;
  const activeCredentialUuid = created.credential?.uuid;
  assert(
    Number.isSafeInteger(created.policyVersion) &&
      created.policyVersion > 0 &&
      Array.isArray(created.cacheInvalidation?.acknowledgedNodes) &&
      Array.isArray(created.cacheInvalidation?.failedNodes),
    `user mutation must publish an observable policy version: ${JSON.stringify(created)}`,
  );
  assert(
    created.credential?.mode === "static"
      && typeof activeCredentialUuid === "string"
      && activeCredentialUuid !== userUuid,
    `user creation must expose the active device credential separately from the user identity: ${JSON.stringify(created)}`,
  );
  const initialDevices = await jsonResponse(
    await fetch(`${base}/api/users/${userId}/devices`, {
      headers: adminHeaders,
    }),
  );
  assert(
    initialDevices.devices.length === 1
      && initialDevices.devices[0].credential_mode === "static"
      && initialDevices.devices[0].hwid_mode === "optional"
      && initialDevices.devices[0].sub_url === created.subUrl,
    `new users must receive one event-driven static device credential: ${JSON.stringify(initialDevices)}`,
  );
  const devicePolicy = await jsonResponse(
    await signedGet(`/api/nodes/${nodeId}/uuids`),
  );
  const userPolicies = devicePolicy.accessPolicies.filter(
    (policy) => policy.userId === userId,
  );
  assert(
    userPolicies.length === 1
      && userPolicies.some((policy) => policy.uuid === activeCredentialUuid)
      && userPolicies.every(
        (policy) =>
          policy.uuid !== userUuid
          && policy.meteringEnabled === true
          && policy.ipHashKey === `user:${userId}`,
      ),
    `edge policy must accept only the device credential with stable per-user IP scope: ${JSON.stringify(userPolicies)}`,
  );
  const requiredDeviceResult = await jsonResponse(
    await fetch(`${base}/api/users/${userId}/devices`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "integration-required",
        hwidMode: "required",
      }),
    }),
  );
  const requiredDevice = requiredDeviceResult.device;
  assert(
    requiredDeviceResult.credential?.mode === "static"
      && typeof requiredDeviceResult.credential?.uuid === "string",
    `device creation must expose its active connection credential: ${JSON.stringify(requiredDeviceResult)}`,
  );
  assert(
    (await fetch(requiredDevice.sub_url)).status === 403,
    "required HWID subscriptions must reject clients without a device identifier",
  );
  assert(
    (await fetch(requiredDevice.sub_url, {
      headers: { "x-hwid": "integration-device-a" },
    })).status === 200,
    "the first valid HWID must bind and download the subscription",
  );
  assert(
    (await fetch(requiredDevice.sub_url, {
      headers: { "x-hwid": "integration-device-b" },
    })).status === 403,
    "a different HWID must be rejected after first binding",
  );
  await jsonResponse(
    await fetch(
      `${base}/api/users/${userId}/devices/${requiredDevice.id}/hwid/reset`,
      { method: "POST", headers: adminHeaders },
    ),
  );
  assert(
    (await fetch(requiredDevice.sub_url, {
      headers: { "x-hwid": "integration-device-b" },
    })).status === 200,
    "an administrator reset must allow a replacement device to bind",
  );
  const boundDevicesBeforeRotation = await jsonResponse(
    await fetch(`${base}/api/users/${userId}/devices`, {
      headers: adminHeaders,
    }),
  );
  const boundDeviceBeforeRotation = boundDevicesBeforeRotation.devices.find(
    (device) => device.id === requiredDevice.id,
  );
  assert(
    boundDeviceBeforeRotation?.hwid_bound === true
      && Number.isSafeInteger(boundDeviceBeforeRotation.hwid_bound_at),
    `the replacement HWID must be bound before credential rotation: ${JSON.stringify(boundDeviceBeforeRotation)}`,
  );
  const credentialBeforeRotation = new URL(
    Buffer.from(
      await (await fetch(requiredDevice.sub_url, {
        headers: { "x-hwid": "integration-device-b" },
      })).text(),
      "base64",
    ).toString("utf8").split(/\r?\n/).find(Boolean),
  ).username;
  const credentialRotationResult = await jsonResponse(
    await fetch(
      `${base}/api/users/${userId}/devices/${requiredDevice.id}/credential/rotate`,
      { method: "POST", headers: adminHeaders },
    ),
  );
  assert(
    credentialRotationResult.device.sub_url === requiredDevice.sub_url
      && credentialRotationResult.device.hwid_bound === true
      && credentialRotationResult.device.hwid_bound_at
        === boundDeviceBeforeRotation.hwid_bound_at
      && credentialRotationResult.device.credential_mode === "static",
    `connection credential rotation must preserve the subscription token and HWID binding: ${JSON.stringify(credentialRotationResult)}`,
  );
  assert(
    (await fetch(requiredDevice.sub_url, {
      headers: { "x-hwid": "integration-device-a" },
    })).status === 403,
    "connection credential rotation must not reset or replace the bound HWID",
  );
  const credentialAfterRotation = new URL(
    Buffer.from(
      await (await fetch(requiredDevice.sub_url, {
        headers: { "x-hwid": "integration-device-b" },
      })).text(),
      "base64",
    ).toString("utf8").split(/\r?\n/).find(Boolean),
  ).username;
  const policyAfterCredentialRotation = await jsonResponse(
    await signedGet(`/api/nodes/${nodeId}/uuids`),
  );
  const credentialsAfterRotation = policyAfterCredentialRotation.accessPolicies
    .filter((policy) => policy.userId === userId)
    .map((policy) => policy.uuid);
  assert(
    credentialAfterRotation !== credentialBeforeRotation
      && credentialsAfterRotation.includes(credentialAfterRotation)
      && !credentialsAfterRotation.includes(credentialBeforeRotation),
    `connection credential rotation must revoke the old node configuration immediately: ${JSON.stringify(credentialsAfterRotation)}`,
  );
  const rotatedDeviceResult = await jsonResponse(
    await fetch(
      `${base}/api/users/${userId}/devices/${requiredDevice.id}/rotate`,
      { method: "POST", headers: adminHeaders },
    ),
  );
  assert(
    (await fetch(requiredDevice.sub_url)).status === 404,
    "replacing a device must revoke its old subscription token",
  );
  assert(
    rotatedDeviceResult.device.credential_mode === "static",
    `replacement credentials must remain event-driven static credentials: ${JSON.stringify(rotatedDeviceResult)}`,
  );
  assert(
    (await fetch(rotatedDeviceResult.device.sub_url, {
      headers: { "x-hwid": "integration-device-c" },
    })).status === 200,
    "the rotated required device must accept a fresh HWID binding",
  );
  await jsonResponse(
    await fetch(
      `${base}/api/users/${userId}/devices/${requiredDevice.id}`,
      { method: "DELETE", headers: adminHeaders },
    ),
  );
  assert(
    (await fetch(
      `${base}/api/users/${userId}/devices/${initialDevices.devices[0].id}`,
      { method: "DELETE", headers: adminHeaders },
    )).status === 409,
    "the migration anchor device must not be deleted and resurrected by a later schema run",
  );

  const admit = (ipHash, leaseId) =>
    signedPost("/api/nodes/admission", {
      nodeId,
      userId,
      uuid: userUuid,
      leaseId,
      ipHash,
    }).then(jsonResponse);

  const first = await admit("iphash-a", "lease-a");
  const second = await admit("iphash-b", "lease-b");
  assert(first.allowed, "first IP should be admitted");
  assert(
    !second.allowed && second.reason === "active_ip_limit_exceeded",
    `second IP should be denied: ${JSON.stringify(second)}`,
  );

  const event = {
    id: `${nodeId}:event-1`,
    userId,
    uuid: userUuid,
    connections: 1,
    bytesUp: 100,
    bytesDown: 200,
    tsBucket: Math.floor(Date.now() / 3_600_000) * 3_600_000,
  };
  const secondEvent = {
    ...event,
    id: `${nodeId}:event-2`,
    connections: 0,
    bytesUp: 300,
    bytesDown: 400,
  };
  await jsonResponse(
    await signedPost("/api/nodes/usage", { nodeId, events: [event, secondEvent] }),
  );
  await jsonResponse(
    await signedPost("/api/nodes/usage", { nodeId, events: [event, secondEvent] }),
  );
  const unlimitedCreated = await jsonResponse(
    await fetch(`${base}/api/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        username: `${username}-unlimited`,
        durationDays: 1,
        deviceLimit: 1,
        ipLimit24h: 2,
        trafficLimitBytes: 0,
      }),
    }),
  );
  unlimitedUserId = unlimitedCreated.user.id;
  const policyWithUnlimited = await jsonResponse(
    await signedGet(`/api/nodes/${nodeId}/uuids`),
  );
  const unlimitedPolicies = policyWithUnlimited.accessPolicies.filter(
    (policy) => policy.userId === unlimitedUserId,
  );
  assert(
    unlimitedPolicies.length === 1
      && unlimitedPolicies[0].uuid === unlimitedCreated.credential.uuid
      && unlimitedPolicies.every(
        (policy) =>
          policy.meteringEnabled === false
          && policy.trafficLimitBytes === 0,
      ),
    "unlimited edge policies must keep admission but disable metering",
  );
  const unlimitedUsage = await jsonResponse(
    await signedPost("/api/nodes/usage", {
      nodeId,
      events: [{
        id: `${nodeId}:unlimited-event-1`,
        userId: unlimitedUserId,
        uuid: unlimitedCreated.user.uuid,
        connections: 1,
        bytesUp: 999,
        bytesDown: 999,
        tsBucket: Math.floor(Date.now() / 3_600_000) * 3_600_000,
      }],
    }),
  );
  assert(
    unlimitedUsage.accepted === 0,
    "unlimited users must not create precise usage rows",
  );

  const users = await jsonResponse(
    await fetch(`${base}/api/users`, { headers: adminHeaders }),
  );
  const row = users.users.find((item) => item.id === userId);
  assert(
    row?.bytes_up === 400 && row?.bytes_down === 600 && row?.connections === 1,
    `batched usage events must aggregate and remain idempotent: ${JSON.stringify(row)}`,
  );
  const unlimitedRow = users.users.find(
    (item) => item.id === unlimitedUserId,
  );
  assert(
    unlimitedRow?.bytes_up === 0
      && unlimitedRow?.bytes_down === 0
      && unlimitedRow?.connections === 0,
    `unlimited users must remain unmetered: ${JSON.stringify(unlimitedRow)}`,
  );
  assert(
    row?.access_state === "active_ip_limit_reached" &&
      row?.access_severity === "warning",
    `user list must expose the operational access reason: ${JSON.stringify(row)}`,
  );

  const activity = await jsonResponse(
    await fetch(`${base}/api/users/${userId}/activity`, {
      headers: adminHeaders,
    }),
  );
  assert(
    activity.user.id === userId &&
      activity.activeLeases.length === 1 &&
      activity.activeLeases[0].nodeId === nodeId &&
      activity.recentFingerprints.length === 1 &&
      activity.usageByNode.some(
        (item) =>
          item.nodeId === nodeId &&
          item.bytesUp === 400 &&
          item.bytesDown === 600,
      ),
    `user activity must combine leases, fingerprints and usage: ${JSON.stringify(activity)}`,
  );

  const overview = await jsonResponse(
    await fetch(`${base}/api/operations/overview`, {
      headers: adminHeaders,
    }),
  );
  assert(
    overview.summary.totalUsers >= 1 &&
      overview.summary.attentionUsers >= 1 &&
      Array.isArray(overview.series) &&
      overview.series.length === 24 &&
      Array.isArray(overview.topUsers) &&
      Array.isArray(overview.alerts) &&
      overview.optimizedIp?.enabled === true &&
      overview.optimizedIp?.eligibleNodes >= 1 &&
      overview.alerts.some((alert) => alert.kind === "optimized_ip") &&
      overview.alertStorage?.backend === "d1" &&
      overview.alertStorage?.kvWrites === 0 &&
      overview.alertStorage?.writes >= 1 &&
      Array.isArray(overview.alertIncidents),
    `operations overview must expose stable dashboard data: ${JSON.stringify(overview)}`,
  );
  const stableOverview = await jsonResponse(
    await fetch(`${base}/api/operations/overview`, {
      headers: adminHeaders,
    }),
  );
  assert(
    stableOverview.alertStorage?.writes === 0,
    `unchanged alerts must not write D1 rows: ${JSON.stringify(stableOverview.alertStorage)}`,
  );
  const initialIncidentHistory = await jsonResponse(
    await fetch(`${base}/api/operations/alerts?status=all&limit=50`, {
      headers: adminHeaders,
    }),
  );
  assert(
    initialIncidentHistory.backend === "d1" &&
      initialIncidentHistory.kvWrites === 0 &&
      initialIncidentHistory.incidents.some(
        (incident) =>
          incident.kind === "node" && incident.sourceId === nodeId,
      ),
    `alert history must expose deduplicated D1 incidents: ${JSON.stringify(initialIncidentHistory)}`,
  );

  const createdLanding = await jsonResponse(
    await fetch(`${base}/api/landings`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: landingName,
        hostname: "127.0.0.1",
        port: 9,
        username: "integration",
        password: "integration",
        region: "test",
        matchHosts: [],
        priority: 999,
        enabled: true,
      }),
    }),
  );
  landingId = createdLanding.landing.id;
  const landingTestResponse = await fetch(
    `${base}/api/landings/${landingId}/test`,
    {
      method: "POST",
      headers: adminHeaders,
    },
  );
  const landingTest = await landingTestResponse.json();
  assert(
    landingTestResponse.status === 502 && landingTest.ok === false,
    `unreachable landing must fail its real SOCKS5 probe: ${JSON.stringify(landingTest)}`,
  );
  const overviewWithLandingAlert = await jsonResponse(
    await fetch(`${base}/api/operations/overview`, {
      headers: adminHeaders,
    }),
  );
  assert(
    overviewWithLandingAlert.summary.unhealthyLandings >= 1 &&
      overviewWithLandingAlert.alerts.some(
        (alert) => alert.kind === "landing" && alert.id === landingId,
      ),
    `operations overview must alert on an unhealthy landing: ${JSON.stringify(overviewWithLandingAlert)}`,
  );

  const runPrefix = `integration-health-${Date.now()}`;
  const failedOnce = await reportNodeHealth(`${runPrefix}-fail-1`, false);
  const failedTwice = await reportNodeHealth(`${runPrefix}-fail-2`, false);
  const failedThird = await reportNodeHealth(`${runPrefix}-fail-3`, false);
  assert(
    failedOnce.nodes.find((item) => item.id === nodeId)?.health ===
      "degraded" &&
      failedTwice.nodes.find((item) => item.id === nodeId)?.health ===
        "degraded" &&
      failedThird.nodes.find((item) => item.id === nodeId)?.health === "banned",
    "node must degrade twice and be banned after the third direct failure",
  );
  const duplicateFailure = await reportNodeHealth(
    `${runPrefix}-fail-3`,
    false,
  );
  const duplicateNode = duplicateFailure.nodes.find(
    (item) => item.id === nodeId,
  );
  assert(
    duplicateFailure.idempotent === true &&
      duplicateNode?.health_consecutive_failures === 3,
    `duplicate health report must be idempotent: ${JSON.stringify(duplicateFailure)}`,
  );

  const bannedSubscription = await fetch(created.subUrl);
  const bannedBody = await bannedSubscription.text();
  assert(
    bannedSubscription.status === 503
      && bannedSubscription.headers.get("retry-after") === "60"
      && bannedSubscription.headers.get("cache-control") === "private, no-store"
      && bannedBody.includes("暂无可用节点"),
    `an empty node set must return a retryable service error instead of an invalid profile: ${bannedSubscription.status} ${bannedBody}`,
  );

  const recoveredOnce = await reportNodeHealth(
    `${runPrefix}-recover-1`,
    true,
  );
  const recoveringSubscription = await fetch(created.subUrl);
  const recoveredTwice = await reportNodeHealth(
    `${runPrefix}-recover-2`,
    true,
  );
  assert(
    recoveredOnce.nodes.find((item) => item.id === nodeId)?.health ===
      "banned" &&
      recoveringSubscription.status === 503 &&
      recoveredTwice.nodes.find((item) => item.id === nodeId)?.health ===
        "healthy",
    "banned node must require two consecutive direct successes to recover",
  );
  const recoveredSubscription = await fetch(created.subUrl);
  const recoveredBody = Buffer.from(
    await recoveredSubscription.text(),
    "base64",
  ).toString("utf8");
  assert(
    recoveredSubscription.status === 200 && recoveredBody.includes(nodeHost),
    `the subscription must recover after the node becomes healthy: ${recoveredSubscription.status} ${recoveredBody}`,
  );

  const landingFailure = await reportNodeHealth(
    `${runPrefix}-landing-fail`,
    true,
    false,
  );
  assert(
    landingFailure.nodes.find((item) => item.id === nodeId)?.health ===
      "degraded",
    "landing-only failure must degrade but not ban the node",
  );
  const degradedSubscription = Buffer.from(
    await (await fetch(created.subUrl)).text(),
    "base64",
  ).toString("utf8");
  assert(
    degradedSubscription.includes(nodeHost),
    "degraded node must remain in the subscription",
  );

  const healthOverview = await jsonResponse(
    await fetch(`${base}/api/operations/node-health`, {
      headers: adminHeaders,
    }),
  );
  assert(
    healthOverview.thresholds.failure === 3 &&
      healthOverview.thresholds.recovery === 2 &&
      healthOverview.events.some(
        (item) =>
          item.nodeId === nodeId &&
          item.details?.vantages?.direct?.github?.available === true,
      ),
    `health overview must expose policy and event history: ${JSON.stringify(healthOverview)}`,
  );

  const invalidPoolResponse = await fetch(`${base}/api/optimized-ips`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      version: 3,
      nodes: {
        [nodeId]: {
          hostname: nodeHost,
          ips: ["172.64.1.1"],
          validatedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          vantages: ["github-runner"],
        },
      },
    }),
  });
  assert(
    invalidPoolResponse.status === 400,
    `single-vantage optimized pool must be rejected: ${invalidPoolResponse.status}`,
  );

  const mismatchedHostResponse = await fetch(`${base}/api/optimized-ips`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      version: 3,
      nodes: {
        [nodeId]: {
          hostname: "wrong.example.com",
          ips: ["172.64.1.1"],
          validatedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          vantages: ["github-runner", "landing-vps"],
        },
      },
    }),
  });
  assert(
    mismatchedHostResponse.status === 400,
    `optimized pool hostname mismatch must be rejected: ${mismatchedHostResponse.status}`,
  );

  const validatedAt = Date.now();
  await jsonResponse(
    await fetch(`${base}/api/optimized-ips`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        version: 3,
        nodes: {
          [nodeId]: {
            hostname: nodeHost,
            ips: ["172.64.1.1"],
            validatedAt,
            expiresAt: validatedAt + 60_000,
            vantages: ["github-runner", "landing-vps"],
          },
        },
      }),
    }),
  );
  const optimizedPool = await jsonResponse(
    await fetch(`${base}/api/optimized-ips`, { headers: adminHeaders }),
  );
  assert(
    optimizedPool.active === true &&
      optimizedPool.activeNodeCount === 1 &&
      optimizedPool.pool?.version === 3 &&
      optimizedPool.pool?.nodes?.[nodeId]?.vantages?.length === 2,
    `validated optimized pool must be observable: ${JSON.stringify(optimizedPool)}`,
  );
  const overviewWithOptimizedPool = await jsonResponse(
    await fetch(`${base}/api/operations/overview`, {
      headers: adminHeaders,
    }),
  );
  assert(
    overviewWithOptimizedPool.optimizedIp?.activeNodes >= 1 &&
      overviewWithOptimizedPool.optimizedIp?.totalIps >= 1 &&
      !overviewWithOptimizedPool.alerts.some(
        (alert) =>
          alert.kind === "optimized_ip" &&
          alert.id === nodeId,
      ),
    `operations overview must clear optimized-IP coverage alerts: ${JSON.stringify(overviewWithOptimizedPool)}`,
  );
  const optimizedSubscription = Buffer.from(
    await (await fetch(created.subUrl)).text(),
    "base64",
  ).toString("utf8");
  assert(
    optimizedSubscription.includes(`@172.64.1.1:443`) &&
      optimizedSubscription.includes(`sni=${nodeHost}`),
    `node-specific optimized IP must retain node SNI: ${optimizedSubscription}`,
  );

  await reportNodeHealth(`${runPrefix}-final-healthy`, true, true);
  await jsonResponse(
    await fetch(`${base}/api/operations/overview`, {
      headers: adminHeaders,
    }),
  );
  const resolvedIncidents = await jsonResponse(
    await fetch(`${base}/api/operations/alerts?status=resolved&limit=200`, {
      headers: adminHeaders,
    }),
  );
  assert(
    resolvedIncidents.incidents.some(
      (incident) =>
        incident.kind === "node" &&
        incident.sourceId === nodeId &&
        incident.status === "resolved" &&
        incident.resolvedAt,
    ),
    `recovered node alert must be resolved once: ${JSON.stringify(resolvedIncidents)}`,
  );

  const subscription = await fetch(created.subUrl);
  const base64Subscription = Buffer.from(
    await subscription.text(),
    "base64",
  ).toString("utf8");
  const usageHeader = subscription.headers.get("subscription-userinfo") || "";
  assert(
    (subscription.headers.get("x-opus8-subscription-protection") || "")
      .startsWith("device-token-v1;") &&
      (subscription.headers.get("cache-control") || "").includes("no-store"),
    "subscription responses must confirm device credentials and disable caching",
  );
  const base64Node = new URL(
    base64Subscription.split(/\r?\n/).find(Boolean),
  );
  assert(
    base64Node.searchParams.get("path") === `${transportPath}?ed=2560`,
    `base64/Xray subscription must use the registered path: ${base64Subscription}`,
  );
  assert(
    base64Node.username === activeCredentialUuid
      && base64Node.username !== userUuid,
    "new subscriptions must render the event-driven device credential instead of the user identity",
  );
  const clashSubscription = await (
    await fetch(`${created.subUrl}?format=clash`)
  ).text();
  assert(
    clashSubscription.includes(`path: "${transportPath}"`) &&
      clashSubscription.includes("max-early-data: 2560") &&
      !clashSubscription.includes(`path: "${transportPath}?ed=2560"`),
    "Mihomo subscription must use a query-free registered path and explicit Early Data",
  );
  const singboxSubscription = await (
    await fetch(`${created.subUrl}?format=singbox`)
  ).json();
  const singboxTransport = singboxSubscription.outbounds?.[0]?.transport;
  assert(
    singboxTransport?.path === transportPath &&
      singboxTransport?.max_early_data === 2560 &&
      singboxTransport?.early_data_header_name ===
        "Sec-WebSocket-Protocol",
    "sing-box subscription must use the registered path and explicit Early Data",
  );
  assert(
    usageHeader.includes("upload=400"),
    `missing upload usage: ${usageHeader}`,
  );
  assert(
    usageHeader.includes("download=600"),
    `missing download usage: ${usageHeader}`,
  );
  assert(
    usageHeader.includes("total=1048576"),
    `missing quota: ${usageHeader}`,
  );

  await jsonResponse(
    await fetch(`${base}/api/users/${userId}/leases/reset`, {
      method: "POST",
      headers: adminHeaders,
    }),
  );
  const afterReset = await admit("iphash-b", "lease-c");
  assert(
    afterReset.allowed,
    `cleared lease should permit a new IP: ${JSON.stringify(afterReset)}`,
  );

  const malformedSubscription = await fetch(
    `${base}/sub/${"a".repeat(31)}`,
  );
  assert(
    malformedSubscription.status === 404 &&
      (malformedSubscription.headers.get("cache-control") || "").includes(
        "no-store",
      ),
    "malformed subscription tokens must fail before D1 and remain non-cacheable",
  );

  if (process.env.OPUS8_TEST_RATE_LIMIT === "1") {
    let limitedResponse = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await fetch(created.subUrl);
      if (response.status === 429) {
        limitedResponse = response;
        break;
      }
    }
    assert(
      limitedResponse?.headers.get("retry-after") === "60" &&
        (limitedResponse.headers.get("cache-control") || "").includes(
          "no-store",
        ),
      "local native rate limiter must return a non-cacheable 429 with Retry-After",
    );
  }

  console.log("OK admission-first-ip");
  console.log("OK active-ip-limit-denial");
  console.log("OK idempotent-usage-accounting");
  console.log("OK subscription-usage-header");
  console.log("OK lease-reset-readmission");
  console.log("OK policy-version-invalidation-summary");
  console.log("OK operations-overview");
  console.log("OK user-activity-privacy-view");
  console.log("OK node-health-failure-threshold");
  console.log("OK node-health-idempotent-report");
  console.log("OK banned-node-subscription-removal");
  console.log("OK node-health-recovery-threshold");
  console.log("OK landing-only-degradation");
  console.log("OK node-health-overview");
  console.log("OK landing-real-probe-alert");
  console.log("OK optimized-ip-two-vantage-admission");
  console.log("OK optimized-ip-node-specific-subscription");
  console.log("OK optimized-ip-operations-alerts");
  console.log("OK alert-incidents-d1-deduplication");
  console.log("OK alert-incidents-resolution-history");
  console.log("OK subscription-native-rate-limit");
  console.log("OK transport-path-single-source");
  console.log("OK freedompost-benefit-integration-contract");
  console.log("OK freedompost-benefit-http-idempotency");
  console.log("OK freedompost-benefit-required-hwid");
} finally {
  if (landingId) {
    await fetch(`${base}/api/landings/${landingId}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
  }
  if (userId) {
    await fetch(`${base}/api/users/${userId}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
  }
  if (unlimitedUserId) {
    await fetch(`${base}/api/users/${unlimitedUserId}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
  }
  for (const benefitUserId of new Set(benefitUserIds)) {
    if (!benefitUserId) continue;
    await fetch(`${base}/api/users/${benefitUserId}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
  }
}
