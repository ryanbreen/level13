"""Tab content views: Dashboard, Top Artists, Top Tracks, Daily View.

Widget subclasses (not Screen) so they can live inside TabbedContent.
"""

from __future__ import annotations

from datetime import date, timedelta

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.widget import Widget
from textual.widgets import DataTable, Label, Static

from level13 import stats as st

_RANGES = ["7d", "30d", "90d", "365d", "all"]
_RANGE_LABELS = {"7d": "7 days", "30d": "30 days", "90d": "90 days", "365d": "1 year", "all": "All time"}


def _est(has_estimates: bool) -> str:
    return "~" if has_estimates else ""


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

class DashboardView(Widget):
    BINDINGS = [Binding("r", "refresh_data", "Refresh")]

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("", id="daemon-status")
            yield Static("", id="today-stats")
            yield Static("", id="streak-stats")
            yield Static("", id="ytd-stats")
            yield Label("[bold]Top Artists — This Week[/bold]")
            yield DataTable(id="top-artists-table", show_cursor=False)
            yield Label("[bold]Top Tracks — This Week[/bold]")
            yield DataTable(id="top-tracks-table", show_cursor=False)

    def on_mount(self) -> None:
        self._load()

    def action_refresh_data(self) -> None:
        self._load()

    def _load(self) -> None:
        from level13.poller import _pid_is_running
        today = date.today()
        s = st.summary_stats()

        running = _pid_is_running()
        self.query_one("#daemon-status", Static).update(
            "[green]● Poller running[/green]" if running else "[dim]○ Poller stopped[/dim]"
        )
        self.query_one("#today-stats", Static).update(
            f"[bold]Today:[/bold] {st.ms_to_human(s['today_ms'])} listened"
        )
        streaks = s["streaks"]
        self.query_one("#streak-stats", Static).update(
            f"[bold]Streak:[/bold] {streaks['current_streak']} days  "
            f"[dim]longest: {streaks['longest_streak']} days[/dim]"
        )
        yr = s["yearly"]
        self.query_one("#ytd-stats", Static).update(
            f"[bold]{today.year} YTD:[/bold] {st.ms_to_human(yr['total_ms'])}  "
            f"[dim]— {yr['total_plays']:,} plays · {yr['unique_artists']:,} artists · "
            f"{yr['unique_tracks']:,} tracks[/dim]"
        )

        tbl_a = self.query_one("#top-artists-table", DataTable)
        tbl_a.clear(columns=True)
        tbl_a.add_columns("#", "Artist", "Plays", "Time")
        for i, a in enumerate(st.top_artists("7d", 5), 1):
            tbl_a.add_row(str(i), a["artist_name"], str(a["play_count"]),
                          st.ms_to_human(a["total_ms"]))

        tbl_t = self.query_one("#top-tracks-table", DataTable)
        tbl_t.clear(columns=True)
        tbl_t.add_columns("#", "Track", "Artist", "Plays", "Time")
        for i, t in enumerate(st.top_tracks("7d", 5), 1):
            tbl_t.add_row(str(i), t["track_name"] or "—", t["artist_name"] or "—",
                          str(t["play_count"]), st.ms_to_human(t["total_ms"]))


# ---------------------------------------------------------------------------
# Top Artists
# ---------------------------------------------------------------------------

class TopArtistsView(Widget):
    BINDINGS = [
        Binding("[", "shorter_range", "[ shorter", show=True),
        Binding("]", "longer_range",  "] longer",  show=True),
        Binding("r", "refresh_data",  "Refresh"),
    ]

    _range_idx: int = 1  # default: 30d

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("", id="artists-range-label")
            yield DataTable(id="artists-table")

    def on_mount(self) -> None:
        self._load()

    def action_refresh_data(self) -> None:
        self._load()

    def action_shorter_range(self) -> None:
        self._range_idx = max(0, self._range_idx - 1)
        self._load()

    def action_longer_range(self) -> None:
        self._range_idx = min(len(_RANGES) - 1, self._range_idx + 1)
        self._load()

    def _load(self) -> None:
        r = _RANGES[self._range_idx]
        prev_hint = f"[dim][ {_RANGE_LABELS[_RANGES[self._range_idx-1]]}[/dim]" if self._range_idx > 0 else ""
        next_hint = f"[dim]] {_RANGE_LABELS[_RANGES[self._range_idx+1]]}[/dim]" if self._range_idx < len(_RANGES)-1 else ""
        self.query_one("#artists-range-label", Static).update(
            f"[bold]Top Artists[/bold]  [cyan]{_RANGE_LABELS[r]}[/cyan]  {prev_hint}  {next_hint}"
        )
        tbl = self.query_one("#artists-table", DataTable)
        tbl.clear(columns=True)
        tbl.add_columns("#", "Artist", "Plays", "Total Time")
        for i, a in enumerate(st.top_artists(r, 100), 1):
            tbl.add_row(str(i), a["artist_name"], str(a["play_count"]),
                        st.ms_to_human(a["total_ms"]))


