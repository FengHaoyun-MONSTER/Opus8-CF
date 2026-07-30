import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controlRoot = join(here, "..");
const bundled = await build({
  entryPoints: [join(controlRoot, "src", "device-credentials.ts")],
  alias: {
    "@opus8-cf/shared": join(controlRoot, "..", "shared", "src", "index.ts"),
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const moduleUrl =
  "data:text/javascript;base64,"
  + Buffer.from(bundled.outputFiles[0].text).toString("base64");
const {
  DEVICE_UUID_WINDOW_MS,
  deriveDeviceUuid,
  deviceCredentialUuids,
  hashDeviceHwid,
  normalizeHwid,
} = await import(moduleUrl);

function assert(value, message) {
  if (!value) throw new Error(message);
}

const secret = "test-secret-with-enough-entropy";
const baseUuid = "11111111-1111-4111-8111-111111111111";
const now = 100 * DEVICE_UUID_WINDOW_MS + 1234;
const current = await deriveDeviceUuid(secret, baseUuid, now);
const repeated = await deriveDeviceUuid(secret, baseUuid, now + 10_000);
const next = await deriveDeviceUuid(secret, baseUuid, now + DEVICE_UUID_WINDOW_MS);
assert(current === repeated, "dynamic UUID must be stable within one window");
assert(current !== next, "dynamic UUID must rotate at the next window");
assert(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(current),
  "derived credential must be a valid RFC 4122 version-4-shaped UUID",
);
const accepted = await deviceCredentialUuids(secret, baseUuid, "rotating", now);
assert(
  accepted.length === 2
  && accepted[0] === current
  && accepted[1] === await deriveDeviceUuid(secret, baseUuid, now, -1),
  "rotating credentials must accept current and previous windows",
);
const staticCredentials = await deviceCredentialUuids(
  secret,
  baseUuid,
  "static",
  now,
);
assert(
  staticCredentials.length === 1 && staticCredentials[0] === baseUuid,
  "legacy static credentials must remain unchanged",
);
assert(normalizeHwid(" device-123456 ") === "device-123456", "HWID normalization failed");
assert(normalizeHwid("short") === null, "short HWIDs must be rejected");
assert(normalizeHwid("device id with spaces") === null, "non-visible HWID bytes must be rejected");
const firstHash = await hashDeviceHwid(secret, "device-a", "device-123456");
const secondHash = await hashDeviceHwid(secret, "device-b", "device-123456");
assert(
  firstHash !== secondHash && /^[0-9a-f]{64}$/.test(firstHash),
  "stored HWID hashes must be scoped per device and use HMAC-SHA256",
);

console.log("OK device credential tests");
