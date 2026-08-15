import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const bundled = await build({
  entryPoints: [join(controlRoot, "src", "data-maintenance.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const moduleUrl = "data:text/javascript;base64,"
  + Buffer.from(bundled.outputFiles[0].text).toString("base64");
const { runDataMaintenance } = await import(moduleUrl);

function assert(value, message) {
  if (!value) throw new Error(message);
}

const prepared = [];
const batchStatements = [];
const db = {
  prepare(sql) {
    const statement = {
      sql,
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
    };
    prepared.push(statement);
    return statement;
  },
  async batch(statements) {
    batchStatements.push(...statements);
    return statements.map(() => ({ success: true, meta: { changes: 2 } }));
  },
};
const now = 2_000_000_000_000;
const result = await runDataMaintenance({ DB: db }, now);
assert(result.deletedRows === 18 && result.statements === 9, "maintenance must report bounded deletion work");
assert(batchStatements.some((item) => item.sql.includes("admin_audit_log")), "audit retention must be enforced");
assert(batchStatements.some((item) => item.sql.includes("ip_history")), "IP fingerprint retention must be enforced");
assert(!batchStatements.some((item) => /DELETE FROM usage(?:\s|$)/.test(item.sql)), "lifetime aggregate usage must not be deleted");
const stateWrite = prepared.find((item) => item.sql.includes("data_maintenance_last_success"));
assert(stateWrite?.values[0] === 18 && stateWrite.values[1] === now, "successful maintenance must publish freshness state");

console.log("OK scheduled data retention tests");
