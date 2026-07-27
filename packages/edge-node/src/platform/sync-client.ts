/**
 * UUID 同步总线（节点侧）：拉取「有效 UUID 集 + 分流规则」并缓存到 KV。
 * 控制面不可达时回退到上次缓存，保证节点不因控制面抖动而全线掉线。
 */
import type { ActiveUuidsResponse } from "@opus8-cf/shared";
import { platformReady, signedRequest, type PlatformEnv } from "./client";

const KV_KEY = "opus8:active";
const MEM_TTL_MS = 30_000;

interface Cached { data: ActiveUuidsResponse; fetchedAt: number; }
let mem: Cached | null = null;

/** 返回当前有效状态；带多级缓存（内存 → KV → 控制面）。 */
export async function getActiveState(env: PlatformEnv): Promise<ActiveUuidsResponse> {
  const now = Date.now();
  if (mem && now - mem.fetchedAt < MEM_TTL_MS) return mem.data;

  // KV 缓存
  if (env.KV) {
    const raw = await env.KV.get(KV_KEY);
    if (raw) {
      try {
        const c = JSON.parse(raw) as Cached;
        if (now - c.fetchedAt < c.data.ttl * 1000) {
          mem = c;
          return c.data;
        }
      } catch { /* ignore */ }
    }
  }

  // 回源控制面
  if (platformReady(env)) {
    try {
      const res = await signedRequest(env, "GET", `/api/nodes/${env.NODE_ID}/uuids`);
      if (res.ok) {
        const data = (await res.json()) as ActiveUuidsResponse;
        const c: Cached = { data, fetchedAt: now };
        mem = c;
        if (env.KV) await env.KV.put(KV_KEY, JSON.stringify(c), { expirationTtl: Math.max(60, data.ttl * 4) });
        return data;
      }
    } catch { /* 网络失败，走回退 */ }
  }

  // 回退：过期的内存/KV 也比全掉线好
  if (mem) return mem.data;
  if (env.KV) {
    const raw = await env.KV.get(KV_KEY);
    if (raw) {
      try { return (JSON.parse(raw) as Cached).data; } catch { /* ignore */ }
    }
  }
  return {
    version: 0,
    ttl: 60,
    uuids: [],
    unlockUuids: [],
    unlockHosts: [],
    socks5Enabled: false,
  };
}

/** 主动失效本地缓存（收到控制面 purge 信号时用）。 */
export async function invalidate(env: PlatformEnv): Promise<void> {
  mem = null;
  if (env.KV) await env.KV.delete(KV_KEY);
}
