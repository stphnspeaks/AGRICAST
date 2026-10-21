# AgriCast

Rice (palay) yield forecasts and PSA analytics for **Pampanga province**. School project, course CPESOFT30/1L.

```
PSA CSVs --> pipeline/ (Python, on your laptop) --> site/data/agricast.db  (real SQLite file, appended to)
                                                --> site/data/model_report.json
site/ (static HTML/CSS/JS) --loads agricast.db in the browser with sql.js (SQLite as WebAssembly)--> SQL --> charts and cards
```

There is no server and no API. The Python pipeline is **never run on Vercel**. The website opens the SQLite file in the browser and queries it with SQL (all queries are in `site/js/db.js`).

## Folders

| Path | What it is |
|---|---|
| `data/` | The two PSA CSV files (production, area harvested) |
| `pipeline/` | `verify.py` (checks before modelling), `load_data.py` (read + yield status), `train.py` (tuning, scoring, forecasts), `build_site_data.py` (appends to the database), `build.py` (runs all), `schema.sql`, `tests/` |
| `site/` | The website: `index.html`, `css/`, `js/` (hub, metrics, task, tune, db, charts, ui, main), `data/`, `vendor/` |
| `screenshots/` | Browser test screenshots (desktop 1440px, phone 390px) |
| `vercel.json` | Serves `site/` as a static site |

## 1. Install (once)

Python 3 with: `pip install -r pipeline/requirements.txt` (pandas, scikit-learn, joblib).
Node is **not** needed to run the project (Chart.js 4.5.1 and sql.js 1.12.0 are already copied into `site/vendor/`).

## 2. Run the pipeline

```
python pipeline/build.py
```

Order: **verify** both CSVs (stops the build on any failure and writes `pipeline/reports/validation_report.txt`) -> load -> tune on validation -> score test once -> **append** to `site/data/agricast.db`. Tests: `python -m unittest discover -s pipeline/tests -v` (leakage tests: changing every actual after the origin must not change the forecast).

## 2b. Reproducibility notes

- PSA OpenStat tables, licence CC BY 4.0. Production: table code `0012E4EVCP0`, https://openstat.psa.gov.ph/PXWeb/pxweb/en/DB/DB__2E__CS/0012E4EVCP0.px/ . Area harvested: table code `0022E4EAHC0`, https://openstat.psa.gov.ph/PXWeb/pxweb/en/DB/DB__2E__CS/0022E4EAHC0.px . Both last updated Jul. 29, 2026; 2026 Q2 is preliminary.
- Production CSV used: 1,428,988 bytes, 654 data rows, 280 period columns, SHA-256 starting `64c7fa55c5eb07fc`. The area CSV's size, rows and full SHA-256 are printed by the build, stored in `source_files`, and written to `site/data/model_report.json`.
- Python packages are listed in `pipeline/requirements.txt`. Random Forest uses `random_state=0`.

## 3. Run the site locally

```
cd site
python -m http.server 8000
```

Open http://localhost:8000. It must be served over HTTP; opening `index.html` as a file will not work.

## 4. Deploy to Vercel (free tier)

`vercel.json` already sets the output folder to `site` with no build step.

**Route A: GitHub.** Push this repo to GitHub (commit `site/data/agricast.db` and `site/vendor/`). On vercel.com choose *Add New > Project*, import the repo, leave Framework = Other, no build command. Deploy.

**Route B: CLI.** `npm i -g vercel`, then in the project root run `vercel` (preview) and `vercel --prod`.

## 5. Update the data later

1. Put the new PSA CSVs in `data/` (same two files, same format). Both are hashed (SHA-256).
2. `python pipeline/build.py`
3. A changed hash adds a new `source_files` row and a new `dataset_versions` row with a complete new set of `observations`; the diff (changed values, newly published quarters) is saved in `dataset_versions.validation_report`. Nothing older is overwritten or deleted. Every training adds new `model_runs`, `model_metrics` and `forecasts`; only one run per model has `is_deployed = 1`. The database is appended to, so **commit it, never delete it**.
4. Commit the new `site/data/agricast.db` and `site/data/model_report.json`, then push.

Trace any forecast to its inputs (also shown in AgriTune > Forecast traceability):

```sql
SELECT * FROM forecast_trace WHERE forecast_id = 1;   -- run, dataset version, SHA-256 of both PSA files
```

## How it works / assumptions

- **Scope:** Pampanga, Palay, Irrigated Palay and Rainfed Palay are stored; only Palay is modelled.
- **Verification (before modelling):** one `....Pampanga` row per croptype, identical period columns and order (positions of `..` listed), identical ecosystem labels, units taken from the PSA titles, Q1+Q2=S1, Q3+Q4=S2, S1+S2=Annual and Irrigated+Rainfed=Palay (tolerance 0.05), production and area both present or both missing. Implied yields outside 0.5 to 8 t/ha are flagged, not dropped.
- **Yield** = production / area only when production is present and area > 0, else NULL with `yield_status` = `ok`, `area_missing`, `production_missing`, `area_zero` or `inconsistent`. NULL is never replaced by 0, interpolated or forward filled; rows without a yield or with a missing lag are left out of training. Annual yield = annual production / annual area.
- **Features** for target T+h at origin T: target year, target quarter, lag 1, lag 4, mean of the four quarters before the target (all built with a shift). For h > 1 unknown lags are the model's own predictions (recursive). The scaler is fitted on the current training window only.
- **Periods:** initial training 1987 Q1 to 2011 Q4 (expanding with each origin), validation 2012 Q1 to 2018 Q4 (28 targets), test 2019 Q1 to 2026 Q1 (29 targets). 2026 Q2 is preliminary: history only, never scored.
- **Protocol:** rolling-origin, expanding window. For each target quarter and h = 1..4 the model is refitted on data up to origin = target - h. Tuning uses validation only (Ridge alpha in {0.01, 0.1, 1, 10, 100}; Random Forest n_estimators {200, 500}, max_depth {3, 5, None}, min_samples_leaf {1, 3, 5}); criterion = mean validation MAE over the four horizons, ties go to the simpler model. The test period is scored once with the fixed settings. If the chosen model does not beat the seasonal-naive baseline on test, the baseline is used for displayed forecasts. Deployment refits on all data up to 2026 Q2.
- **80% forecast range from past errors:** the 10th and 90th percentile of the 28 validation errors (actual - predicted) per model and horizon are added to the point forecast. Test coverage and mean width are reported per horizon. Deployed (future) forecasts use the percentiles of validation + test errors. If a percentile would put the range on the wrong side of the point forecast (violating low <= predicted <= high), that side is clipped to the point forecast and the build report says so. It is not a confidence percentage; "typical error" is the horizon's test MAE.
- **Results** are in the build output and in `site/data/model_report.json`; this README does not repeat numbers.
- **"Generate Forecast"** looks up a precomputed row in the `forecasts` table after a short animation. Nothing is calculated live.
- **Per-device settings:** theme, units, default crop, reduce-motion and recent forecasts live in `localStorage`.
- **Data:** Philippine Statistics Authority, OpenStat "Palay and Corn", CC BY 4.0.
- The saved joblib file in `pipeline/models/` is for reproducibility only; the website never loads it. `pipeline/archive/` holds the database of the first, unversioned design.
