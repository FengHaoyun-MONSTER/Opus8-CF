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
  "let activeUUIDs = await OPUS8_getActiveUUIDs(env, userID, ctx);\n" +
  "\t\tlet activeSubLinks = [];\n" +
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

const out = "// [Opus8-CF build] prelude + patched vendor core\n" + prelude + "\n" + patchedCore;

mkdirSync(join(pkg, "dist"), { recursive: true });
writeFileSync(join(pkg, "dist", "index.js"), out);
console.log("OK build: dist/index.js (" + out.length + " bytes), patch replaced " + replaced.length + " chars");
