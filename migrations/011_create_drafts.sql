CREATE TABLE IF NOT EXISTS draft_batches (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    target_date TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS draft_events (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    row_order INTEGER NOT NULL DEFAULT 0,
    headline TEXT,
    start_year TEXT,
    start_month TEXT,
    start_day TEXT,
    start_date_precision TEXT,
    summary TEXT,
    text TEXT,
    event_type TEXT,
    scale TEXT,
    domain TEXT,
    country_name TEXT,
    region TEXT,
    city TEXT,
    import_status TEXT NOT NULL DEFAULT 'pending',
    imported_event_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (batch_id) REFERENCES draft_batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS draft_sources (
    id TEXT PRIMARY KEY,
    draft_event_id TEXT NOT NULL,
    title TEXT,
    url TEXT,
    type TEXT,
    author TEXT,
    source_date TEXT,
    citation TEXT,
    reliability_score TEXT,
    evidence_quote TEXT,
    imported_source_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (draft_event_id) REFERENCES draft_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_draft_events_batch_id ON draft_events(batch_id);
CREATE INDEX IF NOT EXISTS idx_draft_sources_draft_event_id ON draft_sources(draft_event_id);
