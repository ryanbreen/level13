import React from 'react';
import { render } from 'ink';
import { program } from 'commander';
import App from './tui/app.jsx';

program
  .name('level13')
  .description('Personal Spotify Wrapped — now in Node.js');

program
  .command('tui')
  .description('Launch the interactive TUI')
  .action(() => {
    render(<App />, { fullscreen: true });
  });

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
    s.topArtists30d.forEach((a, i) => console.log(`  ${i+1}. ${a.artistName} — ${msToHuman(a.totalMs)}`));
  });

program.parse();
