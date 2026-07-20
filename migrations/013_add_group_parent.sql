-- Иерархия групп (таксономия из docs/open-spec-country-lanes.md, п. 6):
-- 5 основных групп + подгруппы через parent_id. База — рубрики IPTC Media Topics.
-- Группа "История" (grp-0001) остаётся до разнесения событий, затем выводится из употребления через API.

ALTER TABLE groups ADD COLUMN parent_id TEXT REFERENCES groups(id);

CREATE INDEX IF NOT EXISTS idx_groups_parent_id ON groups(parent_id);

-- Основные группы
INSERT OR IGNORE INTO groups (id, name, slug, description, parent_id) VALUES
    ('grp-0002', 'Общество', 'obshchestvo', 'Социальные вопросы, повседневная жизнь, люди', NULL),
    ('grp-0003', 'Политика', 'politika', 'Власть, дипломатия, международные отношения, госуправление', NULL),
    ('grp-0004', 'Экономика', 'ekonomika', 'Финансы, промышленность, торговля, ресурсы', NULL),
    ('grp-0005', 'Военные действия', 'voennye-deystviya', 'Войны, вооружённые конфликты, мирные переговоры', NULL),
    ('grp-0006', 'Наука', 'nauka', 'Исследования, открытия, технологии', NULL);

-- Подгруппы: Общество
INSERT OR IGNORE INTO groups (id, name, slug, description, parent_id) VALUES
    ('grp-0007', 'Культура и искусство', 'kultura-i-iskusstvo', 'Литература, музыка, театр, кино, наследие', 'grp-0002'),
    ('grp-0008', 'Спорт', 'sport', 'Соревнования, олимпиады, рекорды', 'grp-0002'),
    ('grp-0009', 'Религия', 'religiya', 'Конфессии, церковь и государство', 'grp-0002'),
    ('grp-0010', 'Стиль жизни и досуг', 'stil-zhizni-i-dosug', 'Быт, мода, путешествия, гастрономия', 'grp-0002'),
    ('grp-0011', 'Человеческий интерес', 'chelovecheskiy-interes', 'Судьбы людей, письма, юбилеи', 'grp-0002'),
    ('grp-0012', 'Происшествия и катастрофы', 'proisshestviya-i-katastrofy', 'Аварии, стихийные бедствия, чрезвычайные ситуации', 'grp-0002');

-- Подгруппы: Политика
INSERT OR IGNORE INTO groups (id, name, slug, description, parent_id) VALUES
    ('grp-0013', 'Право и преступность', 'pravo-i-prestupnost', 'Законы, суды, правопорядок', 'grp-0003');

-- Подгруппы: Экономика
INSERT OR IGNORE INTO groups (id, name, slug, description, parent_id) VALUES
    ('grp-0014', 'Труд и занятость', 'trud-i-zanyatost', 'Рабочее движение, профсоюзы, мобилизация тыла', 'grp-0004'),
    ('grp-0015', 'Экология и окружающая среда', 'ekologiya-i-okruzhayushchaya-sreda', 'Природные ресурсы, природопользование', 'grp-0004');

-- Подгруппы: Военные действия (архивная специфика)
INSERT OR IGNORE INTO groups (id, name, slug, description, parent_id) VALUES
    ('grp-0016', 'Фронтовые операции', 'frontovye-operatsii', 'Наступления, сражения, кампании', 'grp-0005'),
    ('grp-0017', 'Оборона', 'oborona', 'Оборонительные операции, укрепрайоны', 'grp-0005'),
    ('grp-0018', 'Оккупация', 'okkupatsiya', 'Оккупационные режимы, администрация', 'grp-0005'),
    ('grp-0019', 'Потери', 'poteri', 'Безвозвратные и санитарные потери, погибшие', 'grp-0005'),
    ('grp-0020', 'Партизанское движение', 'partizanskoe-dvizhenie', 'Партизаны, подполье, сопротивление', 'grp-0005');

-- Подгруппы: Наука
INSERT OR IGNORE INTO groups (id, name, slug, description, parent_id) VALUES
    ('grp-0021', 'Образование', 'obrazovanie', 'Школы, университеты, реформы образования', 'grp-0006'),
    ('grp-0022', 'Здоровье и медицина', 'zdorove-i-meditsina', 'Медицинские открытия, здравоохранение, госпитали', 'grp-0006'),
    ('grp-0023', 'Погода', 'pogoda', 'Метеорология, наблюдения, аномалии', 'grp-0006');
