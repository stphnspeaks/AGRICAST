# AgriCast

Rice (palay) yield forecasts and PSA analytics for **Pampanga province**. School project, course CPESOFT30/1L.

```
PSA CSVs --> pipeline/ (Python, on your laptop) --> site/data/agricast.db  (real SQLite file)
                                                --> site/data/model_report.json
site/ (static HTML/CSS/JS) --loads agricast.db in the browser with sql.js (SQLite as WebAssembly)--> SQL --> charts and cards
```

There is no server and no API. The Python pipeline is **never run on Vercel**. The website opens the SQLite file in the browser and queries it with SQL (all queries are in `site/js/db.js`).

## Folders

| Path | What it is |
|---|---|
| `data/` | The two PSA CSV files (production, area harvested) |
| `pipeline/` | `load_data.py` (read + clean), `train.py` (models + forecasts), `build_site_data.py` (writes the database), `build.py` (runs all), `schema.sql` |
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

It prints a load report, a training report and a database check, then rebuilds `site/data/agricast.db` from scratch (safe to run twice). Expected highlights: 158 of 160 quarterly values, 2025 annual production 418,908.75 t, 0 mismatches, 4 future rows.

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

1. Put the new PSA CSVs in `data/` (same two files, same format).
2. `python pipeline/build.py`
3. Commit the new `site/data/agricast.db` and `site/data/model_report.json`, then push (or run `vercel --prod`).

## How it works / assumptions

- **Scope:** Pampanga, Palay only. The Irrigated/Rainfed rows are loaded and reconciled but not used for features (Rainfed is 0 since 2019 Q3).
- **Yield** = production / area per period. Annual yield = annual production / annual area. `..` in the CSV is stored as NULL, never 0.
- **Checks in the load report:** Q1-Q4 add up to the PSA Annual column, and Q1+Q2 / Q3+Q4 to the semesters, for production and area.
- **Preliminary:** every value of the latest year in the files (2026) is flagged preliminary. 2026 Q3, Q4 and Annual are not published.
- **Model:** target = quarterly yield. Features: year, quarter, lag 1, lag 4, mean of the last 4 quarters. Candidates: seasonal naive (same quarter last year), Ridge, Random Forest. Validation is rolling-origin (expanding window, first window = 40 quarters, forecasting 1-4 quarters ahead recursively), never a random split.
- **Current result:** neither Ridge (MAE 0.244 t/ha) nor Random Forest (0.242) beats the seasonal-naive baseline (0.226), so **the baseline is the model in use**. This is reported in the app (AgriTask, AgriTune). Consequence: the forecast for a quarter equals last year's value for that quarter.
- **Range (low-high):** from the 10th and 90th percentile of backtest errors for that horizon. It is not a confidence percentage. "Typical error" is the backtest MAE for that horizon.
- **Backtest rows** are one-quarter-ahead predictions for 1997 Q1 onward (the first 40 quarters are training only), shown next to the actual value.
- **"Generate Forecast"** looks up a precomputed row in the `forecasts` table after a short animation. Nothing is calculated live.
- **Per-device settings:** theme, units, default crop, reduce-motion and recent forecasts live in `localStorage`.
- **Data:** Philippine Statistics Authority, OpenStat "Palay and Corn", CC BY 4.0.
- The saved joblib file in `pipeline/models/` is for reproducibility only; the website never loads it.
