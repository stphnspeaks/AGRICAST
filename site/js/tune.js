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
  const shown = Q.metrics().filter((m) => m.is_displayed && m.split === 'test');
  const perH = (key, f) => shown.map((m) => `h${m.horizon} ${f(m[key])}`).join(' · ');
  const runs = Q.runs();
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
          ${files.map((f) => `<dt>${f.name}</dt><dd>PSA ${f.table_code} · updated ${f.psa_last_updated}</dd>`).join('')}
          <dt>PSA records stored</dt><dd>${fmtNum(Q.recordCount())}</dd>
          <dt>Forecast rows (shown run)</dt><dd>${fmtNum(info.forecast_rows)}</dd>
          <dt>Dataset version · model run</dt><dd>#${info.dsv_id} · #${info.displayed_run_id}</dd>
          <dt>Latest published quarter</dt><dd>${qLabel(info.latest_year, info.latest_quarter)}</dd>
          <dt>Database built</dt><dd>${built}</dd></dl></div>
        <div><dl class="kv">
          <dt>Model in use</dt><dd>${info.model_name}</dd>
          <dt>Test MAE (${unitLabel()})</dt><dd>${perH('mae', fmtYield)}</dd>
          <dt>Test RMSE (${unitLabel()})</dt><dd>${perH('rmse', fmtYield)}</dd>
          <dt>Test MAPE</dt><dd>${perH('mape', (v) => fmtNum(v, 1) + '%')}</dd>
          <dt>80% range coverage (test)</dt><dd>${perH('coverage', (v) => fmtNum(v * 100, 0) + '%')}</dd>
          <dt>Beats baseline?</dt><dd>${info.beats_baseline ? 'Yes' : `No (${info.chosen_model} was chosen on validation; baseline used)`}</dd></dl></div>
      </div>
      <div class="row" style="margin-top:22px; justify-content:flex-start">
        <button class="btn" id="dlDb">Download database (.db)</button>
        <button class="btn ghost" id="dlCsv">Download forecasts (.csv)</button></div>
      <p class="note" style="margin-top:14px">Data changes only when the offline pipeline is re-run and the site is redeployed. There is no reload button on purpose.</p>
    </section>

    <section class="card reveal" aria-labelledby="traceT"><h2 id="traceT">Forecast traceability</h2>
      <p class="note" style="margin-bottom:12px">Pick any stored forecast to see which model run and dataset version produced it, and the SHA-256 of both PSA files.</p>
      <div class="grid g2">
        <div class="field"><label for="trRun">Model run</label><select id="trRun">${runs.map((r) => `<option value="${r.run_id}" ${r.run_id === info.displayed_run_id ? 'selected' : ''}>Run ${r.run_id} · ${r.model_name} · ${r.trained_at}${r.is_deployed ? ' · deployed' : ''}</option>`).join('')}</select></div>
        <div class="field"><label for="trFc">Forecast</label><select id="trFc"></select></div>
      </div>
      <dl class="kv" id="trOut" style="margin-top:14px"></dl>
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

  // ----- traceability: forecast -> run -> dataset version -> SHA-256 of both PSA files -----
  const kindName = { validation: 'validation', test: 'test', future: 'forecast' };
  const fillForecasts = () => {
    $('#trFc').innerHTML = Q.runForecasts(Number($('#trRun').value)).map((f) =>
      `<option value="${f.forecast_id}">${kindName[f.kind]} · ${qLabel(f.target_year, f.target_quarter)} · ${f.horizon} ahead</option>`).join('');
    drawTrace();
  };
  const drawTrace = () => {
    const t = Q.trace(Number($('#trFc').value));
    $('#trOut').innerHTML = t ? `
      <dt>Forecast</dt><dd>#${t.forecast_id} · ${qLabel(t.target_year, t.target_quarter)} · ${t.horizon} quarter(s) ahead · ${fmtYield(t.predicted)} (${fmtYield(t.low)} to ${fmtYield(t.high)}) ${unitLabel()}</dd>
      <dt>Model run</dt><dd>#${t.run_id} · ${t.model_name} · ${t.params} · trained ${t.trained_at}${t.is_deployed ? ' · deployed' : ''}</dd>
      <dt>Code version</dt><dd>${t.code_version}</dd>
      <dt>Dataset version</dt><dd>#${t.dsv_id} · built ${t.dataset_built_at}</dd>
      <dt>Production file</dt><dd>${t.production_file} (PSA updated ${t.production_updated})<br><code style="word-break:break-all">${t.production_sha256}</code></dd>
      <dt>Area file</dt><dd>${t.area_file} (PSA updated ${t.area_updated})<br><code style="word-break:break-all">${t.area_sha256}</code></dd>` : '';
  };
  $('#trRun').addEventListener('change', fillForecasts);
  $('#trFc').addEventListener('change', drawTrace);
  fillForecasts();
  enhance(el);
}
