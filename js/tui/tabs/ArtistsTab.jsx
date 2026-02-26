import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { topArtists, msToHuman } from '../../stats.js';

const RANGES = ['7d', '30d', '90d', '365d', 'all'];
const RANGE_LABELS = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '365d': '1 year', 'all': 'All time' };

export default function ArtistsTab({ width, height }) {
  const [rangeIdx, setRangeIdx] = useState(1);
  const [artists, setArtists]   = useState(null);

  const load = async (idx) => { setArtists(await topArtists(RANGES[idx], 100)); };

  useEffect(() => { load(rangeIdx); }, []);

  useInput((input) => {
    if (input === '[') { const i = Math.max(0, rangeIdx - 1); setRangeIdx(i); load(i); }
    if (input === ']') { const i = Math.min(RANGES.length-1, rangeIdx + 1); setRangeIdx(i); load(i); }
    if (input === 'r') load(rangeIdx);
  });

  if (!artists) return <Box><Text dimColor>  Loading…</Text></Box>;

  const prev = rangeIdx > 0 ? RANGE_LABELS[RANGES[rangeIdx-1]] : '';
  const next = rangeIdx < RANGES.length-1 ? RANGE_LABELS[RANGES[rangeIdx+1]] : '';

  const nameW = Math.max(20, Math.min(40, width - 30));

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        <Text bold>Top Artists  </Text>
        <Text color="cyan">{RANGE_LABELS[RANGES[rangeIdx]]}</Text>
        {prev ? <Text dimColor>  [ {prev}</Text> : null}
        {next ? <Text dimColor>  ] {next}</Text> : null}
      </Text>
      <Text> </Text>
      <Text bold color="white">{'#'.padEnd(4)}{'Artist'.padEnd(nameW)}{'Plays'.padEnd(8)}Time</Text>
      <Text dimColor>{'─'.repeat(4 + nameW + 8 + 8)}</Text>
      {artists.map((a, i) => (
        <Text key={i}>
          {String(i+1).padEnd(4)}
          {(a.artistName||'—').slice(0, nameW).padEnd(nameW)}
          {String(a.playCount).padEnd(8)}
          {msToHuman(a.totalMs)}
        </Text>
      ))}
    </Box>
  );
}
