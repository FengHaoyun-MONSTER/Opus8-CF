import { hmacSign } from "@opus8-cf/shared";

export interface SubscriptionRateLimitEnv {
  NODE_HMAC_SECRET: string;
  SUB_RATE_LIMIT_REQUIRED?: string;
  SUB_SOURCE_RATE_LIMITER?: RateLimit;
  SUB_TOKEN_RATE_LIMITER?: RateLimit;
}

export type SubscriptionRateLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "source" | "token" | "unavailable";
      retryAfterSeconds: number;
      status: 429 | 503;
    };

export const SUBSCRIPTION_RATE_LIMITS = {
  source: { limit: 120, period: 60, namespaceId: "683401" },
  token: { limit: 20, period: 60, namespaceId: "683402" },
} as const;

function sourceIdentity(request: Request): string {
  const value = (request.headers.get("cf-connecting-ip") || "").trim();
  return value ? value.slice(0, 128) : "unknown-source";
}

async function privateKey(
  secret: string,
  scope: "source" | "token",
  value: string,
): Promise<string> {
  return hmacSign(secret, `subscription-rate-v1:${scope}:${value}`);
}

export function validSubscriptionToken(token: string): boolean {
  // randomToken() is 24 random bytes encoded as 32 URL-safe base64 characters.
  return /^[A-Za-z0-9_-]{32}$/.test(token);
}

export async function enforceSubscriptionRateLimit(
  request: Request,
  env: SubscriptionRateLimitEnv,
  token: string,
): Promise<SubscriptionRateLimitDecision> {
  const required = env.SUB_RATE_LIMIT_REQUIRED === "1";
  const sourceLimiter = env.SUB_SOURCE_RATE_LIMITER;
  const tokenLimiter = env.SUB_TOKEN_RATE_LIMITER;
  if (!sourceLimiter || !tokenLimiter) {
    return required
      ? {
          allowed: false,
          reason: "unavailable",
          retryAfterSeconds: 60,
          status: 503,
        }
      : { allowed: true };
  }

  try {
    const sourceKey = await privateKey(
      env.NODE_HMAC_SECRET,
      "source",
      sourceIdentity(request),
    );
    const source = await sourceLimiter.limit({ key: sourceKey });
    if (!source.success) {
      return {
        allowed: false,
        reason: "source",
        retryAfterSeconds: SUBSCRIPTION_RATE_LIMITS.source.period,
        status: 429,
      };
    }

    const tokenKey = await privateKey(
      env.NODE_HMAC_SECRET,
      "token",
      token,
    );
    const subscription = await tokenLimiter.limit({ key: tokenKey });
    if (!subscription.success) {
      return {
        allowed: false,
        reason: "token",
        retryAfterSeconds: SUBSCRIPTION_RATE_LIMITS.token.period,
        status: 429,
      };
    }
    return { allowed: true };
  } catch {
    return required
      ? {
          allowed: false,
          reason: "unavailable",
          retryAfterSeconds: 60,
          status: 503,
        }
      : { allowed: true };
  }
}
