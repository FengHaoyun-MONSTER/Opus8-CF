import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateBackupFreshness } from "../../../infra/scripts/backup-freshness.mjs";
import { evaluateStrictPromotion } from "../../../infra/scripts/strict-promotion-gate.mjs";

const now = Date.UTC(2026, 7, 15, 12);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fresh = evaluateBackupFreshness([
  { id: 4, conclusion: "success", updated_at: new Date(now - 2 * 3_600_000).toISOString(), html_url: "https://example.test/run/4" },
], now, 26);
assert.equal(fresh.healthy, true);
assert.equal(evaluateBackupFreshness([], now, 26).healthy, false);
assert.equal(evaluateBackupFreshness([
  { id: 3, conclusion: "success", updated_at: new Date(now - 27 * 3_600_000).toISOString() },
], now, 26).healthy, false);

const healthyNode = {
  id: "acc1-n1",
  enabled: 1,
  auth_mode: "isolated",
  credential_fallback_pending: 0,
  credential_activated_at: now - 73 * 3_600_000,
  health: "healthy",
  last_seen: now - 60_000,
  transport_path: "/ws/node-specific",
};
assert.equal(evaluateStrictPromotion([healthyNode], now).allowed, true);
assert.equal(evaluateStrictPromotion([{ ...healthyNode, credential_fallback_pending: 1 }], now).allowed, false);
assert.equal(evaluateStrictPromotion([{ ...healthyNode, credential_activated_at: now - 2 * 3_600_000 }], now).allowed, false);
assert.equal(evaluateStrictPromotion([{ ...healthyNode, transport_path: "/" }], now).allowed, false);
assert.equal(evaluateStrictPromotion([{ ...healthyNode, last_seen: now + 10 * 60_000 }], now).allowed, false);

const strictCliNode = {
  ...healthyNode,
  credential_activated_at: Date.now() - 73 * 3_600_000,
  last_seen: Date.now() - 60_000,
};
const strictCli = spawnSync(
  process.execPath,
  [resolve(repoRoot, "infra/scripts/strict-promotion-gate.mjs")],
  { input: JSON.stringify({ nodes: [strictCliNode] }), encoding: "utf8" },
);
assert.equal(strictCli.status, 0);
assert.match(strictCli.stdout, /OK strict-promotion-gate nodes=1/);

const freshnessCli = spawnSync(
  process.execPath,
  [resolve(repoRoot, "infra/scripts/backup-freshness.mjs")],
  {
    encoding: "utf8",
    env: { ...process.env, GITHUB_REPOSITORY: "", GH_TOKEN: "" },
  },
);
assert.notEqual(freshnessCli.status, 0);
assert.match(freshnessCli.stderr, /ERROR backup-freshness GITHUB_REPOSITORY is required/);

const scratch = mkdtempSync(join(tmpdir(), "opus8-d1-diagnostic-"));
try {
  if (process.platform === "win32") {
    // Windows resolves `bash` to WSL, which cannot execute Win32 paths. The
    // failure-path process test runs on the Linux quality gate instead.
  } else {
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  const fake = join(bin, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  writeFileSync(
    fake,
    process.platform === "win32"
      ? "@echo off\necho Invalid access token code 9109 1>&2\nexit /b 17\n"
      : "#!/usr/bin/env bash\necho 'Invalid access token code 9109' >&2\nexit 17\n",
    { mode: 0o755 },
  );
  const output = join(scratch, "test.opus8bk");
  const run = spawnSync("bash", [resolve(repoRoot, "infra/scripts/d1-backup.sh"), "backup", output], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
      CLOUDFLARE_API_TOKEN: "test-token-never-logged",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      D1_BACKUP_ENCRYPTION_KEY: "test-backup-key-at-least-32-characters",
      D1_LIST_ATTEMPTS: "1",
    },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /ERROR Cloudflare D1 discovery failed/);
  assert.match(run.stderr, /Invalid access token code 9109/);
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /test-token-never-logged/);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const backupScript = readFileSync(resolve(repoRoot, "infra/scripts/d1-backup.sh"), "utf8");
assert.doesNotMatch(backupScript, /wrangler d1 list --json 2>\/dev\/null/);
console.log("OK operations-hardening-test");
