-- Контентная миграция (docs/open-spec-country-lanes.md, п. 6 и «Список изменений»):
-- 1) разнесение 17 событий по таксономии: 5 -> «Военные действия» (grp-0005), 12 -> «Политика» (grp-0003);
--    спорные ev-0018 (ввод войск) и ev-0024 (обращение Молотова) отнесены к политике — решение редактора может изменить;
-- 2) страны-участники (role='participant') для полос сравнения — предварительная разметка, проверить редактором;
-- 3) даты окончания длительных событий (точность 'day'); источники окончаний дополнить через админку;
-- 4) группа «История» (grp-0001) остаётся пустой — вывод из употребления через админку (аудит).

-- 1. Группы: снять «Историю», назначить новые
DELETE FROM event_groups WHERE group_id = 'grp-0001';

INSERT OR IGNORE INTO event_groups (event_id, group_id)
SELECT id, 'grp-0005' FROM events WHERE id IN ('ev-0009','ev-0011','ev-0016','ev-0022','ev-0023');

INSERT OR IGNORE INTO event_groups (event_id, group_id)
SELECT id, 'grp-0003' FROM events WHERE id IN
    ('ev-0010','ev-0012','ev-0013','ev-0014','ev-0015','ev-0017','ev-0018','ev-0019','ev-0020','ev-0021','ev-0024','ev-0025');

-- Синхронизация строкового поля events."group" (правило open-spec.md: поле и связь согласованы)
UPDATE events SET "group" = 'Военные действия', updated_at = CURRENT_TIMESTAMP
WHERE id IN ('ev-0009','ev-0011','ev-0016','ev-0022','ev-0023');

UPDATE events SET "group" = 'Политика', updated_at = CURRENT_TIMESTAMP
WHERE id IN ('ev-0010','ev-0012','ev-0013','ev-0014','ev-0015','ev-0017','ev-0018','ev-0019','ev-0020','ev-0021','ev-0024','ev-0025');

-- 2. Страны-участники (предварительная разметка по заголовкам)
INSERT OR IGNORE INTO event_countries (event_id, country, role) VALUES
    ('ev-0009', 'Германия', 'participant'), ('ev-0009', 'Польша', 'participant'),
    ('ev-0010', 'СССР', 'participant'),
    ('ev-0011', 'СССР', 'participant'), ('ev-0011', 'Польша', 'participant'),
    ('ev-0012', 'СССР', 'participant'), ('ev-0012', 'Германия', 'participant'),
    ('ev-0013', 'СССР', 'participant'), ('ev-0013', 'Эстония', 'participant'),
    ('ev-0014', 'СССР', 'participant'), ('ev-0014', 'Латвия', 'participant'),
    ('ev-0015', 'СССР', 'participant'), ('ev-0015', 'Литва', 'participant'),
    ('ev-0016', 'СССР', 'participant'), ('ev-0016', 'Финляндия', 'participant'),
    ('ev-0017', 'СССР', 'participant'), ('ev-0017', 'Финляндия', 'participant'),
    ('ev-0018', 'СССР', 'participant'), ('ev-0018', 'Литва', 'participant'),
    ('ev-0018', 'Латвия', 'participant'), ('ev-0018', 'Эстония', 'participant'),
    ('ev-0019', 'СССР', 'participant'), ('ev-0019', 'Эстония', 'participant'),
    ('ev-0020', 'СССР', 'participant'), ('ev-0020', 'Югославия', 'participant'),
    ('ev-0021', 'СССР', 'participant'), ('ev-0021', 'Япония', 'participant'),
    ('ev-0022', 'Германия', 'participant'), ('ev-0022', 'СССР', 'participant'),
    ('ev-0023', 'СССР', 'participant'),
    ('ev-0024', 'СССР', 'participant'),
    ('ev-0025', 'СССР', 'participant');

-- 3. Даты окончания длительных событий
-- Германо-польская война: окончание организованного сопротивления — капитуляция ГО «Полесье» под Коцком, 06.10.1939
UPDATE events SET end_year = '1939', end_month = '10', end_day = '6',
    end_date_precision = 'day', updated_at = CURRENT_TIMESTAMP
WHERE id = 'ev-0009' AND COALESCE(end_year, '') = '';

-- Советско-финляндская война: прекращение боевых действий по Московскому договору — 13.03.1940
UPDATE events SET end_year = '1940', end_month = '3', end_day = '13',
    end_date_precision = 'day', updated_at = CURRENT_TIMESTAMP
WHERE id = 'ev-0016' AND COALESCE(end_year, '') = '';
