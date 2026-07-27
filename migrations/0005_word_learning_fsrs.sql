CREATE TABLE word_review_state (
  word_id TEXT PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_at INTEGER NOT NULL,
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  elapsed_days INTEGER NOT NULL DEFAULT 0,
  scheduled_days INTEGER NOT NULL DEFAULT 0,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT 0 CHECK(state BETWEEN 0 AND 3),
  last_review_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO word_review_state
  (word_id, user_id, due_at, created_at, updated_at)
SELECT
  id, user_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM words
WHERE user_id IS NOT NULL;

CREATE TABLE word_review_logs (
  review_id TEXT PRIMARY KEY,
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 4),
  previous_version INTEGER NOT NULL,
  reviewed_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  state INTEGER NOT NULL CHECK(state BETWEEN 0 AND 3),
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  scheduled_days INTEGER NOT NULL,
  result_json TEXT NOT NULL
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, normalized_name)
);

CREATE TABLE word_tags (
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(word_id, tag_id)
);

CREATE TABLE word_relations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word_id_a TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  word_id_b TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK(
    relation_type IN ('family', 'derivative', 'synonym', 'antonym', 'confusable', 'other')
  ),
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(word_id_a < word_id_b),
  UNIQUE(user_id, word_id_a, word_id_b)
);

CREATE INDEX idx_word_review_due ON word_review_state(user_id, due_at);
CREATE INDEX idx_word_review_logs_word ON word_review_logs(word_id, reviewed_at DESC);
CREATE INDEX idx_tags_user_name ON tags(user_id, normalized_name);
CREATE INDEX idx_word_tags_tag ON word_tags(tag_id, word_id);
CREATE INDEX idx_word_relations_a ON word_relations(user_id, word_id_a);
CREATE INDEX idx_word_relations_b ON word_relations(user_id, word_id_b);
