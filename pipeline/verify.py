"""Step 0: verify the two PSA CSV files BEFORE any modelling.

Pure standard library (csv), so it does not depend on the loader it is checking.
`verify(prod_path, area_path)` returns a Verification with .ok, .lines (the report) and .records
(the parsed Pampanga records, reused by the loader so both read the same numbers).
The build stops when .ok is False; the report is always written to pipeline/reports/.
"""
import csv
import re
from dataclasses import dataclass, field
from pathlib import Path

PROVINCE = "....Pampanga"
PALAY = ["Palay", "Irrigated Palay", "Rainfed Palay"]
EXPECTED_UNITS = {"production": ("Metric Tons", "Volume of Production in Metric Tons"),
                  "area": ("Hectares", "Area Harvested in Hectares")}
PERIOD_PATTERN = ["Quarter 1", "Quarter 2", "Semester 1", "Quarter 3", "Quarter 4", "Semester 2", "Annual"]
SHORT = {"Quarter 1": "Q1", "Quarter 2": "Q2", "Semester 1": "S1", "Quarter 3": "Q3",
         "Quarter 4": "Q4", "Semester 2": "S2", "Annual": "Annual"}
TOL = 0.05                       # tolerance for the sums (PSA publishes 2 decimals)
YIELD_MIN, YIELD_MAX = 0.5, 8.0  # plausible palay yield, t/ha
REPORT_DIR = Path(__file__).resolve().parent / "reports"


@dataclass
class Verification:
    ok: bool = True
    lines: list = field(default_factory=list)
    records: dict = field(default_factory=dict)   # (measure, crop, year, period) -> float | None
    titles: dict = field(default_factory=dict)    # measure -> title line
    flagged_yield: set = field(default_factory=set)       # (crop, year, period) outside range
    inconsistent: set = field(default_factory=set)        # (crop, year, period) failing a sum check
    data_rows: dict = field(default_factory=dict)         # measure -> number of data rows
    period_columns: dict = field(default_factory=dict)    # measure -> number of period columns

    def say(self, text=""):
        self.lines.append(text)

    def fail(self, text):
        self.ok = False
        self.lines.append("  FAIL: " + text)


def _num(text):
    if text == "..":
        return None
    return float(text)


def _read(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.reader(fh))
    return rows[0][0], rows[1], rows[2:]


def _ranges(positions):
    """[3,4,5,9] -> '3-5, 9'"""
    out, start, prev = [], None, None
    for p in positions:
        if start is None:
            start = prev = p
        elif p == prev + 1:
            prev = p
        else:
            out.append(f"{start}-{prev}" if start != prev else str(start))
            start = prev = p
    if start is not None:
        out.append(f"{start}-{prev}" if start != prev else str(start))
    return ", ".join(out)


