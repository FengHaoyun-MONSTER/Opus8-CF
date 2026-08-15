# 边缘节点接入方案（把平台层注入现有 `_worker.js`）

原则：**不重写** `_worker.js` 里久经考验的代理核心（VLESS/XHTTP 解析、ECH、TLS 分片、proxyIP/NAT64、
拨号），只在明确锚点注入平台能力。vendor 中的 gRPC 源码仅为上游同步保留，生产构建会把入口替换为
404，并强制分享链接回落到 WS/XHTTP。上游更新时重新执行构建补丁即可。

## 打包方式

- 把上游 `_worker.js` 作为 `vendor/core.js`（原样保留，仅在锚点加注释标记）。
- `src/platform/*.ts` 经 esbuild 打成 ESM 片段 `platform.js`。
- 构建脚本：`platform.js` + 打过补丁的 `core.js` → `dist/index.js`（P3 CI 里做）。

## 注入锚点（对照当前 `_worker.js` 行号，随版本微调）

### ① 鉴权集合 —— 替换 `activeUUIDs` 来源
- 现状：约 **L47** 派生 `userID`；**L50** `let activeUUIDs = [userID]`；**L52–L78** 从 KV `sub-links.json`
  用 `生成动态UUID` 自管多用户。
- 改为：
  ```js
  import { getActiveState } from './platform/sync-client'
  import { buildActiveUuidSet } from './platform/auth'
  const state = await getActiveState(env)
  let activeUUIDs = buildActiveUuidSet(state, userID)   // 同步来的用户 UUID + 本地管理员兜底
  ```
- 效果：面板新增/修改/停用/删除会推进策略版本，控制面主动通知节点清理独立缓存；通知失败时由
  15 秒 TTL 兜底。WS/XHTTP 处理器使用同一份 `activeUUIDs`，gRPC 入口在构建时禁用。

### ② 分流出口 —— 用 AI 解锁清单决定走 SOCKS5 还是 CF
- 现状：`GO2SOCKS5` / `SOCKS5白名单`（约 **L93**）按域名白名单决定是否走 SOCKS5。
- 改为：在真正外连的目标 host 确定处，调用
  ```js
  import { decideEgress } from './platform/egress-router'
  const egress = decideEgress(targetHost, state)   // 'socks5' | 'direct'
  ```
  `socks5` 时走落地机（复用核心已有的 SOCKS5 拨号路径 + `SERVICES_*` 注入的落地凭据），
  `direct` 时走默认 CF 出口 / proxyIP。解锁清单来自控制面（为空则用内置 `config/ai-unlock-domains.ts`）。

### ③ 自注册 / 心跳
- 在 `fetch` 入口早期（拿到 `url.hostname` 后），用 `ctx.waitUntil` 异步上报：
  ```js
  import { registerNode, heartbeat } from './platform/register'
  ctx.waitUntil(heartbeat(env, 'healthy', 反代IP))
  ```
  首次部署前由管理员创建一次性注册任务；CI 用绑定 Node ID、Cloudflare Account ID、
  域名和路径的令牌换取节点独立密钥，然后签名调用 `registerNode`。

### ④ 环境变量（wrangler.toml / CI 注入）
| 变量 | 含义 |
|---|---|
| `CONTROL_PLANE_URL` | 控制面 API 基址，如 `https://api.<ROOT_DOMAIN>` |
| `NODE_ID` | 部署时生成的节点 id |
| `NODE_HMAC_SECRET` | 一次性注册任务派生的每节点独立签名密钥（仅注入该节点 Worker） |
| `NODE_HOSTNAME` / `NODE_ACCOUNT_ALIAS` / `NODE_REGION` | 自注册元数据 |
| `KV` | 绑定本账号 KV，缓存有效 UUID 集与分流规则 |
| `SERVICES_IP/USER/CODE` + 端口 | 落地机（分流出口用） |

## 兼容性
- 平台层未就绪（`platformReady(env)===false`）时，`getActiveState` 返回空集且 `socks5Enabled=false`，
  节点行为退回「无有效用户、纯 CF 出口」，不会崩——便于单节点脱离控制面调试。
- 上游能力（ECH、分片、优选、竞速拨号等）零改动，全部保留。
