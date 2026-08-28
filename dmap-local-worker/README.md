# DMAP Local Worker

DMAP Local Worker runs ESGF downloads and climate processing on the user's computer. Downloads are resumable, completed NetCDF files are cached inside the job workspace, and checksums are verified before processing.

## Install

Install Python 3.10 or newer, open a terminal in this folder, and run:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e .
```

On Linux or macOS, activate with `source .venv/bin/activate` instead.

## Run a job

For the easiest workflow, start the local service and keep its terminal window open:

```powershell
dmap-worker serve
```

Return to the DMAP website and choose **Send to DMAP Local Worker**. The website will show discovery, download, and processing progress. The service listens only on `127.0.0.1`; it is not exposed to other computers. Jobs that require an observation CSV must use the manual command below so the website never receives a local file path.

If DMAP is hosted on another development domain, explicitly allow that exact origin when starting the service:

```powershell
dmap-worker serve --allow-origin "https://your-dmap-domain.example"
```

### Manual execution

Download an **ESGF local job** from the DMAP climate workspace, then validate and inspect its download size:

```powershell
dmap-worker validate "C:\path\to\your.dmap-job.json"
dmap-worker discover "C:\path\to\your.dmap-job.json"
```

When the reported size is acceptable, run it:

```powershell
dmap-worker run "C:\path\to\your.dmap-job.json"
```

Interrupted downloads remain as `.part` files. Run the same command again to resume. The default safety limit is 100 GB; after checking free disk space, it can be changed with `--max-download-gb`.

Results are written under `dmap-jobs/<job-id>/results/`:

- `model_series.csv`
- `ensemble_statistics.csv`
- `metadata.json`

## Observation-based correction

If the web job uses **Bias-correct, then ensemble**, provide a local observation CSV:

```powershell
dmap-worker run "C:\path\to\your.dmap-job.json" --observations "C:\path\to\observations.csv"
```

The observation file must contain:

```csv
station_id,date,value
station-1,1981-01-01,2.4
station-1,1981-01-02,0.0
```

The worker applies a calendar-month correction using overlapping dates: multiplicative correction for precipitation and additive correction for temperature.

## Important data-volume note

ESGF commonly distributes complete gridded NetCDF files. Selecting station points reduces the processed output, but it does not necessarily reduce the initial download. Always run `discover` first and review the estimated size.

The worker only accepts DMAP schema `1.0`, the configured official ESGF index, HTTPS file URLs returned by that index, supported CMIP6 HighResMIP facets, and safe local identifiers. It never executes commands contained in a job file and does not send ESGF credentials to DMAP.
