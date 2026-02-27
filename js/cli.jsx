import React from 'react';
import { render } from 'ink';
import { program } from 'commander';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import App from './tui/app.jsx';

// Project root = parent of dist/ (where this bundle lives)
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Paths that don't need config.js loaded
const DATA_DIR  = path.join(os.homedir(), '.local', 'share', 'level13');
const DB_PATH   = path.join(DATA_DIR, 'level13.db');

// ------------------------------------------------------------------
// tui
// ------------------------------------------------------------------
program
  .name('level13')
  .description('Personal Spotify Wrapped — now in Node.js');

program
  .command('tui')
  .description('Launch the interactive TUI')
  .action(() => {
    render(<App />, { fullscreen: true });
  });

// ------------------------------------------------------------------
// stats
// ------------------------------------------------------------------
program
  .command('stats')
  .description('Print summary stats')
  .action(async () => {
    const { summaryStats, msToHuman } = await import('./stats.js');
    const s = await summaryStats();
    console.log(`Today: ${msToHuman(s.todayMs)}`);
    console.log(`Streak: ${s.streaks.currentStreak} days (longest: ${s.streaks.longestStreak})`);
    console.log(`${s.yearly.year} YTD: ${msToHuman(s.yearly.totalMs)} — ${s.yearly.totalPlays.toLocaleString()} plays`);
    console.log('\nTop Artists (30d):');
    s.topArtists30d.forEach((a, i) => console.log(`  ${i + 1}. ${a.artistName} — ${msToHuman(a.totalMs)}`));
  });

// ------------------------------------------------------------------
// auth
// ------------------------------------------------------------------
program
  .command('auth')
  .description('Authenticate with Spotify (run once to set up credentials)')
  .action(async () => {
    const { runAuthFlow } = await import('./auth.js');
    await runAuthFlow();
  });

// ------------------------------------------------------------------
// poll
// ------------------------------------------------------------------
const poll = program.command('poll').description('Manage polling (now handled by Cloudflare Worker)');

poll
  .command('start')
  .description('[deprecated] Polling is now handled by the Cloudflare Worker')
  .action(() => {
    console.log('Local polling daemon is deprecated.');
    console.log('Polling is now handled by the Cloudflare Worker (every 3 minutes).');
    console.log('Deploy with:  level13 cf deploy');
  });

poll
  .command('stop')
  .description('[deprecated] Polling is now handled by the Cloudflare Worker')
  .action(() => {
    console.log('Local polling daemon is deprecated.');
    console.log('Polling is now handled by the Cloudflare Worker (every 3 minutes).');
    console.log('Deploy with:  level13 cf deploy');
  });

poll
  .command('status')
  .description('Show last sync time from D1')
  .action(async () => {
    const { d1Query } = await import('./d1.js');
    try {
      const rows = await d1Query(
        'SELECT value FROM sync_state WHERE key = ?',
        ['last_poll_cursor'],
      );
      const cursor = rows[0]?.value ?? null;
      console.log(`Last sync: ${cursor ?? 'never'}`);
      console.log('Polling is handled by the Cloudflare Worker (every 3 minutes).');
    } catch (err) {
      console.error(`Failed to read sync state: ${err.message}`);
    }
  });

// ------------------------------------------------------------------
// service (launchd) — deprecated
// ------------------------------------------------------------------
const service = program.command('service').description('[deprecated] Use Cloudflare Worker instead');

service
  .command('install')
  .description('[deprecated] Use Cloudflare Worker instead')
  .action(() => {
    console.log('The launchd service is deprecated.');
    console.log('Polling is now handled by the Cloudflare Worker (every 3 minutes).');
    console.log('Deploy with:  level13 cf deploy');
  });

service
  .command('uninstall')
  .description('Stop and remove the launchd Launch Agent')
  .action(() => {
    const PLIST_LABEL = 'com.level13.poller';
    const PLIST_PATH  = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
    if (fs.existsSync(PLIST_PATH)) {
      try { execSync(`launchctl unload -w "${PLIST_PATH}" 2>/dev/null`); } catch { /* not loaded */ }
      fs.unlinkSync(PLIST_PATH);
      console.log(`Removed ${PLIST_PATH}`);
      console.log('Service uninstalled.');
    } else {
      console.log('No service installed.');
    }
  });

