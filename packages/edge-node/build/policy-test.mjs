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
const oldRequest = {};
OPUS8_setRequestPolicy(oldRequest, await OPUS8_normalizeState({
  uuids: ["legacy-user"],
  unlockHosts: [],
  socks5Enabled: true,
}, "local-admin", true));
if (OPUS8_decideLanding(oldRequest, "legacy-user", "openai.com") !== null) {
  throw new Error("old control-plane response must preserve vendor fallback");
}
})();`;

await runInNewContext(`${prelude}\n${tests}`, {
  console,
  crypto: globalThis.crypto,
  TextEncoder,
  TextDecoder,
  WeakMap,
  Set,
  Uint8Array,
  atob,
});
console.log("OK edge policy tests");
