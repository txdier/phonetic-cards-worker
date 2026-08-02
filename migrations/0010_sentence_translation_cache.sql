CREATE TABLE IF NOT EXISTS sentence_translation_cache (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  sentence_text TEXT NOT NULL,
  translation_zh TEXT NOT NULL,
  model TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_sentence_translation_cache_lookup
  ON sentence_translation_cache(user_id, model, rules_version, updated_at DESC);
