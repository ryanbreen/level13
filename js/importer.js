import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { d1Exec } from './d1.js';

const MIN_MS = 30_000; // skip plays shorter than 30 seconds

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

  const BATCH = 40; // 40 rows × 7 params = 280 params — under D1 REST API ~342-variable limit

  for (const file of jsonFiles) {
    const records = parseRecords(file);
    total += records.length;

    // Pre-filter before batching
    const valid = records
      .filter(r => (r.ms_played ?? MIN_MS) >= MIN_MS && r.ts)
      .map(mapRecord);

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
  console.log(`  Skipped:       ${(total - inserted).toLocaleString()} (duplicates + <30s plays)`);
}
