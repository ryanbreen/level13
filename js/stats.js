import { d1Query } from './d1.js';
import { DEFAULT_MS_PER_PLAY } from './config.js';

const MS_EXPR = `COALESCE(ms_played, ${DEFAULT_MS_PER_PLAY})`;

export function msToHuman(ms) {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function timeRangeFilter(timeRange) {
  if (timeRange === 'all') return { where: '1=1', params: [] };
  const days = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[timeRange];
  if (!days) throw new Error(`Unknown time range: ${timeRange}`);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return { where: 'played_at >= ?', params: [cutoff] };
}

export async function dailyListeningTime(dateStr) {
  const rows = await d1Query(
    `SELECT SUM(${MS_EXPR}) AS total FROM plays WHERE date(played_at) = ?`,
    [dateStr],
  );
  return rows[0]?.total ?? 0;
}

export async function topArtists(timeRange = '30d', limit = 20) {
  const { where, params } = timeRangeFilter(timeRange);
  const rows = await d1Query(`
    SELECT artist_name, COUNT(*) AS play_count, SUM(${MS_EXPR}) AS total_ms,
           SUM(CASE WHEN ms_played IS NULL THEN 1 ELSE 0 END) > 0 AS has_estimates
    FROM plays WHERE ${where} AND artist_name IS NOT NULL
    GROUP BY artist_name ORDER BY total_ms DESC LIMIT ?
  `, [...params, limit]);
  return rows.map(r => ({
    artistName: r.artist_name, playCount: r.play_count,
    totalMs: r.total_ms, estimated: !!r.has_estimates,
  }));
}

export async function topTracks(timeRange = '30d', limit = 20) {
  const { where, params } = timeRangeFilter(timeRange);
  const rows = await d1Query(`
    SELECT track_name, artist_name, COUNT(*) AS play_count, SUM(${MS_EXPR}) AS total_ms,
           SUM(CASE WHEN ms_played IS NULL THEN 1 ELSE 0 END) > 0 AS has_estimates
    FROM plays WHERE ${where} AND track_name IS NOT NULL
    GROUP BY track_name, artist_name ORDER BY total_ms DESC LIMIT ?
  `, [...params, limit]);
  return rows.map(r => ({
    trackName: r.track_name, artistName: r.artist_name,
    playCount: r.play_count, totalMs: r.total_ms, estimated: !!r.has_estimates,
  }));
}

export async function yearlyAggregate(year) {
  const rows = await d1Query(`
    SELECT COUNT(*) AS total_plays, SUM(${MS_EXPR}) AS total_ms,
           COUNT(DISTINCT artist_name) AS unique_artists,
           COUNT(DISTINCT track_name) AS unique_tracks
    FROM plays WHERE date(played_at) BETWEEN ? AND ?
  `, [`${year}-01-01`, `${year}-12-31`]);
  const row = rows[0];
  return { year, totalPlays: row?.total_plays ?? 0, totalMs: row?.total_ms ?? 0,
           uniqueArtists: row?.unique_artists ?? 0, uniqueTracks: row?.unique_tracks ?? 0 };
}

export async function streak() {
  const rows = await d1Query(
    'SELECT DISTINCT date(played_at) AS day FROM plays ORDER BY day',
  );
  if (!rows.length) return { currentStreak: 0, longestStreak: 0 };

  const days = rows.map(r => new Date(r.day));
  let longest = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = (days[i] - days[i-1]) / 86400000;
    if (diff === 1) { run++; longest = Math.max(longest, run); }
    else run = 1;
  }

  const daySet = new Set(rows.map(r => r.day));
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let current = 0;
  let d = daySet.has(today) ? today : (daySet.has(yesterday) ? yesterday : null);
  while (d && daySet.has(d)) {
    current++;
    d = new Date(new Date(d).getTime() - 86400000).toISOString().slice(0, 10);
  }

  return { currentStreak: current, longestStreak: Math.max(longest, current) };
}

export async function listeningByDay(start, end) {
  return d1Query(`
    SELECT date(played_at) AS day, SUM(${MS_EXPR}) AS total_ms, COUNT(*) AS play_count
    FROM plays WHERE date(played_at) BETWEEN ? AND ?
    GROUP BY day ORDER BY day
  `, [start, end]);
}

export async function playsForDay(dateStr) {
  return d1Query(`
    SELECT played_at, track_name, artist_name, album_name, ms_played
    FROM plays WHERE date(played_at) = ? ORDER BY played_at
  `, [dateStr]);
}

export async function summaryStats() {
  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();
  const [todayMs, topArtists30d, topTracks30d, yearly, streaks] = await Promise.all([
    dailyListeningTime(today),
    topArtists('30d', 10),
    topTracks('30d', 10),
    yearlyAggregate(year),
    streak(),
  ]);
  return { todayMs, topArtists30d, topTracks30d, yearly, streaks };
}

export async function artistDailyHistory(limit = 10) {
  const boundsRows = await d1Query(
    'SELECT MIN(date(played_at)) AS first, MAX(date(played_at)) AS last FROM plays',
  );
  const bounds = boundsRows[0];
  if (!bounds?.first) return { days: [], artists: [] };

  const { first, last } = bounds;

  const top = await d1Query(`
    SELECT artist_name, SUM(${MS_EXPR}) AS total_ms
    FROM plays WHERE artist_name IS NOT NULL
    GROUP BY artist_name ORDER BY total_ms DESC LIMIT ?
  `, [limit]);
  if (!top.length) return { days: [], artists: [] };

  const topNames = top.map(r => r.artist_name);
  const topTotals = Object.fromEntries(top.map(r => [r.artist_name, r.total_ms]));

  const ph = topNames.map(() => '?').join(',');
  const rows = await d1Query(`
    SELECT artist_name, date(played_at) AS day, SUM(${MS_EXPR}) AS ms
    FROM plays WHERE artist_name IN (${ph})
    GROUP BY artist_name, day ORDER BY day
  `, topNames);

  // Build full day list
  const days = [];
  const d = new Date(first);
  const endDate = new Date(last);
  while (d <= endDate) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }

  const dayIdx = Object.fromEntries(days.map((day, i) => [day, i]));
  const n = days.length;
  const artistData = Object.fromEntries(topNames.map(name => [name, new Float64Array(n)]));
  for (const row of rows) {
    const idx = dayIdx[row.day];
    if (idx !== undefined && artistData[row.artist_name]) {
      artistData[row.artist_name][idx] = row.ms;
    }
  }

  return {
    days,
    artists: topNames.map(name => ({
      name,
      totalMs: topTotals[name],
      dailyMs: Array.from(artistData[name]),
    })),
  };
}
