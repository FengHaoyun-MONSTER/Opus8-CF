// Opus8-CF 平台前置层（注入到 vendor 核心之前）。纯 JS，用 Workers 全局 fetch/crypto。
// 提供：有效 UUID、每用户落地权限、动态域名策略和节点心跳。

function OPUS8_dedupe(a) {
  return [...new Set(a.map((x) => String(x).toLowerCase()))];
}

async function OPUS8_hmac(secret, msg) {
  const k = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function OPUS8_signedFetch(env, method, path, body = "") {
  const ts = String(Date.now());
  const nodeId = env.NODE_ID;
  const sign = await OPUS8_hmac(env.NODE_HMAC_SECRET, ts + "." + nodeId + "." + body);
  const headers = { "x-opus8-ts": ts, "x-opus8-node": nodeId, "x-opus8-sign": sign };
  if (method === "POST") headers["content-type"] = "application/json";
  return fetch(env.CONTROL_PLANE_URL + path, {
    method,
    headers,
    body: method === "POST" ? body : undefined,
  });
}

function OPUS8_ready(env) {
  return !!(env.CONTROL_PLANE_URL && env.NODE_ID && env.NODE_HMAC_SECRET);
}

const OPUS8_requestPolicies = new WeakMap();

function OPUS8_normalizeState(data, userID, managed) {
  const uuids = Array.isArray(data?.uuids) ? data.uuids : [];
  // 兼容旧控制面：没有 unlockUuids 时继续沿用“所有用户可走落地”的原行为。
  const hasUnlockPolicy = Array.isArray(data?.unlockUuids);
  const unlockUuids = hasUnlockPolicy ? data.unlockUuids : uuids;
  return {
    version: Number(data?.version) || 0,
    ttl: Math.max(15, Number(data?.ttl) || 60),
    uuids: OPUS8_dedupe([userID, ...uuids]),
    unlockUuids: OPUS8_dedupe([userID, ...unlockUuids]),
    unlockHosts: Array.isArray(data?.unlockHosts)
      ? OPUS8_dedupe(
        data.unlockHosts
          .map((x) => String(x).trim().replace(/^\*\./, "").replace(/\.$/, ""))
          .filter(Boolean),
      )
      : [],
    socks5Enabled: data?.socks5Enabled !== false,
    routingManaged: managed && hasUnlockPolicy,
  };
}

function OPUS8_fallbackState(userID) {
  return OPUS8_normalizeState(
    { uuids: [], unlockUuids: [], unlockHosts: [], socks5Enabled: true, ttl: 60 },
    userID,
    false,
  );
}

function OPUS8_setRequestPolicy(request, state) {
  if (request && typeof request === "object") OPUS8_requestPolicies.set(request, state);
}

function OPUS8_canUseLanding(request, uuid) {
  const state = request && typeof request === "object"
    ? OPUS8_requestPolicies.get(request)
    : null;
  if (!state?.routingManaged) return null;
  if (!state.socks5Enabled) return false;
  const presentedUuid = Array.isArray(uuid) ? uuid.OPUS8_authenticated : uuid;
  const normalizedUuid = String(presentedUuid || "").toLowerCase();
  return state.unlockUuids.includes(normalizedUuid);
}

// true=优先落地，false=优先 CF 直出，null=旧控制面/离线兜底。
function OPUS8_decideLanding(request, uuid, host) {
  const allowed = OPUS8_canUseLanding(request, uuid);
  if (allowed !== true) return allowed;
  const state = OPUS8_requestPolicies.get(request);
  const normalizedHost = String(host || "").toLowerCase().replace(/\.$/, "");
  return state.unlockHosts.some((domain) =>
    normalizedHost === domain || normalizedHost.endsWith("." + domain));
}

// 多级缓存：KV(未过期) -> 控制面 -> KV(过期兜底) -> 本地管理员。
async function OPUS8_getActiveState(env, userID, ctx) {
  const fallback = OPUS8_fallbackState(userID);
  if (!OPUS8_ready(env)) return fallback;
  const KVKEY = "opus8:policy:v2";
  try {
    if (env.KV) {
      const raw = await env.KV.get(KVKEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c && c.exp > Date.now() && c.state) {
          return OPUS8_normalizeState(c.state, userID, true);
        }
      }
    }
  } catch (e) { /* ignore */ }
  try {
    const res = await OPUS8_signedFetch(env, "GET", "/api/nodes/" + env.NODE_ID + "/uuids");
    if (res.ok) {
      const state = OPUS8_normalizeState(await res.json(), userID, true);
      if (env.KV) {
        ctx.waitUntil(env.KV.put(
          KVKEY,
          JSON.stringify({ state, exp: Date.now() + state.ttl * 1000 }),
          { expirationTtl: Math.max(120, state.ttl * 4) },
        ));
      }
      return state;
    }
  } catch (e) { /* network fail -> fall through to stale cache */ }
  try {
    if (env.KV) {
      const raw = await env.KV.get(KVKEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c?.state) return OPUS8_normalizeState(c.state, userID, true);
      }
    }
  } catch (e) { /* ignore */ }
  return fallback;
}

let OPUS8_lastHB = 0;
async function OPUS8_heartbeat(env) {
  if (!OPUS8_ready(env)) return;
  const now = Date.now();
  if (now - OPUS8_lastHB < 60000) return; // 同一 isolate 内 60s 节流
  OPUS8_lastHB = now;
  try {
    await OPUS8_signedFetch(env, "POST", "/api/nodes/heartbeat",
      JSON.stringify({ nodeId: env.NODE_ID, health: "healthy" }));
  } catch (e) { /* ignore */ }
}
