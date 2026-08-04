import crypto from "node:crypto";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const bundled = await build({
  entryPoints: [join(controlRoot, "src", "integration-auth.ts")],
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
  INTEGRATION_SIGNATURE_WINDOW_MS,
  integrationSignatureMessage,
  verifyIntegrationRequest,
} = await import(moduleUrl);

function assert(value, message) {
  if (!value) throw new Error(message);
}

const keyId = "freedompost-primary";
const secret = "integration-test-secret-with-at-least-32-bytes";
const path = "/api/integrations/freedompost/benefits/webmaster/claim?version=1";
const body = JSON.stringify({
  externalClaimId: "ef545e54-c513-4817-baa2-2590f9f60659",
  campaignId: "webmaster-benefit-v1",
});
const now = Date.now();

function sign({
  timestamp = String(now),
  requestId = "request-ef545e54-c513-4817-baa2-2590f9f60659",
  method = "POST",
  target = path,
  rawBody = body,
  signingSecret = secret,
} = {}) {
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const message = integrationSignatureMessage(
    timestamp,
    requestId,
    method,
    target,
    bodyHash,
  );
  return crypto.createHmac("sha256", signingSecret).update(message).digest("hex");
}

function request({
  timestamp = String(now),
  requestId = "request-ef545e54-c513-4817-baa2-2590f9f60659",
  method = "POST",
  target = path,
  rawBody = body,
  requestKeyId = keyId,
  signature = null,
} = {}) {
  const headers = {
    "content-type": "application/json",
    "x-opus8-integration-key-id": requestKeyId,
    "x-opus8-integration-timestamp": timestamp,
    "x-opus8-integration-request-id": requestId,
    "x-opus8-integration-signature": signature ?? sign({
      timestamp,
      requestId,
      method,
      target,
      rawBody,
    }),
  };
  return new Request(`https://api.example${target}`, {
    method,
    headers,
    body: method === "GET" ? undefined : rawBody,
  });
}

const config = { keyId, secret };
const valid = await verifyIntegrationRequest(request(), config, body, now);
assert(
  valid?.keyId === keyId
    && valid.requestId === "request-ef545e54-c513-4817-baa2-2590f9f60659"
    && valid.timestamp === now,
  "valid FreedomPost integration signature must authenticate",
);

assert(
  await verifyIntegrationRequest(
    request({ target: `${path}&tampered=1`, signature: sign() }),
    config,
    body,
    now,
  ) === null,
  "query-string tampering must invalidate the signature",
);
assert(
  await verifyIntegrationRequest(
    request({ method: "PUT", signature: sign() }),
    config,
    body,
    now,
  ) === null,
  "method tampering must invalidate the signature",
);
assert(
  await verifyIntegrationRequest(request(), config, `${body} `, now) === null,
  "body tampering must invalidate the signature",
);
assert(
  await verifyIntegrationRequest(
    request({ requestKeyId: "unknown-integration" }),
    config,
    body,
    now,
  ) === null,
  "unknown integration key ids must be rejected",
);
assert(
  await verifyIntegrationRequest(
    request({ signature: "0".repeat(64) }),
    config,
    body,
    now,
  ) === null,
  "invalid signatures must be rejected",
);

const expired = String(now - INTEGRATION_SIGNATURE_WINDOW_MS - 1);
assert(
  await verifyIntegrationRequest(
    request({ timestamp: expired }),
    config,
    body,
    now,
  ) === null,
  "expired signatures must be rejected",
);
const future = String(now + INTEGRATION_SIGNATURE_WINDOW_MS + 1);
assert(
  await verifyIntegrationRequest(
    request({ timestamp: future }),
    config,
    body,
    now,
  ) === null,
  "signatures outside the future clock-skew window must be rejected",
);
assert(
  await verifyIntegrationRequest(
    request({ timestamp: "not-a-timestamp", signature: "0".repeat(64) }),
    config,
    body,
    now,
  ) === null,
  "malformed timestamps must be rejected",
);
assert(
  await verifyIntegrationRequest(
    request({ requestId: "short", signature: "0".repeat(64) }),
    config,
    body,
    now,
  ) === null,
  "malformed request ids must be rejected",
);
assert(
  await verifyIntegrationRequest(request(), { keyId, secret: "" }, body, now)
    === null,
  "missing server-side integration secrets must fail closed",
);

console.log("OK FreedomPost integration authentication tests");
