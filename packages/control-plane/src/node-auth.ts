import {
  hmacSign,
  nodeSignatureMessageV1,
  nodeSignatureMessageV2,
  SIGN_HEADERS,
  SIGN_WINDOW_MS,
  timingSafeEqual,
} from "@opus8-cf/shared";

export interface NodeAuthEnv {
  NODE_HMAC_SECRET: string;
  HMAC_V1_ACCEPT_UNTIL?: string;
  HMAC_V1_NODE_IDS?: string;
}

export interface NodeAuthResult {
  nodeId: string;
  timestamp: number;
  version: 1 | 2;
}

function validTimestamp(value: string): number | null {
  if (!/^\d{13}$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

function validNodeId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,80}$/.test(value);
}

function validSignature(value: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(value);
}

function legacyWindowOpen(env: NodeAuthEnv, now: number): boolean {
  const deadline = Number(env.HMAC_V1_ACCEPT_UNTIL || 0);
  return Number.isSafeInteger(deadline) && deadline >= now;
}

export function legacyNodeAllowed(
  env: Pick<NodeAuthEnv, "HMAC_V1_NODE_IDS">,
  nodeId: string,
): boolean {
  return String(env.HMAC_V1_NODE_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(validNodeId)
    .includes(nodeId);
}

function legacyTargetAllowed(request: Request, nodeId: string): boolean {
  const url = new URL(request.url);
  if (url.search) return false;
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return url.pathname === `/api/nodes/${nodeId}/uuids`;
  }
  return (
    method === "POST" &&
    [
      "/api/nodes/heartbeat",
      "/api/nodes/admission",
      "/api/nodes/usage",
    ].includes(url.pathname)
  );
}

export async function verifyNodeRequest(
  request: Request,
  env: NodeAuthEnv,
  body: string,
  now = Date.now(),
): Promise<NodeAuthResult | null> {
  const timestampText = request.headers.get(SIGN_HEADERS.ts) || "";
  const timestamp = validTimestamp(timestampText);
  const nodeId = request.headers.get(SIGN_HEADERS.node) || "";
  if (
    timestamp === null ||
    !validNodeId(nodeId) ||
    Math.abs(now - timestamp) > SIGN_WINDOW_MS
  ) {
    return null;
  }

  const signatureV2 = request.headers.get(SIGN_HEADERS.signV2);
  if (signatureV2 !== null) {
    if (!validSignature(signatureV2)) return null;
    const expectedV2 = await hmacSign(
      env.NODE_HMAC_SECRET,
      nodeSignatureMessageV2(
        timestampText,
        nodeId,
        request.method,
        request.url,
        body,
      ),
    );
    return timingSafeEqual(expectedV2, signatureV2.toLowerCase())
      ? { nodeId, timestamp, version: 2 }
      : null;
  }

  if (
    !legacyWindowOpen(env, now) ||
    !legacyNodeAllowed(env, nodeId) ||
    !legacyTargetAllowed(request, nodeId)
  ) {
    return null;
  }
  const signatureV1 = request.headers.get(SIGN_HEADERS.sign) || "";
  if (!validSignature(signatureV1)) return null;
  const expectedV1 = await hmacSign(
    env.NODE_HMAC_SECRET,
    nodeSignatureMessageV1(timestampText, nodeId, body),
  );
  return timingSafeEqual(expectedV1, signatureV1.toLowerCase())
    ? { nodeId, timestamp, version: 1 }
    : null;
}
