/**
 * Opus8-CF 控制面 Worker
 * Admin API(JWT) + 节点接口(HMAC) + 订阅下发 + UUID 同步总线。
 * 零运行时依赖：手写小路由 + WebCrypto。
 */
import {
  hmacSign, jwtSign, jwtVerify, timingSafeEqual,
  randomHex, randomUuid, randomToken,
  SIGN_HEADERS, SIGN_WINDOW_MS,
  type ActiveUuidsResponse, type NodeRecord, type UserRecord, type RegisterRequest, type HeartbeatRequest,
} from "@opus8-cf/shared";
import {
  type Env, listNodes, upsertNode, touchNode, listUsers, insertUser, deleteUser,
  getUserByToken, activeUserPolicy, updateUserPolicy,
} from "./db";
import { nodesForUser, renderSubscription, pickFormat } from "./subscription";
import {
  getUnlockHosts, putUnlockHosts, resetUnlockHosts, validateUnlockHosts,
} from "./routing";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...CORS } });
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
async function verifyNodeSig(req: Request, env: Env, body: string): Promise<string | null> {
  const ts = req.headers.get(SIGN_HEADERS.ts);
  const nodeId = req.headers.get(SIGN_HEADERS.node);
  const sign = req.headers.get(SIGN_HEADERS.sign);
  if (!ts || !nodeId || !sign) return null;
  if (Math.abs(Date.now() - Number(ts)) > SIGN_WINDOW_MS) return null;
  const ok = timingSafeEqual(await hmacSign(env.NODE_HMAC_SECRET, `${ts}.${nodeId}.${body}`), sign.toLowerCase());
  return ok ? nodeId : null;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    if (m === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      // ---------- 健康 ----------
      if (p === "/" || p === "/health") return json({ ok: true, service: "opus8-cf-control" });

      // ---------- 管理员登录 ----------
      if (p === "/api/admin/login" && m === "POST") {
        const { password } = (await req.json().catch(() => ({}))) as { password?: string };
        if (!password || !timingSafeEqual(password, env.ADMIN_PASSWORD)) return err("密码错误", 401);
        const token = await jwtSign({ role: "admin" }, env.JWT_SECRET, 86400);
        return json({ token });
      }
      if (p === "/api/admin/me" && m === "GET") {
        return (await requireAdmin(req, env)) ? json({ role: "admin" }) : err("未授权", 401);
      }

      // ---------- 用户管理（admin） ----------
      if (p === "/api/users" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json({ users: await listUsers(env) });
      }
      if (p === "/api/users" && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const b = (await req.json().catch(() => ({}))) as {
          username?: string; planId?: string; nodeGroup?: string[]; unlock?: boolean; durationDays?: number;
        };
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
        await insertUser(env, user);
        // 订阅链接用 worker 实际访问源（workers.dev）；接入自定义域名后可改为 SUB_BASE。
        const base = env.SUB_BASE || url.origin;
        return json({ user, subUrl: `${base}/sub/${user.sub_token}` }, 201);
      }
      const userMatch = p.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch && m === "PATCH") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const b = (await req.json().catch(() => ({}))) as {
          unlock?: unknown; enabled?: unknown;
        };
        if (b.unlock !== undefined && typeof b.unlock !== "boolean") return err("unlock 必须是布尔值");
        if (b.enabled !== undefined && typeof b.enabled !== "boolean") return err("enabled 必须是布尔值");
        if (b.unlock === undefined && b.enabled === undefined) return err("没有可更新的字段");
        await updateUserPolicy(env, userMatch[1], {
          unlock: b.unlock as boolean | undefined,
          enabled: b.enabled as boolean | undefined,
        });
        return json({ ok: true });
      }
      if (userMatch && m === "DELETE") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        await deleteUser(env, userMatch[1]);
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
          return json({
            error: "存在无效域名；请只填写域名，不要包含协议、端口或路径",
            invalidHosts: validated.invalidHosts.slice(0, 20),
          }, 400);
        }
        return json(await putUnlockHosts(env, validated.hosts));
      }
      if (p === "/api/settings/unlock-hosts" && m === "DELETE") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json(await resetUnlockHosts(env));
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
          id: b.nodeId, account_alias: b.accountAlias, hostname: b.hostname,
          region: b.region ?? null, capabilities: b.capabilities ? JSON.stringify(b.capabilities) : null,
          preferred_ip: b.preferredIp ?? null, health: "healthy", enabled: 1, last_seen: now, created_at: now,
        };
        await upsertNode(env, rec);
        return json({ ok: true });
      }
      if (p === "/api/nodes/heartbeat" && m === "POST") {
        const body = await req.text();
        const nodeId = await verifyNodeSig(req, env, body);
        if (!nodeId) return err("签名校验失败", 401);
        const b = JSON.parse(body) as HeartbeatRequest;
        await touchNode(env, b.nodeId, b.health ?? "healthy", b.preferredIp ?? null, Date.now());
        return json({ ok: true });
      }
      // 优选 IP 池（供订阅使用；由 CFST 工作流写入）
      if (p === "/api/optimized-ips" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json({ ips: await getOptimizedIps(env) });
      }
      if (p === "/api/optimized-ips" && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const b = (await req.json().catch(() => ({}))) as { ips?: string[] };
        const ips = Array.isArray(b.ips)
          ? b.ips.filter((x) => typeof x === "string" && /^[0-9a-fA-F.:]+$/.test(x)).slice(0, 50)
          : [];
        await env.KV.put("opus8:opt-ips", JSON.stringify(ips));
        return json({ ok: true, count: ips.length });
      }
      // 有效 UUID 集（UUID 同步总线核心）
      const uuidsMatch = p.match(/^\/api\/nodes\/([^/]+)\/uuids$/);
      if (uuidsMatch && m === "GET") {
        const body = "";
        const nodeId = await verifyNodeSig(req, env, body);
        if (!nodeId) return err("签名校验失败", 401);
        const [policy, routing] = await Promise.all([
          activeUserPolicy(env),
          getUnlockHosts(env),
        ]);
        const resp: ActiveUuidsResponse = {
          version: Date.now(), ttl: 60,
          uuids: policy.uuids,
          unlockUuids: policy.unlockUuids,
          unlockHosts: routing.hosts,
          socks5Enabled: true,
        };
        return json(resp);
      }

      // ---------- 订阅下发 ----------
      const subMatch = p.match(/^\/sub\/([^/]+)$/);
      if (subMatch && m === "GET") {
        const user = await getUserByToken(env, subMatch[1]);
        if (!user || user.enabled !== 1) return err("订阅无效", 404);
        if (user.expire_at && user.expire_at < Date.now()) return err("订阅已过期", 403);
        const nodes = nodesForUser(user, await listNodes(env));
        const fmt = pickFormat(req.headers.get("user-agent") || "", url.searchParams.get("format"));
        // GitHub-hosted CFST 只代表运行器所在网络，不能作为终端用户的可用性证明。
        // 默认关闭 IP 展开；只有部署侧显式启用后才会把经过端到端验证的地址写入订阅。
        const optIps = env.USE_OPTIMIZED_IPS === "1" ? await getOptimizedIps(env) : [];
        const { body, contentType } = renderSubscription(fmt, user, nodes, optIps);
        return new Response(body, {
          headers: {
            "content-type": contentType,
            "profile-update-interval": "12",
            "subscription-userinfo": subUserInfo(user),
          },
        });
      }

      return err("未找到", 404);
    } catch (e) {
      return err(`内部错误: ${(e as Error).message}`, 500);
    }
  },
};

async function getOptimizedIps(env: Env): Promise<string[]> {
  try {
    const raw = await env.KV.get("opus8:opt-ips");
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

function subUserInfo(user: UserRecord): string {
  const expire = user.expire_at ? Math.floor(user.expire_at / 1000) : 0;
  // upload/download/total 一期不做精确计量，给占位值
  return `upload=0; download=0; total=0; expire=${expire}`;
}
