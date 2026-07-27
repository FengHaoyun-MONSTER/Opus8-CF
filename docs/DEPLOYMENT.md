# Opus8-CF 部署手册

## 凭据与执行模型

所有敏感凭据都存放在 **GitHub Actions Secrets**，部署动作经由 GitHub Actions 运行（CI 引用 secrets 执行
`wrangler`、探测落地机等）。本机/沙箱读不到 secret 明文，这是设计使然。

### 已就绪的 Secrets（你已配置）

| Secret | 用途 | 账号 |
|---|---|---|
| `ACCOUNT_ID` / `ACCOUNT_ID_NUM1` | Cloudflare Account ID | acc1 / acc2 |
| `API_TOKEN` / `API_TOKEN_NUM1` | Cloudflare API Token | acc1 / acc2 |
| `ROOT_DOMAIN` / `ROOT_DOMAIN_NUM1` | 根域名 | acc1 / acc2 |
| `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` / `S3_API_ENDPOINT`（+`_NUM1`） | R2(S3) 凭据，用作优选IP/注册表产物存储 | acc1 / acc2 |
| `SERVICES_IP` / `SERVICES_USER` / `SERVICES_CODE` | SOCKS5 落地机 IP/用户/密码 | — |

### 生产密钥

| Secret | 用途 |
|---|---|
| `ADMIN_PASSWORD` | 管理后台登录密码 |
| `JWT_SECRET` | 管理 JWT 签名 |
| `NODE_HMAC_SECRET` | 边缘节点 ↔ 控制面 请求签名共享密钥 |
| `LANDING_CONFIG_KEY` | D1 中落地机账号密码的 AES-GCM 静态加密密钥（至少 32 字符） |

四项均必须以 GitHub Actions Secrets 保存，不要写入仓库。`LANDING_CONFIG_KEY` 不可随意轮换；直接更换会使已保存的
落地机凭据无法解密，应先迁移或重新录入。`NODE_HMAC_SECRET` 轮换后需让控制面和全部节点依次重新部署。

## 动态落地域名

部署控制面时，`infra/ai-unlock.txt` 会作为默认域名清单写入 Worker 配置。管理员在管理站保存自定义清单后，
自定义值持久化到控制面 KV，并优先于代码默认值。节点按 60 秒 TTL 拉取以下策略：

- 当前有效 UUID；
- 允许使用落地机的 UUID；
- 当前落地域名清单；
- SOCKS5 全局开关。
- 使用 `NODE_HMAC_SECRET` 加密的多落地机运行时配置包。

修改默认清单并推送 `main` 会触发 `deploy-control`；控制面成功后再触发 `deploy-nodes`。

## 多落地机

管理站“落地机”页面支持配置多台带认证的 SOCKS5 服务器：

- **负责域名为空**：默认落地，可服务全部解锁域名，也用于 CF 直连失败后的兜底。
- **填写负责域名**：只服务该根域名及其子域名；仍需在“落地分流”页面把目标加入全局分流清单。
- **多台负责同一域名**：按优先级数字从小到大尝试，单次连接超时或握手失败后自动切换。
- **停用**：约 60 秒内从所有节点候选池移除，无需重部署。
- **连通测试**：控制面执行用户名/密码认证并经落地机连接测试站点，结果和最近错误写回 D1。

首次升级部署时，如果 `landings` 表为空，`deploy-control` 会把现有
`SERVICES_IP` / `SERVICES_USER` / `SERVICES_CODE` 自动导入为端口 `40008` 的默认落地机。

## 首次流程

1. **跑 `preflight` 工作流**（Actions 页手动触发）：
   - 校验两个账号 token 是否 active、是否具备 Workers/KV/D1/Pages 权限；
   - 在 acc1 创建 D1 `opus8cf-db` 与 KV `OPUS8_KV`，输出它们的 id；
   - 探测 `SERVICES_IP` 上可用的 SOCKS5 端口。
2. 把 preflight 输出的 **D1 database_id / KV id** 填进 `packages/control-plane/wrangler.toml`；
   把**可用端口**填进 `infra/accounts.json` 的 `landing.port`。
3. 继续 P1/P2：部署边缘节点与控制面（后续工作流 `deploy-nodes.yml` 等）。

## Token 权限要求

`API_TOKEN` 至少需要：Account → Workers Scripts:Edit、Workers KV Storage:Edit、D1:Edit、
Cloudflare Pages:Edit；Zone → DNS:Edit（用自定义域时）。
你标注的是 "develop services" 权限组——preflight 会逐项探测并在 Summary 报告哪项缺失，据此补齐即可。
