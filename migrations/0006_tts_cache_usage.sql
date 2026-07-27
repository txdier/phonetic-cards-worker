CREATE TABLE IF NOT EXISTS tts_monthly_usage (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  used_chars INTEGER NOT NULL DEFAULT 0,
  reserved_chars INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, month),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tts_generation_leases (
  cache_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  token TEXT NOT NULL,
  character_count INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tts_generation_leases_expiry
  ON tts_generation_leases(lease_until);
