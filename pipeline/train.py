"""Step 2: tune on validation, score the test period once, build forecasts and ranges.

Target: quarterly yield (t/ha), Pampanga Palay. Quarter index t = year * 4 + (quarter - 1).
Features for target quarter T+h at origin T: target year, target quarter (one-hot), lag 1, lag 4,
mean of the four quarters before the target. For h > 1 unknown lags are the model's own predictions
(recursive). Every lag/rolling feature is built with a shift, so it only sees earlier quarters.
The scaler lives inside the Ridge pipeline and is fitted on the current training window only.

Periods: initial training window 1987 Q1-2011 Q4 (expanding with each origin), validation
2012 Q1-2018 Q4 (28 targets), test 2019 Q1-2026 Q1 (29 targets). 2026 Q2 is preliminary:
it is history for features and the final refit, never a scored target.
"""
import itertools
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

MODELS_DIR = Path(__file__).resolve().parent / "models"
HORIZONS = (1, 2, 3, 4)
BASELINE = "Seasonal naive"
RIDGE, FOREST = "Ridge", "Random Forest"
RANDOM_STATE = 0

RIDGE_GRID = [{"alpha": a} for a in (0.01, 0.1, 1, 10, 100)]
FOREST_GRID = [{"n_estimators": n, "max_depth": d, "min_samples_leaf": leaf}
               for n, d, leaf in itertools.product((200, 500), (3, 5, None), (1, 3, 5))]


def tq(year, quarter):
    return year * 4 + quarter - 1


def label(t):
    return f"{t // 4} Q{t % 4 + 1}"


SPLITS = {"validation": (tq(2012, 1), tq(2018, 4)), "test": (tq(2019, 1), tq(2026, 1))}
TRAIN_START, TRAIN_END = tq(1987, 1), tq(2011, 4)


def build_series(df):
    """Quarterly Palay yield indexed by t on a COMPLETE calendar; NaN where the yield is undefined."""
    q = df[(df["crop"] == "Palay") & df["period"].isin(["Q1", "Q2", "Q3", "Q4"])
           & (df["yield_status"] == "ok")]
    t = (q["year"] * 4 + q["period"].str[1].astype(int) - 1).astype(int)
    s = pd.Series(q["yield_t_ha"].values, index=t.values).sort_index()
    return s.reindex(range(int(s.index.min()), int(s.index.max()) + 1))


# ---------------------------------------------------------------------------------------------
# features and models
# ---------------------------------------------------------------------------------------------
FEATURE_NAMES = ["year", "q1", "q2", "q3", "q4", "lag1", "lag4", "mean4"]


