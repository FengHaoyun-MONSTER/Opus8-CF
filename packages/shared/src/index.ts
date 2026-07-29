export * from "./crypto";
export * from "./transport";
export * from "./types";

/** 节点↔控制面 请求签名头。v2 绑定 method + pathname + query + body。 */
export const SIGN_HEADERS = {
  ts: "x-opus8-ts",
  node: "x-opus8-node",
  sign: "x-opus8-sign",
  signV2: "x-opus8-sign-v2",
} as const;

/** 允许的签名新鲜度窗口（毫秒）；业务写入另由幂等键约束重复执行。 */
export const SIGN_WINDOW_MS = 5 * 60 * 1000;

export function canonicalRequestTarget(pathOrUrl: string): string {
  const url = new URL(pathOrUrl, "https://opus8-signature.invalid");
  return url.pathname + url.search;
}

/** 仅供滚动升级期间验证旧节点；新调用方不得继续生成 v1。 */
export function nodeSignatureMessageV1(
  timestamp: string,
  nodeId: string,
  body: string,
): string {
  return `${timestamp}.${nodeId}.${body}`;
}

export function nodeSignatureMessageV2(
  timestamp: string,
  nodeId: string,
  method: string,
  pathOrUrl: string,
  body: string,
): string {
  return [
    "opus8-hmac-v2",
    timestamp,
    nodeId,
    method.toUpperCase(),
    canonicalRequestTarget(pathOrUrl),
    body,
  ].join("\n");
}
