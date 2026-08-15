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
  transport_path TEXT NOT NULL DEFAULT '/', -- WebSocket 数据面路径；查询参数由客户端格式单独生成
  health        TEXT DEFAULT 'unknown',     -- healthy / degraded / banned / unknown
  enabled       INTEGER DEFAULT 1,
  last_seen     INTEGER,                    -- 心跳时间戳(ms)
  created_at    INTEGER NOT NULL
);

-- 节点运行凭据。控制面只保存随机 salt，实际节点密钥由控制面根密钥派生；
-- 任一节点泄露后不能计算其他节点的密钥。
CREATE TABLE IF NOT EXISTS node_credentials (
  node_id         TEXT PRIMARY KEY,
  auth_mode       TEXT NOT NULL DEFAULT 'legacy'
    CHECK (auth_mode IN ('legacy', 'isolated', 'revoked')),
  current_salt    TEXT,
  previous_salt   TEXT,
  legacy_fallback INTEGER NOT NULL DEFAULT 0
    CHECK (legacy_fallback IN (0, 1)),
  activated_at    INTEGER,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  CHECK (auth_mode != 'isolated' OR current_salt IS NOT NULL)
);

-- 一次性节点注册/轮换令牌。token 本体只返回一次，库中仅保存 HMAC 摘要。
CREATE TABLE IF NOT EXISTS node_enrollments (
  id              TEXT PRIMARY KEY,
  node_id         TEXT NOT NULL,
  kind            TEXT NOT NULL
    CHECK (kind IN ('provision', 'migrate', 'rotate')),
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'issued', 'activated', 'revoked')),
  account_alias   TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  hostname        TEXT NOT NULL,
  region          TEXT,
  capabilities    TEXT NOT NULL DEFAULT '[]',
  preferred_ip    TEXT,
  transport_path  TEXT NOT NULL,
  token_hash      TEXT UNIQUE NOT NULL,
  secret_salt     TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  issued_at       INTEGER,
  activated_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_node_enrollments_node_status
  ON node_enrollments(node_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_node_enrollments_token
  ON node_enrollments(token_hash);

-- 只在首次引入节点隔离时将当时已经存在的生产节点标成 legacy。
-- 新节点若注册事务失败，后续 schema 重放不会错误地为其开启共享根密钥回退。
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO node_credentials (node_id, auth_mode, updated_at)
SELECT id, 'legacy', 0 FROM nodes
WHERE NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE id='node-isolation-v1'
);

INSERT OR IGNORE INTO schema_migrations (id, applied_at)
VALUES ('node-isolation-v1', 0);

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
  uuid        TEXT UNIQUE NOT NULL,         -- 用户身份 UUID；旧版静态用户可能同时将其作为连接凭证
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

-- Each device has its own subscription token and connection credential.
-- Existing users are backfilled as static credentials so upgrades do not break clients.
CREATE TABLE IF NOT EXISTS user_devices (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  base_uuid       TEXT UNIQUE NOT NULL,      -- 实际设备连接 UUID；新用户与 users.uuid 分离
  sub_token       TEXT UNIQUE NOT NULL,
  credential_mode TEXT NOT NULL DEFAULT 'static'
    CHECK (credential_mode IN ('static', 'rotating')),
  hwid_mode       TEXT NOT NULL DEFAULT 'off'
    CHECK (hwid_mode IN ('off', 'optional', 'required')),
  hwid_hash       TEXT,
  hwid_bound_at   INTEGER,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user
  ON user_devices(user_id, enabled, created_at);
CREATE INDEX IF NOT EXISTS idx_user_devices_subtoken
  ON user_devices(sub_token);
CREATE INDEX IF NOT EXISTS idx_user_devices_uuid
  ON user_devices(base_uuid);

-- Server-to-server campaign idempotency. The referenced user and device are
-- created in the same D1 batch as this record.
CREATE TABLE IF NOT EXISTS integration_claims (
  external_claim_id TEXT PRIMARY KEY,
  integration_id    TEXT NOT NULL,
  campaign_id       TEXT NOT NULL,
  user_id           TEXT NOT NULL UNIQUE,
  device_id         TEXT NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_integration_claims_campaign
  ON integration_claims(integration_id, campaign_id, created_at);

-- Idempotent compatibility migration. Existing users retain their legacy static credential.
INSERT OR IGNORE INTO user_devices
  (id, user_id, name, base_uuid, sub_token, credential_mode, hwid_mode,
   hwid_hash, hwid_bound_at, enabled, created_at, updated_at)
SELECT
  'legacy-' || id, id, 'Default device', uuid, sub_token, 'static', 'off',
  NULL, NULL, enabled, created_at, created_at
FROM users;

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

-- 仅保存由控制面按用户派生的稳定 HMAC 密钥生成的 IP 指纹，不保存客户原始 IP。
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

-- P6.7 告警事件：每个 kind/source_id 只保留一行，仅在开启、恢复、复发或级别变化时写入。
CREATE TABLE IF NOT EXISTS alert_incidents (
  incident_key     TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  source_id        TEXT NOT NULL,
  severity         TEXT NOT NULL,
  title            TEXT NOT NULL,
  detail           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  first_seen       INTEGER NOT NULL,
  last_changed     INTEGER NOT NULL,
  resolved_at      INTEGER,
  occurrence_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_alert_incidents_status_changed
  ON alert_incidents(status, last_changed DESC);

-- 计费预留（P7，一期不写入）
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  plan_id     TEXT,
  amount_cents INTEGER,
  status      TEXT DEFAULT 'reserved',
  created_at  INTEGER
);
