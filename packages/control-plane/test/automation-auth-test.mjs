import crypto from "node:crypto";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const bundled = await build({
  entryPoints: [join(controlRoot, "src", "automation-auth.ts")],
  alias: {
    "@opus8-cf/shared": join(controlRoot, "..", "shared", "src", "index.ts"),
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const moduleUrl = "data:text/javascript;base64,"
  + Buffer.from(bundled.outputFiles[0].text).toString("base64");
const {
  AUTOMATION_SIGNATURE_WINDOW_MS,
  automationSignatureMessage,
  claimAutomationRequest,
  verifyAutomationRequest,
} = await import(moduleUrl);

function assert(value, message) {
  if (!value) throw new Error(message);
}

const secret = "automation-test-secret-with-at-least-32-bytes";
const identity = "github-node-deploy";
const requestId = "b3c06512-e7ca-49fd-a994-0cf0685e2b22";
const now = Date.now();
const target = "/api/node-enrollments?version=1";
const body = JSON.stringify({ nodeId: "acc1-n1" });

function signature({
  timestamp = String(now),
  method = "POST",
  path = target,
  rawBody = body,
  signingSecret = secret,
} = {}) {
  const hash = crypto.createHash("sha256").update(rawBody).digest("hex");
  return crypto.createHmac("sha256", signingSecret).update(
    automationSignatureMessage(
      timestamp,
      identity,
      requestId,
      method,
      path,
      hash,
    ),
  ).digest("hex");
}

function request({
  timestamp = String(now),
  method = "POST",
  path = target,
  rawBody = body,
  signed = signature(),
} = {}) {
  return new Request(`https://api.example${path}`, {
    method,
    headers: {
      "x-opus8-automation-id": identity,
      "x-opus8-automation-timestamp": timestamp,
      "x-opus8-automation-request-id": requestId,
      "x-opus8-automation-signature": signed,
    },
    body: method === "GET" ? undefined : rawBody,
  });
}

const valid = await verifyAutomationRequest(
  request(),
  { AUTOMATION_HMAC_SECRET: secret },
  body,
  now,
);
assert(valid?.identity === identity && valid.requestId === requestId, "valid automation request must authenticate");
assert(
  await verifyAutomationRequest(
    request({ path: "/api/users", signed: signature() }),
    { AUTOMATION_HMAC_SECRET: secret },
    body,
    now,
  ) === null,
  "path tampering must fail",
);
assert(
  await verifyAutomationRequest(
    request({ rawBody: `${body} `, signed: signature() }),
    { AUTOMATION_HMAC_SECRET: secret },
    `${body} `,
    now,
  ) === null,
  "body tampering must fail",
);
const expired = String(now - AUTOMATION_SIGNATURE_WINDOW_MS - 1);
assert(
  await verifyAutomationRequest(
    request({ timestamp: expired, signed: signature({ timestamp: expired }) }),
    { AUTOMATION_HMAC_SECRET: secret },
    body,
    now,
  ) === null,
  "expired signatures must fail",
);
assert(
  await verifyAutomationRequest(request(), {}, body, now) === null,
  "missing server secret must fail closed",
);
assert(
  await verifyAutomationRequest(
    request(),
    { AUTOMATION_HMAC_SECRET: secret, AUTOMATION_ALLOWED_IDS: "another-job" },
    body,
    now,
  ) === null,
  "unlisted signed identities must fail closed",
);

const usedNonces = new Set();
const nonceDb = {
  prepare() {
    return {
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async run() {
        const requestNonce = this.values[0];
        const changes = usedNonces.has(requestNonce) ? 0 : 1;
        usedNonces.add(requestNonce);
        return { meta: { changes } };
      },
    };
  },
};
assert(
  await claimAutomationRequest({ DB: nonceDb }, valid) === true,
  "the first signed mutation nonce must be claimed",
);
assert(
  await claimAutomationRequest({ DB: nonceDb }, valid) === false,
  "a replayed signed mutation nonce must be rejected",
);

console.log("OK least-privilege automation authentication tests");
