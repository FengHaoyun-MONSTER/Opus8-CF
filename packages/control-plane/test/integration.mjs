import crypto from "node:crypto";

const base = process.env.OPUS8_TEST_BASE || "http://127.0.0.1:8787";
const adminPassword = process.env.OPUS8_TEST_ADMIN || "test-admin";
const nodeSecret = process.env.OPUS8_TEST_NODE_SECRET || "test-node-hmac";
const nodeId = "test-node";
const username = "__limits_integration__";

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function jsonResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
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

const login = await jsonResponse(await fetch(`${base}/api/admin/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: adminPassword }),
}));
const adminHeaders = {
  authorization: `Bearer ${login.token}`,
  "content-type": "application/json",
};

const initialUsers = await jsonResponse(await fetch(`${base}/api/users`, {
  headers: adminHeaders,
}));
for (const user of initialUsers.users.filter((item) => item.username === username)) {
  await fetch(`${base}/api/users/${user.id}`, { method: "DELETE", headers: adminHeaders });
}

let userId = "";
try {
  const created = await jsonResponse(await fetch(`${base}/api/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      username,
      durationDays: 1,
      deviceLimit: 1,
      ipLimit24h: 2,
      trafficLimitBytes: 1_048_576,
    }),
  }));
  userId = created.user.id;
  const userUuid = created.user.uuid;
  assert(
    Number.isSafeInteger(created.policyVersion) &&
      created.policyVersion > 0 &&
      Array.isArray(created.cacheInvalidation?.acknowledgedNodes) &&
      Array.isArray(created.cacheInvalidation?.failedNodes),
    `user mutation must publish an observable policy version: ${JSON.stringify(created)}`,
  );

  const admit = (ipHash, leaseId) => signedPost("/api/nodes/admission", {
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
  await jsonResponse(await signedPost("/api/nodes/usage", { nodeId, events: [event] }));
  await jsonResponse(await signedPost("/api/nodes/usage", { nodeId, events: [event] }));

  const users = await jsonResponse(await fetch(`${base}/api/users`, { headers: adminHeaders }));
  const row = users.users.find((item) => item.id === userId);
  assert(
    row?.bytes_up === 100 && row?.bytes_down === 200 && row?.connections === 1,
    `usage event must be idempotent: ${JSON.stringify(row)}`,
  );

  const subscription = await fetch(created.subUrl);
  const usageHeader = subscription.headers.get("subscription-userinfo") || "";
  assert(usageHeader.includes("upload=100"), `missing upload usage: ${usageHeader}`);
  assert(usageHeader.includes("download=200"), `missing download usage: ${usageHeader}`);
  assert(usageHeader.includes("total=1048576"), `missing quota: ${usageHeader}`);

  await jsonResponse(await fetch(`${base}/api/users/${userId}/leases/reset`, {
    method: "POST",
    headers: adminHeaders,
  }));
  const afterReset = await admit("iphash-b", "lease-c");
  assert(afterReset.allowed, `cleared lease should permit a new IP: ${JSON.stringify(afterReset)}`);

  console.log("OK admission-first-ip");
  console.log("OK active-ip-limit-denial");
  console.log("OK idempotent-usage-accounting");
  console.log("OK subscription-usage-header");
  console.log("OK lease-reset-readmission");
  console.log("OK policy-version-invalidation-summary");
} finally {
  if (userId) {
    await fetch(`${base}/api/users/${userId}`, { method: "DELETE", headers: adminHeaders });
  }
}
