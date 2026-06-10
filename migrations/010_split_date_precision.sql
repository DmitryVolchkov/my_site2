-- Точность даты отдельно для начала и окончания.

ALTER TABLE events ADD COLUMN start_date_precision TEXT;
ALTER TABLE events ADD COLUMN end_date_precision TEXT;

UPDATE events
SET start_date_precision = date_precision
WHERE COALESCE(date_precision, '') != ''
  AND date_precision != 'period';

ALTER TABLE events DROP COLUMN date_precision;
