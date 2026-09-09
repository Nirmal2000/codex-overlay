PRAGMA foreign_keys = ON;

CREATE TABLE overlay_sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('starting', 'active', 'completed', 'completed_with_warnings', 'failed', 'interrupted')),
    mode TEXT NOT NULL CHECK(mode IN ('overlay', 'webapp')),
    workspace TEXT NOT NULL,
    pi_provider TEXT NOT NULL,
    pi_model TEXT NOT NULL,
    pi_session_id TEXT,
    app_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT
);

CREATE TABLE overlay_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_sequence INTEGER NOT NULL,
    submitted_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    prompt_text TEXT NOT NULL,
    manual_text TEXT,
    transcript_json TEXT NOT NULL DEFAULT '[]',
    screenshot_paths_json TEXT NOT NULL DEFAULT '[]',
    quick_answer TEXT NOT NULL DEFAULT '',
    quick_status TEXT NOT NULL CHECK(quick_status IN ('pending', 'streaming', 'completed', 'failed', 'stopped')),
    quick_error TEXT,
    pi_answer TEXT NOT NULL DEFAULT '',
    pi_status TEXT NOT NULL CHECK(pi_status IN ('pending', 'streaming', 'completed', 'failed', 'stopped')),
    pi_error TEXT,
    FOREIGN KEY (session_id) REFERENCES overlay_sessions(id) ON DELETE CASCADE,
    UNIQUE (session_id, turn_sequence)
);

CREATE TABLE overlay_session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    source TEXT,
    turn_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES overlay_sessions(id) ON DELETE CASCADE,
    UNIQUE (session_id, sequence)
);

CREATE INDEX idx_overlay_sessions_started_at
    ON overlay_sessions(started_at DESC);
CREATE INDEX idx_overlay_sessions_status_updated_at
    ON overlay_sessions(status, updated_at DESC);
CREATE INDEX idx_overlay_turns_session_sequence
    ON overlay_turns(session_id, turn_sequence ASC);
CREATE INDEX idx_overlay_events_session_created
    ON overlay_session_events(session_id, created_at ASC);
CREATE INDEX idx_overlay_events_type_created
    ON overlay_session_events(event_type, created_at DESC);
