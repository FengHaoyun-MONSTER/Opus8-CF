/** 多租户鉴权：校验入站 UUID 是否在控制面同步来的有效集合内。 */
import type { ActiveUuidsResponse } from "@opus8-cf/shared";

export function isAuthorizedUuid(uuid: string, state: ActiveUuidsResponse): boolean {
  if (!uuid) return false;
  const target = uuid.toLowerCase();
  return state.uuids.some((u) => u.toLowerCase() === target);
}

/**
 * 生成用于替换 _worker.js 中 `activeUUIDs` 的集合。
 * 保留节点自身管理员 UUID（本地兜底/调试），并并入同步来的用户 UUID。
 */
export function buildActiveUuidSet(state: ActiveUuidsResponse, localAdminUuid?: string): string[] {
  const set = new Set(state.uuids.map((u) => u.toLowerCase()));
  if (localAdminUuid) set.add(localAdminUuid.toLowerCase());
  return [...set];
}
