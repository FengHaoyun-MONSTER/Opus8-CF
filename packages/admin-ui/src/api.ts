/** Opus8-CF 控制台 · API 客户端(调控制面 Worker) */

export interface User {
  id: string;
  username: string | null;
  uuid: string;
  plan_id: string | null;
  node_group: string | null;
  unlock: number;
  sub_token: string;
  expire_at: number | null;
  enabled: number;
  created_at: number;
  device_limit: number;
  ip_limit_24h: number;
  traffic_limit_bytes: number;
  bytes_up: number;
  bytes_down: number;
  connections: number;
  active_ips: number;
  recent_ips: number;
  access_state:
    | "active"
    | "disabled"
    | "expired"
    | "traffic_quota_exceeded"
    | "active_ip_limit_reached"
    | "ip_churn_limit_reached"
    | "traffic_near_quota"
    | "expiring_soon";
  access_severity: "healthy" | "warning" | "danger";
  access_reason: string;
}

export interface NodeRow {
  id: string;
  account_alias: string;
  hostname: string;
  region: string | null;
  preferred_ip: string | null;
  transport_path: string | null;
  health: string;
  enabled: number;
  last_seen: number | null;
  created_at: number;
  health_consecutive_failures?: number;
  health_consecutive_successes?: number;
  health_direct_ok?: number | null;
  health_landing_ok?: number | null;
  health_direct_latency_ms?: number | null;
  health_landing_latency_ms?: number | null;
  health_last_checked?: number | null;
  health_last_success?: number | null;
  health_last_failure?: number | null;
  health_last_error?: string | null;
  health_last_run_id?: string | null;
}

export interface OptimizedNodeIpPool {
  hostname: string;
  ips: string[];
  validatedAt: number;
  expiresAt: number;
  vantages: string[];
}

export interface OptimizedIpPoolResponse {
  ips: string[];
  active: boolean;
  activeNodeCount: number;
  subscriptionEnabled: boolean;
  pool: {
    version: 3;
    generatedAt: number;
    nodes: Record<string, OptimizedNodeIpPool>;
  } | null;
}

export interface CreateUserInput {
  username?: string;
  nodeGroup?: string[];
  unlock?: boolean;
  durationDays?: number;
  deviceLimit?: number;
  ipLimit24h?: number;
  trafficLimitBytes?: number;
}

export interface UnlockHostsConfig {
  hosts: string[];
  source: "default" | "custom";
  updatedAt: number;
}

