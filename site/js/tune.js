// AgriTune: theme, units, defaults, data and model panel, About.
import { Q, getDbBytes } from './db.js';
import { settings, fmtYield, fmtNum, unitLabel, qLabel, download, toast, enhance } from './ui.js';

const THEMES = [
  { id: 'forest', name: 'Forest Green', sw: 'linear-gradient(135deg,#061f1f,#163430 60%,#8eb69b)' },
  { id: 'ocean', name: 'Ocean Teal', sw: 'linear-gradient(135deg,#04202a,#124350 60%,#7fc4c9)' },
  { id: 'sunset', name: 'Sunset Amber', sw: 'linear-gradient(135deg,#231108,#4c2a14 60%,#e8b26a)' },
  { id: 'slate', name: 'Slate', sw: 'linear-gradient(135deg,#0f141b,#222c3a 60%,#9db4d1)' },
];

const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function render(el) {
  const s = settings.get();
  const info = Q.buildInfo();
  const files = Q.dataFiles();
  const selected = Q.metrics().find((m) => m.is_selected);
  const built = new Date(info.built_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  const toggle = (id, label, hint, on) => `<div class="switch"><div><div id="${id}L">${label}</div><div class="note">${hint}</div></div>
    <button class="toggle" id="${id}" role="switch" aria-checked="${on}" aria-labelledby="${id}L"></button></div>`;

  el.innerHTML = `<div class="view">
    <div><h1 class="page-title">AgriTune</h1><p class="page-sub">Appearance, units and the data behind AgriCast. Settings are saved on this device only.</p></div>

    <div class="grid g2">
      <section class="card reveal" aria-labelledby="appT"><h2 id="appT">Appearance</h2>
        <div class="themes" role="group" aria-label="Theme presets">
          ${THEMES.map((t) => `<button class="theme-opt" data-theme-id="${t.id}" aria-pressed="${s.theme === t.id}"><span class="sw" style="background:${t.sw}"></span><b>${t.name}</b></button>`).join('')}
        </div>
        <div style="margin-top:14px">
          ${toggle('tLight', 'Light mode', 'Pale background with dark text', s.light)}
          ${toggle('tMotion', 'Reduce motion', 'Turns off animations, count-ups and tilt', s.reduceMotion)}
        </div></section>

      <section class="card reveal" aria-labelledby="prefT"><h2 id="prefT">Preferences</h2>
        <div class="grid" style="gap:16px">
          <div class="field"><span class="lbl" id="uL">Yield units</span>
            <div class="seg" role="group" aria-labelledby="uL"><button data-unit="tha" aria-pressed="${s.units === 'tha'}">t/ha</button><button data-unit="kg" aria-pressed="${s.units === 'kg'}">kg/ha</button></div></div>
          <div class="field"><label for="dCrop">Default crop</label><select id="dCrop">${Q.crops().map((c) => `<option ${c === s.crop ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          <p class="note">Other PSA crops are not modelled. Pampanga palay only.</p>
        </div></section>
    </div>

    <section class="card reveal" aria-labelledby="dataT"><h2 id="dataT">Data and model</h2>
      <div class="grid g2" style="gap:30px">
        <div><dl class="kv">
          ${files.map((f) => `<dt>${f.name}</dt><dd>Loaded · ${fmtNum(f.rows_loaded)} rows</dd>`).join('')}
          <dt>PSA records stored</dt><dd>${fmtNum(Q.recordCount())}</dd>
          <dt>Forecast rows</dt><dd>${fmtNum(info.forecast_rows)}</dd>
          <dt>Latest published quarter</dt><dd>${qLabel(info.latest_year, info.latest_quarter)}</dd>
          <dt>Database built</dt><dd>${built}</dd></dl></div>
        <div><dl class="kv">
          <dt>Model in use</dt><dd>${info.model_name}</dd>
          <dt>MAE</dt><dd>${fmtYield(selected.mae)} ${unitLabel()}</dd>
          <dt>RMSE</dt><dd>${fmtYield(selected.rmse)} ${unitLabel()}</dd>
          <dt>MAPE</dt><dd>${fmtNum(selected.mape, 1)}%</dd>
          <dt>Beats baseline?</dt><dd>${info.beats_baseline ? 'Yes' : 'No (baseline used)'}</dd></dl></div>
      </div>
      <div class="row" style="margin-top:22px; justify-content:flex-start">
        <button class="btn" id="dlDb">Download database (.db)</button>
        <button class="btn ghost" id="dlCsv">Download forecasts (.csv)</button></div>
      <p class="note" style="margin-top:14px">Data changes only when the offline pipeline is re-run and the site is redeployed. There is no reload button on purpose.</p>
    </section>

    <section class="card reveal" aria-labelledby="aboutT"><h2 id="aboutT">About</h2>
      <p><b>AgriCast</b> forecasts rice (palay) yield for Pampanga province and shows past production, harvested area and yield.</p>
      <p class="note" style="margin-top:10px">Data: Philippine Statistics Authority (PSA), OpenStat, "Palay and Corn" tables, licensed
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>. Changes: reshaped, yields calculated as production divided by area, forecasts added.</p>
      <p class="note" style="margin-top:10px">School project for course CPESOFT30/1L. Forecasts are estimates from a small statistical model and are not official PSA figures.</p>
    </section>
  </div>`;

  const $ = (sel) => el.querySelector(sel);
  const flip = (btn, key) => { const on = btn.getAttribute('aria-checked') !== 'true'; btn.setAttribute('aria-checked', String(on)); settings.set({ [key]: on }); };

  el.querySelectorAll('[data-theme-id]').forEach((b) => b.addEventListener('click', () => {
    settings.set({ theme: b.dataset.themeId });
    el.querySelectorAll('[data-theme-id]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('#tLight').addEventListener('click', (e) => flip(e.currentTarget, 'light'));
  $('#tMotion').addEventListener('click', (e) => flip(e.currentTarget, 'reduceMotion'));
  el.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => {
    settings.set({ units: b.dataset.unit });
    el.querySelectorAll('[data-unit]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    toast(`Yields now shown in ${b.textContent}.`);
    render(el);   // redraw so the metrics above use the new unit
  }));
  $('#dCrop').addEventListener('change', (e) => settings.set({ crop: e.target.value }));

  $('#dlDb').addEventListener('click', () => { download('agricast.db', getDbBytes(), 'application/x-sqlite3'); toast('Database downloaded.'); });
  $('#dlCsv').addEventListener('click', () => {
    const rows = Q.forecastsCsvRows();
    const head = Object.keys(rows[0]);
    const csv = [head.join(','), ...rows.map((r) => head.map((h) => csvCell(r[h])).join(','))].join('\n');
    download('agricast_forecasts.csv', csv, 'text/csv');
    toast('Forecast table downloaded.');
  });
  enhance(el);
}
