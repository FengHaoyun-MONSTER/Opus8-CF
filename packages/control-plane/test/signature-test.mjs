import crypto from "node:crypto";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const bundled = await build({
  entryPoints: [join(controlRoot, "src", "node-auth.ts")],
  alias: {
    "@opus8-cf/shared": join(controlRoot, "..", "shared", "src", "index.ts"),
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const moduleUrl =
  "data:text/javascript;base64," +
  Buffer.from(bundled.outputFiles[0].text).toString("base64");
const { verifyNodeRequest } = await import(moduleUrl);

const secret = "signature-test-secret";
const nodeId = "acc1-n1";
const now = Date.now();

function hmac(message) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function hmacWith(key, message) {
  return crypto.createHmac("sha256", key).update(message).digest("hex");
}

function target(pathOrUrl) {
  const url = new URL(pathOrUrl, "https://opus8-signature.invalid");
  return url.pathname + url.search;
}

function v1Message(timestamp, body) {
  return `${timestamp}.${nodeId}.${body}`;
}

function v2Message(timestamp, method, pathOrUrl, body) {
  return [
    "opus8-hmac-v2",
    timestamp,
    nodeId,
    method.toUpperCase(),
    target(pathOrUrl),
    body,
  ].join("\n");
}

function signedRequest(path, {
  method = "POST",
  body = "",
  timestamp = String(now),
  includeV1 = false,
  v2Signature = null,
} = {}) {
  const headers = {
    "x-opus8-ts": timestamp,
    "x-opus8-node": nodeId,
  };
  if (includeV1) headers["x-opus8-sign"] = hmac(v1Message(timestamp, body));
  headers["x-opus8-sign-v2"] =
    v2Signature ?? hmac(v2Message(timestamp, method, path, body));
  return new Request("https://api.example" + path, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
  });
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

const body = JSON.stringify({ nodeId, health: "healthy" });
const valid = await verifyNodeRequest(
  signedRequest("/api/nodes/heartbeat", { body }),
  { NODE_HMAC_SECRET: secret },
  body,
  now,
);
assert(
  valid?.nodeId === nodeId && valid.timestamp === now && valid.version === 2,
  "valid v2 signature must authenticate",
);
assert(valid?.secretSlot === "current", "current key slot must be reported");

const previousSecret = "signature-test-previous-secret";
const previousRequest = signedRequest("/api/nodes/heartbeat", {
  body,
  v2Signature: hmacWith(
    previousSecret,
    v2Message(String(now), "POST", "/api/nodes/heartbeat", body),
  ),
});
const previousValid = await verifyNodeRequest(
  previousRequest,
  {
    NODE_HMAC_SECRET: secret,
    NODE_HMAC_SECRET_PREVIOUS: previousSecret,
  },
  body,
  now,
);
assert(
  previousValid?.secretSlot === "previous" &&
    previousValid.version === 2,
  "bounded previous HMAC key must authenticate and report its slot",
);
assert(
  await verifyNodeRequest(
    previousRequest,
    { NODE_HMAC_SECRET: secret },
    body,
    now,
  ) === null,
  "previous HMAC key must fail after the fallback binding is removed",
);

const pathReplay = signedRequest("/api/nodes/heartbeat", { body });
const replayedToUsage = new Request("https://api.example/api/nodes/usage", {
  method: "POST",
  headers: pathReplay.headers,
  body,
});
assert(
  await verifyNodeRequest(
    replayedToUsage,
    { NODE_HMAC_SECRET: secret },
    body,
    now,
  ) === null,
  "signature replayed to another path must fail",
);

const getPath = `/api/nodes/${nodeId}/uuids?view=full`;
const signedGet = signedRequest(getPath, { method: "GET" });
const queryTamper = new Request(
  `https://api.example/api/nodes/${nodeId}/uuids?view=other`,
  { headers: signedGet.headers },
);
assert(
  await verifyNodeRequest(
    queryTamper,
    { NODE_HMAC_SECRET: secret },
    "",
    now,
  ) === null,
  "query-string changes must invalidate v2 signatures",
);

const methodTamper = new Request("https://api.example/api/nodes/heartbeat", {
  method: "PUT",
  headers: signedRequest("/api/nodes/heartbeat", { body }).headers,
  body,
});
assert(
  await verifyNodeRequest(
    methodTamper,
    { NODE_HMAC_SECRET: secret },
    body,
    now,
  ) === null,
  "method changes must invalidate v2 signatures",
);

assert(
  await verifyNodeRequest(
    signedRequest("/api/nodes/heartbeat", { body }),
    { NODE_HMAC_SECRET: secret },
    body + " ",
    now,
  ) === null,
  "body changes must invalidate v2 signatures",
);

const invalidV2WithValidV1 = signedRequest("/api/nodes/heartbeat", {
  body,
  includeV1: true,
  v2Signature: "0".repeat(64),
});
assert(
  await verifyNodeRequest(
    invalidV2WithValidV1,
    {
      NODE_HMAC_SECRET: secret,
      HMAC_V1_ACCEPT_UNTIL: String(now + 60_000),
      HMAC_V1_NODE_IDS: nodeId,
    },
    body,
    now,
  ) === null,
  "an invalid v2 header must never downgrade to a valid v1 header",
);

const timestamp = String(now);
const legacyRequest = new Request("https://api.example/api/nodes/heartbeat", {
  method: "POST",
  headers: {
    "x-opus8-ts": timestamp,
    "x-opus8-node": nodeId,
    "x-opus8-sign": hmac(v1Message(timestamp, body)),
  },
  body,
});
const legacyDuringGrace = await verifyNodeRequest(
  legacyRequest,
  {
    NODE_HMAC_SECRET: secret,
    HMAC_V1_ACCEPT_UNTIL: String(now + 60_000),
    HMAC_V1_NODE_IDS: nodeId,
  },
  body,
  now,
);
assert(
  legacyDuringGrace?.timestamp === now && legacyDuringGrace.version === 1,
  "legacy signature must work only during the rollout grace window",
);
assert(
  await verifyNodeRequest(
    legacyRequest,
    {
      NODE_HMAC_SECRET: secret,
      HMAC_V1_ACCEPT_UNTIL: String(now + 60_000),
      HMAC_V1_NODE_IDS: "acc1-n2,acc2-n1",
    },
    body,
    now,
  ) === null,
  "legacy signatures must be restricted to declared existing nodes",
);

const legacyRegister = new Request("https://api.example/api/nodes/register", {
  method: "POST",
  headers: legacyRequest.headers,
  body,
});
assert(
  await verifyNodeRequest(
    legacyRegister,
    {
      NODE_HMAC_SECRET: secret,
      HMAC_V1_ACCEPT_UNTIL: String(now + 60_000),
      HMAC_V1_NODE_IDS: nodeId,
    },
    body,
    now,
  ) === null,
  "legacy signatures must never register a node",
);

const legacyQuery = new Request(
  "https://api.example/api/nodes/heartbeat?retry=1",
  {
    method: "POST",
    headers: legacyRequest.headers,
    body,
  },
);
assert(
  await verifyNodeRequest(
    legacyQuery,
    {
      NODE_HMAC_SECRET: secret,
      HMAC_V1_ACCEPT_UNTIL: String(now + 60_000),
      HMAC_V1_NODE_IDS: nodeId,
    },
    body,
    now,
  ) === null,
  "legacy signatures must reject query variants",
);

const legacyUuidRequest = new Request(
  `https://api.example/api/nodes/${nodeId}/uuids`,
  {
    headers: {
      "x-opus8-ts": timestamp,
      "x-opus8-node": nodeId,
      "x-opus8-sign": hmac(v1Message(timestamp, "")),
    },
  },
);
const legacyUuid = await verifyNodeRequest(
  legacyUuidRequest,
  {
    NODE_HMAC_SECRET: secret,
    HMAC_V1_ACCEPT_UNTIL: String(now + 60_000),
    HMAC_V1_NODE_IDS: nodeId,
  },
  "",
  now,
);
assert(
  legacyUuid?.nodeId === nodeId && legacyUuid.version === 1,
  "legacy UUID sync must remain available to declared existing nodes",
);
assert(
  await verifyNodeRequest(
    legacyRequest,
    {
      NODE_HMAC_SECRET: secret,
      HMAC_V1_ACCEPT_UNTIL: String(now - 1),
      HMAC_V1_NODE_IDS: nodeId,
    },
    body,
    now,
  ) === null,
  "legacy signature must fail after the rollout deadline",
);

const expiredTimestamp = String(now - 5 * 60_000 - 1);
assert(
  await verifyNodeRequest(
    signedRequest("/api/nodes/heartbeat", {
      body,
      timestamp: expiredTimestamp,
    }),
    { NODE_HMAC_SECRET: secret },
    body,
    now,
  ) === null,
  "expired v2 signatures must fail",
);

console.log("OK control HMAC v2 tests");
