// Standalone polling daemon — run directly: node js/poller.js
// NOT bundled by esbuild; imports directly from js/ source.

import fs from 'fs';
import { DATA_DIR, PID_FILE, LOG_FILE, POLL_INTERVAL_MS } from './config.js';
import { createSpotifyClient, refreshIfNeeded } from './auth.js';
import { getDb, insertPlay, getSyncState, setSyncState } from './db.js';

// ------------------------------------------------------------------
// PID file
// ------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(PID_FILE, String(process.pid));

function cleanup() {
  try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
}

process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('exit',    () => cleanup());

// ------------------------------------------------------------------
// Logging
// ------------------------------------------------------------------
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
}

// ------------------------------------------------------------------
// Poll
// ------------------------------------------------------------------
const spotify = createSpotifyClient();

async function poll() {
  await refreshIfNeeded(spotify);

  const cursor = getSyncState('last_poll_cursor');
  const opts = { limit: 50 };
  if (cursor) {
    // Spotify `after` param is a Unix timestamp in milliseconds
    opts.after = new Date(cursor).getTime();
  }

  const data = await spotify.getMyRecentlyPlayedTracks(opts);
  const items = data.body.items || [];
  if (items.length === 0) {
    log('Poll: no new tracks');
    return;
  }

  const db = getDb();
  const insertMany = db.transaction((rows) => {
    for (const item of rows) {
      insertPlay({
        played_at:   item.played_at,
        track_uri:   item.track.uri,
        track_name:  item.track.name,
        artist_name: item.track.artists[0]?.name ?? 'Unknown',
        album_name:  item.track.album?.name ?? '',
        ms_played:   null,
        source:      'api',
      });
    }
  });
  insertMany(items);

  // items are newest-first; cursor = newest play's timestamp
  const newest = items[0].played_at;
  setSyncState('last_poll_cursor', newest);
  log(`Poll: inserted up to ${items.length} tracks (newest: ${newest})`);
}

// ------------------------------------------------------------------
// Main loop
// ------------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  log(`Poller started (PID ${process.pid})`);
  while (true) {
    try {
      await poll();
    } catch (err) {
      if (err.statusCode === 429) {
        const wait = parseInt(err.headers?.['retry-after'] ?? '60', 10) * 1000;
        log(`Rate limited — sleeping ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      log(`Poll error: ${err.message}`);
      // On auth errors try once after a short delay; other errors just wait a minute
      await sleep(60_000);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

run().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
