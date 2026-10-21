// AgriMetrics: filters, KPI cards, yield trend, production bars, seasonality heatmap, data availability.
import { Q } from './db.js';
import { settings, fmtYield, fmtNum, toUnit, unitLabel, unitDec, enhance, setupReveal, setupTilt, toast } from './ui.js';
import { yieldLine, productionBars } from './charts.js';

const PERIODS = { quarterly: ['Q1', 'Q2', 'Q3', 'Q4'], semestral: ['S1', 'S2'], annual: ['Annual'] };

// "2019 Q1" / "2019 S1" / "2019"
const labelOf = (r) => (r.period === 'Annual' ? String(r.year) : `${r.year} ${r.period}`);

export function render(el, ctx) {
  const crop = settings.get().crop;
  const { first, last } = Q.years();
  const quarterly = Q.quarterly(crop);
  const state = {
    from: Number(ctx.query.get('from')) || Math.max(first, last - 9),
    to: Number(ctx.query.get('to')) || last,
    period: 'quarterly',
    heat: 'yield',
  };
  state.from = Math.min(Math.max(state.from, first), last);
  state.to = Math.min(Math.max(state.to, first), last);
  if (state.from > state.to) [state.from, state.to] = [state.to, state.from];

  const yearOptions = (selected) => {
    let html = '';
    for (let y = last; y >= first; y--) html += `<option value="${y}" ${y === selected ? 'selected' : ''}>${y}</option>`;
    return html;
  };

  el.innerHTML = `<div class="view">
    <div><h1 class="page-title">Pampanga Historical Rice Data</h1>
      <p class="page-sub">Production, harvested area and yield from PSA OpenStat.</p></div>

    <section class="card reveal" aria-label="Filters">
      <div class="filters">
        <div class="field"><label for="fFrom">From year</label><select id="fFrom">${yearOptions(state.from)}</select></div>
        <div class="field"><label for="fTo">To year</label><select id="fTo">${yearOptions(state.to)}</select></div>
        <div class="field"><label for="fPeriod">Period</label><select id="fPeriod">
          <option value="quarterly">Quarterly</option><option value="semestral">Semestral</option><option value="annual">Annual</option></select></div>
        <div class="field"><label for="fCrop">Crop</label><select id="fCrop">${Q.crops().map((c) => `<option>${c}</option>`).join('')}</select></div>
      </div>
    </section>

    <section id="kpis" class="grid g3" aria-label="Key figures"></section>

    <section class="grid g2">
      <article class="card reveal" data-tilt><h2 id="yieldTitle">Yield Trends</h2>
        <div class="chart-box"><canvas id="yieldChart" role="img" aria-label="Yield trend for the selected years"></canvas></div></article>
      <article class="card reveal" data-tilt><h2 id="prodTitle">Production by quarter</h2>
        <div class="chart-box"><canvas id="prodChart" role="img" aria-label="Production for the selected years"></canvas></div>
        <div class="legend"><span><i></i>Final</span><span><i class="dash"></i>Preliminary</span></div></article>
    </section>

    <section class="card reveal">
      <div class="row"><h2>Seasonality heatmap</h2>
        <div class="seg" role="group" aria-label="Heatmap measure">
          <button data-heat="yield" aria-pressed="true">Yield</button><button data-heat="production" aria-pressed="false">Production</button></div></div>
      <p class="note" style="margin-bottom:12px" id="heatNote"></p>
      <div class="heat-wrap" id="heat" tabindex="0" aria-label="Seasonality heatmap, scrollable"></div>
    </section>

    <section class="card reveal" aria-label="Data availability"><h2>Data Availability</h2><div id="avail" class="availability"></div></section>
  </div>`;

  el.querySelector('#fPeriod').value = state.period;

  // ----- pieces -----
  const drawKpis = () => {
    // KPIs show the latest COMPLETE year inside or before the selected range.
    const done = Q.annualComplete(crop, state.to, 2);
    const box = el.querySelector('#kpis');
    if (!done.length) { box.innerHTML = '<div class="card">No complete year available.</div>'; return; }
    const [cur, prev] = done;
    const note = cur.year < state.to
      ? `${state.to} is not complete yet, so the latest complete year (${cur.year}) is shown.`
      : cur.year < state.from ? `No complete year inside ${state.from}-${state.to}; showing ${cur.year}.` : `Annual figures for ${cur.year}.`;
    const kpi = (name, value, dec, unit, before) => {
      const d = before == null ? '' : `<span class="delta ${value >= before ? 'up' : 'down'}">${value >= before ? '&#9650;' : '&#9660;'} ${Math.abs(((value - before) / before) * 100).toFixed(1)}% vs ${prev.year}</span>`;
      return `<article class="card small stat reveal" data-tilt><span class="k">${name} · ${cur.year}</span>
        <span class="v"><span data-count="${value}" data-dec="${dec}">0</span><small>${unit}</small></span>${d}</article>`;
    };
    box.innerHTML =
      kpi('Production', cur.production_t, 2, 't', prev?.production_t) +
      kpi('Harvested area', cur.area_ha, 0, 'ha', prev?.area_ha) +
      kpi('Yield', toUnit(cur.yield_t_ha), unitDec(), unitLabel(), prev ? toUnit(prev.yield_t_ha) : null) +
      `<p class="note" style="grid-column:1/-1">${note}</p>`;
    enhance(box);
  };

  let charts = [];
  const drawCharts = () => {
    charts.forEach((c) => c.destroy());
    const periods = PERIODS[state.period];
    const data = Q.periodRows(crop, periods, state.from, state.to);
    const labels = data.map(labelOf);
    const word = { quarterly: 'quarter', semestral: 'semester', annual: 'year' }[state.period];
    el.querySelector('#prodTitle').textContent = `Production by ${word}`;
    el.querySelector('#yieldTitle').textContent = `Yield Trends (${state.from}-${state.to})`;
    charts = [
      yieldLine(el.querySelector('#yieldChart'), labels, data.map((r) => r.yield_t_ha)),
      productionBars(el.querySelector('#prodChart'), labels, data.map((r) => r.production_t), data.map((r) => r.is_preliminary === 1)),
    ];
  };

  const drawHeat = () => {
    const years = [];
    for (let y = state.to; y >= state.from; y--) years.push(y);
    const byKey = new Map(Q.periodRows(crop, PERIODS.quarterly, state.from, state.to).map((r) => [`${r.year}${r.period}`, r]));
    const value = (r) => (state.heat === 'yield' ? r.yield_t_ha : r.production_t);
    const vals = [...byKey.values()].map(value).filter((v) => v != null);
    const min = Math.min(...vals), max = Math.max(...vals);
    const show = (v) => (state.heat === 'yield' ? fmtYield(v) : fmtNum(v / 1000, 1) + 'k');
    let html = '<span></span>' + ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => `<span class="h">${q}</span>`).join('');
    for (const y of years) {
      html += `<span class="y">${y}</span>`;
      for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
        const r = byKey.get(`${y}${q}`);
        if (!r) { html += `<span class="c na" title="${y} ${q}: not available" aria-label="${y} ${q}: not available">n/a</span>`; continue; }
        const t = 0.12 + 0.88 * ((value(r) - min) / (max - min || 1));
        const full = state.heat === 'yield' ? `${fmtYield(r.yield_t_ha)} ${unitLabel()}` : `${fmtNum(r.production_t)} t`;
        html += `<span class="c ${t > 0.55 ? 'hi' : ''}" style="--t:${t.toFixed(2)}" title="${y} ${q}: ${full}" aria-label="${y} ${q}: ${full}">${show(value(r))}</span>`;
      }
    }
    el.querySelector('#heat').innerHTML = `<div class="heat">${html}</div>`;
    el.querySelector('#heatNote').textContent = `Darker cells are lower, brighter cells are higher ${state.heat === 'yield' ? `yield (${unitLabel()})` : 'production (thousand tonnes)'} · hatched = not available.`;
  };

  const drawAvail = () => {
    const info = Q.buildInfo();
    const missing = Q.unavailable(crop);
    const list = missing.map((r) => (r.period === 'Annual' ? `${r.year} Annual` : `${r.year} ${r.period}`));
    el.querySelector('#avail').innerHTML =
      `<span class="badge">Latest available quarter: Q${info.latest_quarter} ${info.latest_year} (preliminary)</span>` +
      (list.length ? `<span class="badge missing">Not available yet: ${list.join(', ')}</span>` : '');
  };

  const redraw = () => { drawKpis(); drawCharts(); drawHeat(); };

  // ----- events -----
  const changed = (what) => {
    state.from = Number(el.querySelector('#fFrom').value);
    state.to = Number(el.querySelector('#fTo').value);
    if (state.from > state.to) {
      if (what === 'from') { state.to = state.from; el.querySelector('#fTo').value = state.to; }
      else { state.from = state.to; el.querySelector('#fFrom').value = state.from; }
      toast('The start year cannot be after the end year, so the other one was adjusted.');
    }
    state.period = el.querySelector('#fPeriod').value;
    redraw();
  };
  el.querySelector('#fFrom').addEventListener('change', () => changed('from'));
  el.querySelector('#fTo').addEventListener('change', () => changed('to'));
  el.querySelector('#fPeriod').addEventListener('change', () => changed('period'));
  el.querySelectorAll('[data-heat]').forEach((b) => b.addEventListener('click', () => {
    state.heat = b.dataset.heat;
    el.querySelectorAll('[data-heat]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    drawHeat();
  }));

  setupReveal(el);   // before redraw(): the KPI cards are enhanced separately when they are drawn
  setupTilt(el);
  redraw();
  drawAvail();
}
