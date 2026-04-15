// Resolve missing Apple Music artists via iTunes Search API.
//
// Apple's privacy export leaves Artist Name blank in nearly all rows of
// Apple Music Play Activity.csv. The importer fills most of those from
// the user's Library Tracks JSON, but ~800 distinct streaming-only tracks
// remain unresolved. iTunes Search is a free, unauthenticated endpoint
// (https://itunes.apple.com/search) that resolves them from track+album.
//
// Strategy:
//   1. SELECT distinct (track_name, album_name) pairs with null artist.
//   2. For each, query iTunes Search and pick the best match (album-aware
//      when album is present).
//   3. UPDATE each row's artist_name AND regenerate its synthetic track_uri
//      so future re-imports collapse into the same key.
//   4. Cache resolved artists in a JSON file to make re-runs idempotent
//      and fast.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { d1Query, d1Exec } from './d1.js';

const CACHE_PATH = path.join(os.homedir(), '.local/share/level13/itunes-artist-cache.json');
const REQ_DELAY_MS = 1200; // ~50 req/min — iTunes Search returns 403 above ~70/min sustained
const RETRY_DELAY_MS = 30_000; // back off 30s on 403, up to MAX_RETRIES times
const MAX_RETRIES = 4;

// Known cover/karaoke/tribute "artists" that pollute iTunes Search results.
// When the matcher returns one of these for a famous song, it's almost always
// wrong — the original artist is on a different store than the cover.
const COVER_PATTERNS = [
  /karaoke/i, /tribute/i, /cover\b/i, /kidzone/i,
  /\brock star\b/i, /little.*rock star/i,
  /\bworkout\b/i, /\bperformance\b/i,
  /power electric band/i, /the rock heroes/i,
  /\bplayed by\b/i, /\bin the style of\b/i,
];
function looksLikeCover(name) {
  return COVER_PATTERNS.some(re => re.test(name || ''));
}

