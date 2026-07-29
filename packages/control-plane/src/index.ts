/**
 * Opus8-CF 控制面 Worker
 * Admin API(JWT) + 节点接口(HMAC) + 订阅下发 + UUID 同步总线。
 * 零运行时依赖：手写小路由 + WebCrypto。
 */
import {
  hmacSign,
  jwtSign,
  jwtVerify,
  timingSafeEqual,
  randomHex,
  randomUuid,
  randomToken,
  SIGN_HEADERS,
  SIGN_WINDOW_MS,
  type ActiveUuidsResponse,
  type NodeRecord,
  type UserRecord,
  type RegisterRequest,
  type HeartbeatRequest,
} from "@opus8-cf/shared";
import {
  type Env,
  listNodes,
  upsertNode,
  touchNode,
  listUsers,
  insertUser,
  deleteUser,
  getUserByToken,
  activeUserPolicy,
  updateUserPolicy,
  getUserUsage,
  resetUserUsage,
  clearUserLeases,
  getUserLimits,
} from "./db";
import {
  nodesForUser,
  renderSubscription,
  pickFormat,
  type OptimizedIpsByNode,
} from "./subscription";
import {
  getUnlockHosts,
  putUnlockHosts,
  resetUnlockHosts,
  validateUnlockHosts,
} from "./routing";
import {
  createLanding,
  deleteLanding,
  listLandings,
  runtimeLandings,
  testLanding,
  updateLanding,
  type LandingInput,
} from "./landings";
import { sealJson } from "./secret-box";
import { admitConnection, recordUsage, type AdmissionInput } from "./usage";
import { getEdgePolicyVersion, publishEdgePolicyChange } from "./policy-cache";
import { operationsOverview, userOperationsActivity } from "./operations";
import {
  applyNodeHealthReport,
  nodeHealthOverview,
  type NodeHealthReportInput,
} from "./node-health";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...CORS },
  });
const err = (msg: string, status = 400) => json({ error: msg }, status);

/** 校验管理员 JWT，返回 true/false。 */
async function requireAdmin(req: Request, env: Env): Promise<boolean> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const payload = await jwtVerify(token, env.JWT_SECRET);
  return !!payload && payload.role === "admin";
}

