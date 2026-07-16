ALTER TABLE words ADD COLUMN lemma TEXT;
UPDATE words SET lemma = en WHERE lemma IS NULL OR trim(lemma) = '';

CREATE TABLE word_forms (
  id TEXT PRIMARY KEY,
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  form TEXT NOT NULL,
  normalized_form TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(word_id, normalized_form)
);

INSERT INTO word_forms (id, word_id, user_id, form, normalized_form, created_at)
SELECT 'legacy:' || id, id, user_id, en, lower(trim(en)), created_at
FROM words WHERE user_id IS NOT NULL;

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE marked_terms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('word', 'phrase')),
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, normalized_text)
);

CREATE TABLE article_markings (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_text TEXT NOT NULL,
  selected_text TEXT NOT NULL,
  context_sentence TEXT NOT NULL,
  marked_term_id TEXT REFERENCES marked_terms(id) ON DELETE CASCADE,
  word_id TEXT REFERENCES words(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  CHECK((marked_term_id IS NOT NULL AND word_id IS NULL) OR
        (marked_term_id IS NULL AND word_id IS NOT NULL)),
  UNIQUE(article_id, normalized_text)
);

CREATE TABLE article_progress (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_position_ratio REAL NOT NULL DEFAULT 0 CHECK(last_position_ratio BETWEEN 0 AND 1),
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
  read_count INTEGER NOT NULL DEFAULT 0,
  active_read_ms INTEGER NOT NULL DEFAULT 0,
  full_read_aloud_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE article_progress_events (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('active_ms', 'read_complete', 'read_aloud_complete')),
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_articles_user_created ON articles(user_id, created_at DESC);
CREATE INDEX idx_word_forms_user_normalized ON word_forms(user_id, normalized_form);
CREATE INDEX idx_marked_terms_user ON marked_terms(user_id, created_at DESC);
CREATE INDEX idx_article_markings_article ON article_markings(article_id);
CREATE INDEX idx_article_markings_pending ON article_markings(marked_term_id);
CREATE INDEX idx_article_markings_word ON article_markings(word_id);
CREATE INDEX idx_progress_events_article ON article_progress_events(article_id, created_at);
