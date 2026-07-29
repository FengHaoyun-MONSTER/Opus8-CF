import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const script = join(repoRoot, "infra", "scripts", "d1-backup-crypto.mjs");
const temporary = await mkdtemp(join(tmpdir(), "opus8-d1-backup-test-"));
const plain = join(temporary, "database.sql");
const encrypted = join(temporary, "database.opus8bk");
const restored = join(temporary, "restored.sql");
const wrong = join(temporary, "wrong.sql");
const secret = "correct-backup-key-with-at-least-32-characters";
const sql = Buffer.from(
  "CREATE TABLE users(id TEXT PRIMARY KEY);\nINSERT INTO users VALUES('u1');\n",
);

function run(operation, input, output, key) {
  return spawnSync(process.execPath, [script, operation, input, output], {
    encoding: "utf8",
    env: { ...process.env, D1_BACKUP_ENCRYPTION_KEY: key },
  });
}

try {
  await writeFile(plain, sql);
  const encryptedResult = run("encrypt", plain, encrypted, secret);
  assert.equal(encryptedResult.status, 0, encryptedResult.stderr);
  const envelope = await readFile(encrypted);
  assert.notDeepEqual(envelope, sql);
  assert.equal(envelope.subarray(0, 8).toString("binary"), "OPUS8D1\x01");

  const restoredResult = run("decrypt", encrypted, restored, secret);
  assert.equal(restoredResult.status, 0, restoredResult.stderr);
  assert.deepEqual(await readFile(restored), sql);

  const wrongResult = run(
    "decrypt",
    encrypted,
    wrong,
    "wrong-backup-key-with-at-least-32-characters",
  );
  assert.notEqual(wrongResult.status, 0);
  await assert.rejects(readFile(wrong));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("OK authenticated D1 backup encryption tests");