/** 校验节点 HMAC 签名，返回 nodeId 或 null。body 为原始文本。 */
async function verifyNodeSig(
  req: Request,
  env: Env,
  body: string,
): Promise<string | null> {
  const ts = req.headers.get(SIGN_HEADERS.ts);
  const nodeId = req.headers.get(SIGN_HEADERS.node);
  const sign = req.headers.get(SIGN_HEADERS.sign);
  if (!ts || !nodeId || !sign) return null;
  if (Math.abs(Date.now() - Number(ts)) > SIGN_WINDOW_MS) return null;
  const ok = timingSafeEqual(
    await hmacSign(env.NODE_HMAC_SECRET, `${ts}.${nodeId}.${body}`),
    sign.toLowerCase(),
  );
  return ok ? nodeId : null;
}

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    if (m === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      // ---------- 健康 ----------
      if (p === "/__opus8/build") {
        return json({
          service: "opus8-cf-control",
          buildId: env.OPUS8_BUILD_ID || "unknown",
        });
      }
      if (p === "/" || p === "/health")
        return json({
          ok: true,
          service: "opus8-cf-control",
          buildId: env.OPUS8_BUILD_ID || "unknown",
        });

      // ---------- 管理员登录 ----------
      if (p === "/api/admin/login" && m === "POST") {
        const { password } = (await req.json().catch(() => ({}))) as {
          password?: string;
        };
        if (!password || !timingSafeEqual(password, env.ADMIN_PASSWORD))
          return err("密码错误", 401);
        const token = await jwtSign({ role: "admin" }, env.JWT_SECRET, 86400);
        return json({ token });
      }
      if (p === "/api/admin/me" && m === "GET") {
        return (await requireAdmin(req, env))
          ? json({ role: "admin" })
          : err("未授权", 401);
      }

      // ---------- 运营总览（admin） ----------
      if (p === "/api/operations/overview" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json(await operationsOverview(env));
      }
      if (p === "/api/operations/node-health" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json(await nodeHealthOverview(env));
      }
      if (p === "/api/operations/node-health/report" && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        try {
          const input = (await req.json()) as NodeHealthReportInput;
          return json(await applyNodeHealthReport(env, input));
        } catch (error) {
          return err((error as Error).message, 400);
        }
      }
      const activityMatch = p.match(/^\/api\/users\/([^/]+)\/activity$/);
      if (activityMatch && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const activity = await userOperationsActivity(env, activityMatch[1]);
        return activity ? json(activity) : err("用户不存在", 404);
      }

      // ---------- 用户管理（admin） ----------
      if (p === "/api/users" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json({ users: await listUsers(env) });
      }
      if (p === "/api/users" && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const b = (await req.json().catch(() => ({}))) as {
          username?: string;
          planId?: string;
          nodeGroup?: string[];
          unlock?: boolean;
          durationDays?: number;
          deviceLimit?: number;
          ipLimit24h?: number;
          trafficLimitBytes?: number;
        };
        let deviceLimit: number;
        let ipLimit24h: number;
        let trafficLimitBytes: number;
        try {
          deviceLimit = boundedInteger(b.deviceLimit, 1, 20, 2);
          ipLimit24h = boundedInteger(
            b.ipLimit24h,
            deviceLimit,
            100,
            Math.max(5, deviceLimit),
          );
          trafficLimitBytes = boundedInteger(
            b.trafficLimitBytes,
            0,
            Number.MAX_SAFE_INTEGER,
            0,
          );
        } catch (error) {
          return err((error as Error).message, 400);
        }
        const now = Date.now();
        const user: UserRecord = {
          id: randomHex(8),
          username: b.username ?? null,
          uuid: randomUuid(),
          plan_id: b.planId ?? null,
          node_group: b.nodeGroup ? JSON.stringify(b.nodeGroup) : null,
          unlock: b.unlock ? 1 : 0,
          sub_token: randomToken(),
          expire_at: b.durationDays ? now + b.durationDays * 86400_000 : null,
          enabled: 1,
          created_at: now,
        };
        await insertUser(env, user, {
          deviceLimit,
          ipLimit24h,
          trafficLimitBytes,
        });
        const policy = await publishEdgePolicyChange(env);
        // 订阅链接用 worker 实际访问源（workers.dev）；接入自定义域名后可改为 SUB_BASE。
        const base = env.SUB_BASE || url.origin;
        return json(
          {
            user,
            subUrl: `${base}/sub/${user.sub_token}`,
            policyVersion: policy.version,
            cacheInvalidation: policy.invalidation,
          },
          201,
        );
      }
      const userMatch = p.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch && m === "PATCH") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const b = (await req.json().catch(() => ({}))) as {
          unlock?: unknown;
          enabled?: unknown;
          deviceLimit?: unknown;
          ipLimit24h?: unknown;
          trafficLimitBytes?: unknown;
        };
        if (b.unlock !== undefined && typeof b.unlock !== "boolean")
          return err("unlock 必须是布尔值");
        if (b.enabled !== undefined && typeof b.enabled !== "boolean")
          return err("enabled 必须是布尔值");
        const deviceLimit = optionalBoundedInteger(b.deviceLimit, 1, 20);
        const ipLimit24h = optionalBoundedInteger(b.ipLimit24h, 1, 100);
        const trafficLimitBytes = optionalBoundedInteger(
          b.trafficLimitBytes,
          0,
          Number.MAX_SAFE_INTEGER,
        );
        if (
          deviceLimit === false ||
          ipLimit24h === false ||
          trafficLimitBytes === false
        ) {
          return err("连接限制或流量额度超出允许范围");
        }
        if (
          b.unlock === undefined &&
          b.enabled === undefined &&
          deviceLimit === undefined &&
          ipLimit24h === undefined &&
          trafficLimitBytes === undefined
        )
          return err("没有可更新的字段");
        const currentLimits = await getUserLimits(env, userMatch[1]);
        if (!currentLimits) return err("用户不存在", 404);
        const effectiveDeviceLimit =
          typeof deviceLimit === "number"
            ? deviceLimit
            : currentLimits.deviceLimit;
        const effectiveIpLimit24h =
          typeof ipLimit24h === "number"
            ? ipLimit24h
            : currentLimits.ipLimit24h;
        if (effectiveIpLimit24h < effectiveDeviceLimit) {
          return err("24 小时 IP 上限不能小于同时在线 IP 上限");
        }
        await updateUserPolicy(env, userMatch[1], {
          unlock: b.unlock as boolean | undefined,
          enabled: b.enabled as boolean | undefined,
          deviceLimit: deviceLimit as number | undefined,
          ipLimit24h: ipLimit24h as number | undefined,
          trafficLimitBytes: trafficLimitBytes as number | undefined,
        });
        const policy = await publishEdgePolicyChange(env);
        return json({
          ok: true,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      if (userMatch && m === "DELETE") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        await deleteUser(env, userMatch[1]);
        const policy = await publishEdgePolicyChange(env);
        return json({
          ok: true,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      const usageResetMatch = p.match(/^\/api\/users\/([^/]+)\/usage\/reset$/);
      if (usageResetMatch && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        await resetUserUsage(env, usageResetMatch[1]);
        return json({ ok: true });
      }
      const leaseResetMatch = p.match(/^\/api\/users\/([^/]+)\/leases\/reset$/);
      if (leaseResetMatch && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        await clearUserLeases(env, leaseResetMatch[1]);
        return json({ ok: true });
      }

      // ---------- 落地域名配置（admin） ----------
      if (p === "/api/settings/unlock-hosts" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json(await getUnlockHosts(env));
      }
      if (p === "/api/settings/unlock-hosts" && m === "PUT") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const b = (await req.json().catch(() => ({}))) as { hosts?: unknown };
        const validated = validateUnlockHosts(b.hosts);
        if (validated.invalidHosts.length > 0) {
          return json(
            {
              error: "存在无效域名；请只填写域名，不要包含协议、端口或路径",
              invalidHosts: validated.invalidHosts.slice(0, 20),
            },
            400,
          );
        }
        const routing = await putUnlockHosts(env, validated.hosts);
        const policy = await publishEdgePolicyChange(env);
        return json({
          ...routing,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      if (p === "/api/settings/unlock-hosts" && m === "DELETE") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const routing = await resetUnlockHosts(env);
        const policy = await publishEdgePolicyChange(env);
        return json({
          ...routing,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }

      // ---------- 多落地机配置（admin） ----------
      if (p === "/api/landings" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json({ landings: await listLandings(env) });
      }
      if (p === "/api/landings" && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const input = (await req.json().catch(() => ({}))) as LandingInput;
        let landing: Awaited<ReturnType<typeof createLanding>>;
        try {
          landing = await createLanding(env, input);
        } catch (error) {
          return err((error as Error).message, 400);
        }
        const policy = await publishEdgePolicyChange(env);
        return json(
          {
            landing,
            policyVersion: policy.version,
            cacheInvalidation: policy.invalidation,
          },
          201,
        );
      }
      const landingTestMatch = p.match(/^\/api\/landings\/([^/]+)\/test$/);
      if (landingTestMatch && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const result = await testLanding(env, landingTestMatch[1]);
        return result
          ? json(result, result.ok ? 200 : 502)
          : err("落地机不存在", 404);
      }
      const landingMatch = p.match(/^\/api\/landings\/([^/]+)$/);
      if (landingMatch && m === "PATCH") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const input = (await req.json().catch(() => ({}))) as LandingInput;
        let landing: Awaited<ReturnType<typeof updateLanding>>;
        try {
          landing = await updateLanding(env, landingMatch[1], input);
        } catch (error) {
          return err((error as Error).message, 400);
        }
        if (!landing) return err("落地机不存在", 404);
        const policy = await publishEdgePolicyChange(env);
        return json({
          landing,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      if (landingMatch && m === "DELETE") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        if (!(await deleteLanding(env, landingMatch[1]))) {
          return err("落地机不存在", 404);
        }
        const policy = await publishEdgePolicyChange(env);
        return json({
          ok: true,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }

      // ---------- 节点接口 ----------
      if (p === "/api/nodes" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json({ nodes: await listNodes(env) });
      }
      if (p === "/api/nodes/register" && m === "POST") {
        const body = await req.text();
        const nodeId = await verifyNodeSig(req, env, body);
        if (!nodeId) return err("签名校验失败", 401);
        const b = JSON.parse(body) as RegisterRequest;
        const now = Date.now();
        const rec: NodeRecord = {
          id: b.nodeId,
          account_alias: b.accountAlias,
          hostname: b.hostname,
          region: b.region ?? null,
          capabilities: b.capabilities ? JSON.stringify(b.capabilities) : null,
          preferred_ip: b.preferredIp ?? null,
          health: "healthy",
          enabled: 1,
          last_seen: now,
          created_at: now,
        };
        await upsertNode(env, rec);
        return json({ ok: true });
      }
      if (p === "/api/nodes/heartbeat" && m === "POST") {
        const body = await req.text();
        const nodeId = await verifyNodeSig(req, env, body);
        if (!nodeId) return err("签名校验失败", 401);
        const b = JSON.parse(body) as HeartbeatRequest;
        await touchNode(
          env,
          b.nodeId,
          b.health ?? "healthy",
          b.preferredIp ?? null,
          Date.now(),
        );
        return json({ ok: true });
      }
      if (p === "/api/nodes/admission" && m === "POST") {
        const body = await req.text();
        const nodeId = await verifyNodeSig(req, env, body);
        if (!nodeId) return err("签名校验失败", 401);
        const b = JSON.parse(body) as Omit<AdmissionInput, "nodeId"> & {
          nodeId?: string;
        };
        if (b.nodeId && b.nodeId !== nodeId) return err("节点身份不匹配", 401);
        try {
          return json(await admitConnection(env, { ...b, nodeId }));
        } catch (error) {
          return err((error as Error).message, 400);
        }
      }
      if (p === "/api/nodes/usage" && m === "POST") {
        const body = await req.text();
        const nodeId = await verifyNodeSig(req, env, body);
        if (!nodeId) return err("签名校验失败", 401);
        const b = JSON.parse(body) as { nodeId?: string; events?: unknown };
        if (b.nodeId && b.nodeId !== nodeId) return err("节点身份不匹配", 401);
        try {
          return json(await recordUsage(env, nodeId, b.events));
        } catch (error) {
          return err((error as Error).message, 400);
        }
      }
      // 优选 IP 池（供订阅使用；由 CFST 工作流写入）
      if (p === "/api/optimized-ips" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const pool = await getOptimizedIpPool(env);
        const ips = pool
          ? [...new Set(Object.values(pool.nodes).flatMap((node) => node.ips))]
          : [];
        return json({
          ips,
          active: Boolean(pool),
          activeNodeCount: pool ? Object.keys(pool.nodes).length : 0,
          subscriptionEnabled: env.USE_OPTIMIZED_IPS === "1",
          pool,
        });
      }
      if (p === "/api/optimized-ips" && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        try {
          const b = (await req.json().catch(() => ({}))) as Partial<OptimizedIpPool>;
          const pool = normalizeOptimizedIpPool(b);
          const registeredNodes = new Map(
            (await listNodes(env)).map((node) => [node.id, node]),
          );
          for (const [nodeId, nodePool] of Object.entries(pool.nodes)) {
            const registered = registeredNodes.get(nodeId);
            if (!registered) throw new Error(`优选 IP 包含未注册节点 ${nodeId}`);
            if (registered.hostname !== nodePool.hostname) {
              throw new Error(`节点 ${nodeId} 的主机名与注册信息不一致`);
            }
          }
          await env.KV.put("opus8:opt-ips", JSON.stringify(pool));
          const count = Object.values(pool.nodes).reduce(
            (sum, node) => sum + node.ips.length,
            0,
          );
          return json({
            ok: true,
            count,
            nodeCount: Object.keys(pool.nodes).length,
            nodes: pool.nodes,
          });
        } catch (error) {
          return err((error as Error).message, 400);
        }
      }
      // 有效 UUID 集（UUID 同步总线核心）
      const uuidsMatch = p.match(/^\/api\/nodes\/([^/]+)\/uuids$/);
      if (uuidsMatch && m === "GET") {
        const body = "";
        const nodeId = await verifyNodeSig(req, env, body);
        if (!nodeId || nodeId !== uuidsMatch[1])
          return err("签名校验失败", 401);
        const [policy, routing, landings, policyVersion] = await Promise.all([
          activeUserPolicy(env),
          getUnlockHosts(env),
          runtimeLandings(env),
          getEdgePolicyVersion(env),
        ]);
        const resp: ActiveUuidsResponse = {
          version: policyVersion,
          ttl: 15,
          uuids: policy.uuids,
          unlockUuids: policy.unlockUuids,
          unlockHosts: routing.hosts,
          socks5Enabled: true,
          accessPolicies: policy.accessPolicies,
          landingBundle: await sealJson(
            env.NODE_HMAC_SECRET,
            landings,
            `node:${nodeId}`,
          ),
        };
        return json(resp);
      }

      // ---------- 订阅下发 ----------
      const subMatch = p.match(/^\/sub\/([^/]+)$/);
      if (subMatch && m === "GET") {
        const user = await getUserByToken(env, subMatch[1]);
        if (!user || user.enabled !== 1) return err("订阅无效", 404);
        if (user.expire_at && user.expire_at < Date.now())
          return err("订阅已过期", 403);
        const nodes = nodesForUser(user, await listNodes(env));
        const fmt = pickFormat(
          req.headers.get("user-agent") || "",
          url.searchParams.get("format"),
        );
        // GitHub-hosted CFST 只代表运行器所在网络，不能作为终端用户的可用性证明。
        // 默认关闭 IP 展开；只有部署侧显式启用后才会把经过端到端验证的地址写入订阅。
        const optIpsByNode =
          env.USE_OPTIMIZED_IPS === "1"
            ? await getOptimizedIpsByNode(env, nodes)
            : {};
        const [{ body, contentType }, usage] = await Promise.all([
          Promise.resolve(
            renderSubscription(fmt, user, nodes, optIpsByNode),
          ),
          getUserUsage(env, user.id),
        ]);
        return new Response(body, {
          headers: {
            "content-type": contentType,
            "profile-update-interval": "12",
            "subscription-userinfo": subUserInfo(
              user,
              usage.bytesUp,
              usage.bytesDown,
              usage.trafficLimitBytes,
            ),
          },
        });
      }

      return err("未找到", 404);
    } catch (e) {
      return err(`内部错误: ${(e as Error).message}`, 500);
    }
  },
};

interface OptimizedNodeIpPool {
  hostname: string;
  ips: string[];
  validatedAt: number;
  expiresAt: number;
  vantages: string[];
}

interface OptimizedIpPool {
  version: 3;
  generatedAt: number;
  nodes: Record<string, OptimizedNodeIpPool>;
}

function uniqueCleanStrings(
  value: unknown,
  pattern: RegExp,
  limit: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && pattern.test(item)),
    ),
  ].slice(0, limit);
}

function normalizeOptimizedNodePool(
  value: Partial<OptimizedNodeIpPool>,
  requireFreshValidation: boolean,
  requireUnexpired: boolean,
): OptimizedNodeIpPool {
  const now = Date.now();
  const ips = uniqueCleanStrings(value.ips, /^[0-9a-fA-F.:]+$/, 10);
  const vantages = uniqueCleanStrings(
    value.vantages,
    /^[A-Za-z0-9._:-]+$/,
    10,
  );
  const hostname =
    typeof value.hostname === "string"
      ? value.hostname.trim().toLowerCase().slice(0, 253)
      : "";
  const validatedAt = Number(value.validatedAt);
  const expiresAt = Number(value.expiresAt);
  if (!hostname || !/^[a-z0-9.-]+$/.test(hostname)) {
    throw new Error("优选 IP 节点主机名无效");
  }
  if (ips.length === 0) throw new Error("节点优选 IP 池不能为空");
  if (
    !Number.isSafeInteger(validatedAt) ||
    validatedAt <= 0 ||
    validatedAt > now + 15 * 60_000 ||
    (requireFreshValidation && now - validatedAt > 15 * 60_000)
  ) {
    throw new Error("优选 IP 验证时间无效");
  }
  if (
    !Number.isSafeInteger(expiresAt) ||
    (requireUnexpired && expiresAt <= now) ||
    expiresAt > validatedAt + 24 * 60 * 60_000
  ) {
    throw new Error("优选 IP 有效期无效");
  }
  if (
    !vantages.includes("github-runner") ||
    !vantages.includes("landing-vps")
  ) {
    throw new Error("优选 IP 必须通过 GitHub Runner 与落地 VPS 双视角验证");
  }
  return {
    hostname,
    ips,
    validatedAt,
    expiresAt,
    vantages,
  };
}

function normalizeOptimizedIpPool(
  value: Partial<OptimizedIpPool>,
): OptimizedIpPool {
  if (!value.nodes || typeof value.nodes !== "object" || Array.isArray(value.nodes)) {
    throw new Error("按节点优选 IP 池不能为空");
  }
  const entries = Object.entries(value.nodes);
  if (entries.length === 0 || entries.length > 50) {
    throw new Error("按节点优选 IP 池数量无效");
  }
  const nodes: Record<string, OptimizedNodeIpPool> = {};
  for (const [nodeId, nodePool] of entries) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(nodeId)) {
      throw new Error(`优选 IP 节点 ID 无效: ${nodeId}`);
    }
    nodes[nodeId] = normalizeOptimizedNodePool(nodePool, true, true);
  }
  return { version: 3, generatedAt: Date.now(), nodes };
}

async function getOptimizedIpPool(env: Env): Promise<OptimizedIpPool | null> {
  try {
    const raw = await env.KV.get("opus8:opt-ips");
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<OptimizedIpPool>;
    if (
      value.version !== 3 ||
      !value.nodes ||
      typeof value.nodes !== "object" ||
      Array.isArray(value.nodes)
    ) {
      return null;
    }
    const nodes: Record<string, OptimizedNodeIpPool> = {};
    for (const [nodeId, nodePool] of Object.entries(value.nodes)) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(nodeId)) continue;
      try {
        const normalized = normalizeOptimizedNodePool(
          nodePool,
          false,
          false,
        );
        if (normalized.expiresAt > Date.now()) nodes[nodeId] = normalized;
      } catch {
        // One malformed or expired node must not suppress other safe nodes.
      }
    }
    if (Object.keys(nodes).length === 0) return null;
    return {
      version: 3,
      generatedAt: Number(value.generatedAt) || Date.now(),
      nodes,
    };
  } catch {
    return null;
  }
}

async function getOptimizedIpsByNode(
  env: Env,
  currentNodes: NodeRecord[],
): Promise<OptimizedIpsByNode> {
  const pool = await getOptimizedIpPool(env);
  if (!pool) return {};
  const registeredHostnames = new Map(
    currentNodes.map((node) => [node.id, node.hostname]),
  );
  return Object.fromEntries(
    Object.entries(pool.nodes)
      .filter(
        ([nodeId, node]) => registeredHostnames.get(nodeId) === node.hostname,
      )
      .map(([nodeId, node]) => [nodeId, node.ips]),
  );
}

function subUserInfo(
  user: UserRecord,
  upload = 0,
  download = 0,
  total = 0,
): string {
  const expire = user.expire_at ? Math.floor(user.expire_at / 1000) : 0;
  return `upload=${upload}; download=${download}; total=${total}; expire=${expire}`;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`整数必须位于 ${min} 到 ${max} 之间`);
  }
  return parsed;
}

function optionalBoundedInteger(
  value: unknown,
  min: number,
  max: number,
): number | undefined | false {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    return false;
  return parsed;
}
