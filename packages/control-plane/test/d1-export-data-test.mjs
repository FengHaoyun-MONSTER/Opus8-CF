import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const script = join(repoRoot, "infra", "scripts", "d1-export-data.py");
const temporary = await mkdtemp(join(tmpdir(), "opus8-d1-export-test-"));
const input = join(temporary, "full.sql");
const output = join(temporary, "data.sql");
const sql = `-- full Wrangler-style export
PRAGMA foreign_keys=OFF;
CREATE TABLE "notes" ("id" TEXT PRIMARY KEY, "body" TEXT);
INSERT INTO "notes" VALUES('one','line one;
line two');
CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "plan_id" TEXT REFERENCES "plans"("id"));
INSERT INTO "users" VALUES('user-one','plan-one');
CREATE TABLE "user_devices" ("id" TEXT PRIMARY KEY, "user_id" TEXT REFERENCES "users"("id"));
INSERT INTO "user_devices" VALUES('device-one','user-one');
CREATE TABLE "plans" ("id" TEXT PRIMARY KEY);
INSERT INTO "plans" VALUES('plan-one');
/* schema separator */
CREATE INDEX "idx_notes" ON "notes" ("id");
INSERT INTO "notes" VALUES('two','quote '' and ; semicolon');
`;

try {
  await writeFile(input, sql);
  const python = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(python, [script, input, output], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const extracted = await readFile(output, "utf8");
  assert.match(extracted, /INSERT INTO "notes" VALUES\('one','line one;\nline two'\);/);
  assert.match(extracted, /INSERT INTO "notes" VALUES\('two','quote '' and ; semicolon'\);/);
  assert.doesNotMatch(extracted, /CREATE TABLE|CREATE INDEX|PRAGMA foreign_keys/);
  assert.doesNotMatch(extracted, /BEGIN TRANSACTION|COMMIT;/);
  assert.ok(
    extracted.indexOf('INSERT INTO "plans"') <
      extracted.indexOf('INSERT INTO "users"'),
    "parent table data must precede child table data",
  );
  assert.ok(
    extracted.indexOf('INSERT INTO "users"') <
      extracted.indexOf('INSERT INTO "user_devices"'),
    "user data must precede device credential data",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("OK D1 export data extraction tests");
