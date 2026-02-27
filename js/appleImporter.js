import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { d1Exec } from './d1.js';

const MIN_MS = 30_000;
const BATCH  = 40; // 40 rows × 7 params = 280, under D1 REST ~342-variable limit

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
  track:    ['Track Description', 'Song Name', 'Title', 'Track Name', 'Content Name'],
  artist:   ['Artist Name', 'Artist', 'Performer'],
  album:    ['Album Name', 'Album', 'Container Description', 'Collection Name'],
  date:     ['Play Date', 'Date Played', 'Last Played Date', 'Event Start Timestamp',
             'Event End Timestamp', 'Activity Date Time'],
  ms:       ['Play Duration Milliseconds', 'Play Duration Ms', 'Duration Milliseconds',
             'Played completely', 'Media Duration In Milliseconds'],
  mediaMs:  ['Media Duration In Milliseconds', 'Track Duration Ms', 'Duration'],
  ignored:  ['Ignore For Recommendations', 'Skip Count'],
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
    track:   find(COLUMN_CANDIDATES.track),
    artist:  find(COLUMN_CANDIDATES.artist),
    album:   find(COLUMN_CANDIDATES.album),
    date:    find(COLUMN_CANDIDATES.date),
    ms:      find(COLUMN_CANDIDATES.ms),
    mediaMs: find(COLUMN_CANDIDATES.mediaMs),
  };
}

// ---------------------------------------------------------------------------
// Date parsing — Apple has used multiple formats across export versions
// ---------------------------------------------------------------------------
function parseAppleDate(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // ISO-ish: "2022-01-15T10:30:45Z" or "2022-01-15 10:30:45"
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.replace(' ', 'T').replace(/([+-]\d{2}:\d{2})?$/, v => v || 'Z'));
    if (!isNaN(d)) return d.toISOString();
  }

  // Apple locale format: "Jan 15, 2022 at 10:30 AM"
  const m = s.match(/(\w+ \d+, \d{4})(?: at (\d+:\d+ [AP]M))?/);
  if (m) {
    const d = new Date(`${m[1]}${m[2] ? ' ' + m[2] : ''}`);
    if (!isNaN(d)) return d.toISOString();
  }

  // Date only: "2022-01-15" → use noon UTC as synthetic time
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return `${s}T12:00:00.000Z`;
  }

  // Unix timestamp (ms)
  if (/^\d{10,13}$/.test(s)) {
    const ms = s.length === 13 ? parseInt(s) : parseInt(s) * 1000;
    return new Date(ms).toISOString();
  }

  return null;
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
        /play|activity|history|listen/i.test(entry.name)
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

  let totalRows = 0, inserted = 0, skipped = 0;

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

      const trackRaw  = cols.track  >= 0 ? r[cols.track]?.trim()  : null;
      const artistRaw = cols.artist >= 0 ? r[cols.artist]?.trim() : null;
      const albumRaw  = cols.album  >= 0 ? r[cols.album]?.trim()  : null;
      const dateRaw   = cols.date   >= 0 ? r[cols.date]?.trim()   : null;
      const msRaw     = cols.ms     >= 0 ? r[cols.ms]?.trim()     : null;

      // "Track Description" sometimes encodes as "Artist - Track Title"
      let trackName  = trackRaw  || null;
      let artistName = artistRaw || null;
      if (!artistName && trackRaw?.includes(' - ')) {
        const [a, ...rest] = trackRaw.split(' - ');
        artistName = a.trim();
        trackName  = rest.join(' - ').trim();
      }

      const played_at = parseAppleDate(dateRaw);
      if (!played_at) { skipped++; continue; }

      const ms_played = msRaw ? parseInt(msRaw) : null;
      if (ms_played !== null && ms_played < MIN_MS) { skipped++; continue; }

      records.push({
        played_at,
        track_uri:   syntheticUri(artistName, trackName),
        track_name:  trackName,
        artist_name: artistName,
        album_name:  albumRaw  || null,
        ms_played:   ms_played || null,
        source:      'apple_music',
      });
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
  console.log(`  Total rows:  ${totalRows.toLocaleString()}`);
  console.log(`  Inserted:    ${inserted.toLocaleString()}`);
  console.log(`  Skipped:     ${skipped.toLocaleString()} (no date, <30s, or duplicates)`);
}
