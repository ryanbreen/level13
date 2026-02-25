import React, { useState } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import HistoryTab   from './tabs/HistoryTab.jsx';
import DashboardTab from './tabs/DashboardTab.jsx';
import ArtistsTab   from './tabs/ArtistsTab.jsx';
import TracksTab    from './tabs/TracksTab.jsx';
import DailyTab     from './tabs/DailyTab.jsx';

const TABS = [
  { id: 'history',   label: '1 History',   Component: HistoryTab   },
  { id: 'dashboard', label: '2 Dashboard', Component: DashboardTab },
  { id: 'artists',   label: '3 Artists',   Component: ArtistsTab   },
  { id: 'tracks',    label: '4 Tracks',    Component: TracksTab    },
  { id: 'daily',     label: '5 Daily',     Component: DailyTab     },
];

export default function App() {
  const [active, setActive] = useState(0);
  const { exit } = useApp();
  const { stdout } = useStdout();

  const width  = stdout.columns ?? 120;
  const height = (stdout.rows ?? 40) - 2; // subtract tab bar + footer

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) exit();
    const n = parseInt(input);
    if (n >= 1 && n <= TABS.length) setActive(n - 1);
  });

  const { Component } = TABS[active];

  return (
    <Box flexDirection="column" height={stdout.rows ?? 40}>
      {/* Tab bar */}
      <Box>
        {TABS.map((tab, i) => (
          <Text key={tab.id} color={i === active ? 'cyan' : undefined} bold={i === active} dimColor={i !== active}>
            {' '}{tab.label}{' '}
          </Text>
        ))}
        <Text dimColor>  │  q/^C quit</Text>
      </Box>

      {/* Content */}
      <Box flexGrow={1} overflow="hidden">
        <Component width={width} height={height} />
      </Box>
    </Box>
  );
}
