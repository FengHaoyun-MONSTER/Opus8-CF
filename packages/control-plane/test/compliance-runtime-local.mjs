import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const repoRoot = join(controlRoot, "..", "..");
const wranglerCli = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const persistRelative = `.wrangler/compliance-${process.pid}`;
const persistAbsolute = join(controlRoot, persistRelative);
const nodeSecret = "compliance-runtime-node-secret";

function assert(value, message) {
  if (!value) throw new Error(message);
}

function wrangler(args) {
  const result = spawnSync(process.execPath, [wranglerCli, ...args], {
    cwd: controlRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `wrangler command failed:\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
}

function seedDatabase() {
  wrangler([
    "d1",
    "execute",
    "opus8cf-db",
    "--local",
    "--persist-to",
    persistRelative,
    "--file",
    "schema.sql",
  ]);
  const now = Date.now();
  const sql = `
    INSERT INTO nodes
      (id,account_alias,hostname,region,capabilities,preferred_ip,transport_path,health,enabled,last_seen,created_at)
    VALUES
      ('acc1-n1','acc1','acc1-n1.example.com','test','["vless","ws"]',NULL,'/','healthy',1,${now},${now});
    INSERT INTO users
      (id,username,uuid,plan_id,node_group,unlock,sub_token,expire_at,enabled,created_at)
    VALUES
      ('disabled-user','disabled','11111111-1111-4111-8111-111111111111',NULL,NULL,0,'disabled-token',NULL,0,${now}),
      ('enabled-user','enabled','22222222-2222-4222-8222-222222222222',NULL,NULL,0,'enabled-token',NULL,1,${now});
    INSERT INTO user_limits
      (user_id,device_limit,ip_limit_24h,traffic_limit_bytes,updated_at)
    VALUES
      ('disabled-user',1,2,1000,${now}),
      ('enabled-user',1,2,1000,${now});
  `;
  wrangler([
    "d1",
    "execute",
    "opus8cf-db",
    "--local",
    "--persist-to",
    persistRelative,
    "--command",
    sql,
  ]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) =>
        error
          ? reject(error)
          : resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
}

async function waitUntilReady(base, worker, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (worker.exitCode !== null) {
      throw new Error(`local worker exited early:\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // Wrangler has not bound its local port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`local worker did not become ready:\n${logs.join("")}`);
}

function signedRegister(base, nodeId, overrides = {}) {
  const body = JSON.stringify({
    nodeId,
    accountAlias: "acc1",
    hostname: `${nodeId}.example.com`,
    region: "test",
    capabilities: ["vless", "ws"],
    transportPath: "/ws/compliance-runtime",
    ...overrides,
  });
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac("sha256", nodeSecret)
    .update(
      [
        "opus8-hmac-v2",
        timestamp,
        nodeId,
        "POST",
        "/api/nodes/register",
        body,
      ].join("\n"),
    )
    .digest("hex");
  return fetch(`${base}/api/nodes/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opus8-ts": timestamp,
      "x-opus8-node": nodeId,
      "x-opus8-sign-v2": signature,
    },
    body,
  });
}

seedDatabase();
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const logs = [];
const worker = spawn(
  process.execPath,
  [
    wranglerCli,
    "dev",
    "--local",
    "--port",
    String(port),
    "--persist-to",
    persistRelative,
    "--var",
    "ADMIN_PASSWORD:test-admin",
    "--var",
    "JWT_SECRET:test-jwt-secret",
    "--var",
    `NODE_HMAC_SECRET:${nodeSecret}`,
    "--var",
    "LANDING_CONFIG_KEY:test-landing-config-key-32-bytes",
    "--var",
    "ADMIN_UI_ORIGINS:https://opus8cf-admin-openal.pages.dev",
    "--var",
    "COMPLIANCE_PROXY_ALLOWED:0",
    "--var",
    "COMPLIANCE_ENFORCEMENT_MODE:enforce",
    "--var",
    "COMPLIANCE_POLICY_ID:cloudflare-data-plane-v1",
    "--var",
    "COMPLIANCE_MAINTENANCE_NODE_IDS:acc1-n1",
  ],
  {
    cwd: controlRoot,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
worker.stdout.on("data", (chunk) => logs.push(String(chunk)));
worker.stderr.on("data", (chunk) => logs.push(String(chunk)));

try {
  await waitUntilReady(base, worker, logs);
  const loginResponse = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-admin" }),
  });
  const login = await loginResponse.json();
  assert(loginResponse.ok && login.token, "admin login failed");
  const headers = {
    authorization: `Bearer ${login.token}`,
    "content-type": "application/json",
  };

  const statusResponse = await fetch(`${base}/api/operations/compliance`, {
    headers,
  });
  const status = await statusResponse.json();
  assert(
    statusResponse.ok &&
      status.proxyProvisioningAllowed === false &&
      status.enforcement === "fail-closed",
    `unexpected compliance status: ${JSON.stringify(status)}`,
  );

  const anonymousCreate = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "anonymous" }),
  });
  assert(anonymousCreate.status === 401, "authorization must precede compliance");

  const create = await fetch(`${base}/api/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "blocked" }),
  });
  assert(create.status === 403, "new user provisioning must be blocked");

  const enable = await fetch(`${base}/api/users/disabled-user`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ enabled: true }),
  });
  assert(enable.status === 403, "re-enabling a user must be blocked");

  const increase = await fetch(`${base}/api/users/enabled-user`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ deviceLimit: 2, ipLimit24h: 3 }),
  });
  assert(increase.status === 403, "active capacity increase must be blocked");

  const decrease = await fetch(`${base}/api/users/enabled-user`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ ipLimit24h: 1 }),
  });
  assert(decrease.ok, "capacity reduction must remain available");

  const registerNew = await signedRegister(base, "acc1-n2");
  assert(registerNew.status === 403, "new node registration must be blocked");

  const maintainExisting = await signedRegister(base, "acc1-n1");
  assert(
    maintainExisting.ok,
    "exact in-place registration of an existing node must remain available",
  );
  const maintained = await maintainExisting.json();
  assert(
    maintained.transportPath === "/ws/compliance-runtime",
    "maintenance registration must update the transport path",
  );

  const changeAccount = await signedRegister(base, "acc1-n1", {
    accountAlias: "acc2",
  });
  assert(
    changeAccount.status === 403,
    "maintenance registration must not move an existing node to another account",
  );

  const changeHostname = await signedRegister(base, "acc1-n1", {
    hostname: "replacement.example.com",
  });
  assert(
    changeHostname.status === 403,
    "maintenance registration must not change an existing node hostname",
  );

  const optimized = await fetch(`${base}/api/optimized-ips`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert(optimized.status === 403, "optimized IP publication must be blocked");

  const landing = await fetch(`${base}/api/landings`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "blocked",
      hostname: "127.0.0.1",
      port: 1080,
      username: "user",
      password: "password",
    }),
  });
  assert(landing.status === 403, "new landing provisioning must be blocked");

  const unlockExpansion = await fetch(
    `${base}/api/settings/unlock-hosts`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ hosts: ["example.com"] }),
    },
  );
  assert(
    unlockExpansion.status === 403,
    "landing route expansion must be blocked",
  );

  console.log("compliance fail-closed runtime tests passed");
} finally {
  if (worker.exitCode === null) {
    worker.kill();
    await Promise.race([
      new Promise((resolve) => worker.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    rmSync(persistAbsolute, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  } catch (error) {
    console.warn(`WARN local compliance cleanup deferred: ${error.message}`);
  }
}
