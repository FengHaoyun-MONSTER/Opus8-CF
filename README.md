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
- [ ] P3 多账号批量分发（需 preflight 输出后接线）
- [x] P4 管理独立站（React+Vite）— 已过 tsc + vite build
- [ ] P5 可切换分流出口（代码就绪，待部署联调）
- [ ] P6 优选 IP 自动化 + 硬化
- [ ] P7 计费（暂缓，仅预留）

## 部署

所有凭据存于 GitHub Actions Secrets；部署经由 CI。见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。
先跑 **preflight** 工作流验证密钥、创建 D1/KV、探测落地机端口。

> ⚠️ 在 Cloudflare Workers 上跑代理违反其服务条款、规模化可能被封号。本项目按「封号常态化」设计
> （多账号 + 自愈轮换）。请使用独立小号，勿绑重要业务/付款账号。
