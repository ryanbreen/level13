"""Analytics queries against the plays table.

All functions accept an optional `conn` parameter; if omitted they open their
own connection for convenience.  Pass a connection when you want to run
multiple queries in the same transaction or avoid repeated open/close overhead.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Any

from level13.config import DEFAULT_MS_PER_PLAY
from level13.db import open_db

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

@contextmanager
def _conn_or_open(conn: sqlite3.Connection | None):
    if conn is not None:
        yield conn
    else:
        with open_db() as c:
            yield c


def _time_range_filter(time_range: str) -> tuple[str, list]:
    """Return (WHERE clause fragment, params) for a named time range.

    Recognised values: "7d", "30d", "90d", "365d", "all".
    """
    if time_range == "all":
        return "1=1", []

    days = {
        "7d": 7,
        "30d": 30,
        "90d": 90,
        "365d": 365,
    }.get(time_range)

    if days is None:
        raise ValueError(f"Unknown time range: {time_range!r}. Use 7d/30d/90d/365d/all")

    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    return "played_at >= ?", [cutoff]


def _ms_expr() -> str:
    """SQL expression that substitutes the default when ms_played is NULL."""
    return f"COALESCE(ms_played, {DEFAULT_MS_PER_PLAY})"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def daily_listening_time(
    target_date: date | str,
    conn: sqlite3.Connection | None = None,
) -> int:
    """Total ms listened on a given date (YYYY-MM-DD)."""
    if isinstance(target_date, date):
        target_date = target_date.isoformat()

    with _conn_or_open(conn) as c:
        row = c.execute(
            f"SELECT SUM({_ms_expr()}) FROM plays WHERE date(played_at) = ?",
            (target_date,),
        ).fetchone()
    return row[0] or 0


def top_artists(
    time_range: str = "30d",
    limit: int = 20,
    conn: sqlite3.Connection | None = None,
) -> list[dict]:
    """Ranked list of artists by total ms listened.

    Returns list of dicts with keys: artist_name, play_count, total_ms, estimated.
    `estimated` is True when any play for that artist has NULL ms_played.
    """
    where, params = _time_range_filter(time_range)
    query = f"""
        SELECT
            artist_name,
            COUNT(*) AS play_count,
            SUM({_ms_expr()}) AS total_ms,
            SUM(CASE WHEN ms_played IS NULL THEN 1 ELSE 0 END) > 0 AS has_estimates
        FROM plays
        WHERE {where}
          AND artist_name IS NOT NULL
        GROUP BY artist_name
        ORDER BY total_ms DESC
        LIMIT ?
    """
    with _conn_or_open(conn) as c:
        rows = c.execute(query, params + [limit]).fetchall()
    return [
        {
            "artist_name": r["artist_name"],
            "play_count": r["play_count"],
            "total_ms": r["total_ms"],
            "estimated": bool(r["has_estimates"]),
        }
        for r in rows
    ]


def top_tracks(
    time_range: str = "30d",
    limit: int = 20,
    conn: sqlite3.Connection | None = None,
) -> list[dict]:
    """Ranked list of tracks by total ms listened."""
    where, params = _time_range_filter(time_range)
    query = f"""
        SELECT
            track_name,
            artist_name,
            COUNT(*) AS play_count,
            SUM({_ms_expr()}) AS total_ms,
            SUM(CASE WHEN ms_played IS NULL THEN 1 ELSE 0 END) > 0 AS has_estimates
        FROM plays
        WHERE {where}
          AND track_name IS NOT NULL
        GROUP BY track_name, artist_name
        ORDER BY total_ms DESC
        LIMIT ?
    """
    with _conn_or_open(conn) as c:
        rows = c.execute(query, params + [limit]).fetchall()
    return [
        {
            "track_name": r["track_name"],
            "artist_name": r["artist_name"],
            "play_count": r["play_count"],
            "total_ms": r["total_ms"],
            "estimated": bool(r["has_estimates"]),
        }
        for r in rows
    ]


def yearly_aggregate(
    year: int,
    conn: sqlite3.Connection | None = None,
) -> dict:
    """Summary stats for a full calendar year."""
    start = f"{year}-01-01"
    end = f"{year}-12-31"
    query = f"""
        SELECT
            COUNT(*) AS total_plays,
            SUM({_ms_expr()}) AS total_ms,
            COUNT(DISTINCT artist_name) AS unique_artists,
            COUNT(DISTINCT track_name) AS unique_tracks
        FROM plays
        WHERE date(played_at) BETWEEN ? AND ?
    """
    with _conn_or_open(conn) as c:
        row = c.execute(query, (start, end)).fetchone()
    return {
        "year": year,
        "total_plays": row["total_plays"] or 0,
        "total_ms": row["total_ms"] or 0,
        "unique_artists": row["unique_artists"] or 0,
        "unique_tracks": row["unique_tracks"] or 0,
    }


def listening_by_day(
    start: date | str,
    end: date | str,
    conn: sqlite3.Connection | None = None,
) -> list[dict]:
    """Daily listening totals for a date range.

    Returns list of dicts with keys: day (YYYY-MM-DD), total_ms, play_count.
    Days with zero plays are omitted.
    """
    if isinstance(start, date):
        start = start.isoformat()
    if isinstance(end, date):
        end = end.isoformat()

    query = f"""
        SELECT
            date(played_at) AS day,
            SUM({_ms_expr()}) AS total_ms,
            COUNT(*) AS play_count
        FROM plays
        WHERE date(played_at) BETWEEN ? AND ?
        GROUP BY day
        ORDER BY day
    """
    with _conn_or_open(conn) as c:
        rows = c.execute(query, (start, end)).fetchall()
    return [{"day": r["day"], "total_ms": r["total_ms"], "play_count": r["play_count"]} for r in rows]


def streak(conn: sqlite3.Connection | None = None) -> dict:
    """Compute current and longest consecutive-day listening streaks.

    Returns dict with keys: current_streak, longest_streak.
    """
    with _conn_or_open(conn) as c:
        rows = c.execute(
            "SELECT DISTINCT date(played_at) AS day FROM plays ORDER BY day"
        ).fetchall()

    days = [date.fromisoformat(r["day"]) for r in rows]
    if not days:
        return {"current_streak": 0, "longest_streak": 0}

    # Compute streaks
    longest = 1
    current_run = 1
    for i in range(1, len(days)):
        if (days[i] - days[i - 1]).days == 1:
            current_run += 1
            longest = max(longest, current_run)
        else:
            current_run = 1

    # Current streak: count backwards from today
    today = date.today()
    current = 0
    d = today
    day_set = set(days)
    # Allow today or yesterday as the streak end (account for not yet played today)
    if d not in day_set and (d - timedelta(days=1)) in day_set:
        d = d - timedelta(days=1)
    while d in day_set:
        current += 1
        d -= timedelta(days=1)

    return {"current_streak": current, "longest_streak": max(longest, current)}


# ---------------------------------------------------------------------------
# Historical chart data
# ---------------------------------------------------------------------------

def artist_daily_history(limit: int = 10, conn: sqlite3.Connection | None = None) -> dict:
    """Daily listening for top N artists across all history.

    Returns:
        {
            'days': ['2022-03-12', ...],   # every calendar day in range
            'artists': [
                {'name': ..., 'total_ms': ..., 'daily_ms': [0.0, ...]},
                ...
            ]
        }
    """
    from datetime import date as _date, timedelta as _td

    with _conn_or_open(conn) as c:
        bounds = c.execute(
            "SELECT MIN(date(played_at)), MAX(date(played_at)) FROM plays"
        ).fetchone()
        if not bounds[0]:
            return {"days": [], "artists": []}

        first_day, last_day = bounds[0], bounds[1]

        top = c.execute(
            f"""SELECT artist_name, SUM({_ms_expr()}) AS total_ms
                FROM plays WHERE artist_name IS NOT NULL
                GROUP BY artist_name ORDER BY total_ms DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        if not top:
            return {"days": [], "artists": []}

        top_names = [r["artist_name"] for r in top]
        top_totals = {r["artist_name"]: r["total_ms"] for r in top}

        placeholders = ",".join("?" * len(top_names))
        rows = c.execute(
            f"""SELECT artist_name, date(played_at) AS day, SUM({_ms_expr()}) AS ms
                FROM plays WHERE artist_name IN ({placeholders})
                GROUP BY artist_name, day ORDER BY day""",
            top_names,
        ).fetchall()

    start = _date.fromisoformat(first_day)
    end = _date.fromisoformat(last_day)
    days: list[str] = []
    d = start
    while d <= end:
        days.append(d.isoformat())
        d += _td(days=1)

    day_idx = {day: i for i, day in enumerate(days)}
    n = len(days)

    artist_data: dict[str, list[float]] = {name: [0.0] * n for name in top_names}
    for row in rows:
        idx = day_idx.get(row["day"])
        if idx is not None and row["artist_name"] in artist_data:
            artist_data[row["artist_name"]][idx] = float(row["ms"])

    return {
        "days": days,
        "artists": [
            {"name": name, "total_ms": top_totals[name], "daily_ms": artist_data[name]}
            for name in top_names
        ],
    }


