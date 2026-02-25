"""Background polling daemon — polls Spotify's Recently Played API every 3 minutes."""

import logging
import os
import signal
import sys
import time
from datetime import datetime, timezone

import spotipy

from level13.auth import get_spotify_client
from level13.config import (
    LOG_FILE,
    PID_FILE,
    POLL_INTERVAL_SECONDS,
    POLL_RECENTLY_PLAYED_LIMIT,
    ensure_data_dir,
)
from level13.db import (
    get_connection,
    get_sync_state,
    init_db,
    insert_play,
    set_sync_state,
)

logger = logging.getLogger("level13.poller")

# ---------------------------------------------------------------------------
# Signal handling
# ---------------------------------------------------------------------------

_shutdown = False


def _handle_signal(signum, frame):
    global _shutdown
    logger.info("Received signal %s — shutting down after current cycle", signum)
    _shutdown = True


# ---------------------------------------------------------------------------
# Poll logic
# ---------------------------------------------------------------------------

def _ms_since_epoch(iso_ts: str) -> int:
    """Convert ISO 8601 UTC string to milliseconds since epoch."""
    dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    return int(dt.timestamp() * 1000)


def _poll_once(sp: spotipy.Spotify, conn) -> int:
    """Run a single poll cycle. Returns the number of new plays inserted."""
    last_cursor = get_sync_state(conn, "last_poll_cursor")
    kwargs: dict = {"limit": POLL_RECENTLY_PLAYED_LIMIT}
    if last_cursor:
        kwargs["after"] = _ms_since_epoch(last_cursor)

    result = sp.current_user_recently_played(**kwargs)
    items = result.get("items", [])

    if not items:
        logger.debug("No new plays")
        return 0

    inserted = 0
    newest_played_at: str | None = None

    for item in items:
        track = item.get("track") or {}
        artists = track.get("artists") or [{}]
        played_at = item["played_at"]  # ISO 8601 UTC e.g. "2024-01-15T18:30:00.000Z"

        if insert_play(
            conn,
            played_at=played_at,
            track_uri=track.get("uri"),
            track_name=track.get("name"),
            artist_name=artists[0].get("name") if artists else None,
            album_name=(track.get("album") or {}).get("name"),
            ms_played=None,  # API doesn't provide ms_played
            source="api",
        ):
            inserted += 1

        if newest_played_at is None or played_at > newest_played_at:
            newest_played_at = played_at

    if newest_played_at:
        set_sync_state(conn, "last_poll_cursor", newest_played_at)
        conn.commit()

    logger.info("Poll complete: %d new plays inserted", inserted)
    return inserted


# ---------------------------------------------------------------------------
# Main daemon loop
# ---------------------------------------------------------------------------

def _run_daemon_loop() -> None:
    """Main loop — runs in the forked child process."""
    ensure_data_dir()
    _setup_logging()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    logger.info("Poller daemon starting (PID %d)", os.getpid())
    init_db()
    conn = get_connection()

    sp: spotipy.Spotify | None = None

    while not _shutdown:
        try:
            if sp is None:
                sp = get_spotify_client()

            _poll_once(sp, conn)

        except spotipy.SpotifyException as exc:
            if exc.http_status == 429:
                retry_after = int(exc.headers.get("Retry-After", 60)) if exc.headers else 60
                logger.warning("Rate limited — sleeping %ds", retry_after)
                _interruptible_sleep(retry_after)
                continue
            elif exc.http_status == 401:
                logger.warning("Auth error — refreshing token")
                try:
                    sp = get_spotify_client()
                except Exception as refresh_err:
                    logger.error("Token refresh failed: %s", refresh_err)
                    sp = None
                continue
            else:
                logger.error("Spotify API error: %s", exc)

        except Exception as exc:
            logger.error("Unexpected error: %s", exc, exc_info=True)
            _interruptible_sleep(60)
            continue

        _interruptible_sleep(POLL_INTERVAL_SECONDS)

    conn.close()
    logger.info("Poller daemon stopped cleanly")


def _interruptible_sleep(seconds: int) -> None:
    """Sleep in 1-second increments so SIGTERM wakes us quickly."""
    for _ in range(seconds):
        if _shutdown:
            break
        time.sleep(1)


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
        handlers=[logging.FileHandler(str(LOG_FILE))],
    )


# ---------------------------------------------------------------------------
# Daemon management
# ---------------------------------------------------------------------------

def start() -> None:
    """Fork a daemon process and write its PID to the pidfile."""
    ensure_data_dir()

    if _pid_is_running():
        print(f"Poller is already running (PID {PID_FILE.read_text().strip()})")
        return

    pid = os.fork()
    if pid > 0:
        # Parent — write PID and return
        PID_FILE.write_text(str(pid))
        print(f"Poller started (PID {pid}). Log: {LOG_FILE}")
        return

    # Child — detach from terminal
    os.setsid()

    # Second fork to prevent zombie
    pid2 = os.fork()
    if pid2 > 0:
        # Update pidfile to actual grandchild PID
        PID_FILE.write_text(str(pid2))
        os._exit(0)

    # Grandchild — redirect stdio
    sys.stdout.flush()
    sys.stderr.flush()
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, sys.stdin.fileno())
    os.dup2(devnull, sys.stdout.fileno())
    os.dup2(devnull, sys.stderr.fileno())

    _run_daemon_loop()
    os._exit(0)


def stop() -> None:
    """Send SIGTERM to the running daemon."""
    if not PID_FILE.exists():
        print("Poller is not running (no pidfile found)")
        return

    pid_str = PID_FILE.read_text().strip()
    try:
        pid = int(pid_str)
    except ValueError:
        print(f"Invalid pidfile content: {pid_str!r}")
        return

    try:
        os.kill(pid, signal.SIGTERM)
        print(f"Sent SIGTERM to PID {pid}")
        # Wait briefly for clean exit
        for _ in range(10):
            time.sleep(0.5)
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
        PID_FILE.unlink(missing_ok=True)
    except ProcessLookupError:
        print(f"Process {pid} not found — removing stale pidfile")
        PID_FILE.unlink(missing_ok=True)
    except PermissionError:
        print(f"Permission denied to signal PID {pid}")


def status() -> None:
    """Print daemon status and last sync time from DB."""
    running = _pid_is_running()
    if running:
        pid = PID_FILE.read_text().strip()
        print(f"Poller is RUNNING (PID {pid})")
    else:
        print("Poller is STOPPED")

    try:
        from level13.db import open_db
        with open_db() as conn:
            last = get_sync_state(conn, "last_poll_cursor")
        if last:
            print(f"Last sync: {last}")
        else:
            print("Last sync: never")
    except Exception:
        print("Last sync: (DB not initialised)")


def _pid_is_running() -> bool:
    """Return True if the pidfile exists and the process is alive."""
    if not PID_FILE.exists():
        return False
    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, 0)
        return True
    except (ValueError, ProcessLookupError):
        return False
    except PermissionError:
        return True  # Process exists but we can't signal it
