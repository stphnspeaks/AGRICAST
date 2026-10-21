// Loads agricast.db with sql.js (SQLite compiled to WebAssembly) and runs SQL in the browser.
// ALL SQL of the site lives in this file, so it is easy to read and check.

let db = null;
let dbBytes = null;

export async function openDb() {
  // Start the WebAssembly engine and the database download at the same time.
  const [SQL, res] = await Promise.all([
    initSqlJs({ locateFile: (file) => `vendor/${file}` }),
    fetch('data/agricast.db'),
  ]);
  if (!res.ok) throw new Error(`Database file not found (HTTP ${res.status})`);
  dbBytes = new Uint8Array(await res.arrayBuffer());
  db = new SQL.Database(dbBytes);
  db.exec('SELECT 1 FROM build_info LIMIT 1'); // fails early if the file is not our database
}

export const getDbBytes = () => dbBytes;

// Run a SELECT and return an array of plain objects.
function rows(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

const QUARTERS = "('Q1','Q2','Q3','Q4')";

export const Q = {
  // build_info as an object, numbers converted
  buildInfo() {
    const info = {};
    for (const r of rows('SELECT key, value FROM build_info')) {
      info[r.key] = r.value !== '' && !isNaN(r.value) ? Number(r.value) : r.value;
    }
    return info;
  },

  // The two PSA files behind the displayed dataset version (name shown in the app, table code, hash)
  dataFiles: () => rows(
    `SELECT 'Production CSV' AS name, f.table_code, f.sha256, f.psa_last_updated
       FROM dataset_versions v JOIN source_files f ON f.file_id = v.production_file_id
      WHERE v.dsv_id = (SELECT dsv_id FROM displayed_run)
     UNION ALL
     SELECT 'Area Harvested CSV', f.table_code, f.sha256, f.psa_last_updated
       FROM dataset_versions v JOIN source_files f ON f.file_id = v.area_file_id
      WHERE v.dsv_id = (SELECT dsv_id FROM displayed_run)`),

  // Validation and test scores of every deployed model, one row per model/split/horizon
  metrics: () => rows(
    `SELECT r.run_id, r.model_name AS model, r.params, m.split, m.horizon, m.mae, m.rmse, m.mape, m.coverage, m.mean_width,
            (r.run_id = (SELECT run_id FROM displayed_run)) AS is_displayed
       FROM model_metrics m JOIN model_runs r ON r.run_id = m.run_id
      WHERE r.is_deployed = 1 ORDER BY r.model_name = 'Seasonal naive' DESC, r.model_name, m.split, m.horizon`),

  // Data Records stat card: every PSA value we hold (not "..")
  recordCount: () => rows('SELECT COUNT(*) AS n FROM psa_quarterly WHERE production_t IS NOT NULL')[0].n,

  years: () => rows("SELECT MIN(year) AS first, MAX(year) AS last FROM psa_quarterly WHERE production_t IS NOT NULL")[0],

  // All quarterly rows with a yield, oldest first
  quarterly: (crop) => rows(
    `SELECT year, CAST(substr(period, 2) AS INTEGER) AS q, production_t, area_ha, yield_t_ha, is_preliminary
       FROM psa_quarterly WHERE crop = ? AND period IN ${QUARTERS} AND yield_t_ha IS NOT NULL
      ORDER BY year, period`, [crop]),

  // Rows for the AgriMetrics filters. periods = ['Q1',...] or ['S1','S2'] or ['Annual']
  periodRows: (crop, periods, from, to) => rows(
    `SELECT year, period, production_t, area_ha, yield_t_ha, is_preliminary FROM psa_quarterly
      WHERE crop = ? AND period IN (${periods.map(() => '?').join(',')})
        AND year BETWEEN ? AND ? AND production_t IS NOT NULL
      ORDER BY year, period`, [crop, ...periods, from, to]),

  // Complete (non-preliminary) annual rows up to a year, newest first
  annualComplete: (crop, upToYear, limit = 7) => rows(
    `SELECT year, production_t, area_ha, yield_t_ha FROM psa_quarterly
      WHERE crop = ? AND period = 'Annual' AND is_preliminary = 0 AND production_t IS NOT NULL AND year <= ?
      ORDER BY year DESC LIMIT ?`, [crop, upToYear, limit]),

  // Semester shares of annual production for one year
  semesterShare: (crop, year) => rows(
    `SELECT period, production_t FROM psa_quarterly WHERE crop = ? AND year = ? AND period IN ('S1','S2','Annual')`,
    [crop, year]),

  // Quarters PSA has not published yet
  unavailable: (crop) => rows(
    `SELECT year, period FROM psa_quarterly WHERE crop = ? AND production_t IS NULL ORDER BY year, period`, [crop]),

  // Forecasts of the displayed run. validation/test rows are the 1-quarter-ahead backtest ('backtest'),
  // future rows are the next four quarters. Only Palay is modelled, so crop is not a column.
  forecasts: () => rows(
    `SELECT f.forecast_id, CASE f.kind WHEN 'future' THEN 'future' ELSE 'backtest' END AS kind, f.kind AS split,
            f.target_year AS year, f.target_quarter AS q, f.horizon, f.predicted AS pred, f.low, f.high,
            f.actual_yield AS actual
       FROM forecasts f WHERE f.run_id = (SELECT run_id FROM displayed_run) AND (f.kind = 'future' OR f.horizon = 1)
      ORDER BY f.target_year, f.target_quarter, f.horizon`),

  forecastOne: (crop, year, q) => rows(
    `SELECT f.forecast_id, CASE f.kind WHEN 'future' THEN 'future' ELSE 'backtest' END AS kind, f.kind AS split,
            f.target_year AS year, f.target_quarter AS q, f.horizon, f.predicted AS pred, f.low, f.high,
            f.actual_yield AS actual, r.model_name, r.run_id
       FROM forecasts f JOIN model_runs r ON r.run_id = f.run_id
      WHERE f.run_id = (SELECT run_id FROM displayed_run) AND f.target_year = ? AND f.target_quarter = ?
        AND (f.kind = 'future' OR f.horizon = 1)`, [year, q])[0] || null,

  // Traceability: runs, forecasts of a run, and the full trace of one forecast
  runs: () => rows(
    `SELECT run_id, model_name, dsv_id, trained_at, is_deployed FROM model_runs ORDER BY run_id DESC`),
  runForecasts: (runId) => rows(
    `SELECT forecast_id, kind, target_year, target_quarter, horizon FROM forecasts WHERE run_id = ?
      ORDER BY kind, target_year, target_quarter, horizon`, [runId]),
  trace: (forecastId) => rows('SELECT * FROM forecast_trace WHERE forecast_id = ?', [forecastId])[0] || null,

  crops: () => rows("SELECT DISTINCT crop FROM psa_quarterly WHERE crop = 'Palay'").map((r) => r.crop),

  // For the CSV download in AgriTune: every forecast of every stored run
  forecastsCsvRows: () => rows(
    `SELECT f.forecast_id, f.run_id, r.model_name, r.dsv_id, f.kind, f.origin_year, f.origin_quarter, f.target_year,
            f.target_quarter, f.horizon, f.predicted, f.low, f.high, f.actual_yield
       FROM forecasts f JOIN model_runs r ON r.run_id = f.run_id ORDER BY f.run_id, f.kind, f.target_year, f.target_quarter, f.horizon`),
};
