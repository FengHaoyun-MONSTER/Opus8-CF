import type { Env } from "./db";

const UNLOCK_HOSTS_KEY = "opus8:unlock-hosts:v1";
const MAX_UNLOCK_HOSTS = 500;
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

interface StoredUnlockHosts {
  hosts: string[];
  updatedAt: number;
}

export interface UnlockHostsConfig extends StoredUnlockHosts {
  source: "default" | "custom";
}

function normalizeOne(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let host = value.trim().toLowerCase();
  if (host.startsWith("*.")) host = host.slice(2);
  host = host.replace(/\.$/, "");
  if (!host || host.includes("://") || /[/?#:@\s]/.test(host)) return null;
  return DOMAIN_RE.test(host) ? host : null;
}

export function validateUnlockHosts(input: unknown): {
  hosts: string[];
  invalidHosts: string[];
} {
  if (!Array.isArray(input)) return { hosts: [], invalidHosts: ["配置必须是域名数组"] };
  const hosts: string[] = [];
  const invalidHosts: string[] = [];
  for (const value of input) {
    const normalized = normalizeOne(value);
    if (!normalized) {
      invalidHosts.push(String(value));
      continue;
    }
    if (!hosts.includes(normalized)) hosts.push(normalized);
  }
  if (hosts.length > MAX_UNLOCK_HOSTS) {
    invalidHosts.push(`域名数量不能超过 ${MAX_UNLOCK_HOSTS}`);
  }
  return { hosts: hosts.slice(0, MAX_UNLOCK_HOSTS), invalidHosts };
}

function defaultHosts(env: Env): string[] {
  return validateUnlockHosts(
    (env.DEFAULT_UNLOCK_HOSTS || "").split(",").filter(Boolean),
  ).hosts;
}

export async function getUnlockHosts(env: Env): Promise<UnlockHostsConfig> {
  try {
    const raw = await env.KV.get(UNLOCK_HOSTS_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as StoredUnlockHosts;
      const validated = validateUnlockHosts(stored.hosts);
      if (validated.invalidHosts.length === 0) {
        return {
          hosts: validated.hosts,
          updatedAt: Number(stored.updatedAt) || 0,
          source: "custom",
        };
      }
    }
  } catch {
    // KV 异常时继续使用随部署下发的默认清单。
  }
  return { hosts: defaultHosts(env), updatedAt: 0, source: "default" };
}

export async function putUnlockHosts(env: Env, hosts: string[]): Promise<UnlockHostsConfig> {
  const stored: StoredUnlockHosts = { hosts, updatedAt: Date.now() };
  await env.KV.put(UNLOCK_HOSTS_KEY, JSON.stringify(stored));
  return { ...stored, source: "custom" };
}

export async function resetUnlockHosts(env: Env): Promise<UnlockHostsConfig> {
  await env.KV.delete(UNLOCK_HOSTS_KEY);
  return getUnlockHosts(env);
}