def feature_frame(y):
    """One row per quarter in y's index. lag/rolling columns use shift, so row t sees only t-1 and earlier."""
    t = y.index.to_numpy()
    f = pd.DataFrame({"year": t // 4}, index=y.index)
    for q in range(4):
        f[f"q{q + 1}"] = (t % 4 == q).astype(float)
    f["lag1"] = y.shift(1)
    f["lag4"] = y.shift(4)
    f["mean4"] = y.shift(1).rolling(4, min_periods=4).mean()
    return f[FEATURE_NAMES]


def make_model(name, params):
    if name == RIDGE:
        return make_pipeline(StandardScaler(), Ridge(alpha=params["alpha"]))
    if name == FOREST:
        return RandomForestRegressor(random_state=RANDOM_STATE, n_jobs=1, **params)
    raise ValueError(name)


def fit_at_origin(series, origin, name, params):
    """Fit on quarters <= origin only. Rows with an undefined target or any missing feature are
    excluded (never filled). Returns the fitted model and the number of training rows."""
    hist = series.loc[:origin]
    f = feature_frame(hist)
    ok = f.notna().all(axis=1) & hist.notna()
    model = make_model(name, params).fit(f[ok].to_numpy(), hist[ok].to_numpy())
    return model, int(ok.sum())


def forecast_at_origin(series, origin, name, params, model=None):
    """Forecast origin+1 .. origin+4. The ONLY data used is series.loc[:origin]; anything after the
    origin is ignored by construction. Returns {h: prediction or None}."""
    hist = series.loc[:origin].copy()
    out = {}
    if name == BASELINE:
        for h in HORIZONS:
            v = hist.get(origin + h - 4, np.nan)           # same quarter last year (always <= origin)
            out[h] = None if pd.isna(v) else float(v)
        return out
    if model is None:
        model, _ = fit_at_origin(series, origin, name, params)
    for h in HORIZONS:
        target = origin + h
        hist.loc[target] = np.nan                           # placeholder, features only look backwards
        row = feature_frame(hist).loc[[target]]
        if row.isna().any(axis=None):
            out[h] = None
            continue                                        # a missing lag is not filled
        pred = float(model.predict(row.to_numpy())[0])
        out[h] = pred
        hist.loc[target] = pred                             # recursive: prediction becomes the next lag
    return out


# ---------------------------------------------------------------------------------------------
# rolling-origin evaluation
# ---------------------------------------------------------------------------------------------
def rolling_origin(series, name, params, lo, hi):
    """For every target t in [lo, hi] and h in 1..4: refit on data up to origin = t - h, predict t.
    Returns a list of dicts (target, horizon, origin, predicted, actual)."""
    by_origin = {}
    for t in range(lo, hi + 1):
        if pd.isna(series.get(t, np.nan)):
            continue                                        # no defined actual -> not scored
        for h in HORIZONS:
            by_origin.setdefault(t - h, []).append((t, h))
    rows = []
    for origin in sorted(by_origin):
        preds = forecast_at_origin(series, origin, name, params)
        for t, h in by_origin[origin]:
            if preds[h] is not None:
                rows.append(dict(target=t, horizon=h, origin=origin, predicted=preds[h],
                                 actual=float(series[t])))
    return rows


def scores(rows):
    e = np.array([r["predicted"] - r["actual"] for r in rows])
    a = np.array([r["actual"] for r in rows])
    return {"n": len(rows), "mae": float(np.mean(np.abs(e))), "rmse": float(np.sqrt(np.mean(e ** 2))),
            "mape": float(np.mean(np.abs(e) / a) * 100)}


def by_horizon(rows):
    return {h: scores([r for r in rows if r["horizon"] == h]) for h in HORIZONS}


def interval_offsets(errors):
    """80% range from past errors (actual - predicted): 10th and 90th percentile.
    The stored range must satisfy low <= predicted <= high, so offsets are clipped at 0 and the clip is reported."""
    q10, q90 = (float(x) for x in np.quantile(errors, [0.10, 0.90]))
    return {"q10": q10, "q90": q90, "lo": min(q10, 0.0), "hi": max(q90, 0.0),
            "clipped": q10 > 0 or q90 < 0, "n": len(errors)}


def complexity(name, params):
    """Smaller = simpler; used only to break exact ties."""
    if name == RIDGE:
        return (-params["alpha"],)                            # stronger shrinkage = simpler
    if name == FOREST:
        return (params["n_estimators"], params["max_depth"] or 10 ** 6, -params["min_samples_leaf"])
    return (0,)


def tune(series, name, grid, log):
    """Pick params by mean validation MAE over the four horizons. Validation only; test is not touched."""
    lo, hi = SPLITS["validation"]
    results = []
    for params in grid:
        rows = rolling_origin(series, name, params, lo, hi)
        bh = by_horizon(rows)
        crit = float(np.mean([bh[h]["mae"] for h in HORIZONS]))
        results.append((params, crit, rows))
        log.append(f"    {name} {params}  validation mean MAE {crit:.4f}")
    best = min(results, key=lambda r: (round(r[1], 12), complexity(name, r[0])))
    return best[0], best[1], best[2], results


def run(df):
    """df comes from load_data. Returns everything build_site_data needs."""
    series = build_series(df)
    first_t, last_t = int(series.index.min()), int(series.index.max())
    assert series.index.min() == TRAIN_START and last_t == tq(2026, 2), (label(first_t), label(last_t))
    log = ["== TRAINING REPORT =="]
    n_val = sum(1 for t in range(*[SPLITS["validation"][0], SPLITS["validation"][1] + 1]) if pd.notna(series.get(t)))
    n_test = sum(1 for t in range(*[SPLITS["test"][0], SPLITS["test"][1] + 1]) if pd.notna(series.get(t)))
    log.append(f"Series {label(first_t)} to {label(last_t)}: {int(series.notna().sum())} quarters with a defined yield "
               f"of {len(series)} on the calendar")
    log.append(f"Train {label(TRAIN_START)}-{label(TRAIN_END)} (initial, expanding) | validation "
               f"{label(SPLITS['validation'][0])}-{label(SPLITS['validation'][1])} ({n_val} targets) | test "
               f"{label(SPLITS['test'][0])}-{label(SPLITS['test'][1])} ({n_test} targets) | "
               f"{label(last_t)} preliminary: history only")
    assert (n_val, n_test) == (28, 29), (n_val, n_test)

    # ---- tuning (validation only) ----
    specs = {BASELINE: {}}
    val_rows = {BASELINE: rolling_origin(series, BASELINE, {}, *SPLITS["validation"])}
    val_crit = {BASELINE: float(np.mean([by_horizon(val_rows[BASELINE])[h]["mae"] for h in HORIZONS]))}
    tuning = {}
    for name, grid in ((RIDGE, RIDGE_GRID), (FOREST, FOREST_GRID)):
        log.append(f"  Tuning {name} on validation ({len(grid)} settings):")
        params, crit, rows, results = tune(series, name, grid, log)
        specs[name], val_rows[name], val_crit[name] = params, rows, crit
        tuning[name] = [(p, c) for p, c, _ in results]
        log.append(f"  -> {name}: {params}, validation mean MAE {crit:.4f}")
    log.append(f"  Seasonal naive validation mean MAE {val_crit[BASELINE]:.4f}")

    # ---- ranges from validation errors, then ONE test scoring with fixed settings ----
    offsets, test_rows = {}, {}
    for name in specs:
        offsets[name] = {h: interval_offsets([r["actual"] - r["predicted"] for r in val_rows[name] if r["horizon"] == h])
                         for h in HORIZONS}
        test_rows[name] = rolling_origin(series, name, specs[name], *SPLITS["test"])

    def band(name, h, pred, off=None):
        o = (off or offsets[name])[h]
        return pred + o["lo"], pred + o["hi"]

    metrics = {}
    for name in specs:
        v_bh, t_bh = by_horizon(val_rows[name]), by_horizon(test_rows[name])
        m = {"validation": {}, "test": {}}
        for h in HORIZONS:
            lo_hi = [band(name, h, r["predicted"]) for r in test_rows[name] if r["horizon"] == h]
            acts = [r["actual"] for r in test_rows[name] if r["horizon"] == h]
            cov = float(np.mean([l <= a <= u for (l, u), a in zip(lo_hi, acts)]))
            width = float(np.mean([u - l for l, u in lo_hi]))
            m["test"][h] = dict(t_bh[h], coverage=cov, mean_width=width)
            # validation coverage would be in-sample by construction, so it is not reported
            m["validation"][h] = dict(v_bh[h], coverage=None, mean_width=offsets[name][h]["hi"] - offsets[name][h]["lo"])
        m["val_crit"] = val_crit[name]
        m["test_crit"] = float(np.mean([t_bh[h]["mae"] for h in HORIZONS]))
        metrics[name] = m

    # ---- choice ----
    cands = [RIDGE, FOREST]
    chosen = min(cands, key=lambda n: (round(val_crit[n], 12), cands.index(n)))   # exact tie -> Ridge (simpler)
    beats = metrics[chosen]["test_crit"] < metrics[BASELINE]["test_crit"]
    displayed = chosen if beats else BASELINE

    # ---- forecasts per model run ----
    pooled = {}
    for name in specs:
        pooled[name] = {h: interval_offsets([r["actual"] - r["predicted"]
                                             for r in val_rows[name] + test_rows[name] if r["horizon"] == h])
                        for h in HORIZONS}
    runs, finals = {}, {}
    for name in specs:
        fc = []
        for kind, rows in (("validation", val_rows[name]), ("test", test_rows[name])):
            for r in sorted(rows, key=lambda r: (r["target"], r["horizon"])):
                lo_, hi_ = band(name, r["horizon"], r["predicted"])
                fc.append(dict(kind=kind, origin=r["origin"], target=r["target"], horizon=r["horizon"],
                               predicted=r["predicted"], low=lo_, high=hi_, actual=r["actual"]))
        # deployment: refit on ALL data up to 2026 Q2, ranges from validation + test errors
        final = None if name == BASELINE else fit_at_origin(series, last_t, name, specs[name])[0]
        finals[name] = final
        preds = forecast_at_origin(series, last_t, name, specs[name], model=final)
        for h in HORIZONS:
            lo_, hi_ = band(name, h, preds[h], pooled[name])
            fc.append(dict(kind="future", origin=last_t, target=last_t + h, horizon=h,
                           predicted=preds[h], low=lo_, high=hi_, actual=None))
        runs[name] = dict(model_name=name, params=specs[name], metrics=metrics[name], forecasts=fc,
                          offsets_validation=offsets[name], offsets_pooled=pooled[name])

    MODELS_DIR.mkdir(exist_ok=True)
    joblib.dump({"specs": specs, "models": finals, "trained_through": label(last_t)}, MODELS_DIR / "model.joblib")

    # ---- report ----
    log += ["", "== TEST RESULTS (2019 Q1 - 2026 Q1, 29 targets per horizon) =="]
    base = metrics[BASELINE]["test"]
    log.append(f"{'model':16s} {'h':>2s} {'MAE':>7s} {'RMSE':>7s} {'MAPE %':>7s} {'skill':>7s}")
    for name in specs:
        for h in HORIZONS:
            t = metrics[name]["test"][h]
            skill = "" if name == BASELINE else f"{1 - t['mae'] / base[h]['mae']:+.3f}"
            log.append(f"{name:16s} {h:2d} {t['mae']:7.4f} {t['rmse']:7.4f} {t['mape']:7.2f} {skill:>7s}")
        log.append(f"{name:16s} mean MAE over h1-4: validation {val_crit[name]:.4f}, test {metrics[name]['test_crit']:.4f}")
    log += ["", "== 80% FORECAST RANGE (10th-90th percentile of the 28 validation errors) on TEST =="]
    log.append(f"{'model':16s} {'h':>2s} {'coverage':>9s} {'mean width':>11s} {'q10':>8s} {'q90':>8s}")
    for name in specs:
        for h in HORIZONS:
            t, o = metrics[name]["test"][h], offsets[name][h]
            log.append(f"{name:16s} {h:2d} {t['coverage'] * 100:8.1f}% {t['mean_width']:11.4f} {o['q10']:+8.4f} {o['q90']:+8.4f}"
                       + ("  (offset clipped to keep low<=pred<=high)" if o["clipped"] else ""))
    log += ["", f"Chosen on validation: {chosen} {specs[chosen]} (validation mean MAE {val_crit[chosen]:.4f}; "
                f"seasonal naive {val_crit[BASELINE]:.4f})"]
    if beats:
        log.append(f"Test: {chosen} beats the seasonal-naive baseline (mean MAE {metrics[chosen]['test_crit']:.4f} vs "
                   f"{metrics[BASELINE]['test_crit']:.4f}); displayed forecasts use {chosen}.")
    else:
        log.append(f"Test: {chosen} does NOT beat the seasonal-naive baseline (mean MAE {metrics[chosen]['test_crit']:.4f} vs "
                   f"{metrics[BASELINE]['test_crit']:.4f}); displayed forecasts use the baseline.")
    for name in specs:
        fut = [r for r in runs[name]["forecasts"] if r["kind"] == "future"]
        log.append(f"Deployed {name} forecasts: " + ", ".join(
            f"{label(r['target'])} {r['predicted']:.3f} [{r['low']:.3f}, {r['high']:.3f}]" for r in fut))

    return dict(series=series, runs=runs, specs=specs, chosen=chosen, displayed=displayed, beats=beats,
                tuning=tuning, report=log, latest=(last_t // 4, last_t % 4 + 1), last_t=last_t)
