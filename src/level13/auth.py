"""Spotify OAuth2 via spotipy — Authorization Code flow with token caching."""

import os

import spotipy
from spotipy.oauth2 import SpotifyOAuth

from level13.config import SPOTIFY_SCOPES, TOKEN_CACHE_PATH, ensure_data_dir


def _get_oauth() -> SpotifyOAuth:
    """Build a SpotifyOAuth handler.

    Credentials are read from environment variables:
      SPOTIPY_CLIENT_ID
      SPOTIPY_CLIENT_SECRET
      SPOTIPY_REDIRECT_URI  (defaults to http://localhost:8888/callback)
    """
    ensure_data_dir()

    client_id = os.environ.get("SPOTIPY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIPY_CLIENT_SECRET")
    redirect_uri = os.environ.get("SPOTIPY_REDIRECT_URI", "http://localhost:8888/callback")

    if not client_id or not client_secret:
        raise EnvironmentError(
            "SPOTIPY_CLIENT_ID and SPOTIPY_CLIENT_SECRET must be set.\n"
            "Create a Spotify Developer app at https://developer.spotify.com/dashboard "
            "and export those variables."
        )

    return SpotifyOAuth(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=redirect_uri,
        scope=SPOTIFY_SCOPES,
        cache_path=str(TOKEN_CACHE_PATH),
        open_browser=True,
    )


def get_spotify_client() -> spotipy.Spotify:
    """Return an authenticated Spotify client with automatic token refresh."""
    auth_manager = _get_oauth()
    return spotipy.Spotify(auth_manager=auth_manager)


def run_auth_flow() -> str:
    """Interactive OAuth flow — opens browser, waits for callback.

    Returns the display name of the authenticated user.
    """
    auth_manager = _get_oauth()

    # Force a fresh token fetch (opens browser if needed)
    token_info = auth_manager.get_cached_token()
    if not token_info:
        # get_access_token triggers the browser-based auth flow
        auth_url = auth_manager.get_authorize_url()
        print(f"\nOpening browser for Spotify authorization...\n{auth_url}\n")
        import webbrowser
        webbrowser.open(auth_url)
        response = input("Paste the redirect URL here: ").strip()
        code = auth_manager.parse_response_code(response)
        auth_manager.get_access_token(code)

    sp = spotipy.Spotify(auth_manager=auth_manager)
    user = sp.current_user()
    return user.get("display_name") or user.get("id", "unknown")
