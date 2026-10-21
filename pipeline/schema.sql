-- AgriCast database schema (SQLite). Run with PRAGMA foreign_keys = ON.
-- Every statement is IF NOT EXISTS: the database is APPENDED to, never rebuilt. Older dataset
-- versions, model runs and forecasts are never overwritten or deleted.

-- One row per downloaded PSA CSV, identified by its SHA-256.
CREATE TABLE IF NOT EXISTS source_files (
    file_id          INTEGER PRIMARY KEY,
    table_code       TEXT NOT NULL,
    title            TEXT NOT NULL,
    url              TEXT NOT NULL,
    psa_last_updated TEXT NOT NULL,
    retrieved_at     TEXT NOT NULL,
    file_name        TEXT NOT NULL,
    sha256           TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64)
);

-- One row per (production file, area file) pair. observations are a complete set per version.
CREATE TABLE IF NOT EXISTS dataset_versions (
    dsv_id             INTEGER PRIMARY KEY,
    production_file_id INTEGER NOT NULL REFERENCES source_files (file_id),
    area_file_id       INTEGER NOT NULL REFERENCES source_files (file_id),
    built_at           TEXT NOT NULL,
    checks_passed      INTEGER NOT NULL CHECK (checks_passed IN (0, 1)),
    validation_report  TEXT NOT NULL,          -- verification report + diff against the previous version
    UNIQUE (production_file_id, area_file_id)
);

