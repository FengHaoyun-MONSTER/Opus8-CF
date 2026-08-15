import { buildNodeDeployMatrix } from "../../../infra/scripts/node-deploy-matrix.mjs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function assert(value, message) {
  if (!value) throw new Error(message);
}

const manifest = {
  accounts: [
    {
      alias: "acc1",
      accountIdSecret: "ACCOUNT_ID",
      apiTokenSecret: "API_TOKEN",
      rootDomainSecret: "ROOT_DOMAIN",
      nodes: [
        { id: "acc1-n1", region: "US", deploySuffix: "-v2" },
        { id: "acc1-n2", region: "EU" },
      ],
    },
    {
      alias: "acc2",
      accountIdSecret: "ACCOUNT_ID_NUM1",
      apiTokenSecret: "API_TOKEN_NUM1",
      rootDomainSecret: "ROOT_DOMAIN_NUM1",
      nodes: [{ id: "acc2-n1", region: "SG" }],
    },
  ],
};

const all = buildNodeDeployMatrix(manifest, "all");
assert(all.include.length === 3, "all target must include every declared node");
const one = buildNodeDeployMatrix(manifest, "acc2-n1");
assert(one.include.length === 1 && one.include[0].api_token_secret === "API_TOKEN_NUM1", "exact target must carry account secret references");

for (const [description, mutated] of [
  ["duplicate node", { ...manifest, accounts: [manifest.accounts[0], { ...manifest.accounts[1], nodes: [{ id: "acc1-n1", region: "SG" }] }] }],
  ["invalid secret", { ...manifest, accounts: [{ ...manifest.accounts[0], apiTokenSecret: "not-a-secret" }] }],
  ["wrong account prefix", { ...manifest, accounts: [{ ...manifest.accounts[0], nodes: [{ id: "acc9-n1", region: "US" }] }] }],
]) {
  let rejected = false;
  try {
    buildNodeDeployMatrix(mutated, "all");
  } catch {
    rejected = true;
  }
  assert(rejected, `${description} must be rejected`);
}

let unknownRejected = false;
try {
  buildNodeDeployMatrix(manifest, "acc3-n1");
} catch {
  unknownRejected = true;
}
assert(unknownRejected, "unknown targets must fail closed");

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = JSON.parse(execFileSync(
  process.execPath,
  [
    resolve(repositoryRoot, "infra/scripts/node-deploy-matrix.mjs"),
    resolve(repositoryRoot, "infra/accounts.json"),
    "acc1-n1",
  ],
  { encoding: "utf8" },
));
assert(cli.include?.length === 1 && cli.include[0].node_id === "acc1-n1", "matrix CLI must execute portably");

console.log("OK manifest-driven node deployment matrix tests");
