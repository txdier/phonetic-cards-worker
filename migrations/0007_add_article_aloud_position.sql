ALTER TABLE article_progress
ADD COLUMN last_aloud_sentence_index INTEGER
CHECK (
  last_aloud_sentence_index IS NULL
  OR last_aloud_sentence_index >= 0
);
