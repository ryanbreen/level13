// Braille dot bit layout (offset from U+2800):
//   Left col  → bits 0x01 0x02 0x04 0x40   (rows 0-3 top-bottom)
//   Right col → bits 0x08 0x10 0x20 0x80
const BD = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export const COLORS = [
  '#1DB954', '#5B9BD5', '#FF6B6B', '#FFD93D', '#C77DFF',
  '#06D6A0', '#FF4D6D', '#4CC9F0', '#F8961E', '#90BE6D',
  '#43AA8B', '#F94144',
];

export const ZOOM_DAYS  = { 0: null, 1: 365, 2: 182, 3: 91, 4: 30 };
export const ZOOM_LABEL = { 0: 'all time', 1: '1 year', 2: '6 months', 3: '3 months', 4: '1 month' };
export const LABEL_W = 24;

// Gaussian max-spread in braille column space (σ=3)
function gaussianSpread(sampled) {
  const S = 3.0;
  const weights = Array.from({ length: 10 }, (_, d) => Math.exp(-0.5 * (d / S) ** 2));
  const n = sampled.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = sampled[i];
    if (v <= 0) continue;
    if (v > out[i]) out[i] = v;
    for (let d = 1; d < 10; d++) {
      const w = v * weights[d];
      if (i + d < n && w > out[i + d]) out[i + d] = w;
      if (i - d >= 0 && w > out[i - d]) out[i - d] = w;
    }
  }
  return out;
}

function sampleMax(data, nCols) {
  if (!data.length) return new Float64Array(nCols);
  const nd = data.length;
  const out = new Float64Array(nCols);
  for (let c = 0; c < nCols; c++) {
    let lo = Math.floor(c / nCols * nd);
    let hi = Math.floor((c + 1) / nCols * nd);
    if (lo >= hi) hi = lo + 1;
    hi = Math.min(hi, nd);
    let max = 0;
    for (let i = lo; i < hi; i++) if (data[i] > max) max = data[i];
    out[c] = max;
  }
  return out;
}

export function getSpan(data, zoom) {
  if (!data) return 30;
  const n = data.days.length;
  const s = ZOOM_DAYS[zoom];
  return s === null ? n : Math.min(s, n);
}

export function defaultOffset(data, zoom) {
  if (!data) return 0;
  return Math.max(0, data.days.length - getSpan(data, zoom));
}

// Default value formatter: milliseconds → "Xh Ym".
function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// Clamp a label to exactly LABEL_W chars (truncate if long, pad otherwise).
function fitLabel(text, align) {
  const t = text.length > LABEL_W ? text.slice(0, LABEL_W) : text;
  return align === 'end' ? t.padStart(LABEL_W) : t.padEnd(LABEL_W);
}

/**
 * Returns array of lines; each line is array of { text, color, bold, dim }.
 * Caller renders these with Ink <Text> spans.
 *
 * `data.rows` is an array of { name, subtitle?, total, daily } where `daily`
 * is a per-day series (listening ms for artists, play counts for songs).
 * Options let the same chart render either: `title`/`noun` for the header,
 * `fmtValue` to format totals (time vs. plays), and `nRows` to cap the rows.
 */
