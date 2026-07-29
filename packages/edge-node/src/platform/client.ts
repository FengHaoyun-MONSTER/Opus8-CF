/** 边缘节点 ↔ 控制面 的签名请求客户端。 */
import {
  hmacSign,
  nodeSignatureMessageV2,
  SIGN_HEADERS,
} from "@opus8-cf/shared";

export interface PlatformEnv {
  KV?: KVNamespace;
  CONTROL_PLANE_URL?: string; // 如 https://api.example.com
  NODE_ID?: string;
  NODE_HMAC_SECRET?: string;
  NODE_HOSTNAME?: string;
  NODE_ACCOUNT_ALIAS?: string;
  NODE_REGION?: string;
  OPUS8_TRANSPORT_PATH?: string;
}

export function platformReady(env: PlatformEnv): boolean {
  return !!(env.CONTROL_PLANE_URL && env.NODE_ID && env.NODE_HMAC_SECRET);
}

/** 发送带 HMAC 签名的请求。method 为 GET 时 body 传空串。 */
export async function signedRequest(
  env: PlatformEnv, method: "GET" | "POST", path: string, body = "",
): Promise<Response> {
  const ts = String(Date.now());
  const nodeId = env.NODE_ID!;
  const signV2 = await hmacSign(
    env.NODE_HMAC_SECRET!,
    nodeSignatureMessageV2(ts, nodeId, method, path, body),
  );
  const headers: Record<string, string> = {
    [SIGN_HEADERS.ts]: ts,
    [SIGN_HEADERS.node]: nodeId,
    [SIGN_HEADERS.signV2]: signV2,
  };
  if (method === "POST") headers["content-type"] = "application/json";
  return fetch(`${env.CONTROL_PLANE_URL}${path}`, {
    method,
    headers,
    body: method === "POST" ? body : undefined,
  });
}
