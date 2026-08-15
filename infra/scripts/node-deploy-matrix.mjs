#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{1,62}$/;
const REGION = /^[A-Za-z0-9._-]{1,32}$/;

function requiredString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function buildNodeDeployMatrix(manifest, target = "all") {
  if (!manifest || !Array.isArray(manifest.accounts)) {
    throw new Error("accounts manifest is invalid");
  }
  if (target !== "all" && !IDENTIFIER.test(target)) {
    throw new Error("target is invalid");
  }

  const aliases = new Set();
  const nodeIds = new Set();
  const include = [];
  for (const account of manifest.accounts) {
    const alias = requiredString(account?.alias, "account alias", IDENTIFIER);
    if (aliases.has(alias)) throw new Error(`duplicate account alias: ${alias}`);
    aliases.add(alias);
    const accountIdSecret = requiredString(
      account.accountIdSecret,
      `${alias}.accountIdSecret`,
      SECRET_NAME,
    );
    const apiTokenSecret = requiredString(
      account.apiTokenSecret,
      `${alias}.apiTokenSecret`,
      SECRET_NAME,
    );
    const rootDomainSecret = requiredString(
      account.rootDomainSecret,
      `${alias}.rootDomainSecret`,
      SECRET_NAME,
    );
    if (!Array.isArray(account.nodes)) throw new Error(`${alias}.nodes must be an array`);

    for (const node of account.nodes) {
      const nodeId = requiredString(node?.id, `${alias}.node.id`, IDENTIFIER);
      if (nodeIds.has(nodeId)) throw new Error(`duplicate node id: ${nodeId}`);
      nodeIds.add(nodeId);
      if (!nodeId.startsWith(`${alias}-`)) {
        throw new Error(`node ${nodeId} must be prefixed by account alias ${alias}-`);
      }
      const region = requiredString(node.region, `${nodeId}.region`, REGION);
      const deploySuffix = node.deploySuffix === undefined ? "" : String(node.deploySuffix);
      if (deploySuffix && !/^-[a-z0-9-]{1,24}$/.test(deploySuffix)) {
        throw new Error(`${nodeId}.deploySuffix is invalid`);
      }
      if (target === "all" || target === nodeId) {
        include.push({
          alias,
          node_id: nodeId,
          region,
          deploy_suffix: deploySuffix,
          account_id_secret: accountIdSecret,
          api_token_secret: apiTokenSecret,
          root_domain_secret: rootDomainSecret,
        });
      }
    }
  }

  if (include.length === 0) throw new Error(`unknown or empty deployment target: ${target}`);
  return { include };
}

async function main() {
  const manifestPath = process.argv[2] || "infra/accounts.json";
  const target = process.argv[3] || "all";
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  process.stdout.write(JSON.stringify(buildNodeDeployMatrix(manifest, target)));
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`ERROR node-matrix ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
