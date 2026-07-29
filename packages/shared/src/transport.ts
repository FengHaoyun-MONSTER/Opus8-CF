export const DEFAULT_TRANSPORT_PATH = "/";
export const TRANSPORT_EARLY_DATA = 2560;
export const TRANSPORT_EARLY_DATA_HEADER = "Sec-WebSocket-Protocol";
export const TRANSPORT_PATH_MAX_LENGTH = 128;

const SAFE_PATH = /^\/[A-Za-z0-9._~/-]*$/;
const RESERVED_PREFIXES = [
  "/__opus8",
  "/admin",
  "/login",
  "/sub",
  "/version",
  "/locations",
  "/robots.txt",
  "/favicon.ico",
] as const;

/**
 * Validate a public data-plane pathname. Query strings are deliberately not
 * accepted: client-specific Early Data configuration is rendered separately.
 */
export function normalizeTransportPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (
    path.length === 0 ||
    path.length > TRANSPORT_PATH_MAX_LENGTH ||
    !SAFE_PATH.test(path) ||
    path.includes("//")
  ) {
    return null;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  const lower = path.toLowerCase();
  if (
    RESERVED_PREFIXES.some(
      (prefix) => lower === prefix || lower.startsWith(`${prefix}/`),
    )
  ) {
    return null;
  }
  return path;
}

export function nodeTransportPath(
  value: string | null | undefined,
): string | null {
  return normalizeTransportPath(value ?? DEFAULT_TRANSPORT_PATH);
}

export function xrayWebSocketPath(path: string): string {
  return `${path}?ed=${TRANSPORT_EARLY_DATA}`;
}
