// Opus8-CF 平台前置层（注入到 vendor 核心之前）。纯 JS，用 Workers 全局 fetch/crypto。
// 提供：向控制面同步「有效 UUID 集」、自注册心跳。不改动核心任何既有能力。

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
  return fetch(env.CONTROL_PLANE_URL + path, { method, headers, body: method === "POST" ? body : undefined });
}

function OPUS8_ready(env) {
  return !!(env.CONTROL_PLANE_URL && env.NODE_ID && env.NODE_HMAC_SECRET);
}

// 返回允许连接的 UUID 集：控制面同步来的用户 UUID + 本地管理员 userID 兜底。
// 多级缓存：KV(未过期) -> 控制面 -> KV(过期兜底) -> [userID]
async function OPUS8_getActiveUUIDs(env, userID, ctx) {
  const base = [userID];
  if (!OPUS8_ready(env)) return base;
  const KVKEY = "opus8:active";
  try {
    if (env.KV) {
      const raw = await env.KV.get(KVKEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c && c.exp > Date.now()) return OPUS8_dedupe([userID, ...(c.uuids || [])]);
      }
    }
  } catch (e) { /* ignore */ }
  try {
    const res = await OPUS8_signedFetch(env, "GET", "/api/nodes/" + env.NODE_ID + "/uuids");
    if (res.ok) {
      const data = await res.json();
      const uuids = Array.isArray(data.uuids) ? data.uuids : [];
      const ttl = data.ttl || 60;
      if (env.KV) {
        ctx.waitUntil(env.KV.put(KVKEY, JSON.stringify({ uuids, exp: Date.now() + ttl * 1000 }),
          { expirationTtl: Math.max(120, ttl * 4) }));
      }
      return OPUS8_dedupe([userID, ...uuids]);
    }
  } catch (e) { /* network fail -> fall through to stale cache */ }
  try {
    if (env.KV) {
      const raw = await env.KV.get(KVKEY);
      if (raw) { const c = JSON.parse(raw); return OPUS8_dedupe([userID, ...((c && c.uuids) || [])]); }
    }
  } catch (e) { /* ignore */ }
  return base;
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
