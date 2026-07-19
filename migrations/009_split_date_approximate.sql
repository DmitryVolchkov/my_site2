-- Отдельные флаги приблизительной даты для начала и окончания.

ALTER TABLE events ADD COLUMN start_date_approximate TEXT NOT NULL DEFAULT '0';
ALTER TABLE events ADD COLUMN end_date_approximate TEXT NOT NULL DEFAULT '0';

UPDATE events
SET start_date_approximate = is_date_approximate
WHERE COALESCE(is_date_approximate, '0') = '1';

ALTER TABLE events DROP COLUMN is_date_approximate;
