CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,
  account_alias TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  region        TEXT,
  capabilities  TEXT,
  preferred_ip  TEXT,
  health        TEXT DEFAULT 'unknown',
  enabled       INTEGER DEFAULT 1,
  last_seen     INTEGER,
  created_at    INTEGER NOT NULL
);

INSERT INTO nodes (
  id, account_alias, hostname, region, capabilities, preferred_ip,
  health, enabled, last_seen, created_at
) VALUES (
  'legacy-node', 'legacy', 'legacy.example.com', NULL, '["vless-ws"]', NULL,
  'healthy', 1, 1, 1
);

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  username    TEXT UNIQUE,
  uuid        TEXT UNIQUE NOT NULL,
  plan_id     TEXT,
  node_group  TEXT,
  unlock      INTEGER DEFAULT 0,
  sub_token   TEXT UNIQUE NOT NULL,
  expire_at   INTEGER,
  enabled     INTEGER DEFAULT 1,
  created_at  INTEGER NOT NULL
);

INSERT INTO users (
  id, username, uuid, plan_id, node_group, unlock, sub_token,
  expire_at, enabled, created_at
) VALUES (
  'legacy-user', 'legacy-user', '11111111-1111-4111-8111-111111111111',
  NULL, NULL, 0, 'legacy-subscription-token-000001',
  NULL, 1, 1
);
