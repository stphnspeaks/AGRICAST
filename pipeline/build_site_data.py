"""Step 3: write the SQLite database and model_report.json used by the website."""
import json
import sqlite3
from datetime import datetime
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "site" / "data"
DB_PATH = OUT_DIR / "agricast.db"


def write_database(df, files_info, result):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DB_PATH.unlink(missing_ok=True)            # rebuild from scratch, so running twice is safe
    now = datetime.now().isoformat(timespec="seconds")

    con = sqlite3.connect(DB_PATH)
    con.executescript((Path(__file__).parent / "schema.sql").read_text(encoding="utf-8"))

    # psa_quarterly (NaN -> NULL)
    out = df.copy()
    out["source_file"] = "PSA OpenStat Palay and Corn"
    out = out.astype(object).where(out.notna(), None)
    con.executemany(
        "INSERT INTO psa_quarterly (year, period, crop, production_t, area_ha, yield_t_ha,"
        " is_preliminary, source_file) VALUES (?,?,?,?,?,?,?,?)",
        out[["year", "period", "crop", "production_t", "area_ha", "yield_t_ha",
             "is_preliminary", "source_file"]].values.tolist())

    # forecasts
    version = result["version"]
    con.executemany(
        "INSERT INTO forecasts (crop, kind, target_year, target_quarter, horizon, predicted_yield,"
        " low, high, actual_yield, model_version) VALUES ('Palay',?,?,?,?,?,?,?,?,?)",
        [(f["kind"], f["year"], f["quarter"], f["horizon"], f["pred"], f["low"], f["high"],
          f["actual"], version) for f in result["forecasts"]])

    # model_metrics
    from train import BASELINE
    con.executemany(
        "INSERT INTO model_metrics VALUES (?,?,?,?,?,?,?)",
        [(n, m["mae"], m["rmse"], m["mape"], int(n == BASELINE), int(n == result["chosen"]), now)
         for n, m in result["metrics"].items()])

    # data_files
    con.executemany("INSERT INTO data_files VALUES (?,?,?)",
                    [(label, rows, now) for label, (_, rows) in files_info.items()])

    # build_info
    ly, lq = result["latest"]
    info = {"latest_year": ly, "latest_quarter": lq, "built_at": now,
            "model_name": result["chosen"], "model_version": version,
            "beats_baseline": int(result["beats"]),
            "psa_rows": len(df), "forecast_rows": len(result["forecasts"])}
    for h, v in result["by_horizon"].items():
        info[f"typical_error_h{h}"] = round(v["mae"], 4)
    con.executemany("INSERT INTO build_info VALUES (?,?)", [(k, str(v)) for k, v in info.items()])
    con.commit()
    con.execute("VACUUM")
    con.close()


def write_report(result):
    report = {
        "chosen_model": result["chosen"],
        "beats_baseline": result["beats"],
        "model_version": result["version"],
        "metrics": result["metrics"],
        "by_horizon": {str(h): v for h, v in result["by_horizon"].items()},
        "validation": "rolling-origin, expanding window, horizons 1-4 (recursive), no random split",
    }
    (OUT_DIR / "model_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


def verify():
    """Print a few real queries so the build can be checked without opening the site."""
    con = sqlite3.connect(DB_PATH)
    lines = ["== DATABASE CHECK =="]
    for t in ["psa_quarterly", "forecasts", "model_metrics", "data_files", "build_info"]:
        lines.append(f"  {t}: {con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]} rows")
    kinds = con.execute("SELECT kind, COUNT(*) FROM forecasts GROUP BY kind").fetchall()
    lines.append(f"  forecasts by kind: {kinds}")
    fut = con.execute("SELECT target_year, target_quarter, ROUND(predicted_yield,2), ROUND(low,2),"
                      " ROUND(high,2) FROM forecasts WHERE kind='future' ORDER BY horizon").fetchall()
    lines.append(f"  future rows (year, q, pred, low, high): {fut}")
    prod = con.execute("SELECT production_t FROM psa_quarterly WHERE crop='Palay' AND year=2025"
                       " AND period='Annual'").fetchone()[0]
    lines.append(f"  2025 Palay annual production from DB: {prod:,.2f} t")
    lines.append(f"  file size: {DB_PATH.stat().st_size / 1024:.0f} KB")
    con.close()
    return lines
