ALTER TABLE article_translation_progress
  ADD COLUMN run_token TEXT NOT NULL DEFAULT '';

ALTER TABLE article_translation_paragraphs
  ADD COLUMN run_token TEXT NOT NULL DEFAULT '';

UPDATE article_translation_progress
SET run_token = 'migrated-' || source_hash
WHERE run_token = '';

UPDATE article_translation_paragraphs
SET run_token = 'migrated-' || source_hash
WHERE run_token = '';

CREATE INDEX IF NOT EXISTS idx_article_translation_paragraphs_run
  ON article_translation_paragraphs(
    article_id, user_id, source_hash, rules_version, run_token
  );
