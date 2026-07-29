import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "src", "cors.ts");
const bundled = await build({
  entryPoints: [source],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const moduleUrl =
  "data:text/javascript;base64," +
  Buffer.from(bundled.outputFiles[0].text).toString("base64");
const {
  controlCorsPolicy,
  isAdminApiPath,
  validateAdminPreflight,
} = await import(moduleUrl);

function assert(value, message) {
  if (!value) throw new Error(message);
}

const env = {
  ADMIN_UI_ORIGINS:
    "https://opus8cf-admin-openal.pages.dev, http://localhost:5173/",
};
const allowedOrigin = "https://opus8cf-admin-openal.pages.dev";

for (const path of [
  "/api/admin/login",
  "/api/users/user-1/activity",
  "/api/operations/overview",
  "/api/operations/key-rotation",
  "/api/operations/key-rotation/landings",
  "/api/settings/unlock-hosts",
  "/api/landings/landing-1/test",
  "/api/optimized-ips",
  "/api/nodes",
]) {
  assert(isAdminApiPath(path), `admin API path was not classified: ${path}`);
}
for (const path of [
  "/",
  "/health",
  "/sub/token",
  "/api/nodes/register",
  "/api/nodes/heartbeat",
  "/api/nodes/admission",
  "/api/nodes/usage",
  "/api/nodes/node-1/uuids",
]) {
  assert(!isAdminApiPath(path), `non-admin path was classified as admin: ${path}`);
}

const allowed = controlCorsPolicy(
  new Request("https://api.example/api/users", {
    headers: { Origin: allowedOrigin },
  }),
  env,
  "/api/users",
);
assert(allowed.allowed, "configured production origin must be allowed");
assert(
  allowed.responseHeaders["access-control-allow-origin"] === allowedOrigin,
  "allowed origin must be reflected exactly",
);
assert(
  allowed.responseHeaders.vary === "Origin" &&
    !("access-control-allow-credentials" in allowed.responseHeaders),
  "CORS response must vary by Origin and must not enable cookie credentials",
);

const denied = controlCorsPolicy(
  new Request("https://api.example/api/users", {
    headers: { Origin: "https://evil.example" },
  }),
  env,
  "/api/users",
);
assert(!denied.allowed, "unconfigured origin must be denied");
assert(
  Object.keys(denied.responseHeaders).length === 0,
  "denied origin must not receive CORS response headers",
);

const nodePolicy = controlCorsPolicy(
  new Request("https://api.example/api/nodes/register", {
    headers: { Origin: allowedOrigin },
  }),
  env,
  "/api/nodes/register",
);
assert(
  !nodePolicy.adminApi &&
    !nodePolicy.allowed &&
    Object.keys(nodePolicy.responseHeaders).length === 0,
  "node HMAC API must never receive browser CORS permission",
);

const preflightRequest = new Request("https://api.example/api/users", {
  method: "OPTIONS",
  headers: {
    Origin: allowedOrigin,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "Authorization, Content-Type",
  },
});
assert(
  validateAdminPreflight(
    preflightRequest,
    controlCorsPolicy(preflightRequest, env, "/api/users"),
  ) === null,
  "valid admin preflight must pass",
);

const badHeaderRequest = new Request("https://api.example/api/users", {
  method: "OPTIONS",
  headers: {
    Origin: allowedOrigin,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "X-Unsafe-Header",
  },
});
assert(
  validateAdminPreflight(
    badHeaderRequest,
    controlCorsPolicy(badHeaderRequest, env, "/api/users"),
  ) === "headers_denied",
  "unexpected preflight headers must be denied",
);

const previewPolicy = controlCorsPolicy(
  new Request("https://api.example/api/users", {
    headers: {
      Origin: "https://preview.opus8cf-admin-openal.pages.dev",
    },
  }),
  env,
  "/api/users",
);
assert(
  !previewPolicy.allowed,
  "preview subdomains must not be implicitly trusted by the production origin",
);

console.log("OK control CORS tests");
