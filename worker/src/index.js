export default {
  async scheduled(event, env, ctx) {
    // 1. Refresh Spotify access token
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: env.SPOTIFY_REFRESH_TOKEN,
      }),
    });

    if (!tokenRes.ok) {
      console.error('Token refresh failed:', await tokenRes.text());
      return;
    }

    const { access_token } = await tokenRes.json();

    // 2. Read cursor from D1
    const cursorRow = await env.DB
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .bind('last_poll_cursor')
      .first();
    const cursor = cursorRow?.value ?? null;

    // 3. Fetch recently played tracks
    const url = new URL('https://api.spotify.com/v1/me/player/recently-played');
    url.searchParams.set('limit', '50');
    if (cursor) url.searchParams.set('after', String(new Date(cursor).getTime()));

    const recentRes = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${access_token}` },
    });

    if (!recentRes.ok) {
      console.error('Recently played fetch failed:', await recentRes.text());
      return;
    }

    const { items } = await recentRes.json();

    if (!items || items.length === 0) {
      console.log('No new tracks since last poll.');
      return;
    }

    // 4. Batch insert via D1 binding
    const stmts = items.map(item => {
      const track = item.track;
      return env.DB
        .prepare('INSERT OR IGNORE INTO plays (played_at, track_uri, track_name, artist_name, album_name, source) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(
          item.played_at,
          track.uri,
          track.name,
          track.artists[0]?.name ?? null,
          track.album?.name ?? null,
          'api',
        );
    });

    await env.DB.batch(stmts);
    console.log(`Processed ${items.length} tracks.`);

    // 5. Update cursor to newest item's played_at (items are newest-first)
    const newest = items[0].played_at;
    await env.DB
      .prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)')
      .bind('last_poll_cursor', newest)
      .run();

    console.log(`Cursor updated to ${newest}`);
  },
};
