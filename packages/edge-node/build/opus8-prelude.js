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

function OPUS8_b64urlDecode(value) {
  let normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function OPUS8_openLandingBundle(secret, nodeId, envelope) {
  const [version, ivPart, cipherPart] = String(envelope || "").split(".");
  if (version !== "v1" || !ivPart || !cipherPart) return [];
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: OPUS8_b64urlDecode(ivPart),
      additionalData: encoder.encode("node:" + nodeId),
    },
    key,
    OPUS8_b64urlDecode(cipherPart),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function OPUS8_normalizeLandings(input) {
  if (!Array.isArray(input)) return [];
  const output = [];
  for (const item of input) {
    const port = Number(item?.port);
    if (!item?.id || !item?.hostname || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (!item?.username || !item?.password) continue;
    output.push({
      id: String(item.id),
      hostname: String(item.hostname),
      port,
      username: String(item.username),
      password: String(item.password),
      matchHosts: Array.isArray(item.matchHosts)
        ? OPUS8_dedupe(
          item.matchHosts
            .map((x) => String(x).trim().replace(/^\*\./, "").replace(/\.$/, ""))
            .filter(Boolean),
        )
        : [],
      priority: Number(item.priority) || 100,
    });
  }
  return output.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

async function OPUS8_normalizeState(data, userID, managed, env = null) {
  const uuids = Array.isArray(data?.uuids) ? data.uuids : [];
  // 兼容旧控制面：没有 unlockUuids 时继续沿用“所有用户可走落地”的原行为。
  const hasUnlockPolicy = Array.isArray(data?.unlockUuids);
  const unlockUuids = hasUnlockPolicy ? data.unlockUuids : uuids;
  let landingData = Array.isArray(data?.landings) ? data.landings : [];
  if (env?.NODE_HMAC_SECRET && env?.NODE_ID && data?.landingBundle) {
    try {
      landingData = await OPUS8_openLandingBundle(
        env.NODE_HMAC_SECRET,
        env.NODE_ID,
        data.landingBundle,
      );
    } catch (e) {
      landingData = [];
    }
  }
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
    landings: OPUS8_normalizeLandings(landingData),
  };
}

async function OPUS8_fallbackState(userID) {
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

function OPUS8_hasDynamicLandings(request) {
  const state = request && typeof request === "object"
    ? OPUS8_requestPolicies.get(request)
    : null;
  return Boolean(state?.landings?.length);
}

function OPUS8_hasLandingCandidates(request, uuid, host) {
  return OPUS8_landingCandidates(request, uuid, host).length > 0;
}

function OPUS8_landingCandidates(request, uuid, host) {
  if (OPUS8_canUseLanding(request, uuid) !== true) return [];
  const state = OPUS8_requestPolicies.get(request);
  const normalizedHost = String(host || "").toLowerCase().replace(/\.$/, "");
  return state.landings.filter((landing) =>
    landing.matchHosts.length === 0 ||
    landing.matchHosts.some((domain) =>
      normalizedHost === domain || normalizedHost.endsWith("." + domain)));
}

async function OPUS8_withLandingTimeout(promise, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`落地机 ${label} 连接超时`)), 10_000);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function OPUS8_connectViaLandings(
  request,
  uuid,
  targetHost,
  targetPort,
  initialData,
  TCP连接,
  connector,
  legacyAddress,
) {
  const candidates = OPUS8_landingCandidates(request, uuid, targetHost);
  let lastError = null;
  for (const landing of candidates) {
    try {
      return await OPUS8_withLandingTimeout(
        connector(targetHost, targetPort, initialData, TCP连接, landing),
        landing.id,
      );
    } catch (error) {
      lastError = error;
    }
  }
  const duplicateLegacy = candidates.some((landing) =>
    landing.hostname === legacyAddress?.hostname &&
    landing.port === legacyAddress?.port &&
    landing.username === legacyAddress?.username &&
    landing.password === legacyAddress?.password);
  if (legacyAddress?.hostname && !duplicateLegacy) {
    try {
      return await OPUS8_withLandingTimeout(
        connector(targetHost, targetPort, initialData, TCP连接, legacyAddress),
        "legacy",
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("没有可用的 SOCKS5 落地机");
}

// 多级缓存：KV(未过期) -> 控制面 -> KV(过期兜底) -> 本地管理员。
async function OPUS8_getActiveState(env, userID, ctx) {
  const fallback = await OPUS8_fallbackState(userID);
  if (!OPUS8_ready(env)) return fallback;
  const KVKEY = "opus8:policy:v3";
  try {
    if (env.KV) {
      const raw = await env.KV.get(KVKEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c && c.exp > Date.now() && c.raw) {
          return await OPUS8_normalizeState(c.raw, userID, true, env);
        }
      }
    }
  } catch (e) { /* ignore */ }
  try {
    const res = await OPUS8_signedFetch(env, "GET", "/api/nodes/" + env.NODE_ID + "/uuids");
    if (res.ok) {
      const rawState = await res.json();
      const state = await OPUS8_normalizeState(rawState, userID, true, env);
      if (env.KV) {
        ctx.waitUntil(env.KV.put(
          KVKEY,
          JSON.stringify({ raw: rawState, exp: Date.now() + state.ttl * 1000 }),
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
        if (c?.raw) return await OPUS8_normalizeState(c.raw, userID, true, env);
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
