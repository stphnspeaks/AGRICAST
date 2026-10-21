"""Step 3: append a dataset version, model runs and forecasts to site/data/agricast.db.

The database is never rebuilt or truncated. A new SHA-256 for either PSA file creates a new
source_files row and a new dataset_versions row with a complete new set of observations. Every
training adds new model_runs; older runs and forecasts stay, and only one run per model is deployed.
"""
import hashlib
import json
import shutil
import sqlite3
import subprocess
from datetime import datetime
from pathlib import Path

import train

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "site" / "data"
DB_PATH = OUT_DIR / "agricast.db"
ARCHIVE_DIR = Path(__file__).resolve().parent / "archive"
MAX_DIFF_LINES = 400


def code_version():
    """git commit + dirty marker + hash of the pipeline sources, so a run can be traced to its code."""
    def git(*a):
        try:
            return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
        except Exception:
            return ""
    commit = git("rev-parse", "--short", "HEAD") or "nogit"
    dirty = "+dirty" if git("status", "--porcelain", "--", "pipeline", "data") else ""
    h = hashlib.sha256()
    for p in sorted((ROOT / "pipeline").glob("*.py")) + [ROOT / "pipeline" / "schema.sql"]:
        h.update(p.read_bytes())
    return f"{commit}{dirty}.{h.hexdigest()[:8]}"


def open_db():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        probe = sqlite3.connect(DB_PATH)
        has_new = probe.execute("SELECT 1 FROM sqlite_master WHERE name = 'dataset_versions'").fetchone()
        probe.close()
        if not has_new:                       # database from the first (unversioned) design: keep it, outside site/
            ARCHIVE_DIR.mkdir(exist_ok=True)
            shutil.move(str(DB_PATH), str(ARCHIVE_DIR / "agricast_v0_unversioned.db"))
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript((Path(__file__).parent / "schema.sql").read_text(encoding="utf-8"))
    return con


def obs_rows(df, dsv_id):
    out = df.astype(object).where(df.notna(), None)
    return [(dsv_id, int(r.year), r.period, r.crop, r.production_t, r.area_ha, r.yield_t_ha,
             r.yield_status, int(r.is_preliminary)) for r in out.itertuples()]


def diff_report(con, df, prev_dsv):
    """Changed values and newly published quarters against the previous dataset version."""
    if prev_dsv is None:
        return ["DIFF: first dataset version, nothing to compare."]
    old = {(y, p, c): (pr, ar) for y, p, c, pr, ar in con.execute(
        "SELECT year, period, crop, production_t, area_ha FROM observations WHERE dsv_id = ?", (prev_dsv,))}
    changed, new_pub, dropped = [], [], []
    for r in df.itertuples():
        key = (int(r.year), r.period, r.crop)
        new = tuple(None if v != v else float(v) for v in (r.production_t, r.area_ha))
        if key not in old:
            new_pub.append((key, new))
            continue
        for name, o, n in zip(("production_t", "area_ha"), old[key], new):
            if o is None and n is not None:
                new_pub.append((key, new))
                break
            if o is not None and n is None:
                dropped.append((key, name, o))
            elif o is not None and abs(o - n) > 1e-9:
                changed.append((key, name, o, n))
    lines = [f"DIFF against dataset version {prev_dsv}:",
             f"  newly published records: {len(new_pub)}; changed values: {len(changed)}; values now missing: {len(dropped)}"]
    shown = ([f"  NEW     {k[2]} {k[0]} {k[1]}: production {n[0]}, area {n[1]}" for k, n in new_pub] +
             [f"  CHANGED {k[2]} {k[0]} {k[1]} {f}: {o} -> {n}" for k, f, o, n in changed] +
             [f"  MISSING {k[2]} {k[0]} {k[1]} {f}: was {o}, now NULL" for k, f, o in dropped])
    lines += shown[:MAX_DIFF_LINES]
    if len(shown) > MAX_DIFF_LINES:
        lines.append(f"  ... {len(shown) - MAX_DIFF_LINES} more lines not shown")
    return lines


