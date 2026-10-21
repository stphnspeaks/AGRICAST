"""Step 1: read the two PSA CSV files and turn them into one tidy table.

Output columns: year, period, crop, production_t, area_ha, yield_t_ha, is_preliminary
"""
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

PROVINCE = "....Pampanga"            # PSA writes sub-regions with leading dots
CROPS = ["Palay", "Irrigated Palay", "Rainfed Palay"]
PERIODS = ["Q1", "Q2", "S1", "Q3", "Q4", "S2", "Annual"]
FILES = {                            # label shown in the app -> file name pattern
    "Production CSV": "*Volume of Production*.csv",
    "Area Harvested CSV": "*Area Harvested*.csv",
}


def find_file(pattern):
    matches = sorted(DATA_DIR.glob(pattern))
    if not matches:
        raise SystemExit(f"Missing CSV in {DATA_DIR}: {pattern}\n"
                         "Both PSA files are required. Never estimate areas.")
    return matches[0]


def read_one(path, value_name):
    """Read one PSA file and return a long table for Pampanga only."""
    # Row 1 is a title, row 2 is the header. utf-8-sig removes the BOM.
    # na_values=".." turns "not available" into NaN (never zero).
    raw = pd.read_csv(path, skiprows=1, encoding="utf-8-sig", na_values=[".."])
    total_rows = len(raw)
    raw.columns = ["crop", "place"] + list(raw.columns[2:])
    raw = raw[(raw["place"] == PROVINCE) & (raw["crop"].isin(CROPS))]
    long = raw.melt(id_vars=["crop", "place"], var_name="label", value_name=value_name)
    # "1987 Quarter 1" -> year 1987, period Q1 ; "1987 Annual" -> Annual
    parts = long["label"].str.split(" ", n=1, expand=True)
    long["year"] = parts[0].astype(int)
    long["period"] = (parts[1].str.replace("Quarter ", "Q").str.replace("Semester ", "S"))
    return long[["year", "period", "crop", value_name]], total_rows


def load_all():
    """Return (table, files_info, report_lines)."""
    report = []
    prod_path, area_path = find_file(FILES["Production CSV"]), find_file(FILES["Area Harvested CSV"])
    prod, prod_rows = read_one(prod_path, "production_t")
    area, area_rows = read_one(area_path, "area_ha")
    files_info = {"Production CSV": (prod_path.name, prod_rows),
                  "Area Harvested CSV": (area_path.name, area_rows)}

    df = prod.merge(area, on=["year", "period", "crop"], how="outer")
    # Yield = production / area, per period (annual yield is annual / annual).
    area_ok = df["area_ha"].where(df["area_ha"] > 0)
    df["yield_t_ha"] = df["production_t"] / area_ok
    df.loc[df["production_t"].isna() | area_ok.isna(), "yield_t_ha"] = np.nan

    # Latest year that has any published number is still preliminary.
    last_year = int(df.loc[df["production_t"].notna(), "year"].max())
    df["is_preliminary"] = (df["year"] == last_year).astype(int)

    df["period"] = pd.Categorical(df["period"], PERIODS, ordered=True)
    df = df.sort_values(["crop", "year", "period"]).reset_index(drop=True)
    df["period"] = df["period"].astype(str)

    report += make_report(df, files_info, last_year)
    return df, files_info, report


def make_report(df, files_info, last_year):
    lines = ["== LOAD REPORT =="]
    for label, (name, rows) in files_info.items():
        lines.append(f"{label}: {name} ({rows} data rows)")

    palay = df[df["crop"] == "Palay"]
    q = palay[palay["period"].isin(["Q1", "Q2", "Q3", "Q4"])]
    have = q["production_t"].notna().sum()
    lines.append(f"Pampanga Palay quarterly production values: {have} of {len(q)} "
                 f"(rest are '..' = not available)")

    # Check 1: four quarters must add up to the PSA Annual column.
    # Check 2: S1 = Q1+Q2 and S2 = Q3+Q4 (needed for the semester donut).
    mismatches = 0
    for crop in CROPS:
        for col in ["production_t", "area_ha"]:
            wide = df[df["crop"] == crop].pivot(index="year", columns="period", values=col)
            for year, r in wide.iterrows():
                for name, parts in [("Annual", ["Q1", "Q2", "Q3", "Q4"]),
                                    ("S1", ["Q1", "Q2"]), ("S2", ["Q3", "Q4"])]:
                    if r[parts].isna().any() or pd.isna(r[name]):
                        continue
                    if abs(r[parts].sum() - r[name]) > 1.0:   # PSA rounds to whole units
                        mismatches += 1
                        lines.append(f"  MISMATCH {crop} {col} {year} {name}: "
                                     f"parts={r[parts].sum():.2f} PSA={r[name]:.2f}")
    lines.append(f"Quarter-sum vs PSA Annual/Semester mismatches (tolerance 1.0): {mismatches}")

    ann = palay[(palay["period"] == "Annual")].set_index("year")["production_t"]
    lines.append(f"Check value: Pampanga Palay 2025 annual production = {ann.get(2025):,.2f} t "
                 f"(expected 418,908.75)")
    lines.append(f"Annual production: 1987 = {ann.get(1987):,.0f} t, "
                 f"peak {ann.idxmax()} = {ann.max():,.0f} t, 2025 = {ann.get(2025):,.0f} t")

    # Quarter shares of the year, 2015-2025 average
    w = q[(q["year"] >= 2015) & (q["year"] <= 2025)].pivot(index="year", columns="period", values="production_t")
    share = (w.div(w.sum(axis=1), axis=0).mean() * 100).round(1)
    lines.append("Average share of yearly output 2015-2025: " +
                 ", ".join(f"{k} {v}%" for k, v in share.items()))

    latest = q[q["production_t"].notna()].iloc[-1]
    lines.append(f"Latest published quarter: {int(latest['year'])} {latest['period']} (preliminary)")
    rainfed = df[(df["crop"] == "Rainfed Palay") & (df["period"] == "Annual") & (df["year"] >= 2020)]
    lines.append(f"Rainfed Palay annual production 2020+: {rainfed['production_t'].fillna(-1).tolist()} "
                 "(zero/NaN: split not used for features)")
    return lines


if __name__ == "__main__":
    table, _, rep = load_all()
    print("\n".join(rep))
