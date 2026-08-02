CREATE TABLE IF NOT EXISTS article_translations (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_zh TEXT NOT NULL,
  paragraphs_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_article_translations_user
  ON article_translations(user_id, updated_at DESC);
