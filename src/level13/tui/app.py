"""Main Textual application."""

from __future__ import annotations

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.widgets import Footer, Header, TabbedContent, TabPane

from level13.tui.screens import DailyView, DashboardView, HistoryView, TopArtistsView, TopTracksView


class Level13App(App):
    """Personal Spotify Wrapped — always-available listening analytics."""

    CSS = """
    Screen {
        padding: 1 2;
    }
    TabbedContent, TabPane {
        height: 1fr;
    }
    DashboardView, TopArtistsView, TopTracksView, DailyView, HistoryView {
        height: 1fr;
    }
    Vertical {
        height: 1fr;
    }
    DataTable {
        height: 1fr;
    }
    Static, Label {
        height: auto;
    }
    """

    # priority=True: fire before any focused widget (DataTable vim keys, etc.)
    BINDINGS = [
        Binding("q",      "quit", "Quit", priority=True),
        Binding("ctrl+c", "quit", "Quit", priority=True, show=False),
        Binding("1", "show_tab('dashboard')", "1 Dash",     priority=True, show=True),
        Binding("2", "show_tab('artists')",   "2 Artists",  priority=True, show=True),
        Binding("3", "show_tab('tracks')",    "3 Tracks",   priority=True, show=True),
        Binding("4", "show_tab('daily')",     "4 Daily",    priority=True, show=True),
        Binding("5", "show_tab('history')",   "5 History",  priority=True, show=True),
    ]

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with TabbedContent(initial="dashboard"):
            with TabPane("1 Dashboard", id="dashboard"):
                yield DashboardView()
            with TabPane("2 Artists", id="artists"):
                yield TopArtistsView()
            with TabPane("3 Tracks", id="tracks"):
                yield TopTracksView()
            with TabPane("4 Daily", id="daily"):
                yield DailyView()
            with TabPane("5 History", id="history"):
                yield HistoryView()
        yield Footer()

    def action_show_tab(self, tab_id: str) -> None:
        self.query_one(TabbedContent).active = tab_id
        # After switching, explicitly move focus into the new pane.
        # Without this, the previously-focused DataTable in the old tab keeps
        # triggering TabPane._on_descendant_focus, which makes TabbedContent
        # snap active back to the old tab.
        self.call_after_refresh(self._focus_pane, tab_id)

    def _focus_pane(self, tab_id: str) -> None:
        """Focus the first focusable widget inside the given tab pane."""
        try:
            pane = self.query_one(f"#{tab_id}", TabPane)
            for widget in pane.walk_children():
                if widget.can_focus and widget.display:
                    self.set_focus(widget)
                    return
        except Exception:
            pass


def run() -> None:
    app = Level13App()
    app.run()
