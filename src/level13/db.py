"""SQLite database: schema creation, connection management, and low-level helpers."""

import sqlite3
from contextlib import contextmanager
from typing import Generator

from level13.config import DB_PATH, ensure_data_dir

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_DDL = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS plays (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    played_at   TEXT    NOT NULL,          -- ISO 8601 UTC timestamp
    track_uri   TEXT,                      -- spotify:track:xxx (nullable for GDPR nulls)
    track_name  TEXT,
    artist_name TEXT,
    album_name  TEXT,
    ms_played   INTEGER,                   -- from GDPR; NULL for API-polled plays
    source      TEXT    NOT NULL DEFAULT 'api',  -- 'api' or 'import'
    UNIQUE(played_at, track_uri)
);

CREATE INDEX IF NOT EXISTS idx_plays_played_at ON plays(played_at);

CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------

def get_connection(db_path=None) -> sqlite3.Connection:
    """Return an open SQLite connection with row_factory set."""
    ensure_data_dir()
    path = str(db_path or DB_PATH)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # WAL mode must be set per-connection
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


@contextmanager
def open_db(db_path=None) -> Generator[sqlite3.Connection, None, None]:
    """Context manager that yields a connection and closes it on exit."""
    conn = get_connection(db_path)
    try:
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Schema initialisation
# ---------------------------------------------------------------------------

def init_db(db_path=None) -> None:
    """Create tables and indexes if they don't exist."""
    with open_db(db_path) as conn:
        conn.executescript(_DDL)
        conn.commit()


# ---------------------------------------------------------------------------
# sync_state helpers
# ---------------------------------------------------------------------------

def get_sync_state(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute(
        "SELECT value FROM sync_state WHERE key = ?", (key,)
    ).fetchone()
    return row["value"] if row else None


def set_sync_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO sync_state(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


# ---------------------------------------------------------------------------
# Plays insert
# ---------------------------------------------------------------------------

def insert_play(
    conn: sqlite3.Connection,
    *,
    played_at: str,
    track_uri: str | None,
    track_name: str | None,
    artist_name: str | None,
    album_name: str | None,
    ms_played: int | None,
    source: str,
) -> bool:
    """Insert a single play, ignoring duplicates. Returns True if inserted."""
    cur = conn.execute(
        """
        INSERT OR IGNORE INTO plays
            (played_at, track_uri, track_name, artist_name, album_name, ms_played, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (played_at, track_uri, track_name, artist_name, album_name, ms_played, source),
    )
    return cur.rowcount == 1


def insert_plays_batch(conn: sqlite3.Connection, rows: list[dict]) -> int:
    """Batch-insert plays. Returns count of rows actually inserted."""
    inserted = 0
    for row in rows:
        if insert_play(conn, **row):
            inserted += 1
    return inserted
