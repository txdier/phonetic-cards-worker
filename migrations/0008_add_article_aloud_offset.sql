ALTER TABLE article_progress
ADD COLUMN last_aloud_offset_seconds REAL NOT NULL DEFAULT 0
CHECK (last_aloud_offset_seconds >= 0);
