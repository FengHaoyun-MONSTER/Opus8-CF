import { hmacSign } from "@opus8-cf/shared";

export interface AdminLoginRateLimitEnv {
  JWT_SECRET: string;
  ADMIN_LOGIN_RATE_LIMIT_REQUIRED?: string;
  ADMIN_LOGIN_RATE_LIMITER?: RateLimit;
}

export type AdminLoginRateLimitDecision =
  | { allowed: true }
  | { allowed: false; status: 429 | 503; retryAfterSeconds: number };

export const ADMIN_LOGIN_RATE_LIMIT = {
  limit: 10,
  period: 60,
  namespaceId: "683403",
} as const;

export async function enforceAdminLoginRateLimit(
  request: Request,
  env: AdminLoginRateLimitEnv,
): Promise<AdminLoginRateLimitDecision> {
  const limiter = env.ADMIN_LOGIN_RATE_LIMITER;
  if (!limiter) {
    return env.ADMIN_LOGIN_RATE_LIMIT_REQUIRED === "1"
      ? { allowed: false, status: 503, retryAfterSeconds: 60 }
      : { allowed: true };
  }
  try {
    const source = (request.headers.get("cf-connecting-ip") || "unknown-source")
      .trim()
      .slice(0, 128);
    const key = await hmacSign(
      env.JWT_SECRET,
      `admin-login-rate-v1:${source || "unknown-source"}`,
    );
    const result = await limiter.limit({ key });
    return result.success
      ? { allowed: true }
      : {
          allowed: false,
          status: 429,
          retryAfterSeconds: ADMIN_LOGIN_RATE_LIMIT.period,
        };
  } catch {
    return env.ADMIN_LOGIN_RATE_LIMIT_REQUIRED === "1"
      ? { allowed: false, status: 503, retryAfterSeconds: 60 }
      : { allowed: true };
  }
}
