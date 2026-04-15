import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { d1Exec } from './d1.js';

const MIN_MS = 30_000;
const BATCH  = 14; // 14 rows × 7 params = 98, under D1's 100-variable statement limit

// ---------------------------------------------------------------------------
// CSV parser (handles quoted fields with embedded commas/newlines)
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let col = 0, row = [], inQuote = false, field = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else field += ch;
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { row.push(field); field = ''; col++; }
      else if (ch === '\n' || ch === '\r') {
        row.push(field); field = ''; col = 0;
        if (row.some(f => f !== '')) rows.push(row);
        row = [];
        if (ch === '\r' && text[i + 1] === '\n') i++;
      } else {
        field += ch;
      }
    }
  }
  if (field || row.length) { row.push(field); if (row.some(f => f !== '')) rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// Column name resolver — Apple's export format has changed over the years
// ---------------------------------------------------------------------------
const COLUMN_CANDIDATES = {
  track:     ['Track Description', 'Song Name', 'Title', 'Track Name', 'Content Name'],
  artist:    ['Artist Name', 'Artist', 'Performer', 'Container Artist Name'],
  album:     ['Album Name', 'Album', 'Container Description', 'Collection Name'],
  date:      ['Play Date', 'Date Played', 'Last Played Date', 'Event Start Timestamp',
              'Event End Timestamp', 'Activity Date Time', 'Last Event End Timestamp',
              'First Event Timestamp', 'Last Event Start Timestamp'],
  ms:        ['Play Duration Milliseconds', 'Play Duration Ms', 'Duration Milliseconds',
              'Played completely', 'Max Play Duration in millis',
              'Total play duration in millis'],
  mediaMs:   ['Media Duration In Milliseconds', 'Track Duration Ms', 'Duration',
              'Media duration in millis'],
  hours:     ['Hours'],
  playCount: ['Play Count', 'Total plays'],
  eventType: ['Event Type'],
};

function resolveColumns(headers) {
  const hLower = headers.map(h => h.trim().toLowerCase());
  const find = (candidates) => {
    for (const c of candidates) {
      const idx = hLower.indexOf(c.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  };
  return {
    track:     find(COLUMN_CANDIDATES.track),
    artist:    find(COLUMN_CANDIDATES.artist),
    album:     find(COLUMN_CANDIDATES.album),
    date:      find(COLUMN_CANDIDATES.date),
    ms:        find(COLUMN_CANDIDATES.ms),
    mediaMs:   find(COLUMN_CANDIDATES.mediaMs),
    hours:     find(COLUMN_CANDIDATES.hours),
    playCount: find(COLUMN_CANDIDATES.playCount),
    eventType: find(COLUMN_CANDIDATES.eventType),
  };
}

// ---------------------------------------------------------------------------
// Date parsing — Apple has used multiple formats across export versions
// ---------------------------------------------------------------------------
function parseAppleDate(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // ISO-ish: "2022-01-15T10:30:45Z" or "2022-01-15 10:30:45"
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) || /^\d{4}-\d{2}-\d{2} \d/.test(s)) {
    const d = new Date(s.replace(' ', 'T').replace(/([+-]\d{2}:\d{2}|Z)?$/, v => v || 'Z'));
    if (!isNaN(d)) return d.toISOString();
  }

  // Date only: "2022-01-15" → use noon UTC as synthetic time
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return `${s}T12:00:00.000Z`;
  }

  // Compact date: "20180615" → noon UTC (Hours column overrides later)
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T12:00:00.000Z`;
  }

  // Unix timestamp (ms or s)
  if (/^\d{10,13}$/.test(s)) {
    const ms = s.length === 13 ? parseInt(s) : parseInt(s) * 1000;
    return new Date(ms).toISOString();
  }

  // Apple locale format: "Jan 15, 2022 at 10:30 AM"
  const m = s.match(/(\w+ \d+, \d{4})(?: at (\d+:\d+ [AP]M))?/);
  if (m) {
    const d = new Date(`${m[1]}${m[2] ? ' ' + m[2] : ''}`);
    if (!isNaN(d)) return d.toISOString();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Library Tracks lookup (resolves missing artists in Play Activity)
// ---------------------------------------------------------------------------
function buildArtistLookup(workDir) {
  const lookup = new Map();
  let libTracksPath = null;

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/Apple Music Library Tracks\.json(\.zip)?$/.test(entry.name)) {
        libTracksPath = full;
      }
    }
  }
  walk(workDir);

  if (!libTracksPath) return lookup;

  let jsonPath = libTracksPath;
  if (libTracksPath.endsWith('.zip')) {
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'level13-lib-'));
    execSync(`unzip -q "${libTracksPath}" -d "${extractDir}"`);
    const files = fs.readdirSync(extractDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return lookup;
    jsonPath = path.join(extractDir, files[0]);
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!Array.isArray(data)) return lookup;

  for (const t of data) {
    const title  = t.Title || t['Song Name'];
    const artist = t.Artist || t['Album Artist'];
    const album  = t.Album;
    if (!title || !artist) continue;
    // Keyed by title+album (more specific), plus title-only as fallback
    if (album) lookup.set(`${title.toLowerCase()}|${album.toLowerCase()}`, artist);
    if (!lookup.has(title.toLowerCase())) lookup.set(title.toLowerCase(), artist);
  }

  console.log(`Loaded ${lookup.size} entries from Apple Music Library Tracks for artist lookup.`);
  return lookup;
}

function resolveArtist(lookup, title, album) {
  if (!title) return null;
  if (album) {
    const hit = lookup.get(`${title.toLowerCase()}|${album.toLowerCase()}`);
    if (hit) return hit;
  }
  return lookup.get(title.toLowerCase()) || null;
}

// Synthetic track_uri for dedup (no Spotify URIs in Apple data)
function syntheticUri(artist, track) {
  if (!artist && !track) return null;
  const a = (artist || '').toLowerCase().replace(/\s+/g, '_');
  const t = (track  || '').toLowerCase().replace(/\s+/g, '_');
  return `apple:${a}:${t}`;
}

// ---------------------------------------------------------------------------
// File finder
// ---------------------------------------------------------------------------
function collectCsvFiles(dir) {
  const results = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.name.endsWith('.csv') &&
        /apple.music/i.test(entry.name) &&
        /play|activity|history|listen/i.test(entry.name) &&
        !/click/i.test(entry.name) &&
        !/container/i.test(entry.name) &&
        !/statistics/i.test(entry.name)
      ) results.push(full);
    }
  }
  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function runAppleImport(inputPath) {
  const resolved = path.resolve(inputPath);
  let workDir = resolved;
  let tmpDir  = null;

  if (resolved.endsWith('.zip')) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'level13-apple-'));
    console.log(`Extracting ${resolved} ...`);
    execSync(`unzip -q "${resolved}" -d "${tmpDir}"`);
    workDir = tmpDir;
  }

  const csvFiles = fs.statSync(workDir).isFile() && workDir.endsWith('.csv')
    ? [workDir]
    : collectCsvFiles(workDir);

  if (csvFiles.length === 0) {
    console.error('No Apple Music CSV files found.');
    console.error('Expected files matching: Apple Music*play*history*.csv (or activity/listen)');
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true });
    process.exit(1);
  }

  console.log(`Found ${csvFiles.length} Apple Music CSV file(s):`);
  for (const f of csvFiles) console.log(`  ${path.basename(f)}`);
  console.log();

  const artistLookup = buildArtistLookup(workDir);

  let totalRows = 0, inserted = 0, skipped = 0, artistResolved = 0;

  for (const file of csvFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const rows = parseCsv(text);
    if (rows.length < 2) { console.log(`  ${path.basename(file)}: empty, skipping.`); continue; }

    const headers = rows[0];
    const cols = resolveColumns(headers);

    console.log(`  ${path.basename(file)}: ${rows.length - 1} rows`);
    console.log(`  Columns detected:`);
    console.log(`    track:   ${cols.track   >= 0 ? headers[cols.track]   : '(not found)'}`);
    console.log(`    artist:  ${cols.artist  >= 0 ? headers[cols.artist]  : '(not found)'}`);
    console.log(`    album:   ${cols.album   >= 0 ? headers[cols.album]   : '(not found)'}`);
    console.log(`    date:    ${cols.date    >= 0 ? headers[cols.date]    : '(not found)'}`);
    console.log(`    ms:      ${cols.ms      >= 0 ? headers[cols.ms]      : '(not found)'}`);

    if (cols.track < 0 && cols.artist < 0) {
      console.warn(`  WARNING: Could not identify track/artist columns. Actual headers:`);
      console.warn(`    ${headers.join(', ')}`);
      console.warn(`  Skipping this file. Please open a GitHub issue with your header row.`);
      continue;
    }

    // Parse and map records
    const records = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      totalRows++;

      const trackRaw     = cols.track     >= 0 ? r[cols.track]?.trim()     : null;
      const artistRaw    = cols.artist    >= 0 ? r[cols.artist]?.trim()    : null;
      const albumRaw     = cols.album     >= 0 ? r[cols.album]?.trim()     : null;
      const dateRaw      = cols.date      >= 0 ? r[cols.date]?.trim()      : null;
      const msRaw        = cols.ms        >= 0 ? r[cols.ms]?.trim()        : null;
      const hoursRaw     = cols.hours     >= 0 ? r[cols.hours]?.trim()     : null;
      const playCountRaw = cols.playCount >= 0 ? r[cols.playCount]?.trim() : null;
      const eventType    = cols.eventType >= 0 ? r[cols.eventType]?.trim() : null;

      // Skip PLAY_START events (we count completed/partial plays via PLAY_END)
      if (eventType === 'PLAY_START') { skipped++; continue; }

      // "Track Description" / "Track Name" sometimes encodes as "Artist - Track Title"
      let trackName  = trackRaw  || null;
      let artistName = artistRaw || null;
      if (!artistName && trackRaw?.includes(' - ')) {
        const [a, ...rest] = trackRaw.split(' - ');
        artistName = a.trim();
        trackName  = rest.join(' - ').trim();
      }

      // Drop rows with no track AND no artist — they carry zero information.
      if (!trackName && !artistName) { skipped++; continue; }

      // Fall back to Apple Music Library Tracks lookup
      if (!artistName && trackName) {
        const hit = resolveArtist(artistLookup, trackName, albumRaw);
        if (hit) { artistName = hit; artistResolved++; }
      }

      let played_at = parseAppleDate(dateRaw);
      if (!played_at) { skipped++; continue; }

      // If an Hours column is present, overlay hour onto synthetic-noon date
      if (hoursRaw && /^\d{1,2}$/.test(hoursRaw)) {
        const hour = parseInt(hoursRaw);
        if (hour >= 0 && hour <= 23) {
          const d = new Date(played_at);
          d.setUTCHours(hour, 0, 0, 0);
          played_at = d.toISOString();
        }
      }

      const ms_played_total = msRaw && /^\d+$/.test(msRaw) ? parseInt(msRaw) : null;

      // Play Count expansion: rows with Play Count > 1 are aggregates. Expand
      // into N individual plays with second-level offsets so dedup key stays unique.
      const playCount = playCountRaw && /^\d+$/.test(playCountRaw)
        ? Math.max(1, parseInt(playCountRaw)) : 1;
      const perPlayMs = ms_played_total !== null
        ? Math.floor(ms_played_total / playCount) : null;

      // Filter very short plays (likely skips). Only filter per-play duration.
      if (perPlayMs !== null && perPlayMs < MIN_MS) { skipped++; continue; }

      const baseDate = new Date(played_at);
      for (let k = 0; k < playCount; k++) {
        const d = new Date(baseDate.getTime() + k * 1000);
        records.push({
          played_at:   d.toISOString(),
          track_uri:   syntheticUri(artistName, trackName),
          track_name:  trackName,
          artist_name: artistName,
          album_name:  albumRaw || null,
          ms_played:   perPlayMs,
          source:      'apple_music',
        });
      }
    }

    // Batch insert into D1
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      const placeholders = batch.map(() => '(?,?,?,?,?,?,?)').join(',');
      const params = batch.flatMap(r => [
        r.played_at, r.track_uri, r.track_name, r.artist_name,
        r.album_name, r.ms_played, r.source,
      ]);
      const result = await d1Exec(
        `INSERT OR IGNORE INTO plays (played_at, track_uri, track_name, artist_name, album_name, ms_played, source) VALUES ${placeholders}`,
        params,
      );
      inserted += result.changes;
      const pct = Math.round(((i + BATCH) / records.length) * 100);
      process.stdout.write(`\r  ${path.basename(file)}: ${Math.min(pct, 100)}%`);
    }
    process.stdout.write('\n');
  }

  if (tmpDir) fs.rmSync(tmpDir, { recursive: true });

  console.log(`\nApple Music import complete.`);
  console.log(`  Total rows:          ${totalRows.toLocaleString()}`);
  console.log(`  Inserted:            ${inserted.toLocaleString()}`);
  console.log(`  Skipped:             ${skipped.toLocaleString()} (no date, <30s, PLAY_START, or duplicates)`);
  console.log(`  Artists resolved via library: ${artistResolved.toLocaleString()}`);
}
