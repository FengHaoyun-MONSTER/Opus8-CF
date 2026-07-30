import { hmacSign } from "@opus8-cf/shared";

export const DEVICE_UUID_WINDOW_MS = 24 * 60 * 60_000;

function uuidFromHex(hex: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < 32; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const normalized = bytes
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20, 32),
  ].join("-");
}

export async function deriveDeviceUuid(
  secret: string,
  baseUuid: string,
  now = Date.now(),
  windowOffset = 0,
): Promise<string> {
  const window = Math.floor(now / DEVICE_UUID_WINDOW_MS) + windowOffset;
  const digest = await hmacSign(
    secret,
    `device-uuid:v1:${baseUuid.toLowerCase()}:${window}`,
  );
  return uuidFromHex(digest);
}

export async function deviceCredentialUuids(
  secret: string,
  baseUuid: string,
  mode: "static" | "rotating",
  now = Date.now(),
): Promise<string[]> {
  if (mode === "static") return [baseUuid.toLowerCase()];
  return Promise.all([
    deriveDeviceUuid(secret, baseUuid, now),
    deriveDeviceUuid(secret, baseUuid, now, -1),
  ]);
}

export function normalizeHwid(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length < 8 || value.length > 256) return null;
  return /^[\x21-\x7e]+$/.test(value) ? value : null;
}

export function hashDeviceHwid(
  secret: string,
  deviceId: string,
  normalizedHwid: string,
): Promise<string> {
  return hmacSign(secret, `device-hwid:v1:${deviceId}:${normalizedHwid}`);
}
