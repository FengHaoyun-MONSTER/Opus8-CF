/**
 * 可切换分流出口决策：命中 AI 解锁清单 → 走 SOCKS5 落地机；否则走默认 CF 出口。
 * 规则优先用控制面下发的 unlockHosts；为空时回退到内置 AI_UNLOCK_LIST。
 */
import type { ActiveUuidsResponse } from "@opus8-cf/shared";
import { AI_UNLOCK_LIST, isUnlockHost } from "../../config/ai-unlock-domains";

export type Egress = "socks5" | "direct";

export function decideEgress(host: string, state: ActiveUuidsResponse): Egress {
  if (!state.socks5Enabled) return "direct";
  const list = state.unlockHosts.length > 0 ? state.unlockHosts : AI_UNLOCK_LIST;
  return isUnlockHost(host, list) ? "socks5" : "direct";
}
