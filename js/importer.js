import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { d1Exec, d1Query } from './d1.js';

const MIN_MS = 30_000; // skip plays shorter than 30 seconds
// The poller stores played_at with milliseconds, a few seconds after the export's ts for the same play
// (measured 2026-09-27: 96% within 5 s, all within 10 min), so exact-key dedup cannot see those rows.
const API_BEFORE_MS = 60_000;
const API_AFTER_MS = 600_000;

async function loadApiPlays() {
  const byUri = new Map();
  for (const r of await d1Query("SELECT played_at, track_uri FROM plays WHERE source = 'api'")) {
    if (!r.track_uri) continue;
    const list = byUri.get(r.track_uri) ?? [];
    list.push(Date.parse(r.played_at));
    byUri.set(r.track_uri, list);
  }
  for (const list of byUri.values()) list.sort((a, b) => a - b);
  return byUri;
}

function capturedByPoller(byUri, record) {
  const list = byUri.get(record.track_uri);
  if (!list) return false;
  const ts = Date.parse(record.played_at);
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < ts - API_BEFORE_MS) lo = mid + 1; else hi = mid; }
  return lo < list.length && list[lo] <= ts + API_AFTER_MS;
}

function mapRecord(r) {
  return {
    played_at:   r.ts,
    track_uri:   r.spotify_track_uri ?? null,
    track_name:  r.master_metadata_track_name ?? null,
    artist_name: r.master_metadata_album_artist_name ?? null,
    album_name:  r.master_metadata_album_album_name ?? null,
    ms_played:   r.ms_played ?? null,
    source:      'import',
  };
}

function parseRecords(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : [];
}

function collectJsonFiles(dir) {
  const results = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/^(Streaming_History_Audio_|endsong_).*\.json$/i.test(entry.name)) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

export async function runImport(inputPath) {
  const resolved = path.resolve(inputPath);
  let workDir = resolved;
  let tmpDir = null;

  if (resolved.endsWith('.zip')) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'level13-import-'));
    console.log(`Extracting ${resolved} ...`);
    execSync(`unzip -q "${resolved}" -d "${tmpDir}"`);
    workDir = tmpDir;
  }

  const jsonFiles = collectJsonFiles(workDir);

  if (jsonFiles.length === 0) {
    console.error('No streaming history JSON files found.');
    console.error('Expected files matching: Streaming_History_Audio_*.json or endsong_*.json');
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true });
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} history file(s).`);

  let total = 0;
  let inserted = 0;
  let polled = 0;
  const apiPlays = await loadApiPlays();

  const BATCH = 14; // 14 rows × 7 params = 98 — D1 rejects more than 100 bound parameters per statement

  for (const file of jsonFiles) {
    const records = parseRecords(file);
    total += records.length;

    // Pre-filter before batching. Records without a track URI are podcast episodes; UNIQUE(played_at, track_uri)
    // treats NULLs as distinct, so they would be inserted again by every re-import.
    const valid = records
      .filter(r => (r.ms_played ?? MIN_MS) >= MIN_MS && r.ts && r.spotify_track_uri)
      .map(mapRecord)
      .filter(r => {
        if (!capturedByPoller(apiPlays, r)) return true;
        polled += 1;
        return false;
      });

    for (let i = 0; i < valid.length; i += BATCH) {
      const batch = valid.slice(i, i + BATCH);
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
      const pct = Math.round(((i + BATCH) / valid.length) * 100);
      process.stdout.write(`\r  ${path.basename(file)}: ${Math.min(pct, 100)}%`);
    }
    process.stdout.write('\n');
  }

  if (tmpDir) fs.rmSync(tmpDir, { recursive: true });

  console.log(`\nImport complete.`);
  console.log(`  Total records: ${total.toLocaleString()}`);
  console.log(`  Inserted:      ${inserted.toLocaleString()}`);
  console.log(`  Already polled: ${polled.toLocaleString()}`);
  console.log(`  Skipped:       ${(total - inserted).toLocaleString()} (duplicates, already polled, <30s plays)`);
}
