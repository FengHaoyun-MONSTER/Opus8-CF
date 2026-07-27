import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const prelude = readFileSync(join(here, "opus8-prelude.js"), "utf8");
const tests = `
const request = {};
const unlocked = OPUS8_normalizeState({
  uuids: ["user-a"],
  unlockUuids: ["user-a"],
  unlockHosts: ["openai.com", "claude.ai"],
  socks5Enabled: true,
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
presentedUuids.OPUS8_authenticated = "user-b";
if (OPUS8_decideLanding(request, presentedUuids, "openai.com") !== false) {
  throw new Error("locked user must not use landing");
}
if (OPUS8_canUseLanding(request, presentedUuids) !== false) {
  throw new Error("locked user must not use landing as fallback");
}
const oldRequest = {};
OPUS8_setRequestPolicy(oldRequest, OPUS8_normalizeState({
  uuids: ["legacy-user"],
  unlockHosts: [],
  socks5Enabled: true,
}, "local-admin", true));
if (OPUS8_decideLanding(oldRequest, "legacy-user", "openai.com") !== null) {
  throw new Error("old control-plane response must preserve vendor fallback");
}
`;

runInNewContext(`${prelude}\n${tests}`, {
  console,
  crypto: globalThis.crypto,
  TextEncoder,
  WeakMap,
  Set,
});
console.log("OK edge policy tests");