# ---------------------------------------------------------------------------
# Top Tracks
# ---------------------------------------------------------------------------

class TopTracksView(Widget):
    BINDINGS = [
        Binding("[", "shorter_range", "[ shorter", show=True),
        Binding("]", "longer_range",  "] longer",  show=True),
        Binding("r", "refresh_data",  "Refresh"),
    ]

    _range_idx: int = 1  # default: 30d

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("", id="tracks-range-label")
            yield DataTable(id="tracks-table")

    def on_mount(self) -> None:
        self._load()

    def action_refresh_data(self) -> None:
        self._load()

    def action_shorter_range(self) -> None:
        self._range_idx = max(0, self._range_idx - 1)
        self._load()

    def action_longer_range(self) -> None:
        self._range_idx = min(len(_RANGES) - 1, self._range_idx + 1)
        self._load()

    def _load(self) -> None:
        r = _RANGES[self._range_idx]
        prev_hint = f"[dim][ {_RANGE_LABELS[_RANGES[self._range_idx-1]]}[/dim]" if self._range_idx > 0 else ""
        next_hint = f"[dim]] {_RANGE_LABELS[_RANGES[self._range_idx+1]]}[/dim]" if self._range_idx < len(_RANGES)-1 else ""
        self.query_one("#tracks-range-label", Static).update(
            f"[bold]Top Tracks[/bold]  [cyan]{_RANGE_LABELS[r]}[/cyan]  {prev_hint}  {next_hint}"
        )
        tbl = self.query_one("#tracks-table", DataTable)
        tbl.clear(columns=True)
        tbl.add_columns("#", "Track", "Artist", "Plays", "Total Time")
        for i, t in enumerate(st.top_tracks(r, 100), 1):
            tbl.add_row(str(i), t["track_name"] or "—", t["artist_name"] or "—",
                        str(t["play_count"]), st.ms_to_human(t["total_ms"]))


# ---------------------------------------------------------------------------
# Daily View
# ---------------------------------------------------------------------------

