/** 节点自注册与心跳。部署后调用一次 register，之后随请求/定时 heartbeat。 */
import type { RegisterRequest, HeartbeatRequest, NodeRecord } from "@opus8-cf/shared";
import { platformReady, signedRequest, type PlatformEnv } from "./client";

export async function registerNode(
  env: PlatformEnv, opts: { capabilities?: string[]; preferredIp?: string; version?: string } = {},
): Promise<boolean> {
  if (!platformReady(env)) return false;
  const payload: RegisterRequest = {
    nodeId: env.NODE_ID!,
    accountAlias: env.NODE_ACCOUNT_ALIAS || "unknown",
    hostname: env.NODE_HOSTNAME || "",
    region: env.NODE_REGION,
    capabilities: opts.capabilities,
    preferredIp: opts.preferredIp,
    version: opts.version,
  };
  try {
    const res = await signedRequest(env, "POST", "/api/nodes/register", JSON.stringify(payload));
    return res.ok;
  } catch {
    return false;
  }
}

export async function heartbeat(
  env: PlatformEnv, health: NodeRecord["health"] = "healthy", preferredIp?: string,
): Promise<boolean> {
  if (!platformReady(env)) return false;
  const payload: HeartbeatRequest = { nodeId: env.NODE_ID!, health, preferredIp };
  try {
    const res = await signedRequest(env, "POST", "/api/nodes/heartbeat", JSON.stringify(payload));
    return res.ok;
  } catch {
    return false;
  }
}
