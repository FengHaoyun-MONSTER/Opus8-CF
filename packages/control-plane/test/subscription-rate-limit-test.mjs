import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const bundled = await build({
  entryPoints: [join(controlRoot, "src", "subscription-rate-limit.ts")],
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
const {
  enforceSubscriptionRateLimit,
  SUBSCRIPTION_RATE_LIMITS,
  validSubscriptionToken,
} = await import(moduleUrl);

function assert(value, message) {
  if (!value) throw new Error(message);
}

function limiter(outcomes, keys) {
  return {
    async limit({ key }) {
      keys.push(key);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return { success: next ?? true };
    },
  };
}

const secret = "subscription-rate-limit-test-secret";
const token = "a".repeat(32);
assert(validSubscriptionToken(token), "32-character URL-safe token must pass");
assert(!validSubscriptionToken("a".repeat(31)), "short token must fail");
assert(!validSubscriptionToken(`${"a".repeat(31)}!`), "unsafe token must fail");

const sourceKeys = [];
const tokenKeys = [];
const request = new Request("https://sub.example/sub/" + token, {
  headers: { "cf-connecting-ip": "203.0.113.5" },
});
const allowed = await enforceSubscriptionRateLimit(
  request,
  {
    NODE_HMAC_SECRET: secret,
    SUB_RATE_LIMIT_REQUIRED: "1",
    SUB_SOURCE_RATE_LIMITER: limiter([true], sourceKeys),
    SUB_TOKEN_RATE_LIMITER: limiter([true], tokenKeys),
  },
  token,
);
assert(allowed.allowed, "both successful counters must allow the request");
assert(
  sourceKeys.length === 1 &&
    tokenKeys.length === 1 &&
    !sourceKeys[0].includes("203.0.113.5") &&
    !tokenKeys[0].includes(token) &&
    /^[a-f0-9]{64}$/.test(sourceKeys[0]) &&
    /^[a-f0-9]{64}$/.test(tokenKeys[0]),
  "counter keys must be deterministic HMAC digests without raw identifiers",
);

const repeatedSourceKeys = [];
await enforceSubscriptionRateLimit(
  request,
  {
    NODE_HMAC_SECRET: secret,
    SUB_SOURCE_RATE_LIMITER: limiter([true], repeatedSourceKeys),
    SUB_TOKEN_RATE_LIMITER: limiter([true], []),
  },
  token,
);
assert(
  repeatedSourceKeys[0] === sourceKeys[0],
  "the same source must map to the same private counter key",
);

const skippedTokenKeys = [];
const sourceBlocked = await enforceSubscriptionRateLimit(
  request,
  {
    NODE_HMAC_SECRET: secret,
    SUB_RATE_LIMIT_REQUIRED: "1",
    SUB_SOURCE_RATE_LIMITER: limiter([false], []),
    SUB_TOKEN_RATE_LIMITER: limiter([true], skippedTokenKeys),
  },
  token,
);
assert(
  !sourceBlocked.allowed &&
    sourceBlocked.status === 429 &&
    sourceBlocked.reason === "source" &&
    skippedTokenKeys.length === 0,
  "source ceiling must reject before consuming the token counter",
);

const tokenBlocked = await enforceSubscriptionRateLimit(
  request,
  {
    NODE_HMAC_SECRET: secret,
    SUB_RATE_LIMIT_REQUIRED: "1",
    SUB_SOURCE_RATE_LIMITER: limiter([true], []),
    SUB_TOKEN_RATE_LIMITER: limiter([false], []),
  },
  token,
);
assert(
  !tokenBlocked.allowed &&
    tokenBlocked.status === 429 &&
    tokenBlocked.reason === "token",
  "token counter exhaustion must return 429",
);

const requiredMissing = await enforceSubscriptionRateLimit(
  request,
  { NODE_HMAC_SECRET: secret, SUB_RATE_LIMIT_REQUIRED: "1" },
  token,
);
assert(
  !requiredMissing.allowed &&
    requiredMissing.status === 503 &&
    requiredMissing.reason === "unavailable",
  "production-required missing bindings must fail closed",
);

const optionalMissing = await enforceSubscriptionRateLimit(
  request,
  { NODE_HMAC_SECRET: secret },
  token,
);
assert(optionalMissing.allowed, "unconfigured local tests may bypass the binding");

const bindingFailure = await enforceSubscriptionRateLimit(
  request,
  {
    NODE_HMAC_SECRET: secret,
    SUB_RATE_LIMIT_REQUIRED: "1",
    SUB_SOURCE_RATE_LIMITER: limiter([new Error("unavailable")], []),
    SUB_TOKEN_RATE_LIMITER: limiter([true], []),
  },
  token,
);
assert(
  !bindingFailure.allowed && bindingFailure.status === 503,
  "production binding failures must fail closed without querying D1",
);

assert(
  SUBSCRIPTION_RATE_LIMITS.source.limit === 120 &&
    SUBSCRIPTION_RATE_LIMITS.source.period === 60 &&
    SUBSCRIPTION_RATE_LIMITS.token.limit === 20 &&
    SUBSCRIPTION_RATE_LIMITS.token.period === 60,
  "documented and deployed rate limits must remain stable",
);

console.log("OK subscription rate limit tests");
