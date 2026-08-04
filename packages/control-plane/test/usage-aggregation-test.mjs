import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const bundled = await build({
  entryPoints: [join(controlRoot, "src", "usage.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const moduleUrl = "data:text/javascript;base64,"
  + Buffer.from(bundled.outputFiles[0].text).toString("base64");
const { recordUsage } = await import(moduleUrl);

class Statement {
  constructor(sql) {
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }
}

const batches = [];
const env = {
  DB: {
    prepare(sql) {
      return new Statement(sql);
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ meta: { changes: 1 }, results: [] }));
    },
  },
};

const bucket = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const event = (id, bytesUp, bytesDown) => ({
  id,
  userId: "user-1",
  uuid: "4ca6da3f-0876-4af3-a03b-b286cdd03db6",
  connections: 1,
  bytesUp,
  bytesDown,
  tsBucket: bucket,
});

const result = await recordUsage(env, "node-1", [
  event("node-1:lease-1:0", 100, 200),
  event("node-1:lease-2:0", 300, 400),
]);
const statements = batches[0] ?? [];
if (result.accepted !== 2) {
  throw new Error(`all new idempotency events must be accepted: ${JSON.stringify(result)}`);
}
if (statements.length !== 5) {
  throw new Error(`two events must use two inserts plus three aggregate/cleanup statements, got ${statements.length}`);
}
const aggregateStatements = statements.filter((statement) =>
  /INSERT INTO usage\s*\(/i.test(statement.sql)
);
if (
  aggregateStatements.length !== 1
  || !/SUM\(connections\)/i.test(aggregateStatements[0].sql)
  || !/GROUP BY user_id,node_id,ts_bucket/i.test(aggregateStatements[0].sql)
) {
  throw new Error("one grouped usage upsert must aggregate all accepted events in the request");
}
const appliedStatements = statements.filter((statement) =>
  /UPDATE usage_events SET applied=1/i.test(statement.sql)
);
if (appliedStatements.length !== 1 || appliedStatements[0].values.length !== 2) {
  throw new Error("one applied update must cover every idempotency event in the request");
}

console.log("OK usage aggregation tests");
