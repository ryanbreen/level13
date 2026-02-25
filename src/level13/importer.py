"""GDPR Extended Streaming History importer.

Accepts a path to either:
  - A ZIP file downloaded from Spotify's privacy page
  - An already-extracted directory

Handles both the "new" format (Streaming_History_Audio_*.json) and the
"old" format (endsong_*.json) — they use the same field names.
"""

import json
import zipfile
from pathlib import Path
from typing import Iterator

from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

from level13.db import init_db, open_db

# Minimum play duration to import (ms). Plays shorter than this are likely skips.
MIN_MS_PLAYED = 30_000

BATCH_SIZE = 1_000


# ---------------------------------------------------------------------------
# Record parsing
# ---------------------------------------------------------------------------

def _parse_record(record: dict) -> dict | None:
    """Map a raw GDPR record to a plays-table row dict, or None to skip."""
    ms_played = record.get("ms_played")
    if ms_played is not None and ms_played < MIN_MS_PLAYED:
        return None

    ts = record.get("ts")
    if not ts:
        return None

    return {
        "played_at": ts,
        "track_uri": record.get("spotify_track_uri"),
        "track_name": record.get("master_metadata_track_name"),
        "artist_name": record.get("master_metadata_album_artist_name"),
        "album_name": record.get("master_metadata_album_album_name"),
        "ms_played": ms_played,
        "source": "import",
    }


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

def _is_history_file(name: str) -> bool:
    stem = Path(name).stem
    return stem.startswith("Streaming_History_Audio_") or stem.startswith("endsong_")


def _iter_records_from_zip(zip_path: Path) -> Iterator[dict]:
    """Yield raw records from all history JSON files inside a ZIP."""
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if _is_history_file(n) and n.endswith(".json")]
        for name in sorted(names):
            with zf.open(name) as fh:
                records = json.load(fh)
                yield from records


def _iter_records_from_dir(dir_path: Path) -> Iterator[dict]:
    """Yield raw records from all history JSON files in a directory."""
    files = sorted(dir_path.glob("*.json"))
    history_files = [f for f in files if _is_history_file(f.name)]
    for f in history_files:
        records = json.loads(f.read_text(encoding="utf-8"))
        yield from records


# ---------------------------------------------------------------------------
# Public import entry point
# ---------------------------------------------------------------------------

def import_history(path: str | Path) -> tuple[int, int]:
    """Import Spotify Extended Streaming History.

    Args:
        path: Path to a ZIP file or extracted directory.

    Returns:
        (total_parsed, total_inserted) counts.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Path not found: {path}")

    if zipfile.is_zipfile(path):
        records_iter = _iter_records_from_zip(path)
    elif path.is_dir():
        records_iter = _iter_records_from_dir(path)
    else:
        raise ValueError(f"Expected a ZIP file or directory, got: {path}")

    init_db()

    total_parsed = 0
    total_inserted = 0

    with open_db() as conn:
        progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            TaskProgressColumn(),
            TimeElapsedColumn(),
        )
        with progress:
            task_id = progress.add_task("Importing plays…", total=None)

            batch: list[dict] = []

            for raw in records_iter:
                total_parsed += 1
                row = _parse_record(raw)
                if row is None:
                    continue
                batch.append(row)

                if len(batch) >= BATCH_SIZE:
                    with conn:
                        for row in batch:
                            from level13.db import insert_play
                            if insert_play(conn, **row):
                                total_inserted += 1
                    batch.clear()
                    progress.update(task_id, completed=total_inserted, description=f"Importing plays… ({total_inserted:,} inserted)")

            # Flush remainder
            if batch:
                with conn:
                    for row in batch:
                        from level13.db import insert_play
                        if insert_play(conn, **row):
                            total_inserted += 1

            progress.update(task_id, completed=total_inserted, total=total_inserted, description="Import complete")

    return total_parsed, total_inserted
