import SpotifyWebApi from 'spotify-web-api-node';
import http from 'http';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { DATA_DIR, TOKEN_CACHE, SPOTIFY_SCOPES } from './config.js';

const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');

export function loadCredentials() {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  }
  const clientId = process.env.SPOTIPY_CLIENT_ID || process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIPY_CLIENT_SECRET || process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'No Spotify credentials found.\n' +
      'Run `level13 auth` to set up, or export SPOTIPY_CLIENT_ID and SPOTIPY_CLIENT_SECRET.'
    );
  }
  return { clientId, clientSecret };
}

export function saveCredentials(clientId, clientSecret) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ clientId, clientSecret }, null, 2));
}

export function loadTokens() {
  if (fs.existsSync(TOKEN_CACHE)) {
    return JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8'));
  }
  return null;
}

export function saveTokens(tokens) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify(tokens, null, 2));
}

export function hasValidAuth() {
  try {
    loadCredentials();
    return loadTokens() !== null;
  } catch {
    return false;
  }
}

export function createSpotifyClient() {
  const { clientId, clientSecret } = loadCredentials();
  const tokens = loadTokens();
  const spotify = new SpotifyWebApi({
    clientId,
    clientSecret,
    redirectUri: 'http://127.0.0.1:8765/callback',
  });
  if (tokens) {
    spotify.setAccessToken(tokens.accessToken);
    spotify.setRefreshToken(tokens.refreshToken);
  }
  return spotify;
}

export async function refreshIfNeeded(spotify) {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated. Run `level13 auth`.');

  const expiresAt = tokens.expiresAt || 0;
  if (Date.now() < expiresAt - 60_000) return; // still valid

  const data = await spotify.refreshAccessToken();
  const newTokens = {
    ...tokens,
    accessToken: data.body.access_token,
    expiresAt: Date.now() + data.body.expires_in * 1000,
  };
  if (data.body.refresh_token) {
    newTokens.refreshToken = data.body.refresh_token;
  }
  saveTokens(newTokens);
  spotify.setAccessToken(newTokens.accessToken);
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

export async function runAuthFlow() {
  let clientId, clientSecret;

  // Try to load existing credentials first
  try {
    ({ clientId, clientSecret } = loadCredentials());
    console.log('Using saved credentials.');
  } catch {
    clientId = await prompt('Spotify Client ID: ');
    clientSecret = await prompt('Spotify Client Secret: ');
    saveCredentials(clientId, clientSecret);
  }

  const spotify = new SpotifyWebApi({
    clientId,
    clientSecret,
    redirectUri: 'http://127.0.0.1:8765/callback',
  });

  const authUrl = spotify.createAuthorizeURL(SPOTIFY_SCOPES, 'level13-state');
  console.log('\nOpening browser for Spotify auth...');
  try {
    execSync(`open "${authUrl}"`);
  } catch {
    console.log(`Visit this URL manually:\n${authUrl}`);
  }

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1:8765');
      if (url.pathname !== '/callback') return;
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (code) {
        res.end('<h1>Auth complete! You can close this tab.</h1>');
        server.close();
        resolve(code);
      } else {
        res.end(`<h1>Auth failed: ${error}</h1>`);
        server.close();
        reject(new Error(`Spotify auth error: ${error}`));
      }
    });
    server.listen(8765, () => console.log('Waiting for Spotify callback on :8765...'));
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('Auth timed out after 2 minutes')); }, 120_000);
  });

  const data = await spotify.authorizationCodeGrant(code);
  saveTokens({
    accessToken: data.body.access_token,
    refreshToken: data.body.refresh_token,
    expiresAt: Date.now() + data.body.expires_in * 1000,
  });
  console.log('Auth complete. Tokens saved to', TOKEN_CACHE);
}