// ------------------------------------------------------------------
// cf — Cloudflare D1 management
// ------------------------------------------------------------------
const cf = program.command('cf').description('Manage Cloudflare D1 database and Worker');

cf
  .command('setup')
  .description('Interactive wizard: configure Cloudflare D1 credentials')
  .action(async () => {
    const { createInterface } = await import('readline/promises');
    const { saveCloudflareConfig } = await import('./config.js');
    const { d1Query } = await import('./d1.js');

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log('Configure Cloudflare D1 connection:\n');
    const accountId  = (await rl.question('Account ID:    ')).trim();
    const databaseId = (await rl.question('Database ID:   ')).trim();
    const apiToken   = (await rl.question('API Token:     ')).trim();
    rl.close();

    if (!accountId || !databaseId || !apiToken) {
      console.error('All fields are required.');
      process.exit(1);
    }

    // Save config before testing so d1Query can load it
    saveCloudflareConfig({ accountId, databaseId, apiToken });
    console.log('\nTesting connection…');

    try {
      const rows = await d1Query('SELECT COUNT(*) AS n FROM plays');
      console.log(`Connection OK — ${(rows[0]?.n ?? 0).toLocaleString()} plays in database.`);
      console.log(`Config saved to ${path.join(DATA_DIR, 'cloudflare.json')}`);
    } catch (err) {
      console.error(`Connection failed: ${err.message}`);
      process.exit(1);
    }
  });

cf
  .command('deploy')
  .description('Deploy the Cloudflare Worker via wrangler')
  .action(() => {
    const workerDir = path.join(PROJECT_ROOT, 'worker');
    execSync(`npx wrangler deploy --cwd "${workerDir}"`, { stdio: 'inherit' });
  });

cf
  .command('migrate-local')
  .description('One-time migration: copy local SQLite plays to D1')
  .action(async () => {
    const { d1Exec } = await import('./d1.js');
    const Database = (await import('better-sqlite3')).default;

    if (!fs.existsSync(DB_PATH)) {
      console.error(`Local database not found at ${DB_PATH}`);
      process.exit(1);
    }

    const db = new Database(DB_PATH, { readonly: true });
    const plays = db.prepare('SELECT * FROM plays ORDER BY played_at').all();
    const syncRows = db.prepare('SELECT * FROM sync_state').all();
    db.close();

    console.log(`Found ${plays.length.toLocaleString()} plays in local database.`);

    let inserted = 0;
    const BATCH = 40; // 40 rows × 7 params = 280 — under D1 REST API ~342-variable limit

    for (let i = 0; i < plays.length; i += BATCH) {
      const batch = plays.slice(i, i + BATCH);
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
      const pct = Math.round(((i + BATCH) / plays.length) * 100);
      process.stdout.write(`\r  Progress: ${Math.min(pct, 100)}%`);
    }
    process.stdout.write('\n');

    // Migrate sync_state (last_poll_cursor)
    for (const row of syncRows) {
      await d1Exec(
        'INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)',
        [row.key, row.value],
      );
    }

    console.log(`\nMigration complete.`);
    console.log(`  Plays inserted: ${inserted.toLocaleString()}`);
    console.log(`  Sync state rows migrated: ${syncRows.length}`);
  });

// ------------------------------------------------------------------
// import
// ------------------------------------------------------------------
program
  .command('import <path>')
  .description('Import Spotify GDPR Extended Streaming History (ZIP or directory)')
  .action(async (importPath) => {
    const { runImport } = await import('./importer.js');
    await runImport(importPath);
  });

program
  .command('import-apple <path>')
  .description('Import Apple Music play history (ZIP or CSV from privacy.apple.com)')
  .action(async (importPath) => {
    const { runAppleImport } = await import('./appleImporter.js');
    await runAppleImport(importPath);
  });

program.parse();