class DailyView(Widget):
    # priority=True so these beat DataTable's own left/right column-scroll bindings
    BINDINGS = [
        Binding("left",  "prev_day", "← prev day", priority=True, show=True),
        Binding("right", "next_day", "next day →", priority=True, show=True),
        Binding("t",     "go_today", "t=today",    show=True),
    ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._day = date.today()

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("", id="day-header")
            yield DataTable(id="day-table")

    def on_mount(self) -> None:
        self._load()

    def action_prev_day(self) -> None:
        self._day -= timedelta(days=1)
        self._load()

    def action_next_day(self) -> None:
        if self._day < date.today():
            self._day += timedelta(days=1)
            self._load()

    def action_go_today(self) -> None:
        self._day = date.today()
        self._load()

    def _load(self) -> None:
        from datetime import datetime
        from level13.db import open_db

        total_ms = st.daily_listening_time(self._day)
        self.query_one("#day-header", Static).update(
            f"[bold]{self._day.strftime('%A, %B %-d %Y')}[/bold]  "
            f"[cyan]{st.ms_to_human(total_ms)}[/cyan] total  "
            "[dim]← → days · t=today[/dim]"
        )
        tbl = self.query_one("#day-table", DataTable)
        tbl.clear(columns=True)
        tbl.add_columns("Time", "Track", "Artist", "Album", "Duration")

        with open_db() as conn:
            rows = conn.execute(
                "SELECT played_at, track_name, artist_name, album_name, ms_played "
                "FROM plays WHERE date(played_at) = ? ORDER BY played_at",
                (self._day.isoformat(),),
            ).fetchall()

        for row in rows:
            try:
                dt = datetime.fromisoformat(row["played_at"].replace("Z", "+00:00"))
                time_str = dt.astimezone().strftime("%H:%M")
            except Exception:
                time_str = row["played_at"][:16]
            dur = st.ms_to_human(row["ms_played"]) if row["ms_played"] else "~3:30"
            tbl.add_row(time_str, row["track_name"] or "—", row["artist_name"] or "—",
                        row["album_name"] or "—", dur)


# ---------------------------------------------------------------------------
# History View — braille pixel chart, one day per ~2 pixels
# ---------------------------------------------------------------------------
#
# Each Unicode braille character is a 2×4 dot grid, giving 2× horizontal and
# 4× vertical resolution compared to a plain character cell.  We use this to
# render a filled area chart for each top artist across the full listening
# history.  Zoom (+-) and pan (←→) let you drill from "all 4 years" down to
# a single month at single-day resolution.
#
# Braille dot bit layout (offset from U+2800):
#   Left col  → dots 1-2-3-7 → bits 0x01 0x02 0x04 0x40   (rows 0-3)
#   Right col → dots 4-5-6-8 → bits 0x08 0x10 0x20 0x80   (rows 0-3)

_BD = [
    [0x01, 0x08],   # cell row 0 (top):    left, right
    [0x02, 0x10],   # cell row 1
    [0x04, 0x20],   # cell row 2
    [0x40, 0x80],   # cell row 3 (bottom)
]

# Vibrant palette – looks great on dark backgrounds
_COLORS = [
    "#1DB954",  # Spotify green
    "#5B9BD5",  # sky blue
    "#FF6B6B",  # coral
    "#FFD93D",  # gold
    "#C77DFF",  # violet
    "#06D6A0",  # mint
    "#FF4D6D",  # hot pink
    "#4CC9F0",  # cyan
    "#F8961E",  # orange
    "#90BE6D",  # sage green
    "#43AA8B",  # teal
    "#F94144",  # red
]

_ZOOM_DAYS  = {0: None, 1: 365, 2: 182, 3: 91, 4: 30}
_ZOOM_LABEL = {0: "all time", 1: "1 year", 2: "6 months", 3: "3 months", 4: "1 month"}

_LABEL_W = 24   # chars reserved for artist name/stats on the left


def _gaussian_spread(sampled: list[float]) -> list[float]:
    """Gaussian max-spread in column space (σ=3 cols, radius=9).

    Each non-zero column decays as a Gaussian into its neighbours.
    The result at each position is the maximum contribution from any peak,
    producing smooth organic hills rather than flat-topped rectangular bars.
    """
    import math
    _S = 3.0
    _W = [math.exp(-0.5 * (d / _S) ** 2) for d in range(10)]  # weights 0..9
    n = len(sampled)
    out = [0.0] * n
    for i in range(n):
        v = sampled[i]
        if v <= 0:
            continue
        if v > out[i]:
            out[i] = v
        for d in range(1, 10):
            w = v * _W[d]
            if i + d < n and w > out[i + d]:
                out[i + d] = w
            if i - d >= 0 and w > out[i - d]:
                out[i - d] = w
    return out


def _sample(data: list[float], n_cols: int) -> list[float]:
    """Down/up-sample data into exactly n_cols buckets (max of each bucket)."""
    if not data:
        return [0.0] * n_cols
    nd = len(data)
    out = []
    for c in range(n_cols):
        lo = int(c / n_cols * nd)
        hi = int((c + 1) / n_cols * nd)
        if lo >= hi:
            hi = lo + 1
        hi = min(hi, nd)
        bucket = data[lo:hi]
        out.append(max(bucket) if bucket else 0.0)
    return out


class HistoryView(Widget):
    """Full-screen braille area chart — all listening history at pixel density."""

    can_focus = True

    BINDINGS = [
        Binding("+",     "zoom_in",       "+ zoom",    show=True),
        Binding("-",     "zoom_out",      "- zoom",    show=True),
        Binding("0",     "zoom_reset",    "0 reset",   show=True),
        Binding("left",  "pan_left",      "← pan",     priority=True, show=True),
        Binding("right", "pan_right",     "→ pan",     priority=True, show=True),
        Binding("]",     "more_artists",  "] +artist", show=True),
        Binding("[",     "fewer_artists", "[ -artist", show=True),
        Binding("r",     "refresh_data",  "Refresh"),
    ]

    _zoom:        int  = 1    # default: 1 year so the chart starts populated
    _offset:      int  = 0   # leftmost visible day index
    _n_artists:   int  = 10
    _data:        dict | None = None

    def on_mount(self) -> None:
        self.call_after_refresh(self._load)

    def _load(self) -> None:
        self._data = st.artist_daily_history(self._n_artists)
        self._offset = self._default_offset()
        self.refresh()

    # --- actions ---

    def action_zoom_in(self) -> None:
        self._zoom = min(4, self._zoom + 1)
        self._offset = self._default_offset()
        self.refresh()

    def action_zoom_out(self) -> None:
        self._zoom = max(0, self._zoom - 1)
        self._offset = self._default_offset()
        self.refresh()

    def action_zoom_reset(self) -> None:
        self._zoom = 0
        self._offset = 0
        self.refresh()

    def action_pan_left(self) -> None:
        if self._zoom == 0:
            return
        self._offset = max(0, self._offset - self._span() // 8)
        self.refresh()

    def action_pan_right(self) -> None:
        if self._zoom == 0 or not self._data:
            return
        n = len(self._data["days"])
        self._offset = min(n - self._span(), self._offset + self._span() // 8)
        self.refresh()

    def action_more_artists(self) -> None:
        self._n_artists = min(15, self._n_artists + 1)
        self._load()

    def action_fewer_artists(self) -> None:
        self._n_artists = max(3, self._n_artists - 1)
        self._load()

    def action_refresh_data(self) -> None:
        self._load()

    # --- helpers ---

    def _span(self) -> int:
        if not self._data:
            return 30
        n = len(self._data["days"])
        s = _ZOOM_DAYS.get(self._zoom)
        return n if s is None else min(s, n)

    def _default_offset(self) -> int:
        if not self._data:
            return 0
        n = len(self._data["days"])
        return max(0, n - self._span())

    # --- rendering ---

    def render(self):                               # → RenderableType
        from rich.text import Text

        w, h = self.size.width, self.size.height
        if not w or not h:
            return Text("")
        if not self._data or not self._data.get("days"):
            return Text("  Loading history…", style="dim")
        return self._draw(w, h)

    def _draw(self, W: int, H: int):
        from rich.text import Text

        days    = self._data["days"]
        artists = self._data["artists"][: self._n_artists]
        n_days  = len(days)
        span    = self._span()
        offset  = max(0, min(self._offset, n_days - span))

        chart_w  = max(4, W - _LABEL_W)
        br_cols  = chart_w * 2          # 2× horizontal resolution via braille

        # rows available to divide among artists (reserve 2: header + axis)
        rows_per = max(2, (H - 2) // len(artists)) if artists else 2
        br_rows  = rows_per * 4         # 4× vertical resolution via braille

        out = Text()

        # ── header ──────────────────────────────────────────────────────────
        v0 = days[offset][:7] if days else "?"
        v1 = days[min(offset + span - 1, n_days - 1)][:7] if days else "?"
        out.append("Artist History  ", style="bold white")
        out.append(f"{v0} → {v1}", style="cyan")
        out.append(f"  {_ZOOM_LABEL[self._zoom]}", style="dim")
        out.append(
            f"  [+/-] zoom  [←→] pan  [[/]] artists ({self._n_artists})",
            style="dim",
        )
        out.append("\n")

        # ── artist rows ──────────────────────────────────────────────────────
        for ai, artist in enumerate(artists):
            color   = _COLORS[ai % len(_COLORS)]
            daily   = artist["daily_ms"]
            end_idx = min(offset + span, n_days)
            visible = daily[offset:end_idx]

            # Sample to braille resolution then apply Gaussian max-spread:
            # each listening day becomes a smooth hill that fades into neighbours.
            sampled = _sample(visible, br_cols)
            sampled = _gaussian_spread(sampled)

            peak = max(sampled) if sampled else 1.0
            if peak == 0:
                peak = 1.0

            # Build braille grid [char_row][char_col]
            grid = [[0] * chart_w for _ in range(rows_per)]
            for bc, val in enumerate(sampled):
                cc  = bc // 2       # char column
                wc  = bc % 2        # 0=left, 1=right braille column
                fill = int(val / peak * br_rows)
                if fill < 2:
                    fill = 0
                for br in range(br_rows - fill, br_rows):
                    cr = br // 4
                    wr = br % 4
                    if cr < rows_per:
                        grid[cr][cc] |= _BD[wr][wc]

            # Emit rows
            for r in range(rows_per):
                line = Text()
                if r == 0:
                    label = f" {artist['name'][:_LABEL_W - 2]}"
                    line.append(f"{label:<{_LABEL_W}}", style=f"bold {color}")
                elif r == 1 and rows_per > 1:
                    hrs = st.ms_to_human(artist["total_ms"])
                    line.append(f"  {hrs:>{_LABEL_W - 2}}", style=f"dim {color}")
                else:
                    line.append(" " * _LABEL_W)

                for c in range(chart_w):
                    bits = grid[r][c]
                    line.append(chr(0x2800 + bits) if bits else " ", style=color)

                out.append_text(line)
                out.append("\n")

        # ── year axis ────────────────────────────────────────────────────────
        out.append(" " * _LABEL_W, style="dim")
        axis = [" "] * chart_w
        prev_year = ""
        for i in range(offset, min(offset + span, n_days)):
            yr = days[i][:4]
            if yr != prev_year:
                cp = int((i - offset) / span * br_cols) // 2
                for j, ch in enumerate(yr):
                    if cp + j < chart_w:
                        axis[cp + j] = ch
                prev_year = yr
        out.append("".join(axis), style="dim")

        return out
