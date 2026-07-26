export * from "./crypto";
export * from "./types";

/** 节点↔控制面 请求签名规范。message = `${ts}.${nodeId}.${body}` */
export const SIGN_HEADERS = {
  ts: "x-opus8-ts",
  node: "x-opus8-node",
  sign: "x-opus8-sign",
} as const;

/** 允许的签名时间窗（毫秒），防重放。 */
export const SIGN_WINDOW_MS = 5 * 60 * 1000;
