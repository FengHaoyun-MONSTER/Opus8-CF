-- Opus8-CF 控制面 D1 主库 schema (P2)
-- 一期：多租户管理 + 订阅 + UUID 同步；计费表结构预留但不使用。

PRAGMA foreign_keys = ON;

-- 边缘节点注册表：CI 部署后由节点自注册/心跳写入
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,            -- node_id（部署时生成）
  account_alias TEXT NOT NULL,              -- acc1 / acc2 ...
  hostname      TEXT NOT NULL,              -- 节点访问域名（自定义域或 *.workers.dev）
  region        TEXT,                       -- 地区（自报/探测）
  capabilities  TEXT,                       -- JSON: 支持的协议/特性
  preferred_ip  TEXT,                       -- 当前优选 IP（优选流程写回）
  health        TEXT DEFAULT 'unknown',     -- healthy / degraded / banned / unknown
  enabled       INTEGER DEFAULT 1,
  last_seen     INTEGER,                    -- 心跳时间戳(ms)
  created_at    INTEGER NOT NULL
);

-- 外部端到端健康检查状态。节点心跳只证明 Worker 仍能运行，不能覆盖这里的真实 VLESS 探测结论。
CREATE TABLE IF NOT EXISTS node_health_state (
  node_id               TEXT PRIMARY KEY,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  direct_ok             INTEGER,
  landing_ok            INTEGER,
  direct_latency_ms     INTEGER,
  landing_latency_ms    INTEGER,
  last_checked          INTEGER,
  last_success          INTEGER,
  last_failure          INTEGER,
  last_error            TEXT,
  last_run_id           TEXT,
  updated_at            INTEGER NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS node_health_runs (
  run_id       TEXT PRIMARY KEY,
  checked_at   INTEGER NOT NULL,
  received_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS node_health_events (
  run_id             TEXT NOT NULL,
  node_id             TEXT NOT NULL,
  checked_at          INTEGER NOT NULL,
  direct_ok           INTEGER NOT NULL,
  landing_ok          INTEGER NOT NULL,
  direct_latency_ms   INTEGER,
  landing_latency_ms  INTEGER,
  error               TEXT,
  details             TEXT,
  PRIMARY KEY (run_id, node_id),
  FOREIGN KEY (run_id) REFERENCES node_health_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_node_health_events_checked
  ON node_health_events(checked_at DESC);

-- 用户/UUID 注册表：管理员创建；边缘节点据此鉴权
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT UNIQUE,
  uuid        TEXT UNIQUE NOT NULL,         -- 该用户的 VLESS/Trojan UUID
  plan_id     TEXT,
  node_group  TEXT,                          -- JSON: 分配的节点组/标签
  unlock      INTEGER DEFAULT 0,             -- 是否解锁套餐(走落地)
  sub_token   TEXT UNIQUE NOT NULL,          -- 订阅访问 token
  expire_at   INTEGER,                       -- 到期(ms)，NULL=永久
  enabled     INTEGER DEFAULT 1,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(uuid);
CREATE INDEX IF NOT EXISTS idx_users_subtoken ON users(sub_token);

-- SOCKS5 落地机注册表：凭据使用 LANDING_CONFIG_KEY 做 AES-GCM 加密。
CREATE TABLE IF NOT EXISTS landings (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  hostname       TEXT NOT NULL,
  port           INTEGER NOT NULL,
  credential_enc TEXT NOT NULL,
  region         TEXT,
  match_hosts    TEXT NOT NULL DEFAULT '[]', -- JSON；空数组=默认落地/可服务全部解锁域名
  priority       INTEGER NOT NULL DEFAULT 100,
  enabled        INTEGER NOT NULL DEFAULT 1,
  health         TEXT NOT NULL DEFAULT 'unknown',
  last_checked   INTEGER,
  last_error     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_landings_enabled_priority
  ON landings(enabled, priority, created_at);

-- 套餐（一期只用 node_group/unlock/时长，价格字段预留）
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  node_group  TEXT,
  unlock      INTEGER DEFAULT 0,
  duration_days INTEGER,
  device_limit  INTEGER,
  price_cents INTEGER DEFAULT 0,             -- 预留：一期不计费
  created_at  INTEGER NOT NULL
);

-- 尽力而为的用量聚合（连接数/粗略字节；非精确计费依据）
CREATE TABLE IF NOT EXISTS usage (
  user_id     TEXT NOT NULL,
  node_id     TEXT,
  ts_bucket   INTEGER NOT NULL,             -- 按小时/天分桶
  connections INTEGER DEFAULT 0,
  bytes_up    INTEGER DEFAULT 0,
  bytes_down  INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, node_id, ts_bucket)
);

-- 服务端防分享策略。device_limit 表示五分钟租约窗口内可同时活跃的公网 IP 数。
CREATE TABLE IF NOT EXISTS user_limits (
  user_id             TEXT PRIMARY KEY,
  device_limit        INTEGER NOT NULL DEFAULT 2,
  ip_limit_24h        INTEGER NOT NULL DEFAULT 5,
  traffic_limit_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 仅保存由 NODE_HMAC_SECRET HMAC 后的 IP，不保存客户原始 IP。
CREATE TABLE IF NOT EXISTS active_leases (
  user_id     TEXT NOT NULL,
  uuid        TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,
  lease_id    TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, ip_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_active_leases_expiry
  ON active_leases(user_id, expires_at);

CREATE TABLE IF NOT EXISTS ip_history (
  user_id     TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (user_id, ip_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ip_history_recent
  ON ip_history(user_id, last_seen);

-- 事件 ID + applied 标记保证节点重试不会重复累加流量。
CREATE TABLE IF NOT EXISTS usage_events (
  event_id    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  ts_bucket   INTEGER NOT NULL,
  connections INTEGER NOT NULL DEFAULT 0,
  bytes_up    INTEGER NOT NULL DEFAULT 0,
  bytes_down  INTEGER NOT NULL DEFAULT 0,
  applied     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_events_created
  ON usage_events(created_at);

-- 边缘策略版本。用户准入策略变更时单调递增，用于主动失效各节点缓存。
CREATE TABLE IF NOT EXISTS runtime_state (
  key         TEXT PRIMARY KEY,
  value       INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO runtime_state (key, value, updated_at)
VALUES ('edge_policy_version', 1, 0);

-- 计费预留（P7，一期不写入）
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  plan_id     TEXT,
  amount_cents INTEGER,
  status      TEXT DEFAULT 'reserved',
  created_at  INTEGER
);
