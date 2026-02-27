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

/**
 * Returns array of lines; each line is array of { text, color, bold, dim }.
 * Caller renders these with Ink <Text> spans.
 */
export function drawChart(data, { width, height, zoom, offset, nArtists, zoomLabel }) {
  const days    = data.days;
  const artists = data.artists.slice(0, nArtists);
  const nDays   = days.length;
  const span    = getSpan(data, zoom);
  const off     = Math.max(0, Math.min(offset, nDays - span));

  const chartW   = Math.max(4, width - LABEL_W);
  const brCols   = chartW * 2;
  const rowsPer  = artists.length > 0 ? Math.max(2, Math.floor((height - 2) / artists.length)) : 2;
  const brRows   = rowsPer * 4;

  const lines = [];

  // Header
  const v0 = days[off]?.slice(0, 7) ?? '?';
  const v1 = days[Math.min(off + span - 1, nDays - 1)]?.slice(0, 7) ?? '?';
  lines.push([
    { text: 'Artist History  ', color: 'white', bold: true },
    { text: `${v0} → ${v1}`, color: 'cyan' },
    { text: `  ${zoomLabel}  [+/-] zoom  [←→] pan  [[/]] artists (${nArtists})`, dim: true },
  ]);

  // Absolute peak: max daily ms across all artists across all time.
  // Computed from raw data before any sampling so it never changes as you pan or zoom.
  let absolutePeak = 1;
  for (const artist of artists) {
    for (const v of artist.dailyMs) {
      if (v > absolutePeak) absolutePeak = v;
    }
  }

  // Artist rows
  for (let ai = 0; ai < artists.length; ai++) {
    const artist = artists[ai];
    const color  = COLORS[ai % COLORS.length];
    const endIdx = Math.min(off + span, nDays);
    const visible = artist.dailyMs.slice(off, endIdx);
    const sampled = gaussianSpread(sampleMax(visible, brCols));
    const peak    = absolutePeak;

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

    // Time helpers
    const fmtMs = ms => {
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return h ? `${h}h ${m}m` : `${m}m`;
    };
    const totalStr   = fmtMs(artist.totalMs);
    const visibleMs  = visible.reduce((a, v) => a + v, 0);
    const visibleStr = fmtMs(visibleMs);

    for (let r = 0; r < rowsPer; r++) {
      const line = [];

      // Label column (must be exactly LABEL_W chars)
      if (r === 0) {
        const name = ` ${artist.name.slice(0, LABEL_W - 2)}`;
        line.push({ text: name.padEnd(LABEL_W), color, bold: true });
      } else if (r === 1 && rowsPer >= 3) {
        // Enough rows: show visible time on this line, total on next
        const label = `  ${visibleStr} in view`.padStart(LABEL_W);
        line.push({ text: label, color, dim: true });
      } else if (r === 1 && rowsPer === 2) {
        // Tight: show both on one line — visible · total
        const label = `  ${visibleStr} · ${totalStr}`.padStart(LABEL_W);
        line.push({ text: label, color, dim: true });
      } else if (r === 2) {
        const label = `  ${totalStr} total`.padStart(LABEL_W);
        line.push({ text: label, color, dim: true });
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
