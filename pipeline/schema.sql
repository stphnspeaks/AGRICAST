-- AgriCast database schema. build_site_data.py runs this on a brand-new file every time.

-- One row per (year, period, crop). period is Q1..Q4, S1, S2 or Annual.
-- production_t / area_ha are NULL when PSA shows ".." (not available), never 0.
CREATE TABLE psa_quarterly (
    year           INTEGER NOT NULL,
    period         TEXT    NOT NULL,
    crop           TEXT    NOT NULL,
    production_t   REAL,
    area_ha        REAL,
    yield_t_ha     REAL,
    is_preliminary INTEGER NOT NULL DEFAULT 0,
    source_file    TEXT,
    UNIQUE (year, period, crop)
);
CREATE INDEX idx_psa_crop_period ON psa_quarterly (crop, period, year);

-- kind = 'backtest' (past quarter, prediction next to actual) or 'future' (next 4 quarters).
CREATE TABLE forecasts (
    id              INTEGER PRIMARY KEY,
    crop            TEXT    NOT NULL,
    kind            TEXT    NOT NULL CHECK (kind IN ('backtest', 'future')),
    target_year     INTEGER NOT NULL,
    target_quarter  INTEGER NOT NULL CHECK (target_quarter BETWEEN 1 AND 4),
    horizon         INTEGER NOT NULL,
    predicted_yield REAL    NOT NULL,
    low             REAL    NOT NULL,
    high            REAL    NOT NULL,
    actual_yield    REAL,
    model_version   TEXT    NOT NULL,
    UNIQUE (crop, kind, target_year, target_quarter)
);
CREATE INDEX idx_forecasts_target ON forecasts (crop, target_year, target_quarter);

CREATE TABLE model_metrics (
    model       TEXT PRIMARY KEY,
    mae         REAL NOT NULL,
    rmse        REAL NOT NULL,
    mape        REAL NOT NULL,
    is_baseline INTEGER NOT NULL,
    is_selected INTEGER NOT NULL,
    trained_at  TEXT NOT NULL
);

CREATE TABLE data_files (
    name        TEXT PRIMARY KEY,
    rows_loaded INTEGER NOT NULL,
    loaded_at   TEXT NOT NULL
);

CREATE TABLE build_info (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
