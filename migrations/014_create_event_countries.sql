-- Страны события: M:N с ролью (docs/open-spec-country-lanes.md, п. 5 «место ≠ участник»).
-- role='place'       — где произошло (синхронизируется со строкой events.country_name, split по запятой);
-- role='participant' — страна-участник (основа полос сравнения стран); заполняется редактором.

CREATE TABLE IF NOT EXISTS event_countries (
    event_id TEXT NOT NULL,
    country TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'place' CHECK (role IN ('place', 'participant')),
    PRIMARY KEY (event_id, country, role),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_countries_country ON event_countries(country, role);
CREATE INDEX IF NOT EXISTS idx_event_countries_event ON event_countries(event_id);

-- Backfill мест из events.country_name с расщеплением составных значений
-- («Литва, Латвия, Эстония» -> три строки role='place').
WITH RECURSIVE split(event_id, rest, item) AS (
    SELECT id, TRIM(COALESCE(country_name, '')) || ',', ''
    FROM events
    WHERE TRIM(COALESCE(country_name, '')) <> ''
    UNION ALL
    SELECT event_id,
           SUBSTR(rest, INSTR(rest, ',') + 1),
           TRIM(SUBSTR(rest, 1, INSTR(rest, ',') - 1))
    FROM split
    WHERE rest <> ''
)
INSERT OR IGNORE INTO event_countries (event_id, country, role)
SELECT event_id, item, 'place'
FROM split
WHERE item <> '';
