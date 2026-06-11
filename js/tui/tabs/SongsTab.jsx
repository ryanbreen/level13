import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { drawChart, ZOOM_LABEL, getSpan, defaultOffset } from '../components/brailleChart.js';
import { trackDailyHistory } from '../../stats.js';

const fmtPlays = v => {
  const n = Math.round(v);
  return `${n} play${n === 1 ? '' : 's'}`;
};

export default function SongsTab({ width, height }) {
  const [data,    setData]    = useState(null);
  const [zoom,    setZoom]    = useState(1);
  const [offset,  setOffset]  = useState(0);
  const [nTracks, setNTracks] = useState(10);

  const load = useCallback(async () => {
    setData(null);
    const d = await trackDailyHistory(nTracks);
    setData(d);
    setOffset(defaultOffset(d, zoom));
  }, [nTracks]);  // zoom excluded intentionally; offset reset handled in effect

  useEffect(() => { load(); }, [nTracks]);

  // Reset offset when zoom changes
  useEffect(() => {
    if (data) setOffset(defaultOffset(data, zoom));
  }, [zoom]);

  useInput((input, key) => {
    if (input === '+' || input === '=') setZoom(z => Math.min(4, z + 1));
    if (input === '-') setZoom(z => Math.max(0, z - 1));
    if (input === '0') { setZoom(0); setOffset(0); }
    if (input === 'r') load();
    if (input === ']') setNTracks(n => Math.min(15, n + 1));
    if (input === '[') setNTracks(n => Math.max(3, n - 1));
    if (key.leftArrow && data && zoom !== 0) {
      const s = getSpan(data, zoom);
      setOffset(o => Math.max(0, o - Math.floor(s / 8)));
    }
    if (key.rightArrow && data && zoom !== 0) {
      const n = data.days.length;
      const s = getSpan(data, zoom);
      setOffset(o => Math.min(n - s, o + Math.floor(s / 8)));
    }
  });

  if (!data) {
    return <Box><Text dimColor>  Loading songs…</Text></Box>;
  }

  const lines = drawChart(data, {
    width, height,
    zoom, offset,
    nRows: nTracks,
    zoomLabel: ZOOM_LABEL[zoom],
    title: 'Top Songs',
    noun: 'songs',
    fmtValue: fmtPlays,
    normalize: 'row',
  });

  return (
    <Box flexDirection="column">
      {lines.map((segments, i) => (
        <Box key={i}>
          {segments.map((seg, j) => (
            <Text
              key={j}
              color={seg.color}
              bold={seg.bold ?? false}
              dimColor={seg.dim ?? false}
            >
              {seg.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
