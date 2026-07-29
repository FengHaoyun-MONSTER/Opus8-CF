import assert from "node:assert/strict";
import crypto from "node:crypto";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const bundled = await build({
  stdin: {
    contents: `
      export { jwtSign } from "../../shared/src/crypto.ts";
      export { verifyJwtWithRotation } from "../src/key-rotation.ts";
      export { sealJson, openJsonWithRotation } from "../src/secret-box.ts";
      export {
        landingCredentialRotationStatus,
        migrateLandingCredentialsToCurrentKey
      } from "../src/landing-key-rotation.ts";
      export { invalidateEdgePolicyCaches } from "../src/policy-cache.ts";
    `,
    resolveDir: here,
    sourcefile: "key-rotation-test-entry.ts",
  },
  alias: {
    "@opus8-cf/shared": join(controlRoot, "..", "shared", "src", "index.ts"),
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const moduleUrl =
  "data:text/javascript;base64," +
  Buffer.from(bundled.outputFiles[0].text).toString("base64");
const {
  jwtSign,
  verifyJwtWithRotation,
  sealJson,
  openJsonWithRotation,
  landingCredentialRotationStatus,
  migrateLandingCredentialsToCurrentKey,
  invalidateEdgePolicyCaches,
} = await import(moduleUrl);

const currentJwt = "current-jwt-secret";
const previousJwt = "previous-jwt-secret";
const oldToken = await jwtSign({ role: "admin" }, previousJwt);
assert.equal(
  (await verifyJwtWithRotation(oldToken, {
    JWT_SECRET: currentJwt,
    JWT_SECRET_PREVIOUS: previousJwt,
  }))?.role,
  "admin",
);
assert.equal(
  await verifyJwtWithRotation(oldToken, { JWT_SECRET: currentJwt }),
  null,
);
const newToken = await jwtSign({ role: "admin" }, currentJwt);
assert.equal(
  (await verifyJwtWithRotation(newToken, {
    JWT_SECRET: currentJwt,
    JWT_SECRET_PREVIOUS: previousJwt,
  }))?.role,
  "admin",
);

const currentLandingKey = "current-landing-key-with-at-least-32-characters";
const previousLandingKey = "previous-landing-key-with-at-least-32-characters";
const credentials = [
  {
    id: "landing-current",
    credential_enc: await sealJson(
      currentLandingKey,
      { username: "current-user", password: "current-password" },
      "landing:landing-current",
    ),
  },
  {
    id: "landing-previous",
    credential_enc: await sealJson(
      previousLandingKey,
      { username: "previous-user", password: "previous-password" },
      "landing:landing-previous",
    ),
  },
];

class Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async all() {
    assert.match(this.sql, /SELECT id, credential_enc FROM landings/);
    return { results: this.database.rows.map((row) => ({ ...row })) };
  }

  async run() {
    assert.match(this.sql, /UPDATE landings/);
    const [id, encrypted, expected] = this.args;
    const row = this.database.rows.find((item) => item.id === id);
    if (row && row.credential_enc === expected) row.credential_enc = encrypted;
    return { success: true };
  }
}

class Database {
  constructor(initialRows) {
    this.rows = initialRows.map((row) => ({ ...row }));
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

const env = {
  DB: new Database(credentials),
  LANDING_CONFIG_KEY: currentLandingKey,
  LANDING_CONFIG_KEY_PREVIOUS: previousLandingKey,
};
const before = await landingCredentialRotationStatus(env);
assert.deepEqual(before, {
  previousKeyConfigured: true,
  total: 2,
  current: 1,
  previous: 1,
  unreadable: 0,
});
const migrated = await migrateLandingCredentialsToCurrentKey(env);
assert.equal(migrated.migrated, 1);
assert.equal(migrated.current, 2);
assert.equal(migrated.previous, 0);
for (const row of env.DB.rows) {
  const opened = await openJsonWithRotation(
    currentLandingKey,
    undefined,
    row.credential_enc,
    `landing:${row.id}`,
  );
  assert.equal(opened.secretSlot, "current");
}

const brokenDatabase = new Database([
  credentials[1],
  { id: "landing-broken", credential_enc: "v1.invalid.invalid" },
]);
await assert.rejects(
  migrateLandingCredentialsToCurrentKey({
    DB: brokenDatabase,
    LANDING_CONFIG_KEY: currentLandingKey,
    LANDING_CONFIG_KEY_PREVIOUS: previousLandingKey,
  }),
  /拒绝迁移/,
);
assert.equal(
  brokenDatabase.rows[0].credential_enc,
  credentials[1].credential_enc,
  "a preflight decrypt failure must prevent partial migration",
);

const currentNodeKey = "current-node-hmac";
const previousNodeKey = "previous-node-hmac";
const invalidationCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  invalidationCalls.push({ url: String(url), options });
  const timestamp = options.headers["x-opus8-ts"];
  const nodeId = options.headers["x-opus8-node"];
  const message = [
    "opus8-hmac-v2",
    timestamp,
    nodeId,
    "POST",
    "/__opus8/policy/invalidate",
    options.body,
  ].join("\n");
  const key = invalidationCalls.length === 1
    ? currentNodeKey
    : previousNodeKey;
  const expected = crypto
    .createHmac("sha256", key)
    .update(message)
    .digest("hex");
  assert.equal(options.headers["x-opus8-sign-v2"], expected);
  return invalidationCalls.length === 1
    ? new Response("Unauthorized", { status: 401 })
    : Response.json({ ok: true, version: 42 });
};
try {
  const invalidation = await invalidateEdgePolicyCaches(
    {
      NODE_HMAC_SECRET: currentNodeKey,
      NODE_HMAC_SECRET_PREVIOUS: previousNodeKey,
      DB: {
        prepare() {
          return {
            async all() {
              return {
                results: [
                  {
                    id: "acc1-n1",
                    hostname: "acc1-n1.example.com",
                    enabled: 1,
                    created_at: 1,
                  },
                ],
              };
            },
          };
        },
      },
    },
    42,
  );
  assert.equal(invalidation.acknowledged, 1);
  assert.equal(invalidationCalls.length, 2);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("OK zero-downtime key rotation tests");
