import {
  canonicalRequestTarget,
  hmacSign,
  timingSafeEqual,
  toHex,
} from "@opus8-cf/shared";

const encoder = new TextEncoder();

export const INTEGRATION_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export const INTEGRATION_HEADERS = {
  keyId: "x-opus8-integration-key-id",
  timestamp: "x-opus8-integration-timestamp",
  requestId: "x-opus8-integration-request-id",
  signature: "x-opus8-integration-signature",
} as const;

export interface IntegrationAuthConfig {
  keyId: string;
  secret: string;
}

export interface IntegrationAuthResult {
  keyId: string;
  requestId: string;
  timestamp: number;
}

export function integrationSignatureMessage(
  timestamp: string,
  requestId: string,
  method: string,
  pathOrUrl: string,
  bodySha256: string,
): string {
  return [
    "opus8-integration-v1",
    timestamp,
    requestId,
    method.toUpperCase(),
    canonicalRequestTarget(pathOrUrl),
    bodySha256.toLowerCase(),
  ].join("\n");
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function validRequestId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{16,128}$/.test(value);
}

function validKeyId(value: string): boolean {
  return /^[A-Za-z0-9._-]{3,64}$/.test(value);
}

export async function verifyIntegrationRequest(
  request: Request,
  config: IntegrationAuthConfig,
  rawBody: string,
  now = Date.now(),
): Promise<IntegrationAuthResult | null> {
  if (
    !validKeyId(config.keyId)
    || config.secret.length < 32
    || !Number.isSafeInteger(now)
  ) {
    return null;
  }

  const keyId = request.headers.get(INTEGRATION_HEADERS.keyId) || "";
  const timestampText = request.headers.get(INTEGRATION_HEADERS.timestamp) || "";
  const requestId = request.headers.get(INTEGRATION_HEADERS.requestId) || "";
  const signature = request.headers.get(INTEGRATION_HEADERS.signature) || "";

  if (
    !timingSafeEqual(keyId, config.keyId)
    || !/^\d{1,16}$/.test(timestampText)
    || !validRequestId(requestId)
    || !/^[0-9a-fA-F]{64}$/.test(signature)
  ) {
    return null;
  }

  const timestamp = Number(timestampText);
  if (
    !Number.isSafeInteger(timestamp)
    || Math.abs(now - timestamp) > INTEGRATION_SIGNATURE_WINDOW_MS
  ) {
    return null;
  }

  const bodyHash = await sha256Hex(rawBody);
  const message = integrationSignatureMessage(
    timestampText,
    requestId,
    request.method,
    request.url,
    bodyHash,
  );
  const expected = await hmacSign(config.secret, message);
  if (!timingSafeEqual(expected, signature.toLowerCase())) return null;

  return { keyId, requestId, timestamp };
}
