// AgriHub: hero, stat cards, trend chart, latest prediction, semester donut.
import { Q } from './db.js';
import { settings, fmtYield, fmtNum, toUnit, unitLabel, unitDec, deltaHtml, pct, enhance, reduced } from './ui.js';
import { trendData, trendChart, donut, sparkline, qKey } from './charts.js';

// Rice paddy at dusk, drawn with SVG. Layers move slightly with the mouse (parallax).
function heroScene() {
  const stalks = Array.from({ length: 60 }, (_, i) => {
    const x = 20 + i * 20;
    return `<path d="M${x} 400 q2 -26 ${i % 2 ? 6 : -6} -44 M${x} 400 q-3 -18 -8 -30" />`;
  }).join('');
  return `<svg class="scene" viewBox="0 0 1200 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a2a2c"/><stop offset=".5" stop-color="#2d5d4b"/><stop offset=".85" stop-color="#d79b5c"/><stop offset="1" stop-color="#f0c17c"/></linearGradient>
      <radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff2c9"/><stop offset=".25" stop-color="#ffd58a" stop-opacity=".75"/><stop offset="1" stop-color="#ffb866" stop-opacity="0"/></radialGradient>
      <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#04181a" stop-opacity=".82"/><stop offset=".6" stop-color="#04181a" stop-opacity=".25"/><stop offset="1" stop-color="#04181a" stop-opacity="0"/></linearGradient>
    </defs>
    <rect width="1200" height="400" fill="url(#sky)"/>
    <g class="layer" data-depth="3"><circle cx="860" cy="250" r="190" fill="url(#sun)"/><circle cx="860" cy="262" r="38" fill="#fff0c2"/></g>
    <g class="layer" data-depth="6"><path d="M-40 290 C140 220 260 250 400 232 S640 200 800 245 S1060 215 1260 262 V420 H-40Z" fill="#3b7a5c" opacity=".75"/></g>
    <g class="layer" data-depth="12"><path d="M-40 320 C120 270 300 300 470 285 S760 262 920 300 S1120 280 1260 306 V420 H-40Z" fill="#245c46"/>
      <g stroke="#3c8a63" stroke-width="1.4" fill="none" opacity=".7"><path d="M0 330 q300 -30 600 -8 t640 -10"/><path d="M0 345 q300 -26 620 -4 t620 -8"/></g></g>
    <g class="layer" data-depth="20"><path d="M-40 355 C160 330 360 350 560 338 S900 330 1260 352 V420 H-40Z" fill="#14402f"/>
      <g stroke="#6faa7e" stroke-width="2" fill="none" stroke-linecap="round" opacity=".55">${stalks}</g></g>
    <rect width="1200" height="400" fill="url(#shade)"/></svg>`;
}

