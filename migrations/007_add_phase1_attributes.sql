-- Фаза 1: расширенные атрибуты событий и цитата-подтверждение в источниках.

ALTER TABLE events ADD COLUMN slug TEXT;
ALTER TABLE events ADD COLUMN summary TEXT;
ALTER TABLE events ADD COLUMN event_type TEXT;
ALTER TABLE events ADD COLUMN scale TEXT;
ALTER TABLE events ADD COLUMN domain TEXT;
ALTER TABLE events ADD COLUMN category TEXT;
ALTER TABLE events ADD COLUMN subcategory TEXT;
ALTER TABLE events ADD COLUMN country_name TEXT;
ALTER TABLE events ADD COLUMN region TEXT;
ALTER TABLE events ADD COLUMN city TEXT;
ALTER TABLE events ADD COLUMN verification_status TEXT;
ALTER TABLE events ADD COLUMN date_precision TEXT;
ALTER TABLE events ADD COLUMN is_date_approximate TEXT NOT NULL DEFAULT '0';
ALTER TABLE events ADD COLUMN related_events TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug
    ON events(slug)
    WHERE slug IS NOT NULL AND TRIM(slug) != '';

ALTER TABLE sources ADD COLUMN evidence_quote TEXT;
