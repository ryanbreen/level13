"""Click CLI entry points for level13."""

from __future__ import annotations

import sys

import click
from rich.console import Console
from rich.table import Table

console = Console()


# ---------------------------------------------------------------------------
# Root group
# ---------------------------------------------------------------------------

@click.group()
def cli() -> None:
    """Personal Spotify Wrapped — always-available listening analytics."""


# ---------------------------------------------------------------------------
# auth
# ---------------------------------------------------------------------------

@cli.command()
def auth() -> None:
    """Run Spotify OAuth flow and confirm success."""
    try:
        from level13.auth import run_auth_flow
        display_name = run_auth_flow()
        console.print(f"[green]✓[/green] Authenticated as [bold]{display_name}[/bold]")
    except EnvironmentError as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Auth failed:[/red] {e}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# poll
# ---------------------------------------------------------------------------

@cli.group()
def poll() -> None:
    """Manage the background polling daemon."""


@poll.command("start")
def poll_start() -> None:
    """Start the background polling daemon."""
    from level13.poller import start
    start()


@poll.command("stop")
def poll_stop() -> None:
    """Stop the background polling daemon."""
    from level13.poller import stop
    stop()


@poll.command("status")
def poll_status() -> None:
    """Show daemon status and last sync time."""
    from level13.poller import status
    status()


# ---------------------------------------------------------------------------
# import
# ---------------------------------------------------------------------------

@cli.command("import")
@click.argument("path", type=click.Path(exists=True))
def import_history(path: str) -> None:
    """Import Spotify Extended Streaming History from a ZIP or directory."""
    from level13.importer import import_history as do_import
    try:
        total_parsed, total_inserted = do_import(path)
        console.print(
            f"\n[green]✓[/green] Imported [bold]{total_inserted:,}[/bold] plays "
            f"(parsed {total_parsed:,} records, "
            f"{total_parsed - total_inserted:,} skipped as duplicates or too short)"
        )
    except Exception as e:
        console.print(f"[red]Import failed:[/red] {e}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------

@cli.command()
@click.option("--year", type=int, default=None, help="Year for aggregate stats (default: current)")
def stats(year: int | None) -> None:
    """Print summary listening stats to the terminal."""
    from datetime import date

    from level13.stats import (
        ms_to_human,
        summary_stats,
        top_artists,
        top_tracks,
        yearly_aggregate,
    )

    target_year = year or date.today().year

    try:
        s = summary_stats()
    except Exception as e:
        console.print(f"[red]Error reading stats:[/red] {e}")
        sys.exit(1)

    # ---- Today ----
    console.rule("[bold]Today")
    console.print(f"Listened: [cyan]{ms_to_human(s['today_ms'])}[/cyan]")

    # ---- Streaks ----
    console.rule("[bold]Streaks")
    streaks = s["streaks"]
    console.print(
        f"Current: [cyan]{streaks['current_streak']} days[/cyan]  |  "
        f"Longest: [cyan]{streaks['longest_streak']} days[/cyan]"
    )

    # ---- Year aggregate ----
    console.rule(f"[bold]{target_year} Summary")
    yr = s["yearly"]
    console.print(
        f"Total: [cyan]{ms_to_human(yr['total_ms'])}[/cyan]  "
        f"({yr['total_plays']:,} plays, "
        f"{yr['unique_artists']:,} artists, "
        f"{yr['unique_tracks']:,} tracks)"
    )

    # ---- Top artists ----
    console.rule("[bold]Top Artists — Last 30 Days")
    tbl = Table(show_header=True, header_style="bold magenta")
    tbl.add_column("#", style="dim", width=4)
    tbl.add_column("Artist")
    tbl.add_column("Plays", justify="right")
    tbl.add_column("Time", justify="right")
    for i, a in enumerate(s["top_artists_30d"], 1):
        suffix = " ~" if a["estimated"] else ""
        tbl.add_row(str(i), a["artist_name"], str(a["play_count"]), ms_to_human(a["total_ms"]) + suffix)
    console.print(tbl)

    # ---- Top tracks ----
    console.rule("[bold]Top Tracks — Last 30 Days")
    tbl2 = Table(show_header=True, header_style="bold magenta")
    tbl2.add_column("#", style="dim", width=4)
    tbl2.add_column("Track")
    tbl2.add_column("Artist")
    tbl2.add_column("Plays", justify="right")
    tbl2.add_column("Time", justify="right")
    for i, t in enumerate(s["top_tracks_30d"], 1):
        suffix = " ~" if t["estimated"] else ""
        tbl2.add_row(str(i), t["track_name"] or "—", t["artist_name"] or "—", str(t["play_count"]), ms_to_human(t["total_ms"]) + suffix)
    console.print(tbl2)


# ---------------------------------------------------------------------------
# tui
# ---------------------------------------------------------------------------

@cli.command()
def tui() -> None:
    """Launch the interactive Textual dashboard."""
    from level13.tui.app import run
    run()
