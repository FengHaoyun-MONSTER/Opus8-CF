import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const bundled = await build({
  entryPoints: [join(controlRoot, "src", "admin-login-rate-limit.ts")],
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
const { enforceAdminLoginRateLimit } = await import(moduleUrl);

function assert(value, message) {
  if (!value) throw new Error(message);
}

const keys = [];
const request = new Request("https://api.example/api/admin/login", {
  headers: { "cf-connecting-ip": "203.0.113.10" },
});
const allowed = await enforceAdminLoginRateLimit(request, {
  JWT_SECRET: "test-jwt-secret-at-least-32-bytes",
  ADMIN_LOGIN_RATE_LIMIT_REQUIRED: "1",
  ADMIN_LOGIN_RATE_LIMITER: {
    async limit({ key }) {
      keys.push(key);
      return { success: true };
    },
  },
});
assert(allowed.allowed === true, "available login limiter must admit in-budget requests");
assert(/^[a-f0-9]{64}$/.test(keys[0]) && !keys[0].includes("203.0.113.10"), "login source keys must be anonymized");
const limited = await enforceAdminLoginRateLimit(request, {
  JWT_SECRET: "test-jwt-secret-at-least-32-bytes",
  ADMIN_LOGIN_RATE_LIMIT_REQUIRED: "1",
  ADMIN_LOGIN_RATE_LIMITER: { async limit() { return { success: false }; } },
});
assert(limited.allowed === false && limited.status === 429, "over-budget logins must be rejected");
const unavailable = await enforceAdminLoginRateLimit(request, {
  JWT_SECRET: "test-jwt-secret-at-least-32-bytes",
  ADMIN_LOGIN_RATE_LIMIT_REQUIRED: "1",
});
assert(unavailable.allowed === false && unavailable.status === 503, "missing required bindings must fail closed");

console.log("OK admin login rate limit tests");
