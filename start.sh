#!/bin/sh
# level13 — start the TUI.
# ./start.sh          TUI only
# ./start.sh --poller TUI + background poller (requires Spotify credentials)

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/.venv/bin/level13"

if [ ! -x "$BIN" ]; then
  echo "Setting up Python environment..."
  python3 -m venv "$DIR/.venv"
  "$DIR/.venv/bin/pip" install -q -e "$DIR"
fi

if [ "$1" = "--poller" ]; then
  if [ -z "$SPOTIPY_CLIENT_ID" ] || [ -z "$SPOTIPY_CLIENT_SECRET" ]; then
    echo "Warning: SPOTIPY_CLIENT_ID/SPOTIPY_CLIENT_SECRET not set — skipping poller."
  else
    "$BIN" poll start
  fi
fi

exec "$BIN" tui
