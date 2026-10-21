"""Step 2: compare models with time-based validation and make all forecasts.

Target: quarterly yield (t/ha), Pampanga Palay.
Features: year, quarter (one-hot), lag 1, lag 4, mean of the last 4 quarters.
Candidates: seasonal naive (baseline), Ridge, Random Forest.
"""
from datetime import date
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

MODELS_DIR = Path(__file__).resolve().parent / "models"
MIN_TRAIN = 40        # first rolling origin trains on 40 quarters (10 years)
HORIZONS = 4
BASELINE = "Seasonal naive"


def make_model(name):
    if name == "Ridge":
        return make_pipeline(StandardScaler(), Ridge(alpha=3.0))
    if name == "Random Forest":
        return RandomForestRegressor(n_estimators=200, min_samples_leaf=2, random_state=0, n_jobs=1)
    raise ValueError(name)


def features(history, year, quarter):
    """Feature row for one target quarter, given all earlier yields (a list)."""
    row = [year] + [1.0 if quarter == q else 0.0 for q in (1, 2, 3, 4)]
    row += [history[-1], history[-4], float(np.mean(history[-4:]))]
    return row


def next_quarter(year, quarter):
    return (year + 1, 1) if quarter == 4 else (year, quarter + 1)


def training_table(series):
    """series: list of (year, quarter, yield). Rows start at the 5th quarter (lags need history)."""
    X, y = [], []
    for i in range(4, len(series)):
        hist = [s[2] for s in series[:i]]
        X.append(features(hist, series[i][0], series[i][1]))
        y.append(series[i][2])
    return np.array(X), np.array(y)


def forecast_ahead(name, model, series, steps):
    """Predict `steps` quarters after the end of series. Recursive: predictions feed the next lag."""
    hist = [s[2] for s in series]
    year, quarter = series[-1][0], series[-1][1]
    out = []
    for _ in range(steps):
        year, quarter = next_quarter(year, quarter)
        if name == BASELINE:
            pred = hist[-4]                      # same quarter last year
        else:
            pred = float(model.predict(np.array([features(hist, year, quarter)]))[0])
        hist.append(pred)
        out.append((year, quarter, pred))
    return out


def backtest(series, names):
    """Rolling origin: train on the past only, forecast the next 4 quarters, move forward 1 quarter.
    Returns {model: [(origin_index, horizon, year, quarter, predicted, actual), ...]}"""
    results = {n: [] for n in names}
    for origin in range(MIN_TRAIN, len(series)):
        train = series[:origin]
        X, y = training_table(train)
        for name in names:
            model = None if name == BASELINE else make_model(name).fit(X, y)
            preds = forecast_ahead(name, model, train, HORIZONS)
            for h, (yr, q, p) in enumerate(preds, start=1):
                idx = origin + h - 1
                if idx < len(series):            # skip steps beyond the last known quarter
                    results[name].append((origin, h, yr, q, p, series[idx][2]))
    return results


def scores(rows):
    err = np.array([r[4] - r[5] for r in rows])
    act = np.array([r[5] for r in rows])
    return {"mae": float(np.mean(np.abs(err))),
            "rmse": float(np.sqrt(np.mean(err ** 2))),
            "mape": float(np.mean(np.abs(err) / act) * 100)}


def run(df):
    """df comes from load_data. Returns everything build_site_data needs."""
    palay = df[(df["crop"] == "Palay") & df["period"].isin(["Q1", "Q2", "Q3", "Q4"])]
    palay = palay.dropna(subset=["yield_t_ha"]).sort_values(["year", "period"])
    series = [(int(r.year), int(r.period[1]), float(r.yield_t_ha)) for r in palay.itertuples()]
    last_year, last_q = series[-1][0], series[-1][1]

    names = [BASELINE, "Ridge", "Random Forest"]
    results = backtest(series, names)
    metrics = {n: scores(results[n]) for n in names}

    # Pick the best learned model by MAE; use the baseline unless it is beaten.
    best = min(["Ridge", "Random Forest"], key=lambda n: metrics[n]["mae"])
    beats = metrics[best]["mae"] < metrics[BASELINE]["mae"]
    chosen = best if beats else BASELINE
    version = f"{chosen.lower().replace(' ', '-')}-{date.today().isoformat()}"

    # Error quantiles per horizon (actual - predicted) give the low-high range.
    by_h = {}
    for h in range(1, HORIZONS + 1):
        errs = np.array([r[5] - r[4] for r in results[chosen] if r[1] == h])
        by_h[h] = {"q10": float(np.quantile(errs, 0.10)), "q90": float(np.quantile(errs, 0.90)),
                   "mae": float(np.mean(np.abs(errs))), "n": int(len(errs))}

    forecasts = []
    # Backtest rows: one-step-ahead (horizon 1) prediction next to the actual value.
    for origin, h, yr, q, pred, actual in results[chosen]:
        if h == 1:
            forecasts.append(dict(kind="backtest", year=yr, quarter=q, horizon=1, pred=pred,
                                  low=pred + by_h[1]["q10"], high=pred + by_h[1]["q90"], actual=actual))

    # Final model trained on everything, then the next 4 quarters.
    X, y = training_table(series)
    final = None if chosen == BASELINE else make_model(chosen).fit(X, y)
    for h, (yr, q, pred) in enumerate(forecast_ahead(chosen, final, series, HORIZONS), start=1):
        forecasts.append(dict(kind="future", year=yr, quarter=q, horizon=h, pred=pred,
                              low=pred + by_h[h]["q10"], high=pred + by_h[h]["q90"], actual=None))

    MODELS_DIR.mkdir(exist_ok=True)
    joblib.dump({"name": chosen, "model": final, "version": version}, MODELS_DIR / "model.joblib")

    lines = ["== TRAINING REPORT (rolling-origin validation, horizons 1-4, recursive) =="]
    lines.append(f"Series: {len(series)} quarters, {series[0][0]} Q{series[0][1]} to {last_year} Q{last_q}; "
                 f"first training window = {MIN_TRAIN} quarters")
    for n in names:
        m = metrics[n]
        lines.append(f"  {n:15s} MAE {m['mae']:.3f}  RMSE {m['rmse']:.3f}  MAPE {m['mape']:.1f}%")
    if beats:
        gain = (1 - metrics[best]["mae"] / metrics[BASELINE]["mae"]) * 100
        lines.append(f"Chosen: {chosen} - beats the seasonal-naive baseline by {gain:.1f}% in MAE.")
    else:
        lines.append(f"Chosen: {BASELINE} - NO learned model beat the baseline, so the baseline is used.")
    lines.append("Typical error (MAE) by horizon: " +
                 ", ".join(f"h{h} {by_h[h]['mae']:.2f}" for h in by_h))

    return dict(series=series, metrics=metrics, chosen=chosen, beats=beats, version=version,
                by_horizon=by_h, forecasts=forecasts, report=lines,
                latest=(last_year, last_q))
