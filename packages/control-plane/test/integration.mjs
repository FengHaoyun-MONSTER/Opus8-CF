import crypto from "node:crypto";

const base = process.env.OPUS8_TEST_BASE || "http://127.0.0.1:8787";
const adminPassword = process.env.OPUS8_TEST_ADMIN || "test-admin";
const nodeSecret = process.env.OPUS8_TEST_NODE_SECRET || "test-node-hmac";
const nodeId = `test-node-${process.pid}-${Date.now()}`;
const nodeHost = `${nodeId}.example.com`;
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

async function signedPost(path, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac("sha256", nodeSecret)
    .update(`${timestamp}.${nodeId}.${body}`)
    .digest("hex");
  return fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opus8-ts": timestamp,
      "x-opus8-node": nodeId,
      "x-opus8-sign": signature,
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

await jsonResponse(
  await signedPost("/api/nodes/register", {
    nodeId,
    accountAlias: "integration",
    hostname: nodeHost,
    region: "test",
    capabilities: ["vless", "ws"],
  }),
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
let landingId = "";
try {
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
      }),
    }),
  );
  userId = created.user.id;
  const userUuid = created.user.uuid;
  assert(
    Number.isSafeInteger(created.policyVersion) &&
      created.policyVersion > 0 &&
      Array.isArray(created.cacheInvalidation?.acknowledgedNodes) &&
      Array.isArray(created.cacheInvalidation?.failedNodes),
    `user mutation must publish an observable policy version: ${JSON.stringify(created)}`,
  );

  const admit = (ipHash, leaseId) =>
    signedPost("/api/nodes/admission", {
      nodeId,
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
    uuid: userUuid,
    connections: 1,
    bytesUp: 100,
    bytesDown: 200,
    tsBucket: Math.floor(Date.now() / 3_600_000) * 3_600_000,
  };
  await jsonResponse(
    await signedPost("/api/nodes/usage", { nodeId, events: [event] }),
  );
  await jsonResponse(
    await signedPost("/api/nodes/usage", { nodeId, events: [event] }),
  );

  const users = await jsonResponse(
    await fetch(`${base}/api/users`, { headers: adminHeaders }),
  );
  const row = users.users.find((item) => item.id === userId);
  assert(
    row?.bytes_up === 100 && row?.bytes_down === 200 && row?.connections === 1,
    `usage event must be idempotent: ${JSON.stringify(row)}`,
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
          item.bytesUp === 100 &&
          item.bytesDown === 200,
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
      Array.isArray(overview.alerts),
    `operations overview must expose stable dashboard data: ${JSON.stringify(overview)}`,
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
  const bannedBody = Buffer.from(
    await bannedSubscription.text(),
    "base64",
  ).toString("utf8");
  assert(
    !bannedBody.includes(nodeHost),
    `banned node must be removed from subscription: ${bannedBody}`,
  );

  const recoveredOnce = await reportNodeHealth(
    `${runPrefix}-recover-1`,
    true,
  );
  const recoveredTwice = await reportNodeHealth(
    `${runPrefix}-recover-2`,
    true,
  );
  assert(
    recoveredOnce.nodes.find((item) => item.id === nodeId)?.health ===
      "banned" &&
      recoveredTwice.nodes.find((item) => item.id === nodeId)?.health ===
        "healthy",
    "banned node must require two consecutive direct successes to recover",
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

  const subscription = await fetch(created.subUrl);
  const usageHeader = subscription.headers.get("subscription-userinfo") || "";
  assert(
    usageHeader.includes("upload=100"),
    `missing upload usage: ${usageHeader}`,
  );
  assert(
    usageHeader.includes("download=200"),
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
}