function syntheticUri(artist, track) {
  if (!artist && !track) return null;
  const a = (artist || '').toLowerCase().replace(/\s+/g, '_');
  const t = (track  || '').toLowerCase().replace(/\s+/g, '_');
  return `apple:${a}:${t}`;
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
  catch { return {}; }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function cacheKey(track, album) {
  return `${(track || '').toLowerCase()}|${(album || '').toLowerCase()}`;
}

// Strip parenthetical/featuring noise that hurts matching. Keep the result
// for matching purposes only — the original strings stay in the DB.
function normalizeTitle(s) {
  if (!s) return '';
  return s
    .replace(/\(feat\..*?\)/gi, '')
    .replace(/\[feat\..*?\]/gi, '')
    .replace(/\(with .*?\)/gi, '')
    .replace(/\(.*?(remaster|deluxe|edition|version|bonus|live|expanded|remix).*?\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchItunes(term) {
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=15&country=US`;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 403 || res.status === 429) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      continue;
    }
    throw new Error(`iTunes ${res.status}`);
  }
  throw new Error('iTunes 403 (max retries exhausted)');
}

async function searchItunes(track, album) {
  const term = encodeURIComponent(`${normalizeTitle(track)} ${normalizeTitle(album)}`.trim());
  const json = await fetchItunes(term);
  const results = json.results || [];
  if (results.length === 0) return null;

  const trackNorm = normalizeTitle(track).toLowerCase();
  const albumNorm = normalizeTitle(album).toLowerCase();

  let best = null, bestScore = -1;
  for (const r of results) {
    if (looksLikeCover(r.artistName) || looksLikeCover(r.collectionName)) continue;

    const rt = normalizeTitle(r.trackName || '').toLowerCase();
    const ra = normalizeTitle(r.collectionName || '').toLowerCase();
    let score = 0;
    if (rt === trackNorm) score += 10;
    else if (rt.includes(trackNorm) || trackNorm.includes(rt)) score += 4;
    if (album) {
      if (ra === albumNorm) score += 8;
      else if (ra.includes(albumNorm) || albumNorm.includes(ra)) score += 5;
      // small overlap (e.g. shared first word) only counts a little
      else if (ra.split(' ')[0] && albumNorm.split(' ')[0] && ra.split(' ')[0] === albumNorm.split(' ')[0]) score += 1;
      else score -= 3; // album was provided but didn't match — penalize
    }
    if (score > bestScore) { bestScore = score; best = r; }
  }

  // Require a meaningful confidence floor:
  // - album-aware match needs >= 9 (track-exact + album-overlap)
  // - title-only match (no album in source) needs >= 10 (exact title)
  const floor = album ? 9 : 10;
  if (bestScore < floor) return null;
  return best?.artistName || null;
}

export async function runArtistBackfill({ limit = null, dryRun = false } = {}) {
  console.log('Loading distinct unresolved (track, album) pairs from D1 ...');
  let unresolved = await d1Query(`
    SELECT track_name, album_name, COUNT(*) as plays
    FROM plays
    WHERE source='apple_music'
      AND (artist_name IS NULL OR artist_name='')
      AND track_name IS NOT NULL
      AND track_name <> ''
    GROUP BY track_name, album_name
    ORDER BY plays DESC
  `);
  console.log(`Found ${unresolved.length} distinct unresolved tracks.`);
  if (limit) unresolved = unresolved.slice(0, limit);

  const cache = loadCache();
  let resolved = 0, missed = 0, fromCache = 0, rowsUpdated = 0, errors = 0;

  for (let i = 0; i < unresolved.length; i++) {
    const { track_name, album_name, plays } = unresolved[i];
    const key = cacheKey(track_name, album_name);
    let artist = cache[key];

    if (artist === undefined) {
      try {
        artist = await searchItunes(track_name, album_name);
        cache[key] = artist; // null = looked up, no match
        if (i % 25 === 0) saveCache(cache);
        await new Promise(r => setTimeout(r, REQ_DELAY_MS));
      } catch (e) {
        errors++;
        process.stdout.write(`\n  iTunes error for "${track_name}": ${e.message}\n`);
        continue;
      }
    } else {
      fromCache++;
    }

    if (!artist) { missed++; }
    else {
      resolved++;
      if (!dryRun) {
        const newUri = syntheticUri(artist, track_name);
        // Update by (track_name, album_name) match; regenerate URI atomically
        const sql = album_name === null
          ? `UPDATE plays SET artist_name = ?, track_uri = ? WHERE source='apple_music' AND track_name = ? AND album_name IS NULL AND (artist_name IS NULL OR artist_name='')`
          : `UPDATE plays SET artist_name = ?, track_uri = ? WHERE source='apple_music' AND track_name = ? AND album_name = ? AND (artist_name IS NULL OR artist_name='')`;
        const params = album_name === null
          ? [artist, newUri, track_name]
          : [artist, newUri, track_name, album_name];
        try {
          const r = await d1Exec(sql, params);
          rowsUpdated += r.changes;
        } catch (e) {
          errors++;
          process.stdout.write(`\n  D1 update error for "${track_name}": ${e.message}\n`);
        }
      }
    }

    process.stdout.write(`\r  [${i + 1}/${unresolved.length}] resolved=${resolved} missed=${missed} cached=${fromCache} updated=${rowsUpdated}`);
  }

  saveCache(cache);
  console.log('\n');
  console.log(`Backfill complete.`);
  console.log(`  Distinct tracks processed: ${unresolved.length}`);
  console.log(`  Resolved via iTunes:       ${resolved}`);
  console.log(`  Pulled from cache:         ${fromCache}`);
  console.log(`  Not found:                 ${missed}`);
  console.log(`  Rows updated in D1:        ${rowsUpdated}`);
  console.log(`  Errors:                    ${errors}`);
  console.log(`  Cache file: ${CACHE_PATH}`);
}
