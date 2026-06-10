-- Slug события заменён на хештег: короткая метка для поиска и навигации.

ALTER TABLE events RENAME COLUMN slug TO hashtag;

DROP INDEX IF EXISTS idx_events_slug;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_hashtag
    ON events(hashtag)
    WHERE hashtag IS NOT NULL AND TRIM(hashtag) != '';
