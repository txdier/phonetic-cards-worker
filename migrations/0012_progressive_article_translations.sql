CREATE TABLE IF NOT EXISTS article_translation_progress (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  title_zh TEXT,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS article_translation_paragraphs (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  paragraph_index INTEGER NOT NULL,
  translation_zh TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (article_id, user_id, source_hash, rules_version, paragraph_index)
);

CREATE INDEX IF NOT EXISTS idx_article_translation_paragraphs_current
  ON article_translation_paragraphs(article_id, user_id, source_hash, rules_version);
