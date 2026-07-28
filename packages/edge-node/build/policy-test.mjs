import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const prelude = readFileSync(join(here, "opus8-prelude.js"), "utf8");
const tests = `(async () => {
const request = {};
const unlocked = await OPUS8_normalizeState({
  uuids: ["user-a"],
  unlockUuids: ["user-a"],
  accessPolicies: [{
    userId: "account-a", uuid: "user-a", deviceLimit: 2,
    ipLimit24h: 5, trafficLimitBytes: 1073741824, usedBytes: 1024,
  }],
  unlockHosts: ["openai.com", "claude.ai"],
  socks5Enabled: true,
  landings: [
    {
      id: "primary", hostname: "primary.example", port: 1080,
      username: "user", password: "pass", matchHosts: ["openai.com"], priority: 10,
    },
    {
      id: "default", hostname: "default.example", port: 1080,
      username: "user", password: "pass", matchHosts: [], priority: 20,
    },
  ],
}, "local-admin", true);
OPUS8_setRequestPolicy(request, unlocked);
if (unlocked.accessPolicies["user-a"]?.deviceLimit !== 2) {
  throw new Error("access policy must be indexed by UUID");
}
const presentedUuids = ["local-admin", "user-a", "user-b"];
Object.defineProperty(presentedUuids, "OPUS8_authenticated", {
  value: "user-a", writable: true, configurable: true,
});
if (OPUS8_decideLanding(request, presentedUuids, "api.openai.com") !== true) {
  throw new Error("unlocked subdomain must use landing");
}
if (OPUS8_decideLanding(request, "user-a", "evilopenai.com") !== false) {
  throw new Error("domain suffix matching must respect label boundaries");
}
if (OPUS8_decideLanding(request, "user-a", "example.com") !== false) {
  throw new Error("unlisted domain must use direct egress");
}
if (OPUS8_canUseLanding(request, presentedUuids) !== true) {
  throw new Error("unlocked user must be allowed to use landing as direct fallback");
}
const openaiCandidates = OPUS8_landingCandidates(request, presentedUuids, "api.openai.com");
if (openaiCandidates.map((x) => x.id).join(",") !== "primary,default") {
  throw new Error("domain-specific and default landings must form an ordered failover pool");
}
const directFallback = OPUS8_landingCandidates(request, presentedUuids, "example.com");
if (directFallback.map((x) => x.id).join(",") !== "default") {
  throw new Error("unlisted domains may only use default landings as fallback");
}
if (!OPUS8_hasLandingCandidates(request, presentedUuids, "example.com")) {
  throw new Error("default landing must be available as direct failure fallback");
}
const attempts = [];
const connected = await OPUS8_connectViaLandings(
  request, presentedUuids, "api.openai.com", 443, null, null,
  async (_host, _port, _data, _tcp, landing) => {
    attempts.push(landing.id);
    if (landing.id === "primary") throw new Error("primary down");
    return "connected";
  },
  null,
);
if (connected !== "connected" || attempts.join(",") !== "primary,default") {
  throw new Error("landing failover order is incorrect");
}
presentedUuids.OPUS8_authenticated = "user-b";
if (OPUS8_decideLanding(request, presentedUuids, "openai.com") !== false) {
  throw new Error("locked user must not use landing");
}
if (OPUS8_canUseLanding(request, presentedUuids) !== false) {
  throw new Error("locked user must not use landing as fallback");
}
presentedUuids.OPUS8_authenticated = "user-a";
const streamRequest = {};
OPUS8_setRequestPolicy(streamRequest, unlocked);
const streamRuntime = OPUS8_bindUsageStream(
  streamRequest, { NODE_ID: "test" }, {}, presentedUuids, "xhttp",
);
streamRuntime.lastAdmission = Date.now();
const bridge = {
  readyState: 1,
  sent: [],
  send(value) { this.sent.push(value); },
  close() { this.readyState = 3; },
};
OPUS8_attachUsageBridge(streamRequest, bridge);
OPUS8_noteUplink(streamRequest, new Uint8Array(11));
OPUS8_noteDownlink(bridge, new Uint8Array(13));
if (
  streamRuntime.transport !== "xhttp" ||
  streamRuntime.bytesUp !== 11 ||
  streamRuntime.bytesDown !== 13
) {
  throw new Error("stream transport byte accounting is incorrect");
}
bridge.close();
if (!streamRuntime.closed || bridge.readyState !== 3) {
  throw new Error("stream transport must flush and close with its bridge");
}
const oldRequest = {};
OPUS8_setRequestPolicy(oldRequest, await OPUS8_normalizeState({
  uuids: ["legacy-user"],
  unlockHosts: [],
  socks5Enabled: true,
}, "local-admin", true));
if (OPUS8_decideLanding(oldRequest, "legacy-user", "openai.com") !== null) {
  throw new Error("old control-plane response must preserve vendor fallback");
}

const kvValues = new Map();
const kv = {
  async get(key) { return kvValues.get(key) ?? null; },
  async put(key, value) { kvValues.set(key, String(value)); },
  async delete(key) { kvValues.delete(key); },
};
const controlEnv = {
  KV: kv,
  NODE_ID: "test-node",
  NODE_HMAC_SECRET: "test-secret",
  CONTROL_PLANE_URL: "https://control.example",
};
await kv.put(OPUS8_policyCacheKey(controlEnv), "cached");
await kv.put("opus8:policy:v3", "legacy");
const invalidateBody = JSON.stringify({ version: 12 });
const invalidateTimestamp = String(Date.now());
const invalidateSignature = await OPUS8_hmac(
  controlEnv.NODE_HMAC_SECRET,
  invalidateTimestamp + "." + controlEnv.NODE_ID + "." + invalidateBody,
);
const invalidateResponse = await OPUS8_handleControlRequest(new Request(
  "https://node.example/__opus8/policy/invalidate",
  {
    method: "POST",
    headers: {
      "x-opus8-ts": invalidateTimestamp,
      "x-opus8-node": controlEnv.NODE_ID,
      "x-opus8-sign": invalidateSignature,
    },
    body: invalidateBody,
  },
), controlEnv);
if (
  invalidateResponse.status !== 200 ||
  await kv.get(OPUS8_policyInvalidationKey(controlEnv)) !== "12" ||
  await kv.get(OPUS8_policyCacheKey(controlEnv)) !== null ||
  await kv.get("opus8:policy:v3") !== null
) {
  throw new Error("signed policy invalidation must advance the marker and clear caches");
}
const replayBody = JSON.stringify({ version: 10 });
const replayTimestamp = String(Date.now());
const replaySignature = await OPUS8_hmac(
  controlEnv.NODE_HMAC_SECRET,
  replayTimestamp + "." + controlEnv.NODE_ID + "." + replayBody,
);
const replayResponse = await OPUS8_handleControlRequest(new Request(
  "https://node.example/__opus8/policy/invalidate",
  {
    method: "POST",
    headers: {
      "x-opus8-ts": replayTimestamp,
      "x-opus8-node": controlEnv.NODE_ID,
      "x-opus8-sign": replaySignature,
    },
    body: replayBody,
  },
), controlEnv);
if (
  replayResponse.status !== 200 ||
  await kv.get(OPUS8_policyInvalidationKey(controlEnv)) !== "12"
) {
  throw new Error("an older signed invalidation must not lower the policy marker");
}
})();`;

await runInNewContext(`${prelude}\n${tests}`, {
  console,
  crypto: globalThis.crypto,
  Request,
  Response,
  URL,
  TextEncoder,
  TextDecoder,
  WeakMap,
  Set,
  Uint8Array,
  atob,
});
console.log("OK edge policy tests");
