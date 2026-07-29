import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function validateRelease(entry, repository, expectedAsset) {
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
  assert.equal(entry.releaseTag, `v${entry.version}`);
  assert.equal(entry.asset, expectedAsset);
  assert.equal(
    entry.url,
    `https://github.com/${repository}/releases/download/${entry.releaseTag}/${entry.asset}`,
  );
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
}

const cfst = JSON.parse(
  await readFile(join(repoRoot, "infra", "cfst-tool.json"), "utf8"),
);
assert.equal(cfst.schemaVersion, 1);
assert.equal(cfst.platform, "linux-amd64");
validateRelease(
  cfst,
  "XIU2/CloudflareSpeedTest",
  "cfst_linux_amd64.tar.gz",
);

const clients = JSON.parse(
  await readFile(
    join(repoRoot, "infra", "client-compatibility.json"),
    "utf8",
  ),
);
assert.equal(clients.schemaVersion, 1);
assert.equal(clients.platform, "linux-amd64");
validateRelease(clients.clients.xray, "XTLS/Xray-core", "Xray-linux-64.zip");
validateRelease(
  clients.clients.mihomo,
  "MetaCubeX/mihomo",
  `mihomo-linux-amd64-v${clients.clients.mihomo.version}.gz`,
);
validateRelease(
  clients.clients["sing-box"],
  "SagerNet/sing-box",
  `sing-box-${clients.clients["sing-box"].version}-linux-amd64.tar.gz`,
);

for (const relativePath of [
  ["infra", "scripts", "optimize-ip.sh"],
  ["infra", "scripts", "client-compatibility.sh"],
]) {
  const source = await readFile(join(repoRoot, ...relativePath), "utf8");
  assert.doesNotMatch(
    source,
    /releases\/latest|latest\/download/,
    `${relativePath.join("/")} must not execute unpinned releases`,
  );
}

console.log("supply-chain pinning tests passed");
