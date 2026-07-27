// Opus8-CF 边缘节点构建：vendor 核心 + 平台前置 + 精准补丁 -> dist/index.js
// 用法：node build/build.mjs   （在 packages/edge-node 目录下）
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");

const core = readFileSync(join(pkg, "vendor", "core.js"), "utf8");
const prelude = readFileSync(join(here, "opus8-prelude.js"), "utf8");

// --- 补丁：把 activeUUIDs 的本地自管逻辑替换为控制面同步 ---
const startMarker = "let activeUUIDs = [userID];";
const startIdx = core.indexOf(startMarker);
if (startIdx === -1) throw new Error("PATCH FAIL: 找不到 activeUUIDs 起点");

const ifMarker = "if (env.KV && typeof env.KV.get === 'function') {";
const ifIdx = core.indexOf(ifMarker, startIdx);
if (ifIdx === -1) throw new Error("PATCH FAIL: 找不到 sub-links KV 块");

// 从 ifMarker 的 '{' 开始做花括号配对，找到该 if 块结束位置
let braceStart = core.indexOf("{", ifIdx);
let depth = 0, end = -1;
for (let i = braceStart; i < core.length; i++) {
  if (core[i] === "{") depth++;
  else if (core[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end === -1) throw new Error("PATCH FAIL: 花括号未配对");

const replaced = core.slice(startIdx, end);
// 安全断言：被替换的块必须确实是 sub-links 逻辑
if (!replaced.includes("sub-links.json")) {
  throw new Error("PATCH FAIL: 匹配到的块不含 sub-links.json，已中止以防误伤");
}

const injection =
  "const OPUS8_activeState = await OPUS8_getActiveState(env, userID, ctx);\n" +
  "\t\tlet activeUUIDs = OPUS8_activeState.uuids;\n" +
  "\t\tlet activeSubLinks = [];\n" +
  "\t\tOPUS8_setRequestPolicy(request, OPUS8_activeState);\n" +
  "\t\tglobalThis.OPUS8_LANDING = env.SOCKS5 || '';\n" +
  "\t\tif (env.OPUS8_HEARTBEAT !== '0') ctx.waitUntil(OPUS8_heartbeat(env));";

let patchedCore = core.slice(0, startIdx) + injection + core.slice(end);

// 断言补丁只命中一次、且注入函数存在
if (patchedCore.includes(startMarker)) throw new Error("PATCH FAIL: 起点标记仍残留（可能命中多处）");

// --- 补丁2：SOCKS5 落地从 env.SOCKS5 兜底（凭据留在节点，不进订阅链接）---
const s5re = new RegExp("\\tif \\(!我的SOCKS5账号\\) \\{\\r?\\n\\t\\t启用SOCKS5反代 = null;\\r?\\n\\t\\treturn;\\r?\\n\\t\\}");
if (!s5re.test(patchedCore)) throw new Error("PATCH2 FAIL: 找不到 SOCKS5 fallback 锚点");
const s5new = "\tif (!我的SOCKS5账号) {\n" +
  "\t\tif (globalThis.OPUS8_LANDING) { 我的SOCKS5账号 = globalThis.OPUS8_LANDING; 启用SOCKS5反代 = 'socks5'; }\n" +
  "\t\telse { 启用SOCKS5反代 = null; return; }\n" +
  "\t}";
patchedCore = patchedCore.replace(s5re, s5new);
if (s5re.test(patchedCore)) throw new Error("PATCH2 FAIL: 替换未生效");

// --- 补丁3：按控制面下发的用户权限 + 域名清单决定是否使用落地。---
// 返回 null 表示控制面仍是旧协议，此时完整保留 vendor 原有白名单行为。
const forwardStart = patchedCore.indexOf("async function forwardataTCP(");
const forwardEnd = patchedCore.indexOf("\nasync function forwardataudp(", forwardStart);
if (forwardStart === -1 || forwardEnd === -1) throw new Error("PATCH3 FAIL: 找不到 TCP 转发函数");
let forwardBlock = patchedCore.slice(forwardStart, forwardEnd);
const routeNeedle = "\tif (启用SOCKS5反代 && (启用SOCKS5全局反代 || SOCKS5白名单.some(p => new RegExp(`^${p.replace(/\\*/g, '.*')}$`, 'i').test(host)))) {";
if (!forwardBlock.includes(routeNeedle)) throw new Error("PATCH3 FAIL: 找不到 SOCKS5 路由条件");
const decision =
  "\tconst OPUS8_landingAllowed = OPUS8_canUseLanding(request, yourUUID);\n" +
  "\tconst OPUS8_landingDecision = OPUS8_decideLanding(request, yourUUID, host);\n" +
  "\tconst OPUS8_hasLandingCandidate = OPUS8_hasLandingCandidates(request, yourUUID, host);\n" +
  "\tconst OPUS8_hasLandingTransport = OPUS8_hasLandingCandidate || Boolean(启用SOCKS5反代);\n" +
  "\tconst OPUS8_useConfiguredProxy = OPUS8_landingDecision === null\n" +
  "\t\t? Boolean(启用SOCKS5反代 && (启用SOCKS5全局反代 || SOCKS5白名单.some(p => new RegExp(`^${p.replace(/\\*/g, '.*')}$`, 'i').test(host))))\n" +
  "\t\t: Boolean(OPUS8_hasLandingTransport && OPUS8_landingDecision);\n" +
  "\tconst OPUS8_allowConfiguredProxy = OPUS8_landingAllowed === null\n" +
  "\t\t? Boolean(启用SOCKS5反代)\n" +
  "\t\t: Boolean(OPUS8_hasLandingTransport && OPUS8_landingAllowed);\n";
const connectorNeedle = /\tconst TCP连接 = 创建请求TCP连接器\(request\);\r?\n/;
if (!connectorNeedle.test(forwardBlock)) throw new Error("PATCH3 FAIL: 找不到请求 TCP 连接器");
forwardBlock = forwardBlock.replace(
  connectorNeedle,
  () => "\tconst TCP连接 = 创建请求TCP连接器(request);\n" + decision,
);
forwardBlock = forwardBlock.replace(routeNeedle, "\tif (OPUS8_useConfiguredProxy) {");
for (const type of ["socks5", "http", "https", "turn", "sstp"]) {
  const needle = `启用SOCKS5反代 === '${type}'`;
  const replacement = `OPUS8_allowConfiguredProxy && ${needle}`;
  const before = forwardBlock;
  forwardBlock = forwardBlock.replace(needle, replacement);
  if (before === forwardBlock) throw new Error(`PATCH3 FAIL: 找不到 ${type} 代理分支`);
}
const socksBranchNeedle = "OPUS8_allowConfiguredProxy && 启用SOCKS5反代 === 'socks5'";
if (!forwardBlock.includes(socksBranchNeedle)) throw new Error("PATCH3 FAIL: 找不到动态 SOCKS5 分支");
forwardBlock = forwardBlock.replace(
  socksBranchNeedle,
  "OPUS8_allowConfiguredProxy && (启用SOCKS5反代 === 'socks5' || (OPUS8_hasLandingCandidate && !启用SOCKS5反代))",
);
const socksConnectNeedle = "newSocket = await socks5Connect(host, portNum, 本次首包数据, TCP连接);";
if (!forwardBlock.includes(socksConnectNeedle)) throw new Error("PATCH3 FAIL: 找不到 SOCKS5 连接调用");
forwardBlock = forwardBlock.replace(
  socksConnectNeedle,
  "newSocket = await OPUS8_connectViaLandings(request, yourUUID, host, portNum, 本次首包数据, TCP连接, socks5Connect, parsedSocks5Address);",
);
patchedCore = patchedCore.slice(0, forwardStart) + forwardBlock + patchedCore.slice(forwardEnd);

// --- 补丁4：记录 VLESS 校验时真正命中的 UUID，供每用户出口权限判断。---
const uuidMatchStart = patchedCore.indexOf("function UUID字节匹配(");
const uuidMatchEnd = patchedCore.indexOf("\nfunction 解析魏烈思请求(", uuidMatchStart);
if (uuidMatchStart === -1 || uuidMatchEnd === -1) throw new Error("PATCH4 FAIL: 找不到 UUID 匹配函数");
let uuidMatchBlock = patchedCore.slice(uuidMatchStart, uuidMatchEnd);
const matchedNeedle = "\t\tif (match) return true;";
if (!uuidMatchBlock.includes(matchedNeedle)) throw new Error("PATCH4 FAIL: 找不到 UUID 命中返回");
uuidMatchBlock = uuidMatchBlock.replace(
  matchedNeedle,
  "\t\tif (match) {\n" +
  "\t\t\tif (Array.isArray(uuid)) Object.defineProperty(uuid, 'OPUS8_authenticated', {\n" +
  "\t\t\t\tvalue: String(u).toLowerCase(), writable: true, configurable: true,\n" +
  "\t\t\t});\n" +
  "\t\t\treturn true;\n" +
  "\t\t}",
);
patchedCore = patchedCore.slice(0, uuidMatchStart) + uuidMatchBlock + patchedCore.slice(uuidMatchEnd);

// --- 补丁5：允许 SOCKS5 连接函数接收每次请求选择出的落地凭据，避免多落地并发串线。---
const socksFunctionNeedle = "async function socks5Connect(targetHost, targetPort, initialData, TCP连接) {";
const socksCredentialNeedle = "\tconst { username, password, hostname, port } = parsedSocks5Address;";
if (!patchedCore.includes(socksFunctionNeedle) || !patchedCore.includes(socksCredentialNeedle)) {
  throw new Error("PATCH5 FAIL: 找不到 SOCKS5 函数或凭据读取");
}
patchedCore = patchedCore.replace(
  socksFunctionNeedle,
  "async function socks5Connect(targetHost, targetPort, initialData, TCP连接, OPUS8_proxyAddress = null) {",
);
patchedCore = patchedCore.replace(
  socksCredentialNeedle,
  "\tconst { username, password, hostname, port } = OPUS8_proxyAddress || parsedSocks5Address;",
);

const out = "// [Opus8-CF build] prelude + patched vendor core\n" + prelude + "\n" + patchedCore;

mkdirSync(join(pkg, "dist"), { recursive: true });
writeFileSync(join(pkg, "dist", "index.js"), out);
console.log("OK build: dist/index.js (" + out.length + " bytes), patch replaced " + replaced.length + " chars");
