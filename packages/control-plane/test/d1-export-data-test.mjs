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
/* schema separator */
CREATE INDEX "idx_notes" ON "notes" ("id");
INSERT INTO "notes" VALUES('two','quote '' and ; semicolon');
COMMIT;
`;

try {
  await writeFile(input, sql);
  const python = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(python, [script, input, output], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const extracted = await readFile(output, "utf8");
  assert.match(extracted, /^BEGIN TRANSACTION;$/m);
  assert.match(extracted, /INSERT INTO "notes" VALUES\('one','line one;\nline two'\);/);
  assert.match(extracted, /INSERT INTO "notes" VALUES\('two','quote '' and ; semicolon'\);/);
  assert.doesNotMatch(extracted, /CREATE TABLE|CREATE INDEX|PRAGMA foreign_keys/);
  assert.match(extracted, /^COMMIT;$/m);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("OK D1 export data extraction tests");
