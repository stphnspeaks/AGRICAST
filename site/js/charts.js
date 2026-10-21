// Chart.js helpers: colors from CSS variables, glass tooltip, forecast band, sparklines.
import { toUnit, unitLabel, unitDec, reduced } from './ui.js';

const live = [];
export function destroyCharts() { live.splice(0).forEach((c) => c.destroy()); }

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const colors = () => ({ accent: css('--accent'), pred: css('--pred'), text: css('--text-dim'), grid: css('--grid'), mint: css('--mint'), sage: css('--sage') });

// "#8eb69b" + 0.4 -> rgba(...). Canvas gradients need real color values.
function alpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function areaGradient(color) {
  return (ctx) => {
    const area = ctx.chart.chartArea;
    if (!area) return 'transparent';
    const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, alpha(color, 0.38));
    g.addColorStop(1, alpha(color, 0));
    return g;
  };
}

// Tooltip drawn as a small glass card instead of the default canvas box
function glassTooltip(fmt) {
  return ({ chart, tooltip }) => {
    const host = chart.canvas.parentNode;
    let el = host.querySelector('.tt');
    if (!el) { el = document.createElement('div'); el.className = 'tt'; host.appendChild(el); }
    if (tooltip.opacity === 0) { el.style.opacity = 0; return; }
    const lines = tooltip.dataPoints
      .filter((p) => p.parsed.y != null || typeof p.raw === 'number')
      .map((p) => `<div><span class="dot" style="background:${p.dataset.tipColor || '#fff'}"></span>${p.dataset.label}: ${fmt(p)}</div>`);
    el.innerHTML = `<b>${tooltip.title?.[0] ?? ''}</b>${lines.join('')}`;
    const left = Math.max(0, Math.min(tooltip.caretX + 14, host.clientWidth - el.offsetWidth));
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(0, tooltip.caretY - el.offsetHeight - 10)}px`;
    el.style.opacity = 1;
  };
}

// Draws the shaded low-high band (and a bar at single points) behind the lines
const rangeBand = {
  id: 'rangeBand',
  beforeDatasetsDraw(chart, _args, opts) {
    if (!opts?.low) return;
    const { ctx, scales: { x, y } } = chart;
    ctx.save();
    ctx.fillStyle = opts.color;
    opts.low.forEach((lo, i) => {
      const hi = opts.high[i];
      if (lo == null || hi == null) return;
      const px = x.getPixelForValue(i);
      ctx.fillRect(px - 6, y.getPixelForValue(hi), 12, y.getPixelForValue(lo) - y.getPixelForValue(hi));
      if (opts.low[i + 1] != null) {
        const nx = x.getPixelForValue(i + 1);
        ctx.beginPath();
        ctx.moveTo(px, y.getPixelForValue(hi));
        ctx.lineTo(nx, y.getPixelForValue(opts.high[i + 1]));
        ctx.lineTo(nx, y.getPixelForValue(opts.low[i + 1]));
        ctx.lineTo(px, y.getPixelForValue(lo));
        ctx.closePath();
        ctx.fill();
      }
    });
    ctx.restore();
  },
};

// Show the year on Q1 / S1 / annual labels, thinned out when there are many years.
function tickCallback(labels) {
  const years = new Set(labels.map((l) => l.slice(0, 4))).size;
  const step = Math.max(1, Math.ceil(years / 10));
  return function (_v, i) {
    const l = labels[i];
    if (!l) return '';
    const first = l.length === 4 || l.endsWith('Q1') || l.endsWith('S1');
    return first && Number(l.slice(0, 4)) % step === 0 ? l.slice(0, 4) : '';
  };
}

function baseOptions(c, labels, fmt) {
  return {
    responsive: true, maintainAspectRatio: false,
    animation: reduced() ? false : { duration: 1100, easing: 'easeOutQuart' },
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 8, right: 6 } },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: c.text, autoSkip: false, maxRotation: 0, callback: tickCallback(labels) } },
      y: { grid: { color: c.grid }, border: { display: false }, ticks: { color: c.text, maxTicksLimit: 6, callback: (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: unitDec() }) },
           title: { display: true, text: unitLabel(), color: c.text } },
    },
    plugins: { legend: { display: false }, tooltip: { enabled: false, external: glassTooltip(fmt) } },
  };
}

const yieldFmt = (p) => `${Number(p.parsed.y).toLocaleString('en-US', { minimumFractionDigits: unitDec(), maximumFractionDigits: unitDec() })} ${unitLabel()}`;

// Merge actual quarters and forecast rows into aligned arrays between two quarter keys.
// key = year * 4 + (quarter - 1)
export const qKey = (year, q) => year * 4 + q - 1;
export function trendData(quarterly, forecasts, fromKey, toKey, bandKinds = ['future']) {
  const map = new Map();
  const slot = (year, q) => {
    const k = qKey(year, q);
    if (!map.has(k)) map.set(k, { year, q, actual: null, pred: null, low: null, high: null, future: false });
    return map.get(k);
  };
  quarterly.forEach((r) => { slot(r.year, r.q).actual = r.yield_t_ha; });
  forecasts.forEach((f) => {
    const s = slot(f.year, f.q);
    s.pred = f.pred; s.future = f.kind === 'future';
    if (bandKinds.includes(f.kind)) { s.low = f.low; s.high = f.high; }
  });
  const items = [...map.entries()].filter(([k]) => k >= fromKey && k <= toKey).sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  return {
    items,
    labels: items.map((s) => `${s.year} Q${s.q}`),
    actual: items.map((s) => toUnit(s.actual)),
    pred: items.map((s) => toUnit(s.pred)),
    low: items.map((s) => toUnit(s.low)),
    high: items.map((s) => toUnit(s.high)),
    future: items.map((s) => s.future),
  };
}

export function trendChart(canvas, d, highlight = null) {
  const c = colors();
  const opts = baseOptions(c, d.labels, yieldFmt);
  opts.plugins.rangeBand = { low: d.low, high: d.high, color: alpha(c.pred, 0.22) };
  const chart = new Chart(canvas, {
    type: 'line', plugins: [rangeBand],
    data: {
      labels: d.labels,
      datasets: [
        { label: 'Actual', data: d.actual, tipColor: c.accent, borderColor: c.accent, borderWidth: 2.5, tension: 0.35, fill: 'origin',
          backgroundColor: areaGradient(c.accent), pointRadius: 0, pointHoverRadius: 5, pointBackgroundColor: c.accent },
        { label: 'Predicted', data: d.pred, tipColor: c.pred, borderColor: c.pred, borderWidth: 2, borderDash: [7, 5], tension: 0.25,
          pointRadius: (ctx) => (d.future[ctx.dataIndex] || ctx.dataIndex === highlight ? 5 : 0), pointHoverRadius: 6,
          pointStyle: 'circle', pointBackgroundColor: 'transparent', pointBorderColor: c.pred, pointBorderWidth: 2.5 },
      ],
    },
    options: opts,
  });
  live.push(chart);
  return chart;
}

// Yield (line) for AgriMetrics; labels are "2019 Q1", "2019 S1" or "2019"
export function yieldLine(canvas, labels, values) {
  const c = colors();
  const chart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [{ label: 'Yield', data: values.map(toUnit), tipColor: c.accent, borderColor: c.accent, borderWidth: 2.5, tension: 0.35, fill: 'origin',
      backgroundColor: areaGradient(c.accent), pointRadius: values.length > 50 ? 0 : 3, pointHoverRadius: 6, pointBackgroundColor: c.accent }] },
    options: baseOptions(c, labels, yieldFmt),
  });
  live.push(chart);
  return chart;
}

// Production (bar); preliminary values use the "predicted" color
export function productionBars(canvas, labels, values, prelim) {
  const c = colors();
  const opts = baseOptions(c, labels, (p) => `${Number(p.parsed.y).toLocaleString('en-US')} t`);
  opts.scales.y.title.text = 'tonnes';
  opts.scales.y.ticks.callback = (v) => Number(v).toLocaleString('en-US');
  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Production', data: values, tipColor: c.accent, borderRadius: 6, borderSkipped: false,
      backgroundColor: values.map((_, i) => (prelim[i] ? alpha(c.pred, 0.8) : alpha(c.accent, 0.85))) }] },
    options: opts,
  });
  live.push(chart);
  return chart;
}

export function donut(canvas, labels, values) {
  const c = colors();
  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: [c.accent, c.pred], borderColor: 'transparent', hoverOffset: 8, tipColor: c.accent, label: 'Share' }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '68%',
      animation: reduced() ? false : { duration: 1100, animateRotate: true },
      plugins: { legend: { display: false }, tooltip: { enabled: false, external: glassTooltip((p) => `${Number(p.raw).toLocaleString('en-US')} t`) } },
    },
  });
  live.push(chart);
  return chart;
}

export function sparkline(canvas, values) {
  const c = colors();
  const chart = new Chart(canvas, {
    type: 'line',
    data: { labels: values.map((_, i) => i), datasets: [{ data: values, borderColor: c.accent, borderWidth: 2, tension: 0.4, pointRadius: 0, fill: 'origin', backgroundColor: areaGradient(c.accent) }] },
    options: { responsive: true, maintainAspectRatio: false, animation: reduced() ? false : { duration: 900 },
      scales: { x: { display: false }, y: { display: false } }, plugins: { legend: { display: false }, tooltip: { enabled: false } }, events: [] },
  });
  live.push(chart);
  return chart;
}
