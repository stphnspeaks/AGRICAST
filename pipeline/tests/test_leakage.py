"""Leakage tests.  Run:  py -3.15 -m unittest discover -s pipeline/tests -v   (from the project root)

Change every actual value after the origin and confirm the forecast for T+h does not change.
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import load_data  # noqa: E402
import train  # noqa: E402

SPECS = [(train.BASELINE, {}), (train.RIDGE, {"alpha": 1}),
         (train.FOREST, {"n_estimators": 200, "max_depth": 3, "min_samples_leaf": 3})]
ORIGINS = [train.tq(2011, 4), train.tq(2015, 2), train.tq(2018, 4), train.tq(2025, 4)]


class LeakageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        df, *_ = load_data.load_all()
        cls.series = train.build_series(df)

    def altered(self, origin, how):
        s = self.series.copy()
        after = s.index > origin
        rng = np.random.default_rng(1)
        if how == "garbage":
            s[after] = rng.uniform(0.1, 20, after.sum())
        elif how == "nan":
            s[after] = np.nan
        else:
            s[after] = s[after] * 3 + 7
        return s

    def test_future_actuals_do_not_change_forecast(self):
        for name, params in SPECS:
            for origin in ORIGINS:
                base = train.forecast_at_origin(self.series, origin, name, params)
                for how in ("garbage", "nan", "scaled"):
                    other = train.forecast_at_origin(self.altered(origin, how), origin, name, params)
                    self.assertEqual(base, other, f"{name} origin {train.label(origin)} altered={how}")

    def test_scaler_fitted_on_training_window_only(self):
        origin = train.tq(2015, 2)
        m1, _ = train.fit_at_origin(self.series, origin, train.RIDGE, {"alpha": 1})
        m2, _ = train.fit_at_origin(self.altered(origin, "garbage"), origin, train.RIDGE, {"alpha": 1})
        scaler1, scaler2 = m1.steps[0][1], m2.steps[0][1]
        np.testing.assert_array_equal(scaler1.mean_, scaler2.mean_)
        np.testing.assert_array_equal(scaler1.scale_, scaler2.scale_)
        hist = self.series.loc[:origin]
        f = train.feature_frame(hist)
        ok = f.notna().all(axis=1) & hist.notna()
        np.testing.assert_allclose(scaler1.mean_, f[ok].to_numpy().mean(axis=0))

    def test_features_use_only_earlier_quarters(self):
        f = train.feature_frame(self.series)
        t = train.tq(2015, 3)
        self.assertEqual(f.loc[t, "lag1"], self.series[t - 1])
        self.assertEqual(f.loc[t, "lag4"], self.series[t - 4])
        self.assertAlmostEqual(f.loc[t, "mean4"], self.series.loc[t - 4:t - 1].mean())

    def test_missing_lag_rows_are_excluded_not_filled(self):
        s = self.series.copy()
        gap = train.tq(2000, 2)
        s[gap] = np.nan
        f = train.feature_frame(s)
        for k in (1, 4):                                   # lag1 and lag4 rows see the gap
            self.assertTrue(np.isnan(f.loc[gap + k, "lag1" if k == 1 else "lag4"]))
        for k in (1, 2, 3, 4):                             # mean4 is NaN while the gap is in the window
            self.assertTrue(np.isnan(f.loc[gap + k, "mean4"]))


if __name__ == "__main__":
    unittest.main()
