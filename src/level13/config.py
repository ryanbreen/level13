"""Paths, constants, and configuration loading."""

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Data directory
# ---------------------------------------------------------------------------

DATA_DIR = Path(os.environ.get("LEVEL13_DATA_DIR", "~/.local/share/level13")).expanduser()

DB_PATH = DATA_DIR / "level13.db"
TOKEN_CACHE_PATH = DATA_DIR / ".spotify_cache"
PID_FILE = DATA_DIR / "poller.pid"
LOG_FILE = DATA_DIR / "poller.log"

# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------

POLL_INTERVAL_SECONDS = 180  # 3 minutes
POLL_RECENTLY_PLAYED_LIMIT = 50

# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

DEFAULT_MS_PER_PLAY = 210_000  # 3.5 minutes — used when ms_played is NULL

# ---------------------------------------------------------------------------
# Spotify scopes
# ---------------------------------------------------------------------------

SPOTIFY_SCOPES = "user-read-recently-played user-read-currently-playing"


def ensure_data_dir() -> None:
    """Create the data directory if it doesn't exist."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
