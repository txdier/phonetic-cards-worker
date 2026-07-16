-- 引入用户体系：新增 users 表，words 表增加 user_id 字段

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  created_at INTEGER NOT NULL
);

ALTER TABLE words ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_words_user ON words(user_id);