def write_database(df, files_info, ver, result):
    """One transaction: either everything is appended or nothing is. Returns a dict of ids."""
    now = datetime.now().isoformat(timespec="seconds")
    con = open_db()
    try:
        con.execute("BEGIN")
        ids = {}
        for m, f in files_info.items():
            retrieved = datetime.fromtimestamp(f["path"].stat().st_mtime).isoformat(timespec="seconds")
            con.execute("INSERT OR IGNORE INTO source_files (table_code, title, url, psa_last_updated,"
                        " retrieved_at, file_name, sha256) VALUES (?,?,?,?,?,?,?)",
                        (f["table_code"], f["title"], f["url"], f["psa_last_updated"], retrieved,
                         f["file_name"], f["sha256"]))
            ids[m] = con.execute("SELECT file_id FROM source_files WHERE sha256 = ?", (f["sha256"],)).fetchone()[0]

        row = con.execute("SELECT dsv_id FROM dataset_versions WHERE production_file_id = ? AND area_file_id = ?",
                          (ids["production"], ids["area"])).fetchone()
        if row:
            dsv_id, new_dsv = row[0], False
        else:
            prev = con.execute("SELECT MAX(dsv_id) FROM dataset_versions").fetchone()[0]
            report = "\n".join(list(ver.lines) + [""] + diff_report(con, df, prev))
            cur = con.execute("INSERT INTO dataset_versions (production_file_id, area_file_id, built_at,"
                              " checks_passed, validation_report) VALUES (?,?,?,?,?)",
                              (ids["production"], ids["area"], now, int(ver.ok), report))
            dsv_id, new_dsv = cur.lastrowid, True
            con.executemany("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?)", obs_rows(df, dsv_id))

        version = code_version()
        lab = lambda t: f"{t // 4} Q{t % 4 + 1}"
        run_ids = {}
        for name, run in result["runs"].items():
            con.execute("UPDATE model_runs SET is_deployed = 0 WHERE model_name = ? AND is_deployed = 1", (name,))
            cur = con.execute(
                "INSERT INTO model_runs (dsv_id, model_name, params, train_start, train_end, valid_start, valid_end,"
                " test_start, test_end, code_version, trained_at, is_deployed) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)",
                (dsv_id, name, json.dumps(run["params"], sort_keys=True), lab(train.TRAIN_START), lab(train.TRAIN_END),
                 lab(train.SPLITS["validation"][0]), lab(train.SPLITS["validation"][1]),
                 lab(train.SPLITS["test"][0]), lab(train.SPLITS["test"][1]), version, now))
            rid = run_ids[name] = cur.lastrowid
            con.executemany(
                "INSERT INTO model_metrics VALUES (?,?,?,?,?,?,?,?)",
                [(rid, split, h, m["mae"], m["rmse"], m["mape"], m["coverage"], m["mean_width"])
                 for split in ("validation", "test") for h, m in run["metrics"][split].items()])
            con.executemany(
                "INSERT INTO forecasts (run_id, kind, origin_year, origin_quarter, target_year, target_quarter,"
                " horizon, predicted, low, high, actual_yield) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [(rid, f["kind"], f["origin"] // 4, f["origin"] % 4 + 1, f["target"] // 4, f["target"] % 4 + 1,
                  f["horizon"], f["predicted"], f["low"], f["high"], f["actual"]) for f in run["forecasts"]])

        shown = result["displayed"]
        ly, lq = result["latest"]
        info = {"latest_year": ly, "latest_quarter": lq, "built_at": now, "dsv_id": dsv_id,
                "displayed_run_id": run_ids[shown], "model_name": shown, "chosen_model": result["chosen"],
                "beats_baseline": int(result["beats"]), "code_version": version,
                "forecast_rows": len(result["runs"][shown]["forecasts"])}
        for h in train.HORIZONS:
            info[f"typical_error_h{h}"] = round(result["runs"][shown]["metrics"]["test"][h]["mae"], 4)
        con.executemany("INSERT OR REPLACE INTO build_info VALUES (?,?)", [(k, str(v)) for k, v in info.items()])
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()
    con = sqlite3.connect(DB_PATH)
    con.execute("VACUUM")
    con.close()
    return dict(dsv_id=dsv_id, new_dsv=new_dsv, run_ids=run_ids, file_ids=ids)


def write_report(result, files_info):
    def table(split):
        return {n: {str(h): v for h, v in r["metrics"][split].items()} for n, r in result["runs"].items()}
    report = {
        "chosen_model": result["chosen"], "displayed_model": result["displayed"],
        "beats_baseline_on_test": result["beats"],
        "selected_params": result["specs"],
        "source_files": {m: {"file_name": f["file_name"], "sha256": f["sha256"], "bytes": f["size"],
                             "data_rows": f["data_rows"], "period_columns": f["period_columns"]}
                         for m, f in files_info.items()},
        "validation_metrics": table("validation"), "test_metrics": table("test"),
        "validation_protocol": "rolling-origin, expanding window, horizons 1-4 (recursive), no random split",
    }
    (OUT_DIR / "model_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


def verify(ids):
    """Print real queries so the build can be checked without opening the site."""
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA foreign_keys = ON")
    lines = ["== DATABASE CHECK =="]
    lines.append(f"  integrity_check: {con.execute('PRAGMA integrity_check').fetchone()[0]}; "
                 f"foreign_key_check problems: {len(con.execute('PRAGMA foreign_key_check').fetchall())}")
    for t in ["source_files", "dataset_versions", "observations", "model_runs", "model_metrics", "forecasts"]:
        lines.append(f"  {t}: {con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]} rows")
    lines.append("  deployed runs: " + ", ".join(f"{n} run {r}" for r, n in con.execute(
        "SELECT run_id, model_name FROM model_runs WHERE is_deployed = 1 ORDER BY run_id")))
    t = con.execute("SELECT forecast_id, model_name, run_id, dsv_id, production_sha256, area_sha256 FROM forecast_trace"
                    " WHERE kind = 'future' AND horizon = 1 AND run_id = (SELECT run_id FROM displayed_run)").fetchone()
    lines.append(f"  trace of displayed 'future' h1 forecast {t[0]}: model {t[1]} run {t[2]} dataset {t[3]} "
                 f"production sha {t[4][:16]}... area sha {t[5][:16]}...")
    lines.append(f"  file size: {DB_PATH.stat().st_size / 1024:.0f} KB")
    con.close()
    return lines
