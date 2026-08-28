from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import math
import re
import threading
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any


INDEX_URL = "https://esgf-node.llnl.gov/esg-search/search"
ALLOWED_PROJECTS = {"CMIP6"}
ALLOWED_ACTIVITIES = {"HighResMIP"}
ALLOWED_EXPERIMENTS = {"hist-1950", "highres-future", "highresSST-present", "highresSST-future"}
ALLOWED_VARIABLES = {"pr", "tas", "tasmax", "tasmin"}
ALLOWED_TABLES = {"day", "Amon"}
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
DATE_RANGE_PATTERN = re.compile(r"_(\d{4}(?:\d{2}(?:\d{2})?)?)-(\d{4}(?:\d{2}(?:\d{2})?)?)\.nc$")


class WorkerError(RuntimeError):
    pass


def read_json(path: Path) -> Any:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise WorkerError(f"Cannot read job file: {exc}") from exc
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")
    temporary.replace(path)


def scalar(value: Any) -> Any:
    return value[0] if isinstance(value, list) and value else value


def validate_job(job: dict[str, Any]) -> None:
    if job.get("schema_version") != "1.0" or job.get("execution") != "local_esgf":
        raise WorkerError("Unsupported DMAP job schema or execution mode.")
    job_id = str(job.get("job_id", ""))
    if not ID_PATTERN.fullmatch(job_id):
        raise WorkerError("job_id contains unsupported characters.")
    source = job.get("source")
    subset = job.get("subset")
    processing = job.get("processing")
    if not isinstance(source, dict) or not isinstance(subset, dict) or not isinstance(processing, dict):
        raise WorkerError("source, subset, and processing sections are required.")
    if source.get("index_url") != INDEX_URL:
        raise WorkerError("This worker only accepts the official configured ESGF index.")
    if source.get("project") not in ALLOWED_PROJECTS or source.get("activity_id") not in ALLOWED_ACTIVITIES:
        raise WorkerError("Unsupported ESGF project or activity.")
    experiments = source.get("experiment_ids")
    models = source.get("source_ids")
    if not isinstance(experiments, list) or not experiments or not set(experiments) <= ALLOWED_EXPERIMENTS:
        raise WorkerError("The ESGF experiment list is invalid.")
    if not isinstance(models, list) or not 1 <= len(models) <= 50 or any(not ID_PATTERN.fullmatch(str(item)) for item in models):
        raise WorkerError("Select between 1 and 50 valid ESGF source IDs.")
    for key in ("member_id", "grid_label"):
        if not ID_PATTERN.fullmatch(str(source.get(key, ""))):
            raise WorkerError(f"Invalid {key}.")
    if source.get("variable_id") not in ALLOWED_VARIABLES or source.get("table_id") not in ALLOWED_TABLES:
        raise WorkerError("Unsupported variable or table.")
    version = source.get("version")
    if version is not None and not re.fullmatch(r"\d{8}", str(version)):
        raise WorkerError("ESGF version must contain eight digits.")
    try:
        start = date.fromisoformat(str(subset.get("start_date")))
        end = date.fromisoformat(str(subset.get("end_date")))
    except ValueError as exc:
        raise WorkerError("Invalid start or end date.") from exc
    if start > end or start < date(1950, 1, 1) or end > date(2050, 1, 1):
        raise WorkerError("Dates must be between 1950-01-01 and 2050-01-01.")
    stations = subset.get("stations")
    if not isinstance(stations, list) or not 1 <= len(stations) <= 1000:
        raise WorkerError("The job must contain between 1 and 1,000 stations.")
    seen: set[str] = set()
    for station in stations:
        if not isinstance(station, dict) or not ID_PATTERN.fullmatch(str(station.get("station_id", ""))):
            raise WorkerError("Every station needs a safe station_id.")
        if station["station_id"] in seen:
            raise WorkerError("Station IDs must be unique.")
        seen.add(station["station_id"])
        latitude = station.get("latitude")
        longitude = station.get("longitude")
        if not isinstance(latitude, (int, float)) or not -90 <= latitude <= 90:
            raise WorkerError(f"Invalid latitude for {station['station_id']}.")
        if not isinstance(longitude, (int, float)) or not -180 <= longitude <= 180:
            raise WorkerError(f"Invalid longitude for {station['station_id']}.")
    if processing.get("workflow") not in {"direct_ensemble", "monthly_bias_correction"}:
        raise WorkerError("Unsupported processing workflow.")
    if processing.get("ensemble_method") not in {"equal_mean", "median", "trimmed_mean", "weighted_mean"}:
        raise WorkerError("Unsupported ensemble method.")


