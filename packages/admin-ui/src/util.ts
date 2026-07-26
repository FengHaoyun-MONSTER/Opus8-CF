import { apiBase } from "./api";

export function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtExpire(ms: number | null): string {
  if (!ms) return "永久";
  const left = ms - Date.now();
  if (left <= 0) return "已过期";
  const days = Math.floor(left / 86400_000);
  return days > 0 ? `${days} 天后` : "不足 1 天";
}

export function relTime(ms: number | null): string {
  if (!ms) return "从未";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

export function subUrlFor(token: string): string {
  return `${apiBase()}/sub/${token}`;
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}