def verify(prod_path, area_path):
    v = Verification()
    paths = {"production": Path(prod_path), "area": Path(area_path)}
    parsed = {}
    v.say("== VALIDATION REPORT (area harvested + production) ==")
    for m, p in paths.items():
        title, header, rows = _read(p)
        parsed[m] = (title, header, rows)
        v.titles[m] = title
        v.data_rows[m] = len(rows)
        v.period_columns[m] = len(header) - 2
        v.say(f"{m}: {p.name}")
        v.say(f"  title: {title}")
        v.say(f"  data rows: {len(rows)}, period columns: {len(header) - 2}")

    # ---- 1. Province label -------------------------------------------------------------------
    v.say("\n[1] Province label '....Pampanga' occurs exactly once per croptype row")
    croptypes = {}
    for m, (_, _, rows) in parsed.items():
        croptypes[m] = sorted({r[0] for r in rows})
        for c in croptypes[m]:
            n = sum(1 for r in rows if r[0] == c and r[1] == PROVINCE)
            tag = "ok" if n == 1 else "FAIL"
            if n != 1:
                v.fail(f"{m}: croptype '{c}' has {n} rows labelled {PROVINCE}")
            v.say(f"  {m:10s} {c:16s} {n} row  [{tag}]")
        missing = [c for c in PALAY if c not in croptypes[m]]
        if missing:
            v.fail(f"{m}: missing croptype(s) {missing}")

    # ---- 2. Period columns -------------------------------------------------------------------
    v.say("\n[2] Period columns have the same names and order in both files")
    h_p, h_a = parsed["production"][1][2:], parsed["area"][1][2:]
    if h_p == h_a:
        v.say(f"  identical: {len(h_p)} columns, {h_p[0]} ... {h_p[-1]}  [ok]")
    else:
        diff = [i for i, (a, b) in enumerate(zip(h_p, h_a)) if a != b]
        v.fail(f"period columns differ (lengths {len(h_p)} vs {len(h_a)}; first difference at "
               f"position {diff[0] + 1 if diff else min(len(h_p), len(h_a)) + 1})")
    expected_ok = True
    for i, label in enumerate(h_p):
        year, _, rest = label.partition(" ")
        if not (year.isdigit() and rest == PERIOD_PATTERN[i % 7]):
            expected_ok = False
            v.fail(f"column {i + 1} '{label}' does not follow YYYY Quarter 1-4 / Semester 1-2 / Annual order")
            break
    if expected_ok:
        v.say("  every column follows 'YYYY Quarter 1, Quarter 2, Semester 1, Quarter 3, Quarter 4, Semester 2, Annual'  [ok]")
    for m, (_, header, rows) in parsed.items():
        cols = header[2:]
        v.say(f"  positions of '..' in the {m} file (column number, 1-based among period columns):")
        for r in rows:
            if r[1] != PROVINCE or r[0] not in PALAY:
                continue
            pos = [i + 1 for i, x in enumerate(r[2:]) if x == ".."]
            first = cols[pos[0] - 1] if pos else "-"
            v.say(f"    {r[0]:16s} {len(pos):3d} x '..'  columns {_ranges(pos) or '-'}  (first: {first})")
        total = sum(1 for r in rows for x in r[2:] if x == "..")
        v.say(f"    whole file: {total} '..' cells in {len(rows)} rows x {len(cols)} columns")
        for r in rows:
            for x in r[2:]:
                if x != ".." and not re.fullmatch(r"-?\d+(\.\d+)?", x):
                    v.fail(f"{m}: unexpected cell value {x!r} in row {r[0]} / {r[1]}")
                    break

    # ---- 3. Ecosystem labels -----------------------------------------------------------------
    v.say("\n[3] Palay, Irrigated Palay and Rainfed Palay exist in both files with identical labels")
    for c in PALAY:
        in_both = all(c in croptypes[m] for m in parsed)
        v.say(f"  '{c}': {'present in both' if in_both else 'MISSING'}  [{'ok' if in_both else 'FAIL'}]")
        if not in_both:
            v.fail(f"label '{c}' not in both files")

    # ---- 4. Units ----------------------------------------------------------------------------
    v.say("\n[4] Units (from the PSA table titles)")
    for m, (unit, phrase) in EXPECTED_UNITS.items():
        good = phrase in v.titles[m]
        v.say(f"  {m}: expected '{phrase}' -> {'found' if good else 'NOT found'}  [{'ok' if good else 'FAIL'}]")
        if not good:
            v.fail(f"{m} title does not state {unit}")

    # stop early if the structure is wrong: later checks index by label
    if not v.ok:
        v.say("\nStructure checks failed; value checks skipped.")
        return v

    # ---- records (Pampanga only) --------------------------------------------------------------
    for m, (_, header, rows) in parsed.items():
        cols = header[2:]
        for r in rows:
            if r[1] != PROVINCE or r[0] not in PALAY:
                continue
            for label, cell in zip(cols, r[2:]):
                year, _, rest = label.partition(" ")
                v.records[(m, r[0], int(year), SHORT[rest])] = _num(cell)

    years = sorted({k[2] for k in v.records})
    keys = [(c, y, p) for c in PALAY for y in years for p in SHORT.values()]
    P = lambda k: v.records[("production",) + k]
    A = lambda k: v.records[("area",) + k]

    # ---- 5. Internal consistency -------------------------------------------------------------
    v.say(f"\n[5] Internal consistency (tolerance {TOL})")
    bad = 0
    checked = 0
    for m in ("production", "area"):
        g = lambda c, y, p: v.records[(m, c, y, p)]
        for c in PALAY:
            for y in years:
                for name, parts, whole in [("Q1+Q2=S1", ("Q1", "Q2"), "S1"), ("Q3+Q4=S2", ("Q3", "Q4"), "S2"),
                                           ("S1+S2=Annual", ("S1", "S2"), "Annual")]:
                    vals = [g(c, y, p) for p in parts] + [g(c, y, whole)]
                    if any(x is None for x in vals):
                        continue
                    checked += 1
                    if abs(vals[0] + vals[1] - vals[2]) > TOL:
                        bad += 1
                        v.inconsistent.add((c, y, whole))
                        v.fail(f"{m} {c} {y} {name}: {vals[0]} + {vals[1]} = {vals[0] + vals[1]:.2f} vs {vals[2]}")
        for y in years:
            for p in SHORT.values():
                vals = [g(c, y, p) for c in PALAY]
                if any(x is None for x in vals):
                    continue
                checked += 1
                if abs(vals[1] + vals[2] - vals[0]) > TOL:
                    bad += 1
                    v.inconsistent.add(("Palay", y, p))
                    v.fail(f"{m} {y} {p}: Irrigated {vals[1]} + Rainfed {vals[2]} = {vals[1] + vals[2]:.2f} vs Palay {vals[0]}")
    v.say(f"  {checked} sum checks run, {bad} outside tolerance  [{'ok' if bad == 0 else 'FAIL'}]")

    # ---- 6. Alignment ------------------------------------------------------------------------
    v.say("\n[6] Production and area both present or both missing")
    one_sided = [(k, P(k), A(k)) for k in keys if (P(k) is None) != (A(k) is None)]
    both_missing = sum(1 for k in keys if P(k) is None and A(k) is None)
    v.say(f"  {len(keys)} records, {both_missing} missing in both, {len(one_sided)} with only one measure")
    for k, p, a in one_sided:
        v.fail(f"only one measure for {k}: production={p}, area={a}")

    # ---- yield range (flag only) ---------------------------------------------------------------
    v.say(f"\n[7] Implied yield outside {YIELD_MIN} to {YIELD_MAX} t/ha (flagged, never dropped silently)")
    flagged = []
    for k in keys:
        p, a = P(k), A(k)
        if p is not None and a is not None and a > 0:
            y = p / a
            if not (YIELD_MIN <= y <= YIELD_MAX):
                flagged.append((k, p, a, y))
                v.flagged_yield.add(k)
    zero_area = [(k, P(k)) for k in keys if A(k) == 0 and P(k) is not None]
    v.say(f"  {len(flagged)} records with area > 0 flagged -> yield_status 'inconsistent', yield stored as NULL, kept in observations")
    for k, p, a, y in flagged:
        v.say(f"    {k[0]:16s} {k[1]} {k[2]:6s} production {p:,.2f} / area {a:,.2f} = {y:.3f} t/ha")
    v.say(f"  {len(zero_area)} records with area = 0 (yield_status 'area_zero'): "
          + ", ".join(f"{k[0]} {k[1]} {k[2]}" for k, _ in zero_area[:8]) + (" ..." if len(zero_area) > 8 else ""))

    v.say("\nRESULT: " + ("ALL CHECKS PASSED" if v.ok else "FAILED - build stopped"))
    return v


def write_report(v, extra_lines=()):
    REPORT_DIR.mkdir(exist_ok=True)
    path = REPORT_DIR / "validation_report.txt"
    path.write_text("\n".join(list(v.lines) + list(extra_lines)) + "\n", encoding="utf-8")
    return path


if __name__ == "__main__":
    import load_data
    result = verify(load_data.find_file(load_data.FILES["Production CSV"]),
                    load_data.find_file(load_data.FILES["Area Harvested CSV"]))
    print("\n".join(result.lines))
    write_report(result)