export interface Landing {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  passwordConfigured: true;
  region: string | null;
  matchHosts: string[];
  priority: number;
  enabled: boolean;
  health: "healthy" | "unhealthy" | "unknown";
  lastChecked: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LandingInput {
  name: string;
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  region?: string;
  matchHosts: string[];
  priority: number;
  enabled: boolean;
}

export interface OperationsUser {
  id: string;
  username: string | null;
  enabled: number;
  expireAt: number | null;
  unlock: number;
  usedBytes: number;
  trafficLimitBytes: number;
  connections: number;
  activeIps: number;
  deviceLimit: number;
  recentIps: number;
  ipLimit24h: number;
  accessState: User["access_state"];
  accessSeverity: User["access_severity"];
  accessReason: string;
}

export interface AlertIncident {
  key: string;
  kind: "user" | "node" | "landing" | "optimized_ip";
  sourceId: string;
  severity: "healthy" | "warning" | "danger";
  title: string;
  detail: string;
  status: "open" | "resolved";
  firstSeen: number;
  lastChanged: number;
  resolvedAt: number | null;
  occurrenceCount: number;
}

export interface OperationsOverview {
  generatedAt: number;
  windowHours: number;
  summary: {
    totalUsers: number;
    activeUsers: number;
    blockedUsers: number;
    attentionUsers: number;
    activeIps: number;
    recentIps: number;
    totalTrafficBytes: number;
    windowTrafficBytes: number;
    windowConnections: number;
    totalNodes: number;
    healthyNodes: number;
    totalLandings: number;
    healthyLandings: number;
    unhealthyLandings: number;
    dangerAlerts: number;
    warningAlerts: number;
  };
  series: Array<{
    ts: number;
    bytesUp: number;
    bytesDown: number;
    connections: number;
  }>;
  topUsers: OperationsUser[];
  nodeTraffic: Array<{
    id: string;
    hostname: string;
    region: string | null;
    health: string;
    enabled: number;
    lastSeen: number | null;
    lastChecked: number | null;
    directOk: number | null;
    landingOk: number | null;
    directLatencyMs: number | null;
    landingLatencyMs: number | null;
    bytesUp: number;
    bytesDown: number;
    connections: number;
  }>;
  optimizedIp: {
    enabled: boolean;
    eligibleNodes: number;
    activeNodes: number;
    fallbackNodes: number;
    totalIps: number;
    generatedAt: number | null;
    earliestExpiresAt: number | null;
  };
  alertStorage: {
    backend: "d1";
    writes: number;
    kvWrites: 0;
  };
  alertIncidents: AlertIncident[];
  alerts: Array<{
    kind: "user" | "node" | "landing" | "optimized_ip";
    severity: "healthy" | "warning" | "danger";
    id: string;
    title: string;
    detail: string;
  }>;
}

export interface ComplianceStatus {
  proxyProvisioningAllowed: boolean;
  enforcement: "fail-closed" | "observe-only";
  policyId: string;
  reason:
    | "operator_override"
    | "documented_authorization_verified"
    | "documented_authorization_required";
}

export interface UserActivity {
  generatedAt: number;
  user: OperationsUser;
  activeLeases: Array<{
    fingerprint: string;
    nodeId: string;
    firstSeen: number;
    lastSeen: number;
    expiresAt: number;
  }>;
  recentFingerprints: Array<{
    fingerprint: string;
    firstSeen: number;
    lastSeen: number;
    active: boolean;
  }>;
  usageByNode: Array<{
    nodeId: string;
    bytesUp: number;
    bytesDown: number;
    connections: number;
    lastActive: number;
  }>;
}

interface Auth {
  base: string;
  token: string;
}

const KEY = "opus8-auth";
let auth: Auth = { base: "", token: "" };

export function loadAuth(): Auth {
  try {
    const s = localStorage.getItem(KEY);
    if (s) auth = JSON.parse(s) as Auth;
  } catch {
    /* ignore */
  }
  return auth;
}
export function setAuth(base: string, token: string): void {
  auth = { base: base.replace(/\/+$/, ""), token };
  localStorage.setItem(KEY, JSON.stringify(auth));
}
export function clearAuth(): void {
  auth = { base: "", token: "" };
  localStorage.removeItem(KEY);
}
export function isLoggedIn(): boolean {
  return !!auth.base && !!auth.token;
}
export function apiBase(): string {
  return auth.base;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  if (auth.token) headers["authorization"] = `Bearer ${auth.token}`;
  if (init.body) headers["content-type"] = "application/json";
  const res = await fetch(`${auth.base}${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error || `HTTP ${res.status}`;
    if (res.status === 401) clearAuth();
    throw new Error(msg);
  }
  return data as T;
}

export async function login(base: string, password: string): Promise<string> {
  const b = base.replace(/\/+$/, "");
  const res = await fetch(`${b}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    token?: string;
    error?: string;
  };
  if (!res.ok || !data.token)
    throw new Error(data.error || `登录失败 (HTTP ${res.status})`);
  setAuth(b, data.token);
  return data.token;
}

export const api = {
  operationsOverview: () => req<OperationsOverview>("/api/operations/overview"),
  complianceStatus: () =>
    req<ComplianceStatus>("/api/operations/compliance"),
  alertIncidents: (
    status: "all" | "open" | "resolved" = "all",
    limit = 50,
  ) =>
    req<{ backend: "d1"; kvWrites: 0; incidents: AlertIncident[] }>(
      `/api/operations/alerts?status=${status}&limit=${limit}`,
    ),
  listUsers: () => req<{ users: User[] }>("/api/users"),
  userActivity: (id: string) => req<UserActivity>(`/api/users/${id}/activity`),
  createUser: (input: CreateUserInput) =>
    req<{ user: User; subUrl: string }>("/api/users", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateUser: (
    id: string,
    input: {
      unlock?: boolean;
      enabled?: boolean;
      deviceLimit?: number;
      ipLimit24h?: number;
      trafficLimitBytes?: number;
    },
  ) =>
    req<{ ok: boolean }>(`/api/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteUser: (id: string) =>
    req<{ ok: boolean }>(`/api/users/${id}`, { method: "DELETE" }),
  resetUserUsage: (id: string) =>
    req<{ ok: boolean }>(`/api/users/${id}/usage/reset`, { method: "POST" }),
  resetUserLeases: (id: string) =>
    req<{ ok: boolean }>(`/api/users/${id}/leases/reset`, { method: "POST" }),
  listNodes: () => req<{ nodes: NodeRow[] }>("/api/nodes"),
  optimizedIps: () => req<OptimizedIpPoolResponse>("/api/optimized-ips"),
  getUnlockHosts: () => req<UnlockHostsConfig>("/api/settings/unlock-hosts"),
  putUnlockHosts: (hosts: string[]) =>
    req<UnlockHostsConfig>("/api/settings/unlock-hosts", {
      method: "PUT",
      body: JSON.stringify({ hosts }),
    }),
  resetUnlockHosts: () =>
    req<UnlockHostsConfig>("/api/settings/unlock-hosts", { method: "DELETE" }),
  listLandings: () => req<{ landings: Landing[] }>("/api/landings"),
  createLanding: (input: LandingInput) =>
    req<{ landing: Landing }>("/api/landings", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateLanding: (id: string, input: Partial<LandingInput>) =>
    req<{ landing: Landing }>(`/api/landings/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteLanding: (id: string) =>
    req<{ ok: boolean }>(`/api/landings/${id}`, { method: "DELETE" }),
  testLanding: (id: string) =>
    req<{ ok: boolean; latencyMs: number; error?: string }>(
      `/api/landings/${id}/test`,
      {
        method: "POST",
      },
    ),
};
