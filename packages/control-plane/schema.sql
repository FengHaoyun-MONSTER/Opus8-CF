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

-- 计费预留（P7，一期不写入）
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  plan_id     TEXT,
  amount_cents INTEGER,
  status      TEXT DEFAULT 'reserved',
  created_at  INTEGER
);
