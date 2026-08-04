import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatControlDeployErrors,
  validateControlDeployEnvironment
} from "../../../infra/scripts/control-deploy-preflight.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function validEnvironment() {
  return {
    ROOT_DOMAIN: "example.com",
    ADMIN_PASSWORD: "a".repeat(16),
    JWT_SECRET: "j".repeat(32),
    NODE_HMAC_SECRET: "n".repeat(32),
    LANDING_CONFIG_KEY: Buffer.alloc(32, 9).toString("base64url"),
    FREEDOMPOST_INTEGRATION_KEY_ID: "freedompost-prod",
    FREEDOMPOST_INTEGRATION_SECRET: "f".repeat(32)
  };
}

test("accepts a complete control-plane deployment environment", () => {
  assert.deepEqual(validateControlDeployEnvironment(validEnvironment()), []);
});

test("fails closed when FreedomPost integration credentials are absent", () => {
  const environment = validEnvironment();
  delete environment.FREEDOMPOST_INTEGRATION_KEY_ID;
  delete environment.FREEDOMPOST_INTEGRATION_SECRET;
  const names = validateControlDeployEnvironment(environment).map((error) => error.name);
  assert.ok(names.includes("FREEDOMPOST_INTEGRATION_KEY_ID"));
  assert.ok(names.includes("FREEDOMPOST_INTEGRATION_SECRET"));
});

test("rejects malformed integration credentials without exposing values", () => {
  const environment = validEnvironment();
  environment.FREEDOMPOST_INTEGRATION_KEY_ID = "bad key";
  environment.FREEDOMPOST_INTEGRATION_SECRET = "leak-probe";
  const output = formatControlDeployErrors(validateControlDeployEnvironment(environment));
  assert.match(output, /FREEDOMPOST_INTEGRATION_KEY_ID/);
  assert.match(output, /FREEDOMPOST_INTEGRATION_SECRET/);
  assert.doesNotMatch(output, /bad key|leak-probe/);
});

test("workflow and deploy script inject both integration secrets", () => {
  const workflow = readFileSync(
    `${repositoryRoot}.github/workflows/deploy-control.yml`,
    "utf8"
  );
  const deployScript = readFileSync(
    `${repositoryRoot}infra/scripts/deploy-control.sh`,
    "utf8"
  );
  for (const name of [
    "FREEDOMPOST_INTEGRATION_KEY_ID",
    "FREEDOMPOST_INTEGRATION_SECRET"
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${name}`));
    assert.match(deployScript, new RegExp(`put_secret "${name}"`));
  }
  assert.match(deployScript, /control-deploy-preflight\.mjs/);
});
