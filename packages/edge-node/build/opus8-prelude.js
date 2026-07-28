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

function OPUS8_normalizeAccessPolicies(input) {
  const policies = {};
  if (!Array.isArray(input)) return policies;
  for (const item of input) {
    const uuid = String(item?.uuid || "").toLowerCase();
    if (!uuid) continue;
    policies[uuid] = {
      userId: String(item?.userId || ""),
      uuid,
      deviceLimit: Math.max(1, Number(item?.deviceLimit) || 2),
      ipLimit24h: Math.max(1, Number(item?.ipLimit24h) || 5),
      trafficLimitBytes: Math.max(0, Number(item?.trafficLimitBytes) || 0),
      usedBytes: Math.max(0, Number(item?.usedBytes) || 0),
    };
  }
  return policies;
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
    accessPolicies: OPUS8_normalizeAccessPolicies(data?.accessPolicies),
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

function OPUS8_policyCacheKey(env) {
  return "opus8:policy:v4:" + String(env?.NODE_ID || "unknown");
}

function OPUS8_policyInvalidationKey(env) {
  return "opus8:policy:invalidated:v1:" + String(env?.NODE_ID || "unknown");
}

async function OPUS8_invalidatedPolicyVersion(env) {
  if (!env?.KV) return 0;
  try {
    return Math.max(0, Number(await env.KV.get(OPUS8_policyInvalidationKey(env))) || 0);
  } catch (_) {
    return 0;
  }
}

function OPUS8_policyVersion(raw) {
  return Math.max(0, Number(raw?.version) || 0);
}

function OPUS8_constantTimeEqual(left, right) {
  const a = String(left || "").toLowerCase();
  const b = String(right || "").toLowerCase();
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

async function OPUS8_handleControlRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/__opus8/build" && request.method === "GET") {
    return new Response(JSON.stringify({
      nodeId: String(env?.NODE_ID || ""),
      buildId: String(env?.OPUS8_BUILD_ID || ""),
    }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  const isInvalidation = url.pathname === "/__opus8/policy/invalidate";
  const isStatus = url.pathname === "/__opus8/policy/status";
  if (!isInvalidation && !isStatus) return null;
  if (
    (isInvalidation && request.method !== "POST") ||
    (isStatus && request.method !== "GET")
  ) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { "cache-control": "no-store" },
    });
  }
  if (!OPUS8_ready(env) || !env.KV) {
    return new Response("Unavailable", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  const body = isInvalidation ? await request.text() : "";
  const timestamp = request.headers.get("x-opus8-ts") || "";
  const nodeId = request.headers.get("x-opus8-node") || "";
  const signature = request.headers.get("x-opus8-sign") || "";
  const timestampNumber = Number(timestamp);
  if (
    nodeId !== env.NODE_ID ||
    !Number.isFinite(timestampNumber) ||
    Math.abs(Date.now() - timestampNumber) > 5 * 60 * 1000
  ) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
  const expected = await OPUS8_hmac(
    env.NODE_HMAC_SECRET,
    timestamp + "." + nodeId + "." + body,
  );
  if (!OPUS8_constantTimeEqual(expected, signature)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
  if (isStatus) {
    const requestedUuid = String(url.searchParams.get("uuid") || "").toLowerCase();
    const invalidatedVersion = await OPUS8_invalidatedPolicyVersion(env);
    let cached = null;
    try {
      const cacheText = await env.KV.get(OPUS8_policyCacheKey(env));
      if (cacheText) cached = JSON.parse(cacheText);
    } catch (_) { /* report an empty cache */ }
    const cachedUuids = Array.isArray(cached?.raw?.uuids)
      ? cached.raw.uuids.map((value) => String(value).toLowerCase())
      : [];
    const status = {
      nodeId: env.NODE_ID,
      invalidatedVersion,
      cachedVersion: OPUS8_policyVersion(cached?.raw),
      cachedUuidCount: cachedUuids.length,
      cachedContainsUuid: Boolean(requestedUuid && cachedUuids.includes(requestedUuid)),
      cachedExpiresInMs: Number(cached?.exp || 0) - Date.now(),
      liveOk: false,
      liveStatus: 0,
      liveVersion: 0,
      liveUuidCount: 0,
      liveContainsUuid: false,
      liveError: "",
    };
    try {
      const liveResponse = await OPUS8_signedFetch(
        env,
        "GET",
        "/api/nodes/" + env.NODE_ID + "/uuids",
      );
      status.liveStatus = liveResponse.status;
      status.liveOk = liveResponse.ok;
      if (liveResponse.ok) {
        const live = await liveResponse.json();
        const liveUuids = Array.isArray(live?.uuids)
          ? live.uuids.map((value) => String(value).toLowerCase())
          : [];
        status.liveVersion = OPUS8_policyVersion(live);
        status.liveUuidCount = liveUuids.length;
        status.liveContainsUuid = Boolean(
          requestedUuid && liveUuids.includes(requestedUuid)
        );
      }
    } catch (error) {
      status.liveError = String(error?.message || error || "unknown").slice(0, 160);
    }
    return new Response(JSON.stringify(status), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (_) {
    return new Response("Bad Request", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
  const requestedVersion = Number(payload?.version);
  if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) {
    return new Response("Bad Request", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
  const currentVersion = await OPUS8_invalidatedPolicyVersion(env);
  const version = Math.max(currentVersion, requestedVersion);
  await Promise.all([
    env.KV.put(OPUS8_policyInvalidationKey(env), String(version)),
    env.KV.delete(OPUS8_policyCacheKey(env)),
    env.KV.delete("opus8:policy:v3"),
  ]);
  return new Response(JSON.stringify({ ok: true, version }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// 多级缓存：节点独立 KV(未过期) -> 控制面 -> 合格的过期 KV 兜底 -> 本地管理员。
async function OPUS8_getActiveState(env, userID, ctx) {
  const fallback = await OPUS8_fallbackState(userID);
  if (!OPUS8_ready(env)) return fallback;
  const KVKEY = OPUS8_policyCacheKey(env);
  const invalidatedVersion = await OPUS8_invalidatedPolicyVersion(env);
  try {
    if (env.KV) {
      const raw = await env.KV.get(KVKEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (
          c &&
          c.exp > Date.now() &&
          c.raw &&
          OPUS8_policyVersion(c.raw) >= invalidatedVersion
        ) {
          return await OPUS8_normalizeState(c.raw, userID, true, env);
        }
      }
    }
  } catch (e) { /* ignore */ }
  try {
    const res = await OPUS8_signedFetch(env, "GET", "/api/nodes/" + env.NODE_ID + "/uuids");
    if (res.ok) {
      const rawState = await res.json();
      if (OPUS8_policyVersion(rawState) < invalidatedVersion) return fallback;
      const state = await OPUS8_normalizeState(rawState, userID, true, env);
      if (env.KV) {
        await env.KV.put(
          KVKEY,
          JSON.stringify({ raw: rawState, exp: Date.now() + state.ttl * 1000 }),
          { expirationTtl: Math.max(60, state.ttl * 4) },
        );
      }
      return state;
    }
  } catch (e) { /* network fail -> fall through to stale cache */ }
  try {
    if (env.KV) {
      const raw = await env.KV.get(KVKEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c?.raw && OPUS8_policyVersion(c.raw) >= invalidatedVersion) {
          return await OPUS8_normalizeState(c.raw, userID, true, env);
        }
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

// 服务端防分享与流量计量。只保存 HMAC 后的 IP，绝不向控制面发送原始客户 IP。
const OPUS8_requestUsage = new WeakMap();
const OPUS8_socketUsage = new WeakMap();
const OPUS8_admissionCache = new Map();
const OPUS8_USAGE_FLUSH_BYTES = 1024 * 1024;
const OPUS8_USAGE_FLUSH_MS = 30_000;

function OPUS8_dataSize(value) {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  return Number(value?.byteLength || value?.size || 0);
}

function OPUS8_authenticatedUuid(uuid) {
  const presented = Array.isArray(uuid) ? uuid.OPUS8_authenticated : uuid;
  return String(presented || "").toLowerCase();
}

function OPUS8_usageRuntime(request) {
  return request && typeof request === "object" ? OPUS8_requestUsage.get(request) : null;
}

function OPUS8_scheduleUsage(runtime, final = false) {
  const promise = OPUS8_flushUsage(runtime, final).catch(() => {});
  try { runtime.ctx?.waitUntil?.(promise) } catch (_) { /* WebSocket event may outlive fetch ctx */ }
  return promise;
}

function OPUS8_maybeFlushUsage(runtime) {
  if (!runtime || runtime.closed) return;
  const total = runtime.bytesUp + runtime.bytesDown;
  if (
    total >= OPUS8_USAGE_FLUSH_BYTES ||
    (total > 0 && Date.now() - runtime.lastFlush >= OPUS8_USAGE_FLUSH_MS)
  ) {
    OPUS8_scheduleUsage(runtime, false);
  }
}

function OPUS8_enforceLocalQuota(runtime) {
  if (
    !runtime ||
    runtime.trafficLimitBytes <= 0 ||
    runtime.usedBytesAtStart + runtime.sessionBytes < runtime.trafficLimitBytes
  ) return false;
  try { runtime.socket?.close?.(1008, "traffic quota exceeded") } catch (_) { /* ignore */ }
  return true;
}

function OPUS8_createUsageRuntime(request, env, ctx, uuidRef, transport, socket = null) {
  const existing = OPUS8_usageRuntime(request);
  if (existing) return existing;
  const runtime = {
    request,
    env,
    ctx,
    socket,
    transport,
    uuidRef,
    uuid: "",
    leaseId: crypto.randomUUID(),
    seq: 0,
    bytesUp: 0,
    bytesDown: 0,
    sessionBytes: 0,
    usedBytesAtStart: 0,
    trafficLimitBytes: 0,
    connectionReported: false,
    lastFlush: Date.now(),
    queuedEvents: [],
    flushPromise: null,
    admissionPromise: null,
    initialFlushScheduled: false,
    lastAdmission: 0,
    admitted: false,
    closed: false,
  };
  OPUS8_requestUsage.set(request, runtime);
  if (socket) OPUS8_socketUsage.set(socket, runtime);
  return runtime;
}

function OPUS8_bindUsageSocket(webSocket, request, env, ctx, uuidRef) {
  if (!webSocket || OPUS8_socketUsage.has(webSocket)) return;
  const runtime = OPUS8_createUsageRuntime(
    request,
    env,
    ctx,
    uuidRef,
    "websocket",
    webSocket,
  );
  OPUS8_socketUsage.set(webSocket, runtime);
  webSocket.addEventListener("message", (event) => {
    OPUS8_maybeRenewAdmission(runtime);
    const size = OPUS8_dataSize(event.data);
    runtime.bytesUp += size;
    runtime.sessionBytes += size;
    OPUS8_enforceLocalQuota(runtime);
    OPUS8_maybeFlushUsage(runtime);
  });
  const finish = () => {
    OPUS8_finishUsage(runtime);
  };
  webSocket.addEventListener("close", finish);
  webSocket.addEventListener("error", finish);
}

function OPUS8_bindUsageStream(request, env, ctx, uuidRef, transport) {
  return OPUS8_createUsageRuntime(request, env, ctx, uuidRef, transport);
}

function OPUS8_attachUsageBridge(request, bridge) {
  const runtime = OPUS8_usageRuntime(request);
  if (!runtime || !bridge || OPUS8_socketUsage.has(bridge)) return;
  runtime.socket = bridge;
  OPUS8_socketUsage.set(bridge, runtime);
  if (typeof bridge.close === "function" && !bridge.OPUS8_closeWrapped) {
    const close = bridge.close.bind(bridge);
    bridge.close = (...args) => {
      OPUS8_finishUsage(runtime);
      return close(...args);
    };
    Object.defineProperty(bridge, "OPUS8_closeWrapped", { value: true });
  }
}

function OPUS8_noteUplink(request, payload) {
  const runtime = OPUS8_usageRuntime(request);
  if (!runtime || runtime.closed) return;
  OPUS8_maybeRenewAdmission(runtime);
  const size = OPUS8_dataSize(payload);
  runtime.bytesUp += size;
  runtime.sessionBytes += size;
  OPUS8_enforceLocalQuota(runtime);
  OPUS8_maybeFlushUsage(runtime);
}

function OPUS8_noteDownlink(webSocket, payload) {
  const runtime = OPUS8_socketUsage.get(webSocket);
  if (!runtime || runtime.closed) return;
  OPUS8_maybeRenewAdmission(runtime);
  const size = OPUS8_dataSize(payload);
  runtime.bytesDown += size;
  runtime.sessionBytes += size;
  OPUS8_enforceLocalQuota(runtime);
  OPUS8_maybeFlushUsage(runtime);
}

function OPUS8_finishUsage(requestOrRuntime) {
  const runtime = requestOrRuntime?.request
    ? requestOrRuntime
    : OPUS8_usageRuntime(requestOrRuntime);
  if (!runtime) return Promise.resolve();
  if (runtime.closed) return runtime.flushPromise || Promise.resolve();
  runtime.closed = true;
  return OPUS8_scheduleUsage(runtime, true);
}

function OPUS8_scheduleInitialStreamUsage(runtime) {
  if (
    !runtime ||
    runtime.transport === "websocket" ||
    runtime.initialFlushScheduled
  ) return;
  runtime.initialFlushScheduled = true;
  const promise = new Promise((resolve) => setTimeout(resolve, 2_000))
    .then(() => OPUS8_flushUsage(runtime, false))
    .catch(() => {});
  try { runtime.ctx?.waitUntil?.(promise) } catch (_) { /* ignore */ }
}

async function OPUS8_ipHash(runtime) {
  const request = runtime.request;
  const rawIp = request.headers.get("cf-connecting-ip")
    || request.headers.get("true-client-ip")
    || request.headers.get("x-real-ip")
    || "unknown";
  return OPUS8_hmac(
    runtime.env.NODE_HMAC_SECRET,
    "ip:v1:" + runtime.uuid + ":" + rawIp,
  );
}

function OPUS8_maybeRenewAdmission(runtime) {
  if (
    !runtime ||
    runtime.closed ||
    runtime.admissionPromise ||
    Date.now() - runtime.lastAdmission < 120_000
  ) return;
  const promise = OPUS8_requireAdmission(runtime.request, runtime.uuidRef, true)
    .catch(() => {
      try { runtime.socket?.close?.(1008, "access policy denied") } catch (_) { /* ignore */ }
    });
  try { runtime.ctx?.waitUntil?.(promise) } catch (_) { /* ignore */ }
}

async function OPUS8_requireAdmission(request, uuidRef, force = false) {
  const runtime = OPUS8_usageRuntime(request);
  if (!runtime) return true;
  const uuid = OPUS8_authenticatedUuid(uuidRef || runtime.uuidRef);
  if (!uuid) return true;
  runtime.uuid = uuid;
  const state = OPUS8_requestPolicies.get(request);
  const policy = state?.accessPolicies?.[uuid];
  if (!policy) return true;
  runtime.usedBytesAtStart = Number(policy.usedBytes || 0);
  runtime.trafficLimitBytes = Number(policy.trafficLimitBytes || 0);
  if (runtime.admissionPromise) return runtime.admissionPromise;

  runtime.admissionPromise = (async () => {
    const ipHash = await OPUS8_ipHash(runtime);
    const cacheKey = uuid + ":" + ipHash;
    const cachedUntil = Number(OPUS8_admissionCache.get(cacheKey) || 0);
    if (!force && cachedUntil > Date.now()) {
      if (OPUS8_enforceLocalQuota(runtime)) {
        throw new Error("OPUS8_ACCESS_DENIED:traffic_quota_exceeded");
      }
      runtime.admitted = true;
      runtime.lastAdmission = Date.now();
      return true;
    }

    const body = JSON.stringify({
      nodeId: runtime.env.NODE_ID,
      uuid,
      leaseId: runtime.leaseId,
      ipHash,
    });
    let response;
    try {
      response = await OPUS8_signedFetch(
        runtime.env,
        "POST",
        "/api/nodes/admission",
        body,
      );
    } catch (_) {
      // 控制面短时不可达时可用性优先；UUID 本身仍已由缓存策略校验。
      runtime.admitted = true;
      runtime.lastAdmission = Date.now();
      return true;
    }
    if (!response.ok) {
      runtime.admitted = true;
      runtime.lastAdmission = Date.now();
      return true;
    }
    const result = await response.json();
    if (!result?.allowed) {
      throw new Error("OPUS8_ACCESS_DENIED:" + String(result?.reason || "policy_denied"));
    }
    runtime.usedBytesAtStart = Number(result.usedBytes || runtime.usedBytesAtStart || 0);
    runtime.trafficLimitBytes = Number(
      result.trafficLimitBytes || runtime.trafficLimitBytes || 0,
    );
    if (OPUS8_enforceLocalQuota(runtime)) {
      throw new Error("OPUS8_ACCESS_DENIED:traffic_quota_exceeded");
    }
    runtime.admitted = true;
    runtime.lastAdmission = Date.now();
    const cacheMs = Math.min(45_000, Math.max(5_000, Number(result.leaseTtlMs) || 30_000));
    if (OPUS8_admissionCache.size > 512) OPUS8_admissionCache.clear();
    OPUS8_admissionCache.set(cacheKey, Date.now() + cacheMs);
    return true;
  })().finally(() => {
    runtime.admissionPromise = null;
  });
  const admitted = await runtime.admissionPromise;
  if (runtime.admitted) OPUS8_scheduleInitialStreamUsage(runtime);
  return admitted;
}

function OPUS8_queueUsageEvent(runtime) {
  const uuid = runtime.uuid || OPUS8_authenticatedUuid(runtime.uuidRef);
  if (!uuid) return;
  const state = OPUS8_requestPolicies.get(runtime.request);
  if (!runtime.admitted || !state?.accessPolicies?.[uuid]) return;
  if (
    runtime.bytesUp === 0 &&
    runtime.bytesDown === 0 &&
    runtime.connectionReported
  ) return;
  const event = {
    id: runtime.env.NODE_ID + ":" + runtime.leaseId + ":" + runtime.seq,
    uuid,
    connections: runtime.connectionReported ? 0 : 1,
    bytesUp: runtime.bytesUp,
    bytesDown: runtime.bytesDown,
    tsBucket: Math.floor(Date.now() / 3_600_000) * 3_600_000,
  };
  runtime.seq += 1;
  runtime.bytesUp = 0;
  runtime.bytesDown = 0;
  runtime.connectionReported = true;
  runtime.lastFlush = Date.now();
  runtime.queuedEvents.push(event);
}

async function OPUS8_flushUsage(runtime, final = false) {
  if (!runtime) return;
  OPUS8_queueUsageEvent(runtime);
  if (runtime.flushPromise) {
    await runtime.flushPromise;
    if (runtime.queuedEvents.length === 0) return;
  }
  runtime.flushPromise = (async () => {
    while (runtime.queuedEvents.length > 0) {
      const events = runtime.queuedEvents.slice(0, 20);
      const body = JSON.stringify({ nodeId: runtime.env.NODE_ID, events });
      let response;
      try {
        response = await OPUS8_signedFetch(
          runtime.env,
          "POST",
          "/api/nodes/usage",
          body,
        );
      } catch (_) {
        return;
      }
      if (!response.ok) return;
      runtime.queuedEvents.splice(0, events.length);
      if (!final) break;
    }
  })();
  try {
    await runtime.flushPromise;
  } finally {
    runtime.flushPromise = null;
  }
}
