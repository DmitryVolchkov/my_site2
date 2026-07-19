CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS event_groups (
    event_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    PRIMARY KEY (event_id, group_id),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO groups (id, name, slug, description)
VALUES ('grp-0001', 'История', 'istoriya', '');

INSERT OR IGNORE INTO event_groups (event_id, group_id)
SELECT e.id, 'grp-0001'
FROM events e
WHERE TRIM(COALESCE(e."group", '')) = 'История';
