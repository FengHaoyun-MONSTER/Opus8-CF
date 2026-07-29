export interface CorsEnv {
  ADMIN_UI_ORIGINS?: string;
}

export interface ControlCorsPolicy {
  adminApi: boolean;
  origin: string | null;
  allowed: boolean;
  responseHeaders: Record<string, string>;
}

const ADMIN_API_PREFIXES = [
  "/api/admin",
  "/api/operations",
  "/api/users",
  "/api/settings",
  "/api/landings",
  "/api/optimized-ips",
];

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_HEADERS = new Set(["authorization", "content-type"]);
const ALLOW_METHODS_HEADER = [...ALLOWED_METHODS].join(", ");

export function isAdminApiPath(pathname: string): boolean {
  if (pathname === "/api/nodes") return true;
  return ADMIN_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

function configuredOrigins(env: CorsEnv): Set<string> {
  const origins = new Set<string>();
  for (const value of String(env.ADMIN_UI_ORIGINS || "").split(",")) {
    const candidate = value.trim();
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        parsed.username ||
        parsed.password ||
        (parsed.pathname !== "/" && parsed.pathname !== "") ||
        parsed.search ||
        parsed.hash
      ) {
        continue;
      }
      origins.add(parsed.origin);
    } catch {
      // Invalid entries fail closed and do not weaken the remaining allow-list.
    }
  }
  return origins;
}

export function controlCorsPolicy(
  request: Request,
  env: CorsEnv,
  pathname: string,
): ControlCorsPolicy {
  const adminApi = isAdminApiPath(pathname);
  const origin = request.headers.get("Origin");
  const allowed =
    adminApi && origin !== null && configuredOrigins(env).has(origin);
  return {
    adminApi,
    origin,
    allowed,
    responseHeaders: allowed
      ? {
          "access-control-allow-origin": origin,
          "access-control-allow-headers": [...ALLOWED_HEADERS].join(", "),
          "access-control-allow-methods": ALLOW_METHODS_HEADER,
          "access-control-max-age": "600",
          vary: "Origin",
        }
      : {},
  };
}

export function validateAdminPreflight(
  request: Request,
  policy: ControlCorsPolicy,
): string | null {
  if (!policy.adminApi) return "not_admin_api";
  if (!policy.origin) return "origin_required";
  if (!policy.allowed) return "origin_denied";

  const requestedMethod = String(
    request.headers.get("Access-Control-Request-Method") || "",
  ).toUpperCase();
  if (!ALLOWED_METHODS.has(requestedMethod)) return "method_denied";

  const requestedHeaders = String(
    request.headers.get("Access-Control-Request-Headers") || "",
  )
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((header) => !ALLOWED_HEADERS.has(header))) {
    return "headers_denied";
  }
  return null;
}
