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

  dataFiles: () => rows('SELECT name, rows_loaded, loaded_at FROM data_files ORDER BY name DESC'),

  metrics: () => rows('SELECT model, mae, rmse, mape, is_baseline, is_selected FROM model_metrics ORDER BY is_baseline DESC, mae'),

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

  forecasts: (crop) => rows(
    `SELECT kind, target_year AS year, target_quarter AS q, horizon, predicted_yield AS pred, low, high,
            actual_yield AS actual FROM forecasts WHERE crop = ? ORDER BY target_year, target_quarter`, [crop]),

  forecastOne: (crop, year, q) => rows(
    `SELECT kind, target_year AS year, target_quarter AS q, horizon, predicted_yield AS pred, low, high,
            actual_yield AS actual, model_version FROM forecasts
      WHERE crop = ? AND target_year = ? AND target_quarter = ?`, [crop, year, q])[0] || null,

  crops: () => rows("SELECT DISTINCT crop FROM psa_quarterly WHERE crop = 'Palay'").map((r) => r.crop),

  // For the CSV download in AgriTune
  forecastsCsvRows: () => rows(
    `SELECT crop, kind, target_year, target_quarter, horizon, predicted_yield, low, high, actual_yield, model_version
       FROM forecasts ORDER BY target_year, target_quarter`),
};
