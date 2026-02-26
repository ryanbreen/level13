import React from 'react';
import { render } from 'ink';
import { program } from 'commander';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync, spawn } from 'child_process';
import App from './tui/app.jsx';
import { getSyncState } from './db.js';

// Project root = parent of dist/ (where this bundle lives)
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Paths that don't need config.js loaded
const DATA_DIR  = path.join(os.homedir(), '.local', 'share', 'level13');
const PID_FILE  = path.join(DATA_DIR, 'poller.pid');
const LOG_FILE  = path.join(DATA_DIR, 'poller.log');

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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
    const s = summaryStats();
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
const poll = program.command('poll').description('Manage the polling daemon');

poll
  .command('start')
  .description('Start the polling daemon in the background')
  .action(() => {
    if (isRunning()) {
      const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
      console.log(`Poller already running (PID ${pid})`);
      return;
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const logFd = fs.openSync(LOG_FILE, 'a');
    const child = spawn(
      process.execPath,
      [path.join(PROJECT_ROOT, 'js', 'poller.js')],
      { detached: true, stdio: ['ignore', logFd, logFd], cwd: PROJECT_ROOT }
    );
    child.unref();
    fs.closeSync(logFd);
    console.log(`Poller started (PID ${child.pid})`);
    console.log(`Logs: ${LOG_FILE}`);
  });

poll
  .command('stop')
  .description('Stop the polling daemon')
  .action(() => {
    if (!fs.existsSync(PID_FILE)) {
      console.log('Poller is not running (no PID file).');
      return;
    }
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Stopped poller (PID ${pid}).`);
    } catch {
      console.log(`PID ${pid} not found — removing stale PID file.`);
      fs.unlinkSync(PID_FILE);
    }
  });

poll
  .command('status')
  .description('Show polling daemon status and last sync time')
  .action(() => {
    if (isRunning()) {
      const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
      const cursor = getSyncState('last_poll_cursor');
      console.log(`Poller running (PID ${pid})`);
      console.log(`Last sync: ${cursor ?? 'never'}`);
    } else {
      console.log('Poller not running.');
      const cursor = getSyncState('last_poll_cursor');
      if (cursor) console.log(`Last sync was: ${cursor}`);
    }
    console.log(`Log: ${LOG_FILE}`);
  });

// ------------------------------------------------------------------
// service (launchd)
// ------------------------------------------------------------------
const PLIST_LABEL = 'com.level13.poller';
const PLIST_PATH  = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

const service = program.command('service').description('Manage the macOS launchd service');

service
  .command('install')
  .description('Install launchd Launch Agent — auto-starts at login, restarts on crash')
  .action(() => {
    const nodePath   = process.execPath;
    const pollerPath = path.join(PROJECT_ROOT, 'js', 'poller.js');

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${pollerPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>`;

    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.writeFileSync(PLIST_PATH, plist);
    console.log(`Wrote ${PLIST_PATH}`);

    // Unload first in case it was already installed (picks up plist changes)
    try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch { /* not loaded */ }
    execSync(`launchctl load -w "${PLIST_PATH}"`);
    console.log('Service installed and started.');
    console.log('The poller will now run automatically at every login.');
    console.log(`Logs: ${LOG_FILE}`);
  });

service
  .command('uninstall')
  .description('Stop and remove the launchd Launch Agent')
  .action(() => {
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
// import
// ------------------------------------------------------------------
program
  .command('import <path>')
  .description('Import Spotify GDPR Extended Streaming History (ZIP or directory)')
  .action(async (importPath) => {
    const { runImport } = await import('./importer.js');
    await runImport(importPath);
  });

program.parse();
