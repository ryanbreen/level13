import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { getDb, insertPlay } from './db.js';

const MIN_MS = 30_000; // skip plays shorter than 30 seconds

function findJsonFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => /^(Streaming_History_Audio_|endsong_).*\.json$/i.test(f))
    .map(f => path.join(dir, f));
}

function parseRecords(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : [];
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

export async function runImport(inputPath) {
  const resolved = path.resolve(inputPath);
  let workDir = resolved;
  let tmpDir = null;

  // Unzip if it's a ZIP file
  if (resolved.endsWith('.zip')) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'level13-import-'));
    console.log(`Extracting ${resolved} ...`);
    execSync(`unzip -q "${resolved}" -d "${tmpDir}"`);
    workDir = tmpDir;
  }

  // Walk to find the actual JSON files (they may be inside a subfolder)
  const jsonFiles = collectJsonFiles(workDir);

  if (jsonFiles.length === 0) {
    console.error('No streaming history JSON files found.');
    console.error('Expected files matching: Streaming_History_Audio_*.json or endsong_*.json');
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true });
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} history file(s).`);

  const db = getDb();
  let total = 0;
  let inserted = 0;
  let skipped = 0;

  const batchInsert = db.transaction((records) => {
    let ins = 0;
    for (const r of records) {
      if ((r.ms_played ?? MIN_MS) < MIN_MS) { skipped++; continue; }
      const mapped = mapRecord(r);
      if (!mapped.played_at) { skipped++; continue; }
      const result = db.prepare(`
        INSERT OR IGNORE INTO plays (played_at, track_uri, track_name, artist_name, album_name, ms_played, source)
        VALUES (@played_at, @track_uri, @track_name, @artist_name, @album_name, @ms_played, @source)
      `).run(mapped);
      ins += result.changes;
    }
    return ins;
  });

  for (const file of jsonFiles) {
    const records = parseRecords(file);
    total += records.length;
    const BATCH = 1000;
    for (let i = 0; i < records.length; i += BATCH) {
      inserted += batchInsert(records.slice(i, i + BATCH));
      const pct = Math.round(((i + BATCH) / records.length) * 100);
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

// Recursively walk dir to find matching JSON files
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