export function drawChart(data, {
  width, height, zoom, offset, nRows, zoomLabel,
  title = 'Artist History', noun = 'artists', fmtValue = fmtMs,
  normalize = 'global',
}) {
  const days  = data.days;
  const rows  = data.rows.slice(0, nRows);
  const nDays = days.length;
  const span  = getSpan(data, zoom);
  const off   = Math.max(0, Math.min(offset, nDays - span));

  const chartW   = Math.max(4, width - LABEL_W);
  const brCols   = chartW * 2;
  const rowsPer  = rows.length > 0 ? Math.max(2, Math.floor((height - 2) / rows.length)) : 2;
  const brRows   = rowsPer * 4;

  const lines = [];

  // Header
  const v0 = days[off]?.slice(0, 7) ?? '?';
  const v1 = days[Math.min(off + span - 1, nDays - 1)]?.slice(0, 7) ?? '?';
  lines.push([
    { text: `${title}  `, color: 'white', bold: true },
    { text: `${v0} → ${v1}`, color: 'cyan' },
    { text: `  ${zoomLabel}  [+/-] zoom  [←→] pan  [[/]] ${noun} (${nRows})`, dim: true },
  ]);

  // Normalization peak, computed from raw data before any sampling so the
  // heights never change as you pan or zoom.
  //   'global' — one peak across all rows (artists, whose daily totals are
  //              comparable, so relative intensity reads correctly)
  //   'row'    — each row scaled to its own peak (songs, where one binge would
  //              otherwise flatten every more-spread-out song to nothing)
  let absolutePeak = 1;
  for (const row of rows) {
    for (const v of row.daily) {
      if (v > absolutePeak) absolutePeak = v;
    }
  }
  const rowPeak = (row) => {
    let p = 1;
    for (const v of row.daily) if (v > p) p = v;
    return p;
  };

  // Rows
  for (let ai = 0; ai < rows.length; ai++) {
    const row    = rows[ai];
    const color  = COLORS[ai % COLORS.length];
    const endIdx = Math.min(off + span, nDays);
    const visible = row.daily.slice(off, endIdx);
    const sampled = gaussianSpread(sampleMax(visible, brCols));
    const peak    = normalize === 'row' ? rowPeak(row) : absolutePeak;

    // Build braille grid [rowsPer][chartW]
    const grid = Array.from({ length: rowsPer }, () => new Uint8Array(chartW));
    for (let bc = 0; bc < sampled.length; bc++) {
      const cc = bc >> 1;
      const wc = bc & 1;
      let fill = Math.floor(sampled[bc] / peak * brRows);
      if (fill < 2) fill = 0;
      for (let br = brRows - fill; br < brRows; br++) {
        const cr = br >> 2;
        const wr = br & 3;
        if (cr < rowsPer) grid[cr][cc] |= BD[wr][wc];
      }
    }

    const totalStr   = fmtValue(row.total);
    const visibleVal = visible.reduce((a, v) => a + v, 0);
    const visibleStr = fmtValue(visibleVal);

    for (let r = 0; r < rowsPer; r++) {
      const line = [];

      // Label column (must be exactly LABEL_W chars)
      if (r === 0) {
        line.push({ text: fitLabel(` ${row.name}`, 'start'), color, bold: true });
      } else if (r === 1 && row.subtitle && rowsPer >= 3) {
        // Songs with room: artist on its own line, total on the next
        line.push({ text: fitLabel(`  ${row.subtitle}`, 'end'), color, dim: true });
      } else if (r === 1 && row.subtitle) {
        // Songs, tight: artist · total plays
        line.push({ text: fitLabel(`  ${row.subtitle} · ${totalStr}`, 'end'), color, dim: true });
      } else if (r === 1 && rowsPer >= 3) {
        // Enough rows: show visible value on this line, total on next
        line.push({ text: fitLabel(`  ${visibleStr} in view`, 'end'), color, dim: true });
      } else if (r === 1) {
        // Tight: show both on one line — visible · total
        line.push({ text: fitLabel(`  ${visibleStr} · ${totalStr}`, 'end'), color, dim: true });
      } else if (r === 2) {
        const label = row.subtitle ? `  ${totalStr}` : `  ${totalStr} total`;
        line.push({ text: fitLabel(label, 'end'), color, dim: true });
      } else {
        line.push({ text: ' '.repeat(LABEL_W) });
      }

      // Chart column
      let chartStr = '';
      for (let c = 0; c < chartW; c++) {
        const bits = grid[r][c];
        chartStr += bits ? String.fromCharCode(0x2800 + bits) : ' ';
      }
      line.push({ text: chartStr, color });

      lines.push(line);
    }
  }

  // Year axis
  const axis = new Array(chartW).fill(' ');
  let prevYear = '';
  for (let i = off; i < Math.min(off + span, nDays); i++) {
    const yr = days[i].slice(0, 4);
    if (yr !== prevYear) {
      const cp = Math.floor((i - off) / span * brCols) >> 1;
      for (let j = 0; j < yr.length; j++) {
        if (cp + j < chartW) axis[cp + j] = yr[j];
      }
      prevYear = yr;
    }
  }
  lines.push([
    { text: ' '.repeat(LABEL_W), dim: true },
    { text: axis.join(''), dim: true },
  ]);

  return lines;
}
