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

### 待补的 Secrets（密钥三件套，由我生成）

| Secret | 用途 |
|---|---|
| `ADMIN_PASSWORD` | 管理后台登录密码 |
| `JWT_SECRET` | 管理 JWT 签名 |
| `NODE_HMAC_SECRET` | 边缘节点 ↔ 控制面 请求签名共享密钥 |

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