def artist_monthly_history(limit: int = 15, conn: sqlite3.Connection | None = None) -> dict:
    """Monthly listening history for the top N artists over all time.

    Returns:
        {
            'months': ['2022-03', '2022-04', ...],   # every month in range
            'artists': [
                {
                    'name': 'Taylor Swift',
                    'total_ms': 2634159361,
                    'monthly_ms': [0, 0, 45600000, ...],  # aligned to months list
                },
                ...
            ]
        }
    """
    with _conn_or_open(conn) as c:
        # Get the full date range in the DB
        bounds = c.execute(
            "SELECT MIN(strftime('%Y-%m', played_at)), MAX(strftime('%Y-%m', played_at)) FROM plays"
        ).fetchone()
        if not bounds[0]:
            return {"months": [], "artists": []}
        first_month, last_month = bounds[0], bounds[1]

        # Top artists by all-time ms
        top = c.execute(
            f"""
            SELECT artist_name, SUM({_ms_expr()}) AS total_ms
            FROM plays WHERE artist_name IS NOT NULL
            GROUP BY artist_name
            ORDER BY total_ms DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        top_names = [r["artist_name"] for r in top]
        top_totals = {r["artist_name"]: r["total_ms"] for r in top}

        if not top_names:
            return {"months": [], "artists": []}

        # Monthly breakdown for those artists
        placeholders = ",".join("?" * len(top_names))
        rows = c.execute(
            f"""
            SELECT artist_name,
                   strftime('%Y-%m', played_at) AS month,
                   SUM({_ms_expr()}) AS ms
            FROM plays
            WHERE artist_name IN ({placeholders})
            GROUP BY artist_name, month
            ORDER BY month
            """,
            top_names,
        ).fetchall()

    # Build the complete month list (every month from first to last)
    from datetime import datetime

    def _month_range(start: str, end: str) -> list[str]:
        months = []
        y, m = int(start[:4]), int(start[5:7])
        ey, em = int(end[:4]), int(end[5:7])
        while (y, m) <= (ey, em):
            months.append(f"{y:04d}-{m:02d}")
            m += 1
            if m > 12:
                m, y = 1, y + 1
        return months

    all_months = _month_range(first_month, last_month)
    month_idx = {m: i for i, m in enumerate(all_months)}
    n = len(all_months)

    # Build per-artist arrays
    artist_data: dict[str, list[float]] = {name: [0.0] * n for name in top_names}
    for row in rows:
        name = row["artist_name"]
        idx = month_idx.get(row["month"])
        if idx is not None and name in artist_data:
            artist_data[name][idx] = float(row["ms"])

    return {
        "months": all_months,
        "artists": [
            {
                "name": name,
                "total_ms": top_totals[name],
                "monthly_ms": artist_data[name],
            }
            for name in top_names
        ],
    }


# ---------------------------------------------------------------------------
# Formatting helpers (used by CLI stats command and TUI)
# ---------------------------------------------------------------------------

def ms_to_human(ms: int) -> str:
    """Convert milliseconds to a human-readable string like '3h 42m'."""
    total_seconds = ms // 1000
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def summary_stats(conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Aggregate summary used by the CLI stats command."""
    today = date.today()
    year = today.year
    with _conn_or_open(conn) as c:
        result = {
            "today_ms": daily_listening_time(today, c),
            "top_artists_30d": top_artists("30d", 10, c),
            "top_tracks_30d": top_tracks("30d", 10, c),
            "yearly": yearly_aggregate(year, c),
            "streaks": streak(c),
        }
    return result
