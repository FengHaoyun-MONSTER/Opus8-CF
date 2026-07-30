import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const repoRoot = join(controlRoot, "..", "..");
const wranglerCli = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const persistRelative = `.wrangler/integration-${process.pid}`;
const persistAbsolute = join(controlRoot, persistRelative);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function applySchema() {
  const result = spawnSync(
    process.execPath,
    [
      wranglerCli,
      "d1",
      "execute",
      "opus8cf-db",
      "--local",
      "--persist-to",
      persistRelative,
      "--file",
      "schema.sql",
    ],
    { cwd: controlRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `local D1 schema failed:\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
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

async function stopWorker(worker) {
  if (worker.exitCode !== null) return;
  worker.kill();
  await Promise.race([
    new Promise((resolve) => worker.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

applySchema();
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
    "NODE_HMAC_SECRET:test-node-hmac-secret-32-bytes!!",
    "--var",
    "LANDING_CONFIG_KEY:test-landing-config-key-32-bytes",
    "--var",
    "ADMIN_UI_ORIGINS:https://opus8cf-admin-openal.pages.dev",
    "--var",
    "COMPLIANCE_PROXY_ALLOWED:1",
    "--var",
    "COMPLIANCE_ENFORCEMENT_MODE:enforce",
    "--var",
    "COMPLIANCE_POLICY_ID:cloudflare-data-plane-v1",
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
  process.env.OPUS8_TEST_BASE = base;
  process.env.OPUS8_TEST_ADMIN = "test-admin";
  process.env.OPUS8_TEST_NODE_SECRET = "test-node-hmac-secret-32-bytes!!";
  process.env.OPUS8_TEST_RATE_LIMIT = "1";
  await import(`./integration.mjs?local=${Date.now()}`);
} finally {
  await stopWorker(worker);
  // workerd may release its SQLite handles a fraction after Wrangler exits on Windows.
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    rmSync(persistAbsolute, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  } catch (error) {
    console.warn(`WARN local integration state cleanup deferred: ${error.message}`);
  }
}
