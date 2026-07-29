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
