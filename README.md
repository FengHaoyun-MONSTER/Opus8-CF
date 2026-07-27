# Opus8-CF

一套把「多账号批量部署的分散 Cloudflare 边缘节点」和「统一控制面 + 按用户鉴权 + 订阅下发」缝合起来的
代理分发平台。设计目标见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 形态

- **数据面 `packages/edge-node`** — 增强版 edgetunnel（VLESS/Trojan-WS · gRPC · XHTTP · ECH · TLS分片 ·
  proxyIP/NAT64 · 可切换 SOCKS5 落地分流），多账号批量部署。
- **控制面 `packages/control-plane`** — Worker + D1 + KV：节点/用户注册表、订阅生成、UUID 同步总线、Admin API。
- **管理站 `packages/admin-ui`** — Cloudflare Pages（React/Vite），GitHub 自动部署。
- **编排 `.github/workflows` + `infra`** — 多账号矩阵部署、优选 IP、健康自愈。

## 状态（滚动更新）

- [x] P0 架构设计与骨架
- [x] P1 边缘节点平台层(鉴权/同步/分流/自注册)+ 注入方案 — 已过 typecheck
- [x] P2 控制面(D1 + Admin API + 订阅 + UUID 同步)— 已过 typecheck + crypto 运行时测试
- [x] P3 双账号四节点批量分发 + 自定义域名
- [x] P4 管理独立站（React+Vite）— 已过 tsc + vite build
- [x] P5 按用户权限 + 动态域名清单切换 CF/SOCKS5 出口
- [ ] P6 优选 IP 自动化 + 硬化
- [ ] P7 计费（暂缓，仅预留）

## 部署

所有凭据存于 GitHub Actions Secrets；部署经由 CI。见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。
先跑 **preflight** 工作流验证密钥、创建 D1/KV、探测落地机端口。

## 落地分流运维

- 管理站的“落地分流”页面可在线增删域名；规则保存在控制面 KV，节点约 60 秒内自动更新，无需重新部署。
- 用户只有开启“解锁”权限后，命中清单的目标域名才会走 SOCKS5 落地；其他流量使用 CF 直出。
- 代码默认值维护在 `infra/ai-unlock.txt`。修改并推送该文件会依次触发控制面和节点部署。
- 域名按“根域名或其子域名”精确匹配，不使用正则模糊后缀，避免 `evil-example.com` 误命中 `example.com`。

> ⚠️ 在 Cloudflare Workers 上跑代理违反其服务条款、规模化可能被封号。本项目按「封号常态化」设计
> （多账号 + 自愈轮换）。请使用独立小号，勿绑重要业务/付款账号。
