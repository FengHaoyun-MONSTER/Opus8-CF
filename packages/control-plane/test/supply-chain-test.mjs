import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function validateRelease(entry, repository, expectedAsset) {
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
  assert.equal(entry.releaseTag, `v${entry.version}`);
  assert.equal(entry.asset, expectedAsset);
  assert.equal(
    entry.url,
    `https://github.com/${repository}/releases/download/${entry.releaseTag}/${entry.asset}`,
  );
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
}

const cfst = JSON.parse(
  await readFile(join(repoRoot, "infra", "cfst-tool.json"), "utf8"),
);
assert.equal(cfst.schemaVersion, 1);
assert.equal(cfst.platform, "linux-amd64");
validateRelease(
  cfst,
  "XIU2/CloudflareSpeedTest",
  "cfst_linux_amd64.tar.gz",
);

const clients = JSON.parse(
  await readFile(
    join(repoRoot, "infra", "client-compatibility.json"),
    "utf8",
  ),
);
assert.equal(clients.schemaVersion, 1);
assert.equal(clients.platform, "linux-amd64");
validateRelease(clients.clients.xray, "XTLS/Xray-core", "Xray-linux-64.zip");
validateRelease(
  clients.clients.mihomo,
  "MetaCubeX/mihomo",
  `mihomo-linux-amd64-v${clients.clients.mihomo.version}.gz`,
);
validateRelease(
  clients.clients["sing-box"],
  "SagerNet/sing-box",
  `sing-box-${clients.clients["sing-box"].version}-linux-amd64.tar.gz`,
);

for (const relativePath of [
  ["infra", "scripts", "optimize-ip.sh"],
  ["infra", "scripts", "client-compatibility.sh"],
  ["infra", "scripts", "d1-backup.sh"],
]) {
  const source = await readFile(join(repoRoot, ...relativePath), "utf8");
  assert.doesNotMatch(
    source,
    /releases\/latest|latest\/download/,
    `${relativePath.join("/")} must not execute unpinned releases`,
  );
}

const backupWorkflow = await readFile(
  join(repoRoot, ".github", "workflows", "d1-backup.yml"),
  "utf8",
);
assert.match(
  backupWorkflow,
  /actions\/upload-artifact@[a-f0-9]{40}/,
  "backup artifact action must be pinned to a full commit SHA",
);
assert.doesNotMatch(
  backupWorkflow,
  /^\s*schedule:/m,
  "scheduled backups must remain disabled until an offline key and restore drill exist",
);
assert.match(
  backupWorkflow,
  /\$\{\{ env\.BACKUP_PATH \}\}/,
  "the encrypted backup path must be the uploaded artifact",
);
assert.doesNotMatch(
  backupWorkflow,
  /\.sql\s*$/m,
  "the workflow must never upload plaintext SQL",
);

const recoveryWorkflow = await readFile(
  join(repoRoot, ".github", "workflows", "d1-recovery-drill.yml"),
  "utf8",
);
assert.match(
  recoveryWorkflow,
  /actions\/download-artifact@[a-f0-9]{40}/,
  "recovery download action must be pinned to a full commit SHA",
);
assert.match(
  recoveryWorkflow,
  /\^opus8cf-recovery-/,
  "recovery workflow must restrict target database names",
);
assert.match(
  recoveryWorkflow,
  /\[ "\$RECOVERY_DATABASE" != "opus8cf-db" \]/,
  "recovery workflow must explicitly reject the production database",
);
assert.match(
  recoveryWorkflow,
  /OPUS8_RESTORE_CONFIRM="\$RESTORE_CONFIRMATION"/,
  "recovery workflow must pass the exact manual confirmation to the restore guard",
);
assert.doesNotMatch(
  recoveryWorkflow,
  /^\s*schedule:/m,
  "recovery drills must remain manual",
);

console.log("supply-chain pinning tests passed");