def api_json(params: dict[str, Any]) -> dict[str, Any]:
    url = f"{INDEX_URL}?{urllib.parse.urlencode(params, doseq=True)}"
    request = urllib.request.Request(url, headers={"User-Agent": "DMAP-Local-Worker/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise WorkerError(f"ESGF search failed with HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise WorkerError(f"ESGF search failed: {exc}") from exc


def parse_compact_date(value: str, end: bool = False) -> date:
    if len(value) == 4:
        return date(int(value), 12 if end else 1, 31 if end else 1)
    if len(value) == 6:
        year, month = int(value[:4]), int(value[4:])
        if not end:
            return date(year, month, 1)
        next_month = date(year + (month == 12), 1 if month == 12 else month + 1, 1)
        return date.fromordinal(next_month.toordinal() - 1)
    return date(int(value[:4]), int(value[4:6]), int(value[6:8]))


def overlaps_requested_period(title: str, start: date, end: date) -> bool:
    match = DATE_RANGE_PATTERN.search(title)
    if not match:
        return True
    return parse_compact_date(match.group(1)) <= end and parse_compact_date(match.group(2), end=True) >= start


def http_download_url(doc: dict[str, Any]) -> str | None:
    candidates = doc.get("url", [])
    if isinstance(candidates, str):
        candidates = [candidates]
    for candidate in candidates:
        parts = candidate.split("|")
        if len(parts) >= 3 and parts[2].upper() == "HTTPSERVER" and parts[0].startswith("https://"):
            return parts[0]
    return None


def discover(job: dict[str, Any]) -> list[dict[str, Any]]:
    validate_job(job)
    source = job["source"]
    requested_start = date.fromisoformat(job["subset"]["start_date"])
    requested_end = date.fromisoformat(job["subset"]["end_date"])
    discovered: list[dict[str, Any]] = []
    for model in source["source_ids"]:
        for experiment in source["experiment_ids"]:
            offset = 0
            while True:
                params = {
                    "project": source["project"],
                    "activity_id": source["activity_id"],
                    "experiment_id": experiment,
                    "source_id": model,
                    "member_id": source["member_id"],
                    "grid_label": source["grid_label"],
                    "variable_id": source["variable_id"],
                    "table_id": source["table_id"],
                    "type": "File",
                    "replica": str(bool(source.get("replica", False))).lower(),
                    "format": "application/solr+json",
                    "limit": 1000,
                    "offset": offset,
                }
                if source.get("latest", True):
                    params["latest"] = "true"
                elif source.get("version"):
                    params["version"] = source["version"]
                payload = api_json(params)
                response = payload.get("response", {})
                docs = response.get("docs", [])
                for doc in docs:
                    title = str(doc.get("title", ""))
                    download_url = http_download_url(doc)
                    data_node = str(scalar(doc.get("data_node")) or "")
                    download_host = urllib.parse.urlparse(download_url).hostname if download_url else None
                    if not title.endswith(".nc") or not download_url or not data_node or download_host != data_node or not overlaps_requested_period(title, requested_start, requested_end):
                        continue
                    discovered.append({
                        "id": doc.get("id"),
                        "title": title,
                        "url": download_url,
                        "size": int(doc.get("size") or 0),
                        "checksum": str(scalar(doc.get("checksum")) or ""),
                        "checksum_type": str(scalar(doc.get("checksum_type")) or "").upper(),
                        "data_node": data_node,
                        "source_id": str(scalar(doc.get("source_id")) or model),
                        "experiment_id": str(scalar(doc.get("experiment_id")) or experiment),
                        "member_id": str(scalar(doc.get("member_id")) or source["member_id"]),
                        "grid_label": str(scalar(doc.get("grid_label")) or source["grid_label"]),
                        "version": str(doc.get("version") or ""),
                    })
                offset += len(docs)
                if not docs or offset >= int(response.get("numFound", 0)):
                    break
    unique: dict[str, dict[str, Any]] = {}
    for item in discovered:
        key = item["checksum"] or f"{item['source_id']}|{item['experiment_id']}|{item['title']}"
        unique.setdefault(key, item)
    return sorted(unique.values(), key=lambda item: (item["source_id"], item["experiment_id"], item["title"]))


def hash_file(path: Path, algorithm: str) -> str:
    name = algorithm.lower().replace("-", "")
    if name not in hashlib.algorithms_available:
        raise WorkerError(f"Unsupported checksum algorithm: {algorithm}")
    digest = hashlib.new(name)
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_one(item: dict[str, Any], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if not item["checksum"] or hash_file(destination, item["checksum_type"]) == item["checksum"].lower():
            return
        destination.unlink()
    partial = destination.with_suffix(destination.suffix + ".part")
    existing = partial.stat().st_size if partial.exists() else 0
    headers = {"User-Agent": "DMAP-Local-Worker/0.1"}
    if existing:
        headers["Range"] = f"bytes={existing}-"
    request = urllib.request.Request(item["url"], headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            append = existing > 0 and getattr(response, "status", None) == 206
            with partial.open("ab" if append else "wb") as output:
                while True:
                    block = response.read(8 * 1024 * 1024)
                    if not block:
                        break
                    output.write(block)
    except (urllib.error.URLError, TimeoutError) as exc:
        raise WorkerError(f"Download interrupted for {item['title']}: {exc}. Run the job again to resume.") from exc
    if item["checksum"] and hash_file(partial, item["checksum_type"]) != item["checksum"].lower():
        raise WorkerError(f"Checksum verification failed for {item['title']}.")
    partial.replace(destination)


def nearest_point(data_array: Any, latitude: float, longitude: float) -> Any:
    import numpy as np

    lat_name = next((name for name in data_array.coords if name.lower() in {"lat", "latitude"}), None)
    lon_name = next((name for name in data_array.coords if name.lower() in {"lon", "longitude"}), None)
    if not lat_name or not lon_name:
        raise WorkerError("The NetCDF file does not expose recognizable latitude/longitude coordinates.")
    lat = data_array[lat_name]
    lon = data_array[lon_name]
    target_lon = longitude % 360 if float(lon.max()) > 180 else longitude
    if lat.ndim == 1 and lon.ndim == 1:
        return data_array.sel({lat_name: latitude, lon_name: target_lon}, method="nearest")
    lon_distance = abs(((lon - target_lon + 180) % 360) - 180)
    distance = (lat - latitude) ** 2 + (lon_distance * math.cos(math.radians(latitude))) ** 2
    flat_index = int(np.nanargmin(distance.values))
    indexes = np.unravel_index(flat_index, distance.shape)
    return data_array.isel({dimension: index for dimension, index in zip(distance.dims, indexes)})


def extract_model_rows(job: dict[str, Any], files: list[dict[str, Any]], job_dir: Path) -> Any:
    try:
        import pandas as pd
        import xarray as xr
    except ImportError as exc:
        raise WorkerError("Processing dependencies are missing. Reinstall DMAP Local Worker.") from exc
    variable = job["source"]["variable_id"]
    frames = []
    grouped: dict[str, list[Path]] = defaultdict(list)
    for item in files:
        grouped[item["source_id"]].append(job_dir / item["local_path"])
    for model, paths in grouped.items():
        dataset = xr.open_mfdataset(sorted(paths), combine="by_coords", chunks="auto", parallel=False)
        if variable not in dataset:
            dataset.close()
            raise WorkerError(f"Variable {variable} is missing in files for {model}.")
        array = dataset[variable].sel(time=slice(job["subset"]["start_date"], job["subset"]["end_date"]))
        units = str(array.attrs.get("units", ""))
        for station in job["subset"]["stations"]:
            point = nearest_point(array, station["latitude"], station["longitude"]).compute()
            series = point.to_series().dropna()
            values = series.astype(float)
            output_unit = units
            if variable == "pr" and "s-1" in units:
                if job["source"]["table_id"] == "Amon":
                    day_counts = [getattr(item, "daysinmonth", 30) for item in series.index]
                    values = values * 86400.0 * day_counts
                    output_unit = "mm/month"
                else:
                    values = values * 86400.0
                    output_unit = "mm/day"
            elif variable.startswith("tas") and units.lower() in {"k", "kelvin"}:
                values = values - 273.15
                output_unit = "degC"
            frames.append(pd.DataFrame({
                "station_id": station["station_id"],
                "station_name": station.get("name", station["station_id"]),
                "latitude": station["latitude"],
                "longitude": station["longitude"],
                "source_id": model,
                "date": [str(item)[:10] for item in series.index],
                "value": values.to_numpy(),
                "unit": output_unit,
            }))
        dataset.close()
    if not frames:
        raise WorkerError("No station values were extracted from the downloaded files.")
    return pd.concat(frames, ignore_index=True)


def bias_correct(rows: Any, observations_path: Path, variable: str) -> Any:
    import pandas as pd

    observations = pd.read_csv(observations_path)
    required = {"station_id", "date", "value"}
    if not required <= set(observations.columns):
        raise WorkerError("Observation CSV must contain station_id,date,value columns.")
    observations = observations[list(required)].copy()
    observations["date"] = observations["date"].astype(str).str.slice(0, 10)
    observations["month"] = observations["date"].str.slice(5, 7)
    observations["value"] = pd.to_numeric(observations["value"], errors="coerce")
    corrected = rows.copy()
    corrected["month"] = corrected["date"].str.slice(5, 7)
    for (station_id, model, month), indexes in corrected.groupby(["station_id", "source_id", "month"]).groups.items():
        model_group = corrected.loc[indexes]
        observed = observations[(observations["station_id"] == station_id) & (observations["month"] == month)]
        overlap = model_group.merge(observed, on=["station_id", "date"], suffixes=("_model", "_obs"))
        if overlap.empty:
            continue
        model_mean = overlap["value_model"].mean()
        observed_mean = overlap["value_obs"].mean()
        if variable == "pr":
            factor = 1.0 if not model_mean or math.isnan(model_mean) else max(0.0, min(10.0, observed_mean / model_mean))
            corrected.loc[indexes, "value"] *= factor
        else:
            corrected.loc[indexes, "value"] += observed_mean - model_mean
    return corrected.drop(columns="month")


def aggregate_monthly(rows: Any, variable: str) -> Any:
    rows = rows.copy()
    rows["date"] = rows["date"].str.slice(0, 7)
    keys = ["station_id", "station_name", "latitude", "longitude", "source_id", "date", "unit"]
    operation = "sum" if variable == "pr" else "max" if variable == "tasmax" else "min" if variable == "tasmin" else "mean"
    return rows.groupby(keys, as_index=False, dropna=False)["value"].agg(operation)


def ensemble_rows(rows: Any, job: dict[str, Any]) -> Any:
    import numpy as np
    import pandas as pd

    processing = job["processing"]
    keys = ["station_id", "station_name", "latitude", "longitude", "date", "unit"]
    output = []
    for key, group in rows.groupby(keys, dropna=False):
        values = group["value"].dropna().astype(float).to_numpy()
        if not len(values):
            continue
        method = processing["ensemble_method"]
        if method == "median":
            center = float(np.median(values))
        elif method == "trimmed_mean" and len(values) >= 5:
            center = float(np.mean(np.sort(values)[1:-1]))
        elif method == "weighted_mean":
            weights = processing.get("model_weights") or {}
            applied = np.array([max(0.0, float(weights.get(model, 0))) for model in group["source_id"]])
            center = float(np.average(group["value"].astype(float), weights=applied)) if applied.sum() else float(np.mean(values))
        else:
            center = float(np.mean(values))
        record = dict(zip(keys, key))
        record.update({
            "ensemble_method": method,
            "ensemble_value": center,
            "model_count": len(values),
            "mean": float(np.mean(values)),
            "median": float(np.median(values)),
            "minimum": float(np.min(values)),
            "maximum": float(np.max(values)),
        })
        spread = processing.get("reported_spread")
        if spread in {"p10_p90", "all"}:
            record.update({"p10": float(np.percentile(values, 10)), "p90": float(np.percentile(values, 90))})
        if spread in {"p25_p75", "all"}:
            record.update({"p25": float(np.percentile(values, 25)), "p75": float(np.percentile(values, 75))})
        if spread == "all":
            record["standard_deviation"] = float(np.std(values))
        output.append(record)
    return pd.DataFrame(output)


def process(job: dict[str, Any], files: list[dict[str, Any]], job_dir: Path, observations: Path | None) -> None:
    rows = extract_model_rows(job, files, job_dir)
    if job["processing"]["workflow"] == "monthly_bias_correction":
        if observations is None:
            raise WorkerError("This job requires observations. Run with --observations path/to/observations.csv.")
        rows = bias_correct(rows, observations, job["source"]["variable_id"])
    if job["processing"].get("output_frequency") == "monthly" and job["source"]["table_id"] == "day":
        rows = aggregate_monthly(rows, job["source"]["variable_id"])
    results = job_dir / "results"
    results.mkdir(exist_ok=True)
    rows.to_csv(results / "model_series.csv", index=False)
    ensemble_rows(rows, job).to_csv(results / "ensemble_statistics.csv", index=False)
    write_json(results / "metadata.json", {
        "job": job,
        "completed_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "downloaded_files": len(files),
        "model_rows": len(rows),
        "attribution": "CMIP6 data distributed by ESGF; processing performed locally by DMAP Local Worker.",
    })


def prepare_job(job_path: Path, workspace: Path) -> tuple[dict[str, Any], Path, Path]:
    job = read_json(job_path)
    if not isinstance(job, dict):
        raise WorkerError("The job file must contain one JSON object.")
    validate_job(job)
    job_dir = workspace.resolve() / job["job_id"]
    job_dir.mkdir(parents=True, exist_ok=True)
    job_copy = job_dir / "job.json"
    if job_copy.exists() and read_json(job_copy) != job:
        raise WorkerError("A different job already uses this job_id in the workspace.")
    write_json(job_copy, job)
    return job, job_dir, job_dir / "state.json"


def command_discover(job_path: Path, workspace: Path) -> None:
    job, job_dir, state_path = prepare_job(job_path, workspace)
    write_json(state_path, {"status": "discovering", "updated_at": datetime.now(UTC).isoformat()})
    files = discover(job)
    for item in files:
        item["local_path"] = str(Path("data") / item["source_id"] / item["experiment_id"] / Path(item["title"]).name)
    write_json(job_dir / "discovery.json", files)
    found_models = sorted({item["source_id"] for item in files})
    missing_models = sorted(set(job["source"]["source_ids"]) - set(found_models))
    write_json(state_path, {"status": "discovered", "files": len(files), "bytes": sum(item["size"] for item in files), "found_models": found_models, "missing_models": missing_models, "updated_at": datetime.now(UTC).isoformat()})
    print(f"Discovered {len(files)} files ({sum(item['size'] for item in files) / 1e9:.2f} GB).")
    if missing_models:
        print(f"Warning: no matching files were found for: {', '.join(missing_models)}")


def command_run(job_path: Path, workspace: Path, observations: Path | None, max_download_gb: float) -> None:
    job, job_dir, state_path = prepare_job(job_path, workspace)
    discovery_path = job_dir / "discovery.json"
    if discovery_path.exists():
        files = read_json(discovery_path)
        if not isinstance(files, list):
            raise WorkerError("Stored discovery state is invalid.")
    else:
        command_discover(job_path, workspace)
        files = json.loads(discovery_path.read_text(encoding="utf-8"))
    if not files:
        raise WorkerError("No matching ESGF files were found. Try another member, grid, experiment pair, or model.")
    total_bytes = sum(int(item.get("size") or 0) for item in files)
    if total_bytes > max_download_gb * 1e9:
        raise WorkerError(f"This job would download approximately {total_bytes / 1e9:.2f} GB, above the {max_download_gb:.2f} GB safety limit. Increase --max-download-gb only after checking disk space.")
    for index, item in enumerate(files, start=1):
        destination = job_dir / item["local_path"]
        write_json(state_path, {"status": "downloading", "completed_files": index - 1, "total_files": len(files), "current_file": item["title"], "updated_at": datetime.now(UTC).isoformat()})
        print(f"[{index}/{len(files)}] {item['title']}")
        download_one(item, destination)
    write_json(state_path, {"status": "processing", "completed_files": len(files), "total_files": len(files), "updated_at": datetime.now(UTC).isoformat()})
    process(job, files, job_dir, observations)
    write_json(state_path, {"status": "complete", "results": "results", "updated_at": datetime.now(UTC).isoformat()})
    print(f"Complete. Results: {job_dir / 'results'}")


def serve(workspace: Path, port: int, extra_origins: list[str], max_download_gb: float) -> None:
    allowed_origins = {"https://droughtanalysis.com", "https://www.droughtanalysis.com", *extra_origins}
    active_jobs: set[str] = set()
    active_lock = threading.Lock()

    def origin_allowed(origin: str | None) -> bool:
        if not origin:
            return False
        if origin in allowed_origins:
            return True
        parsed = urllib.parse.urlparse(origin)
        return parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}

    def background_run(job_path: Path, job_id: str) -> None:
        try:
            command_run(job_path, workspace, observations=None, max_download_gb=max_download_gb)
        except Exception as exc:  # state must survive unexpected library failures
            state_path = workspace.resolve() / job_id / "state.json"
            write_json(state_path, {"status": "error", "message": str(exc), "updated_at": datetime.now(UTC).isoformat()})
        finally:
            with active_lock:
                active_jobs.discard(job_id)

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "DMAPLocalWorker/0.1"

        def log_message(self, message: str, *args: Any) -> None:
            print(f"Local API: {message % args}")

        def send_json(self, status: int, payload: Any) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            origin = self.headers.get("Origin")
            if origin_allowed(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:
            origin = self.headers.get("Origin")
            if not origin_allowed(origin):
                self.send_json(403, {"error": "Origin is not allowed."})
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.end_headers()

        def do_GET(self) -> None:
            if not origin_allowed(self.headers.get("Origin")):
                self.send_json(403, {"error": "Origin is not allowed."})
                return
            if self.path == "/health":
                self.send_json(200, {"service": "DMAP Local Worker", "version": "0.1.0", "status": "ready"})
                return
            match = re.fullmatch(r"/jobs/([A-Za-z0-9][A-Za-z0-9._-]{0,127})", self.path)
            if not match:
                self.send_json(404, {"error": "Not found."})
                return
            state_path = workspace.resolve() / match.group(1) / "state.json"
            if not state_path.exists():
                self.send_json(404, {"error": "Job not found."})
                return
            self.send_json(200, read_json(state_path))

        def do_POST(self) -> None:
            if self.path != "/jobs":
                self.send_json(404, {"error": "Not found."})
                return
            if not origin_allowed(self.headers.get("Origin")):
                self.send_json(403, {"error": "Origin is not allowed."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 1_000_000:
                    raise WorkerError("Job body must be between 1 byte and 1 MB.")
                job = json.loads(self.rfile.read(length))
                if not isinstance(job, dict):
                    raise WorkerError("Job body must be a JSON object.")
                validate_job(job)
                if job["processing"]["workflow"] == "monthly_bias_correction":
                    self.send_json(409, {"error": "This job needs a local observation CSV. Download the job and run it manually with --observations."})
                    return
                incoming = workspace.resolve() / "incoming"
                job_path = incoming / f"{job['job_id']}.dmap-job.json"
                write_json(job_path, job)
                with active_lock:
                    if job["job_id"] not in active_jobs:
                        active_jobs.add(job["job_id"])
                        threading.Thread(target=background_run, args=(job_path, job["job_id"]), daemon=True).start()
                self.send_json(202, {"job_id": job["job_id"], "status": "accepted"})
            except (WorkerError, json.JSONDecodeError, ValueError) as exc:
                self.send_json(400, {"error": str(exc)})

    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"DMAP Local Worker is ready at http://127.0.0.1:{port}")
    print("Keep this window open while local ESGF jobs are running.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping DMAP Local Worker.")
    finally:
        server.server_close()


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="dmap-worker", description="Download and process a DMAP ESGF job locally.")
    commands = result.add_subparsers(dest="command", required=True)
    for name in ("validate", "discover", "run"):
        command = commands.add_parser(name)
        command.add_argument("job", type=Path)
        if name != "validate":
            command.add_argument("--workspace", type=Path, default=Path("dmap-jobs"))
        if name == "run":
            command.add_argument("--observations", type=Path)
            command.add_argument("--max-download-gb", type=float, default=100.0)
    local_api = commands.add_parser("serve")
    local_api.add_argument("--workspace", type=Path, default=Path("dmap-jobs"))
    local_api.add_argument("--port", type=int, default=8766)
    local_api.add_argument("--allow-origin", action="append", default=[])
    local_api.add_argument("--max-download-gb", type=float, default=100.0)
    return result


def main() -> None:
    args = parser().parse_args()
    try:
        if args.command == "serve":
            serve(args.workspace, args.port, args.allow_origin, args.max_download_gb)
        elif args.command == "validate":
            job = read_json(args.job)
            if not isinstance(job, dict):
                raise WorkerError("The job file must contain one JSON object.")
            validate_job(job)
            print("DMAP job is valid.")
        elif args.command == "discover":
            command_discover(args.job, args.workspace)
        else:
            command_run(args.job, args.workspace, args.observations, args.max_download_gb)
    except WorkerError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
