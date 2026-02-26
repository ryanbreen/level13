import fs from 'fs';
import os from 'os';
import path from 'path';

export const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'level13');
export const DB_PATH = path.join(DATA_DIR, 'level13.db');
export const TOKEN_CACHE = path.join(DATA_DIR, '.spotify_cache');
export const PID_FILE = path.join(DATA_DIR, 'poller.pid');
export const LOG_FILE = path.join(DATA_DIR, 'poller.log');
export const POLL_INTERVAL_MS = 180_000;
export const DEFAULT_MS_PER_PLAY = 210_000;
export const SPOTIFY_SCOPES = ['user-read-recently-played', 'user-read-currently-playing'];
export const CF_CONFIG_PATH = path.join(DATA_DIR, 'cloudflare.json');

export function loadCloudflareConfig() {
  if (!fs.existsSync(CF_CONFIG_PATH)) {
    throw new Error(`Cloudflare config not found at ${CF_CONFIG_PATH}\nRun: level13 cf setup`);
  }
  return JSON.parse(fs.readFileSync(CF_CONFIG_PATH, 'utf8'));
}

export function saveCloudflareConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CF_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
