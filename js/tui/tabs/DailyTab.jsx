import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { playsForDay, dailyListeningTime, msToHuman } from '../../stats.js';

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export default function DailyTab({ width, height }) {
  const [day,   setDay]   = useState(new Date());
  const [plays, setPlays] = useState([]);
  const [total, setTotal] = useState(0);

  const load = (d) => {
    const ds = d.toISOString().slice(0, 10);
    setPlays(playsForDay(ds));
    setTotal(dailyListeningTime(ds));
  };

  useEffect(() => { load(day); }, []);

  useInput((input, key) => {
    if (key.leftArrow) {
      const d = new Date(day); d.setDate(d.getDate() - 1);
      setDay(d); load(d);
    }
    if (key.rightArrow) {
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      if (day < tomorrow) {
        const d = new Date(day); d.setDate(d.getDate() + 1);
        setDay(d); load(d);
      }
    }
    if (input === 't') { const d = new Date(); setDay(d); load(d); }
  });

  const timeW  = 6;
  const trackW = Math.max(20, Math.min(40, width - 50));
  const artistW = Math.max(15, Math.min(25, width - trackW - 20));

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        <Text bold>{fmtDate(day)}</Text>
        {'  '}
        <Text color="cyan">{msToHuman(total)}</Text>
        <Text dimColor>  ← → days · t=today</Text>
      </Text>
      <Text> </Text>
      <Text bold color="white">
        {'Time'.padEnd(timeW+2)}{'Track'.padEnd(trackW)}{'Artist'.padEnd(artistW)}Dur
      </Text>
      <Text dimColor>{'─'.repeat(timeW + 2 + trackW + artistW + 8)}</Text>
      {plays.length === 0
        ? <Text dimColor>  No plays recorded.</Text>
        : plays.map((p, i) => {
            let timeStr = p.played_at?.slice(11, 16) ?? '??:??';
            try {
              const dt = new Date(p.played_at);
              timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            } catch {}
            const dur = p.ms_played ? msToHuman(p.ms_played) : '~3:30';
            return (
              <Text key={i}>
                {timeStr.padEnd(timeW+2)}
                {(p.track_name||'—').slice(0, trackW).padEnd(trackW)}
                {(p.artist_name||'—').slice(0, artistW).padEnd(artistW)}
                {dur}
              </Text>
            );
          })
      }
    </Box>
  );
}
