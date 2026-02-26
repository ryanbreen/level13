CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  played_at TEXT NOT NULL,
  track_uri TEXT,
  track_name TEXT,
  artist_name TEXT,
  album_name TEXT,
  ms_played INTEGER,
  source TEXT NOT NULL DEFAULT 'api',
  UNIQUE(played_at, track_uri)
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plays_played_at ON plays(played_at);
