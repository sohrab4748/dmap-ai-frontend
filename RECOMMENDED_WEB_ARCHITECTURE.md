# Recommended web architecture:

DMAP-AI remains a browser-based application. Climate files are not downloaded through the user's browser and users do not install a local worker.

## Request flow

1. The browser submits stations, CMIP release, experiment, scenario, models, members, grid, variable, dates, workflow, and ensemble method to the DMAP API.
2. The API validates the request and creates a background job.
3. An ESGF discovery service searches the federation and selects the requested file versions and replicas.
4. An OPeNDAP extraction service reads model coordinates, maps each station to a grid cell, and requests only the required cells and dates.
5. Extracted station series are cached so matching requests do not contact ESGF again.
6. A processing worker performs aggregation, observation-based correction or downscaling, ensemble calculation, and statistics.
7. The browser polls job status and opens the Results tab when processing is complete.
8. Results are provided as charts, CSV files, metadata, and optional NetCDF packages.

## Server components

- **FastAPI application:** request validation, ESGF catalogue search, job status, and result endpoints.
- **Background queue:** resumable discovery, extraction, processing, and retry tasks.
- **PostgreSQL:** users, jobs, selections, provenance, progress, and result metadata.
- **Redis:** queue coordination, short-lived locks, and rate control.
- **Object storage:** cached station series, observations, intermediate products, and completed packages.
- **Nginx:** HTTPS termination and reverse proxy from the existing site to the API.

## Reliability rules

- Prefer OPeNDAP station/time subsetting over complete NetCDF downloads.
- Cache by dataset version, variable, grid cell, and time range.
- Try a verified ESGF replica when a node or OPeNDAP endpoint fails.
- Fall back to a queued full-file server download only when remote subsetting is unavailable.
- Store dataset identifiers, versions, checksums, source nodes, transformations, and citations with every result.
- Enforce per-user job, storage, and processing limits.
- Never collect or store ESGF passwords. Add delegated OAuth or Globus authentication only for restricted datasets.

## Delivery phases

1. Implement CMIP6 discovery and OPeNDAP extraction for one variable, one station, and one model.
2. Add multiple stations, models, experiment pairs, members, grids, releases, caching, and retry handling.
3. Add ensemble statistics and the existing Results-tab charts and downloads.
4. Add observation upload, validation, bias correction, and downscaling.
5. Add accounts, subscriptions, quotas, saved jobs, notifications, and CMIP7 catalogue adapters.

The optional desktop application is deferred. It should be reconsidered only for workflows that cannot be served reliably through ESGF subsetting or server-side processing.
