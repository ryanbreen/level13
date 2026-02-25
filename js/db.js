import Database from 'better-sqlite3';
import fs from 'fs';
import { DATA_DIR, DB_PATH, DEFAULT_MS_PER_PLAY } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
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
  `);
  return _db;
}

export function insertPlay(play) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO plays (played_at, track_uri, track_name, artist_name, album_name, ms_played, source)
    VALUES (@played_at, @track_uri, @track_name, @artist_name, @album_name, @ms_played, @source)
  `).run(play);
}

export function getSyncState(key) {
  const db = getDb();
  return db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value ?? null;
}

export function setSyncState(key, value) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)').run(key, value);
}