-- period is Q1..Q4, S1, S2 or Annual. production_t / area_ha are NULL when PSA shows ".." (never 0).
-- yield_t_ha is NOT NULL exactly when yield_status = 'ok'.
CREATE TABLE IF NOT EXISTS observations (
    dsv_id         INTEGER NOT NULL REFERENCES dataset_versions (dsv_id),
    year           INTEGER NOT NULL CHECK (year BETWEEN 1987 AND 2100),
    period         TEXT    NOT NULL CHECK (period IN ('Q1', 'Q2', 'Q3', 'Q4', 'S1', 'S2', 'Annual')),
    crop           TEXT    NOT NULL CHECK (crop IN ('Palay', 'Irrigated Palay', 'Rainfed Palay')),
    production_t   REAL CHECK (production_t >= 0),
    area_ha        REAL CHECK (area_ha >= 0),
    yield_t_ha     REAL,
    yield_status   TEXT NOT NULL CHECK (yield_status IN
                       ('ok', 'area_missing', 'production_missing', 'area_zero', 'inconsistent')),
    is_preliminary INTEGER NOT NULL DEFAULT 0 CHECK (is_preliminary IN (0, 1)),
    PRIMARY KEY (dsv_id, year, period, crop),
    CHECK ((yield_status = 'ok') = (yield_t_ha IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_obs_crop_period ON observations (dsv_id, crop, period, year);

CREATE TABLE IF NOT EXISTS model_runs (
    run_id       INTEGER PRIMARY KEY,
    dsv_id       INTEGER NOT NULL REFERENCES dataset_versions (dsv_id),
    model_name   TEXT NOT NULL CHECK (model_name IN ('Seasonal naive', 'Ridge', 'Random Forest')),
    params       TEXT NOT NULL,                -- JSON
    train_start  TEXT NOT NULL,
    train_end    TEXT NOT NULL,                -- end of the INITIAL window; it expands with each origin
    valid_start  TEXT NOT NULL,
    valid_end    TEXT NOT NULL,
    test_start   TEXT NOT NULL,
    test_end     TEXT NOT NULL,
    code_version TEXT NOT NULL,
    trained_at   TEXT NOT NULL,
    is_deployed  INTEGER NOT NULL DEFAULT 0 CHECK (is_deployed IN (0, 1))
);
-- at most one deployed run per model
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_deployed_per_model ON model_runs (model_name) WHERE is_deployed = 1;

CREATE TABLE IF NOT EXISTS model_metrics (
    run_id     INTEGER NOT NULL REFERENCES model_runs (run_id),
    split      TEXT    NOT NULL CHECK (split IN ('validation', 'test')),
    horizon    INTEGER NOT NULL CHECK (horizon BETWEEN 1 AND 4),
    mae        REAL NOT NULL CHECK (mae >= 0),
    rmse       REAL NOT NULL CHECK (rmse >= 0),
    mape       REAL NOT NULL CHECK (mape >= 0),
    coverage   REAL CHECK (coverage BETWEEN 0 AND 1),   -- test only; validation is in-sample, so NULL
    mean_width REAL CHECK (mean_width >= 0),
    PRIMARY KEY (run_id, split, horizon)
);

-- kind: 'validation' and 'test' are rolling-origin backtests with the actual next to them;
-- 'future' is the deployed refit (all data up to 2026 Q2) for the next four quarters.
CREATE TABLE IF NOT EXISTS forecasts (
    forecast_id    INTEGER PRIMARY KEY,
    run_id         INTEGER NOT NULL REFERENCES model_runs (run_id),
    kind           TEXT    NOT NULL CHECK (kind IN ('validation', 'test', 'future')),
    origin_year    INTEGER NOT NULL CHECK (origin_year BETWEEN 1987 AND 2100),
    origin_quarter INTEGER NOT NULL CHECK (origin_quarter BETWEEN 1 AND 4),
    target_year    INTEGER NOT NULL CHECK (target_year BETWEEN 1987 AND 2100),
    target_quarter INTEGER NOT NULL CHECK (target_quarter BETWEEN 1 AND 4),
    horizon        INTEGER NOT NULL CHECK (horizon BETWEEN 1 AND 4),
    predicted      REAL NOT NULL,
    low            REAL NOT NULL,
    high           REAL NOT NULL,
    actual_yield   REAL,
    UNIQUE (run_id, kind, target_year, target_quarter, horizon),
    CHECK (low <= predicted AND predicted <= high)
);
CREATE INDEX IF NOT EXISTS idx_forecasts_target ON forecasts (run_id, target_year, target_quarter);

-- Small key/value table the site reads (latest quarter, displayed run, ...). Rewritten each build.
CREATE TABLE IF NOT EXISTS build_info (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ---- views used by the site and for traceability --------------------------------------------
DROP VIEW IF EXISTS displayed_run;
CREATE VIEW displayed_run AS
    SELECT * FROM model_runs WHERE run_id = (SELECT CAST(value AS INTEGER) FROM build_info WHERE key = 'displayed_run_id');

DROP VIEW IF EXISTS psa_quarterly;
CREATE VIEW psa_quarterly AS
    SELECT o.year, o.period, o.crop, o.production_t, o.area_ha, o.yield_t_ha, o.yield_status, o.is_preliminary
      FROM observations o JOIN displayed_run d ON d.dsv_id = o.dsv_id;

-- For any forecast: its run, dataset version and the SHA-256 of both PSA files.
--   SELECT * FROM forecast_trace WHERE forecast_id = ?;
DROP VIEW IF EXISTS forecast_trace;
CREATE VIEW forecast_trace AS
    SELECT f.forecast_id, f.kind, f.target_year, f.target_quarter, f.horizon, f.predicted, f.low, f.high,
           r.run_id, r.model_name, r.params, r.code_version, r.trained_at, r.is_deployed,
           v.dsv_id, v.built_at AS dataset_built_at,
           pf.file_name AS production_file, pf.sha256 AS production_sha256, pf.psa_last_updated AS production_updated,
           af.file_name AS area_file, af.sha256 AS area_sha256, af.psa_last_updated AS area_updated
      FROM forecasts f
      JOIN model_runs r ON r.run_id = f.run_id
      JOIN dataset_versions v ON v.dsv_id = r.dsv_id
      JOIN source_files pf ON pf.file_id = v.production_file_id
      JOIN source_files af ON af.file_id = v.area_file_id;
