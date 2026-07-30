import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = resolve(here, "..");
const repoRoot = resolve(controlRoot, "..", "..");
const wranglerCli = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const persistRelative = `.wrangler/schema-migration-${process.pid}`;
const persistAbsolute = resolve(controlRoot, persistRelative);
if (!persistAbsolute.startsWith(controlRoot + "\\") && !persistAbsolute.startsWith(controlRoot + "/")) {
  throw new Error("unsafe migration-test persistence path");
}

function wrangler(args) {
  const result = spawnSync(process.execPath, [wranglerCli, ...args], {
    cwd: controlRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `wrangler ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function executeFile(path) {
  wrangler([
    "d1",
    "execute",
    "opus8cf-db",
    "--local",
    "--persist-to",
    persistRelative,
    "--file",
    path,
  ]);
}

function executeJson(command) {
  return JSON.parse(
    wrangler([
      "d1",
      "execute",
      "opus8cf-db",
      "--local",
      "--persist-to",
      persistRelative,
      "--command",
      command,
      "--json",
    ]),
  ).flatMap((item) => item.results || []);
}

try {
  executeFile("test/fixtures/nodes-pre-p685.sql");
  executeFile("schema.sql");
  const before = executeJson("PRAGMA table_info(nodes);");
  if (before.some((row) => row.name === "transport_path")) {
    throw new Error("CREATE TABLE IF NOT EXISTS must not hide the legacy migration case");
  }
  const migratedDevices = executeJson(
    "SELECT id,user_id,credential_mode,sub_token FROM user_devices WHERE user_id='legacy-user';",
  );
  if (
    migratedDevices.length !== 1
    || migratedDevices[0]?.id !== "legacy-legacy-user"
    || migratedDevices[0]?.credential_mode !== "static"
    || migratedDevices[0]?.sub_token !== "legacy-subscription-token-000001"
  ) {
    throw new Error("legacy users must be backfilled as static compatibility devices");
  }
  wrangler([
    "d1",
    "execute",
    "opus8cf-db",
    "--local",
    "--persist-to",
    persistRelative,
    "--command",
    "ALTER TABLE nodes ADD COLUMN transport_path TEXT NOT NULL DEFAULT '/';",
  ]);
  const after = executeJson(
    "SELECT transport_path FROM nodes WHERE id='legacy-node';",
  );
  if (after[0]?.transport_path !== "/") {
    throw new Error("legacy rows must receive the root compatibility default");
  }
  console.log("OK transport path and device credential D1 migration test");
} finally {
  rmSync(persistAbsolute, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
