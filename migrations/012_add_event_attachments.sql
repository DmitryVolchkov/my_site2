-- Составные события: привязка вторичного события к основному ("привязано к"),
-- объединяющий заголовок и ручной порядок в объединённой карточке.

ALTER TABLE events ADD COLUMN attached_to TEXT;
ALTER TABLE events ADD COLUMN attachment_order INTEGER;
ALTER TABLE events ADD COLUMN composite_headline TEXT;
ALTER TABLE events ADD COLUMN use_composite_headline TEXT NOT NULL DEFAULT '0';

CREATE INDEX IF NOT EXISTS idx_events_attached_to ON events(attached_to);
