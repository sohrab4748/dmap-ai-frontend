import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

from dmap_worker.cli import overlaps_requested_period, process, validate_job


class WorkerTests(unittest.TestCase):
    def setUp(self):
        example = Path(__file__).parents[1] / "examples" / "example-job.json"
        self.job = json.loads(example.read_text(encoding="utf-8"))

    def test_example_job_is_valid(self):
        validate_job(self.job)

    def test_file_period_filter(self):
        self.assertTrue(overlaps_requested_period("pr_day_model_19500101-19501231.nc", pd.Timestamp("1950-06-01").date(), pd.Timestamp("1950-06-30").date()))
        self.assertFalse(overlaps_requested_period("pr_day_model_19500101-19501231.nc", pd.Timestamp("1951-01-01").date(), pd.Timestamp("1951-12-31").date()))

    def test_station_extraction_and_ensemble(self):
        with tempfile.TemporaryDirectory() as directory:
            job_dir = Path(directory)
            self.job["subset"]["end_date"] = "1950-01-02"
            self.job["source"]["source_ids"] = ["model-a", "model-b"]
            files = []
            for model, values in (("model-a", [1.0, 2.0]), ("model-b", [3.0, 4.0])):
                relative = Path("data") / model / "hist-1950" / f"pr_{model}.nc"
                target = job_dir / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                xr.Dataset(
                    {"pr": (("time", "lat", "lon"), np.asarray(values)[:, None, None])},
                    coords={"time": pd.date_range("1950-01-01", periods=2), "lat": [42.0], "lon": [266.4]},
                ).assign_attrs(title=model).assign(pr=lambda ds: ds.pr.assign_attrs(units="kg m-2 s-1")).to_netcdf(target)
                files.append({"source_id": model, "local_path": str(relative)})
            process(self.job, files, job_dir, observations=None)
            models = pd.read_csv(job_dir / "results" / "model_series.csv")
            ensemble = pd.read_csv(job_dir / "results" / "ensemble_statistics.csv")
            self.assertEqual(len(models), 4)
            self.assertEqual(len(ensemble), 2)
            self.assertAlmostEqual(ensemble.iloc[0]["ensemble_value"], 2.0 * 86400.0)


if __name__ == "__main__":
    unittest.main()
