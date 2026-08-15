import {
  canonicalRequestTarget,
  hmacSign,
  timingSafeEqual,
  toHex,
} from "@opus8-cf/shared";

const encoder = new TextEncoder();

export const AUTOMATION_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export const AUTOMATION_HEADERS = {
  identity: "x-opus8-automation-id",
  timestamp: "x-opus8-automation-timestamp",
  requestId: "x-opus8-automation-request-id",
  signature: "x-opus8-automation-signature",
} as const;

export interface AutomationAuthEnv {
  AUTOMATION_HMAC_SECRET?: string;
  AUTOMATION_ALLOWED_IDS?: string;
  DB?: D1Database;
}

export interface AutomationAuthResult {
  identity: string;
  requestId: string;
  timestamp: number;
}

export function automationSignatureMessage(
  timestamp: string,
  identity: string,
  requestId: string,
  method: string,
  pathOrUrl: string,
  bodySha256: string,
): string {
  return [
    "opus8-automation-v1",
    timestamp,
    identity,
    requestId,
    method.toUpperCase(),
    canonicalRequestTarget(pathOrUrl),
    bodySha256.toLowerCase(),
  ].join("\n");
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function validIdentity(value: string): boolean {
  return /^[A-Za-z0-9._-]{3,64}$/.test(value);
}

function validRequestId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{16,128}$/.test(value);
}

export async function verifyAutomationRequest(
  request: Request,
  env: AutomationAuthEnv,
  rawBody: string,
  now = Date.now(),
): Promise<AutomationAuthResult | null> {
  const secret = env.AUTOMATION_HMAC_SECRET || "";
  if (secret.length < 32 || !Number.isSafeInteger(now)) return null;

  const identity = request.headers.get(AUTOMATION_HEADERS.identity) || "";
  const timestampText =
    request.headers.get(AUTOMATION_HEADERS.timestamp) || "";
  const requestId = request.headers.get(AUTOMATION_HEADERS.requestId) || "";
  const signature = request.headers.get(AUTOMATION_HEADERS.signature) || "";
  const allowedIdentities = new Set(
    (env.AUTOMATION_ALLOWED_IDS || "github-node-deploy")
      .split(",")
      .map((item) => item.trim())
      .filter(validIdentity),
  );
  if (
    !validIdentity(identity)
    || !allowedIdentities.has(identity)
    || !/^\d{1,16}$/.test(timestampText)
    || !validRequestId(requestId)
    || !/^[0-9a-fA-F]{64}$/.test(signature)
  ) {
    return null;
  }

  const timestamp = Number(timestampText);
  if (
    !Number.isSafeInteger(timestamp)
    || Math.abs(now - timestamp) > AUTOMATION_SIGNATURE_WINDOW_MS
  ) {
    return null;
  }

  const bodyHash = await sha256Hex(rawBody);
  const expected = await hmacSign(
    secret,
    automationSignatureMessage(
      timestampText,
      identity,
      requestId,
      request.method,
      request.url,
      bodyHash,
    ),
  );
  if (!timingSafeEqual(expected, signature.toLowerCase())) return null;
  return { identity, requestId, timestamp };
}

export async function claimAutomationRequest(
  env: AutomationAuthEnv,
  authentication: AutomationAuthResult,
): Promise<boolean> {
  if (!env.DB) return false;
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO automation_request_nonces
       (request_id,identity,expires_at,created_at)
     VALUES (?1,?2,?3,?4)`,
  )
    .bind(
      authentication.requestId,
      authentication.identity,
      authentication.timestamp + AUTOMATION_SIGNATURE_WINDOW_MS,
      Date.now(),
    )
    .run();
  return Number(result.meta?.changes || 0) === 1;
}
