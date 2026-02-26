import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { summaryStats, msToHuman } from '../../stats.js';

function Table({ rows, columns }) {
  const widths = columns.map((col, ci) =>
    Math.max(col.length, ...rows.map(r => String(r[ci] ?? '').length))
  );
  const header = columns.map((col, ci) => col.padEnd(widths[ci])).join('  ');
  const divider = widths.map(w => '─'.repeat(w)).join('  ');
  return (
    <Box flexDirection="column">
      <Text bold color="white">{header}</Text>
      <Text dimColor>{divider}</Text>
      {rows.map((row, ri) => (
        <Text key={ri}>
          {row.map((cell, ci) => String(cell ?? '').padEnd(widths[ci])).join('  ')}
        </Text>
      ))}
    </Box>
  );
}

export default function DashboardTab({ width, height }) {
  const [stats, setStats] = useState(null);

  const load = async () => {
    setStats(await summaryStats());
  };

  useEffect(() => { load(); }, []);
  useInput((input) => { if (input === 'r') load(); });

  if (!stats) return <Box><Text dimColor>  Loading…</Text></Box>;

  const { todayMs, topArtists30d, topTracks30d, yearly, streaks } = stats;

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>● Worker active</Text>
      <Text> </Text>
      <Text><Text bold>Today: </Text><Text color="cyan">{msToHuman(todayMs)}</Text></Text>
      <Text><Text bold>Streak: </Text>{streaks.currentStreak} days  <Text dimColor>longest: {streaks.longestStreak} days</Text></Text>
      <Text><Text bold>{yearly.year} YTD: </Text><Text color="cyan">{msToHuman(yearly.totalMs)}</Text>  <Text dimColor>— {yearly.totalPlays.toLocaleString()} plays · {yearly.uniqueArtists.toLocaleString()} artists · {yearly.uniqueTracks.toLocaleString()} tracks</Text></Text>
      <Text> </Text>
      <Text bold color="white">Top Artists — Last 30 Days</Text>
      <Table
        columns={['#', 'Artist', 'Plays', 'Time']}
        rows={topArtists30d.map((a, i) => [i+1, a.artistName, a.playCount, msToHuman(a.totalMs)])}
      />
      <Text> </Text>
      <Text bold color="white">Top Tracks — Last 30 Days</Text>
      <Table
        columns={['#', 'Track', 'Artist', 'Plays', 'Time']}
        rows={topTracks30d.map((t, i) => [i+1, (t.trackName||'—').slice(0,30), (t.artistName||'—').slice(0,20), t.playCount, msToHuman(t.totalMs)])}
      />
      <Text> </Text>
      <Text dimColor>r refresh</Text>
    </Box>
  );
}
