import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { topTracks, msToHuman } from '../../stats.js';

const RANGES = ['7d', '30d', '90d', '365d', 'all'];
const RANGE_LABELS = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '365d': '1 year', 'all': 'All time' };

export default function TracksTab({ width, height }) {
  const [rangeIdx, setRangeIdx] = useState(1);
  const [tracks, setTracks]     = useState(null);

  const load = async (idx) => { setTracks(await topTracks(RANGES[idx], 100)); };

  useEffect(() => { load(rangeIdx); }, []);

  useInput((input) => {
    if (input === '[') { const i = Math.max(0, rangeIdx - 1); setRangeIdx(i); load(i); }
    if (input === ']') { const i = Math.min(RANGES.length-1, rangeIdx + 1); setRangeIdx(i); load(i); }
    if (input === 'r') load(rangeIdx);
  });

  if (!tracks) return <Box><Text dimColor>  Loading…</Text></Box>;

  const prev = rangeIdx > 0 ? RANGE_LABELS[RANGES[rangeIdx-1]] : '';
  const next = rangeIdx < RANGES.length-1 ? RANGE_LABELS[RANGES[rangeIdx+1]] : '';
  const trackW  = Math.max(20, Math.min(35, width - 50));
  const artistW = Math.max(15, Math.min(25, width - trackW - 25));

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        <Text bold>Top Tracks  </Text>
        <Text color="cyan">{RANGE_LABELS[RANGES[rangeIdx]]}</Text>
        {prev ? <Text dimColor>  [ {prev}</Text> : null}
        {next ? <Text dimColor>  ] {next}</Text> : null}
      </Text>
      <Text> </Text>
      <Text bold color="white">
        {'#'.padEnd(4)}{'Track'.padEnd(trackW)}{'Artist'.padEnd(artistW)}{'Plays'.padEnd(8)}Time
      </Text>
      <Text dimColor>{'─'.repeat(4 + trackW + artistW + 8 + 8)}</Text>
      {tracks.map((t, i) => (
        <Text key={i}>
          {String(i+1).padEnd(4)}
          {(t.trackName||'—').slice(0, trackW).padEnd(trackW)}
          {(t.artistName||'—').slice(0, artistW).padEnd(artistW)}
          {String(t.playCount).padEnd(8)}
          {msToHuman(t.totalMs)}
        </Text>
      ))}
    </Box>
  );
}
