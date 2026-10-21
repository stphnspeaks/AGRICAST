"""Step 1: verify, then read the two PSA CSV files into one tidy table.

Output columns: year, period, crop, production_t, area_ha, yield_t_ha, yield_status, is_preliminary
NULL (NaN here) is never replaced by 0, interpolated or forward filled.
"""
import hashlib
from pathlib import Path

import numpy as np
import pandas as pd

import verify as verify_mod

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

CROPS = verify_mod.PALAY
PERIODS = ["Q1", "Q2", "S1", "Q3", "Q4", "S2", "Annual"]
FILES = {                            # measure -> file name pattern
    "production": "*Volume of Production*.csv",
    "area": "*Area Harvested*.csv",
}
# Reproducibility facts about the PSA tables (PSA OpenStat, CC BY 4.0). Not stored inside the CSVs.
PSA_TABLES = {
    "production": {"table_code": "0012E4EVCP0",
                   "url": "https://openstat.psa.gov.ph/PXWeb/pxweb/en/DB/DB__2E__CS/0012E4EVCP0.px/"},
    "area": {"table_code": "0022E4EAHC0",
             "url": "https://openstat.psa.gov.ph/PXWeb/pxweb/en/DB/DB__2E__CS/0022E4EAHC0.px"},
}
PSA_LAST_UPDATED = "2026-07-29"      # "Jul. 29, 2026" on both tables


def find_file(pattern):
    matches = sorted(DATA_DIR.glob(pattern))
    if not matches:
        raise SystemExit(f"Missing CSV in {DATA_DIR}: {pattern}\n"
                         "Both PSA files are required. Never estimate areas.")
    return matches[0]


def sha256_of(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def yield_and_status(prod, area, flagged):
    """yield = production / area only when production is present and area > 0."""
    if prod is None:
        return None, "production_missing"
    if area is None:
        return None, "area_missing"
    if area == 0:
        return None, "area_zero"
    if flagged:
        return None, "inconsistent"
    return prod / area, "ok"


def load_all():
    """Return (table, files_info, report_lines, verification). Stops the build if verification fails."""
    paths = {m: find_file(p) for m, p in FILES.items()}
    ver = verify_mod.verify(paths["production"], paths["area"])
    report_path = verify_mod.write_report(ver)
    if not ver.ok:
        print("\n".join(ver.lines))
        raise SystemExit(f"\nBUILD STOPPED: verification failed. Report written to {report_path}")

    files_info = {}
    for m, p in paths.items():
        files_info[m] = dict(measure=m, path=p, file_name=p.name, sha256=sha256_of(p),
                             size=p.stat().st_size, data_rows=ver.data_rows[m],
                             period_columns=ver.period_columns[m], title=ver.titles[m],
                             psa_last_updated=PSA_LAST_UPDATED, **PSA_TABLES[m])

    years = sorted({k[2] for k in ver.records})
    rows = []
    for crop in CROPS:
        for year in years:
            for period in PERIODS:
                p = ver.records[("production", crop, year, period)]
                a = ver.records[("area", crop, year, period)]
                flagged = ((crop, year, period) in ver.flagged_yield
                           or (crop, year, period) in ver.inconsistent)
                y, status = yield_and_status(p, a, flagged)
                rows.append((year, period, crop, p, a, y, status))
    df = pd.DataFrame(rows, columns=["year", "period", "crop", "production_t", "area_ha",
                                     "yield_t_ha", "yield_status"])
    for col in ["production_t", "area_ha", "yield_t_ha"]:
        df[col] = df[col].astype(float)          # None -> NaN, never 0

    # The latest published quarter is preliminary, and so is the semester that contains it.
    pal = df[(df["crop"] == "Palay") & df["period"].isin(["Q1", "Q2", "Q3", "Q4"]) & df["production_t"].notna()]
    last_year = int(pal["year"].max())
    last_q = int(pal[pal["year"] == last_year]["period"].str[1].astype(int).max())
    prelim_periods = {f"Q{last_q}", "S1" if last_q <= 2 else "S2"}
    df["is_preliminary"] = ((df["year"] == last_year) & df["period"].isin(prelim_periods)
                            & df["production_t"].notna()).astype(int)

    df["period"] = pd.Categorical(df["period"], PERIODS, ordered=True)
    df = df.sort_values(["crop", "year", "period"]).reset_index(drop=True)
    df["period"] = df["period"].astype(str)

    report = list(ver.lines) + [""] + make_report(df, files_info, last_year, last_q)
    return df, files_info, report, ver


def make_report(df, files_info, last_year, last_q):
    lines = ["== LOAD REPORT =="]
    for m, f in files_info.items():
        lines.append(f"{m}: {f['file_name']}  {f['size']:,} bytes, {f['data_rows']} data rows, "
                     f"{f['period_columns']} period columns, SHA-256 {f['sha256']}")
    counts = df.groupby(["crop", "yield_status"]).size().unstack(fill_value=0)
    lines.append("Yield status counts per crop (all periods):")
    lines += ["  " + l for l in counts.to_string().splitlines()]
    q = df[(df["crop"] == "Palay") & df["period"].isin(["Q1", "Q2", "Q3", "Q4"])]
    lines.append(f"Pampanga Palay quarters with a defined yield: {int(q['yield_t_ha'].notna().sum())} of {len(q)}")
    ann = df[(df["crop"] == "Palay") & (df["period"] == "Annual")].set_index("year")
    y25 = ann.loc[2025]
    lines.append(f"Check value: Palay 2025 annual production = {y25['production_t']:,.2f} t, "
                 f"area = {y25['area_ha']:,.2f} ha, yield = {y25['yield_t_ha']:.3f} t/ha")
    lines.append(f"Latest published quarter: {last_year} Q{last_q} (preliminary, history only, never scored)")
    return lines


if __name__ == "__main__":
    table, _, rep, _ = load_all()
    print("\n".join(rep[-14:]))
