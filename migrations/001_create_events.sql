CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    start_year TEXT NOT NULL,
    start_month TEXT,
    start_day TEXT,
    end_year TEXT,
    end_month TEXT,
    end_day TEXT,
    headline TEXT NOT NULL,
    text TEXT,
    media_url TEXT,
    media_caption TEXT,
    media_credit TEXT,
    "group" TEXT,
    tags TEXT,
    importance TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