export function render(el) {
  const crop = settings.get().crop;
  const info = Q.buildInfo();
  const quarterly = Q.quarterly(crop);
  const forecasts = Q.forecasts(crop);
  const next = forecasts.find((f) => f.kind === 'future');
  const annual = Q.annualComplete(crop, 9999, 10);   // newest first
  const lastQ = quarterly[quarterly.length - 1];
  const years = Q.years();

  // Stat 1: next forecast vs the same quarter one year earlier
  const sameLastYear = quarterly.find((r) => r.year === next.year - 1 && r.q === next.q);
  const ch1 = pct(next.pred, sameLastYear?.yield_t_ha);
  // Stat 2: latest complete year vs the average of the 5 complete years before it
  const prev5 = annual.slice(1, 6);
  const avg5 = prev5.reduce((s, r) => s + r.yield_t_ha, 0) / prev5.length;
  const ch2 = pct(annual[0].yield_t_ha, avg5);
  // Donut: Semester share of annual production in the latest complete year
  const sem = Q.semesterShare(crop, annual[0].year);
  const prodOf = (p) => sem.find((r) => r.period === p)?.production_t ?? 0;
  const s1 = prodOf('S1'), s2 = prodOf('S2'), total = prodOf('Annual') || s1 + s2;
  const nextLabel = `Q${next.q} ${next.year}`;

  el.innerHTML = `<div class="view">
    <section class="hero"aria-labelledby="heroTitle">${heroScene()}
      <div class="hero-body">
        <h1 id="heroTitle">Welcome to AgriCast</h1>
        <p class="sub1">Rice yield Prediction and Agricultural Analytics for Pampanga Province</p>
        <p class="tag">From PSA harvest records to a clear forecast, one quarter at a time.</p>
        <a class="btn" href="#/task">Make prediction</a>
      </div></section>

    <section class="grid g4" aria-label="Key numbers">
      <article class="card small stat reveal" data-tilt>
        <span class="k">Latest Prediction Yield</span>
        <span class="v"><span data-count="${toUnit(next.pred)}" data-dec="${unitDec()}">0</span><small>${unitLabel()}</small></span>
        ${deltaHtml(ch1, `vs same quarter last year (${nextLabel.replace(next.year, next.year - 1)})`)}
        <div class="spark"><canvas id="sp1" role="img" aria-label="Recent quarterly yields"></canvas></div></article>
      <article class="card small stat reveal" data-tilt>
        <span class="k">Average Yield · ${annual[0].year}</span>
        <span class="v"><span data-count="${toUnit(annual[0].yield_t_ha)}" data-dec="${unitDec()}">0</span><small>${unitLabel()}</small></span>
        ${deltaHtml(ch2, `vs ${prev5[prev5.length - 1].year}-${prev5[0].year} average`)}
        <div class="spark"><canvas id="sp2" role="img" aria-label="Annual yields, last 10 years"></canvas></div></article>
      <article class="card small stat reveal" data-tilt>
        <span class="k">Province Coverage</span>
        <span class="v">Pampanga</span>
        <span class="delta">${crop} · ${years.first} to Q${lastQ.q} ${lastQ.year}</span></article>
      <article class="card small stat reveal" data-tilt>
        <span class="k">Data Records</span>
        <span class="v"><span data-count="${Q.recordCount()}">0</span></span>
        <span class="delta">PSA values stored in the database</span></article>
    </section>

    <section class="grid g-main">
      <article class="card reveal" data-tilt>
        <div class="row"><h2>Pampanga Rice Yield Trend</h2>
          <div class="field"><label for="range" class="sr-only" style="position:absolute;left:-9999px">Year range</label>
            <select id="range" aria-label="Year range"><option value="5">Last 5 years</option><option value="10" selected>Last 10 years</option><option value="20">Last 20 years</option><option value="0">All years</option></select></div></div>
        <div class="chart-box"><canvas id="trend" role="img" aria-label="Quarterly rice yield, actual and predicted"></canvas></div>
        <div class="legend"><span><i></i>Actual (PSA)</span><span><i class="dash"></i>Predicted</span><span><i class="band"></i>Low-high range (future)</span></div>
      </article>
      <div class="grid">
        <article class="card reveal" data-tilt>
          <h2>Latest Prediction</h2>
          <span class="pill pred">${nextLabel} · forecast</span>
          <p class="result-num"><span data-count="${toUnit(next.pred)}" data-dec="${unitDec()}">0</span><small>${unitLabel()}</small></p>
          <p class="note">Range ${fmtYield(next.low)} to ${fmtYield(next.high)} ${unitLabel()} · typical error ±${fmtYield(info.typical_error_h1)} ${unitLabel()}</p>
          <p style="margin-top:14px"><a class="btn sm" href="#/task?y=${next.year}&q=${next.q}">Open in AgriTask</a></p>
        </article>
        <article class="card reveal" data-tilt>
          <h2>Semester share · ${annual[0].year}</h2>
          <div class="chart-box donut"><canvas id="donut" role="img" aria-label="Semester 1 versus Semester 2 share of annual production"></canvas></div>
          <div class="legend"><span><i></i>Semester 1: ${fmtNum((s1 / total) * 100, 1)}%</span><span><i class="dash"></i>Semester 2: ${fmtNum((s2 / total) * 100, 1)}%</span></div>
        </article>
      </div>
    </section>
  </div>`;

  // sparklines and donut
  const lastQuarters = quarterly.slice(-12).map((r) => toUnit(r.yield_t_ha));
  sparkline(el.querySelector('#sp1'), [...lastQuarters, toUnit(next.pred)]);
  sparkline(el.querySelector('#sp2'), annual.map((r) => toUnit(r.yield_t_ha)).reverse());
  donut(el.querySelector('#donut'), ['Semester 1', 'Semester 2'], [s1, s2]);

  // trend chart with year-range dropdown
  const endKey = qKey(forecasts[forecasts.length - 1].year, forecasts[forecasts.length - 1].q);
  let chart = null;
  const drawTrend = () => {
    chart?.destroy();
    const n = Number(el.querySelector('#range').value);
    const from = n ? endKey - n * 4 + 1 : 0;
    chart = trendChart(el.querySelector('#trend'), trendData(quarterly, forecasts, from, endKey));
  };
  el.querySelector('#range').addEventListener('change', drawTrend);
  drawTrend();

  // parallax for the hero layers
  const hero = el.querySelector('.hero');
  if (!reduced()) {
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      const dx = (e.clientX - r.left) / r.width - 0.5;
      hero.querySelectorAll('.layer').forEach((l) => { l.style.transform = `translateX(${(-dx * Number(l.dataset.depth)).toFixed(1)}px)`; });
    });
  }
  enhance(el);
}
