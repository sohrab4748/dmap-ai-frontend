(function () {
  "use strict";

  const stations = [
    { name: "Ames, Iowa", lat: 42.0308, lon: -93.6319, elev: 288 },
    { name: "Tucson, Arizona", lat: 32.2226, lon: -110.9747, elev: 728 },
    { name: "Yuma, Arizona", lat: 32.6927, lon: -114.6277, elev: 43 }
  ];
  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const CLIMATE_API = "https://climate-api.open-meteo.com/v1/climate";
  const CLIMATE_DOCS = "https://open-meteo.com/en/docs/climate-api";
  const LOCAL_WORKER_API = "http://127.0.0.1:8766";
  const FREE_HOURLY_API_LIMIT = 5000;
  const SAFE_REQUEST_API_LIMIT = 4500;
  const climateResponseCache = new Map();
  const VARIABLE_RULES = {
    precipitation_sum: { label: "Precipitation", unit: "mm", monthly: "sum", esgf: "pr" },
    temperature_2m_mean: { label: "Mean temperature", unit: "°C", monthly: "mean", esgf: "tas" },
    temperature_2m_max: { label: "Maximum temperature", unit: "°C", monthly: "max", esgf: "tasmax" },
    temperature_2m_min: { label: "Minimum temperature", unit: "°C", monthly: "min", esgf: "tasmin" }
  };
  const ESGF_MODEL_IDS = {
    CMCC_CM2_VHR4: "CMCC-CM2-VHR4",
    FGOALS_f3_H: "FGOALS-f3-H",
    HiRAM_SIT_HR: "HiRAM-SIT-HR",
    MRI_AGCM3_2_S: "MRI-AGCM3-2-S",
    EC_Earth3P_HR: "EC-Earth3P-HR",
    MPI_ESM1_2_XR: "MPI-ESM1-2-XR",
    NICAM16_8S: "NICAM16-8S"
  };
  let resultState = { modelRows: [], ensembleRows: [], metadata: null };
  let localJobPollTimer = null;

  function selectedValue(name) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value || "";
  }

  function selectedModels() {
    return $$("#model-grid input:checked").map(input => input.value);
  }

  function modelLabel(model) {
    const input = $$("#model-grid input").find(item => item.value === model);
    return input?.closest(".model")?.querySelector("strong")?.textContent || model;
  }

  function ensembleMethodLabel() {
    return $("#ensemble-method").selectedOptions[0]?.textContent || "Equal-weight mean";
  }

  function modelWeights() {
    return Object.fromEntries($$("#model-weights input[data-model]").map(input => [input.dataset.model, Math.max(0, Number(input.value) || 0)]));
  }

  function renderModelWeights() {
    const previous = modelWeights();
    $("#model-weights").innerHTML = selectedModels().map(model => `
      <label>${escapeHtml(modelLabel(model))}<input type="number" min="0" step="0.1" value="${previous[model] ?? 1}" data-model="${escapeHtml(model)}" aria-label="Weight for ${escapeHtml(modelLabel(model))}"></label>`).join("");
  }

  function updateEnsembleMethod() {
    const weighted = $("#ensemble-method").value === "weighted_mean";
    $("#weights-panel").classList.toggle("show", weighted);
    if (weighted) renderModelWeights();
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value);
    return div.innerHTML;
  }

  function renderStations() {
    $("#station-rows").innerHTML = stations.map((station, index) => `
      <tr>
        <td><strong>${escapeHtml(station.name)}</strong></td>
        <td>${Number(station.lat).toFixed(4)}</td>
        <td>${Number(station.lon).toFixed(4)}</td>
        <td>${station.elev === "" || station.elev == null ? "—" : `${Number(station.elev).toFixed(0)} m`}</td>
        <td><button class="remove" type="button" data-remove="${index}" aria-label="Remove ${escapeHtml(station.name)}">×</button></td>
      </tr>`).join("");
    $("#station-count-badge").textContent = `${stations.length} station${stations.length === 1 ? "" : "s"}`;
    updateSummary();
  }

  function updatePhase() {
    const phase = selectedValue("phase");
    $("#availability-note").innerHTML = phase === "CMIP7"
      ? "<strong>CMIP7 catalogue mode:</strong> live downloads are not enabled yet because model coverage is still emerging. Choose CMIP6 to run a real station request now."
      : "<strong>CMIP6 live source:</strong> Open-Meteo serves seven CMIP6 HighResMIP models at 10 km from 1950–2050. The pathway is approximately high-emissions and cannot be changed in this source.";
    $("#review-button").textContent = phase === "CMIP6" ? "Run CMIP6 request" : "CMIP7 processing coming soon";
    $("#review-button").disabled = phase !== "CMIP6";
    updateSummary();
  }

  function updateWorkflow() {
    $("#obs-panel").classList.toggle("show", selectedValue("workflow") === "Bias-correct, then ensemble");
    updateSummary();
  }

  function updateSummary() {
    const models = selectedModels();
    const startYear = $("#hist-period").value.slice(0, 4);
    const endYear = $("#future-period").value.slice(0, 4);
    $("#summary-stations").textContent = `${stations.length} point${stations.length === 1 ? "" : "s"}`;
    $("#summary-phase").textContent = selectedValue("phase") || "CMIP6";
    $("#summary-variable").textContent = VARIABLE_RULES[$("#variable").value].label;
    $("#summary-scenario").textContent = "HighResMIP provider trajectory";
    $("#summary-models").textContent = `${models.length} model${models.length === 1 ? "" : "s"}`;
    $("#summary-workflow").textContent = selectedValue("workflow");
    $("#summary-period").textContent = startYear && endYear ? `${startYear}–${endYear}` : "—";
    $("#model-count-badge").textContent = `${models.length} selected`;
    $("#series-estimate").textContent = (stations.length * models.length).toLocaleString();
    const apiLoad = estimatedApiLoad();
    $("#api-load-estimate").textContent = Number.isFinite(apiLoad) ? `≈ ${Math.ceil(apiLoad).toLocaleString()}` : "—";
    $("#api-load-note").textContent = Number.isFinite(apiLoad) && apiLoad > SAFE_REQUEST_API_LIMIT
      ? "Reduce the station count or date range before running."
      : `Open-Meteo free limit: ${FREE_HOURLY_API_LIMIT.toLocaleString()} units per hour. Repeated runs on this page reuse downloaded data.`;
    $("#api-load-note").classList.toggle("warning", Number.isFinite(apiLoad) && apiLoad > SAFE_REQUEST_API_LIMIT);
  }

  function estimatedApiLoad() {
    const start = new Date(`${$("#hist-period").value}T00:00:00Z`);
    const end = new Date(`${$("#future-period").value}T00:00:00Z`);
    if (!stations.length || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return NaN;
    const days = Math.floor((end - start) / 86400000) + 1;
    const outputSeriesFactor = Math.max(0.1, selectedModels().length / 10);
    return stations.length * Math.max(1, days / 14) * outputSeriesFactor;
  }

  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error("The CSV needs a header and at least one station.");
    const headers = lines[0].split(",").map(value => value.trim().toLowerCase());
    const index = key => headers.indexOf(key);
    const latIndex = index("latitude");
    const lonIndex = index("longitude");
    if (latIndex < 0 || lonIndex < 0) throw new Error("Include latitude and longitude columns.");
    const nameIndex = index("station_name") >= 0 ? index("station_name") : index("name") >= 0 ? index("name") : index("station_id");
    const elevIndex = index("elevation") >= 0 ? index("elevation") : index("elevation_m");
    return lines.slice(1).map((line, row) => {
      const values = line.split(",").map(value => value.trim().replace(/^"|"$/g, ""));
      const lat = Number(values[latIndex]);
      const lon = Number(values[lonIndex]);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error(`Invalid coordinates on row ${row + 2}.`);
      return { name: nameIndex >= 0 ? values[nameIndex] || `Station ${row + 1}` : `Station ${row + 1}`, lat, lon, elev: elevIndex >= 0 ? values[elevIndex] : "" };
    });
  }

  function requestObject() {
    const corrected = selectedValue("workflow") === "Bias-correct, then ensemble";
    return {
      created_at: new Date().toISOString(),
      stations: stations.map(station => ({ ...station })),
      archive: selectedValue("phase"),
      variable: $("#variable").value,
      frequency: $("#frequency").value,
      pathway: "HighResMIP provider trajectory; approximately high emissions",
      start_date: $("#hist-period").value,
      end_date: $("#future-period").value,
      spatial_product: $("#extraction").value,
      models: selectedModels(),
      workflow: selectedValue("workflow"),
      provider_bias_correction: corrected,
      correction_reference: corrected ? "ERA5-Land" : null,
      correction_method: corrected ? "Monthly linear bias correction" : null,
      ensemble_method: $("#ensemble-method").value,
      ensemble_method_label: ensembleMethodLabel(),
      model_weights: $("#ensemble-method").value === "weighted_mean" ? modelWeights() : null,
      reported_spread: $("#statistics").value,
      provider: "Open-Meteo Climate API",
      provider_documentation: CLIMATE_DOCS,
      source_note: "Processed CMIP6 HighResMIP series; individual ESGF versions, members, and scenarios are not exposed by this provider.",
      attribution: "CMIP6 and Open-Meteo"
    };
  }

  function esgfJobObject() {
    const variable = $("#variable").value;
    const version = $("#esgf-version").value.trim();
    const experimentPair = $("#esgf-experiments").value === "sst"
      ? ["highresSST-present", "highresSST-future"]
      : ["hist-1950", "highres-future"];
    const member = $("#esgf-member").value.trim() || "r1i1p1f1";
    const grid = $("#esgf-grid").value.trim() || "gn";
    const jobId = globalThis.crypto?.randomUUID?.() || `dmap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return {
      schema_version: "1.0",
      job_id: jobId,
      created_at: new Date().toISOString(),
      execution: "local_esgf",
      source: {
        provider: "ESGF",
        project: "CMIP6",
        index_url: "https://esgf-node.llnl.gov/esg-search/search",
        activity_id: "HighResMIP",
        experiment_ids: experimentPair,
        source_ids: selectedModels().map(model => ESGF_MODEL_IDS[model] || model),
        member_id: member,
        grid_label: grid,
        variable_id: VARIABLE_RULES[variable].esgf,
        table_id: $("#frequency").value === "Daily" ? "day" : "Amon",
        frequency: $("#frequency").value === "Daily" ? "day" : "mon",
        latest: !version,
        version: version || null,
        replica: false
      },
      subset: {
        start_date: $("#hist-period").value,
        end_date: $("#future-period").value,
        stations: stations.map((station, index) => ({
          station_id: `station-${index + 1}`,
          name: station.name,
          latitude: Number(station.lat),
          longitude: Number(station.lon),
          elevation_m: station.elev === "" || station.elev == null ? null : Number(station.elev)
        }))
      },
      processing: {
        output_frequency: $("#frequency").value.toLowerCase(),
        workflow: selectedValue("workflow") === "Bias-correct, then ensemble" ? "monthly_bias_correction" : "direct_ensemble",
        observations_required: selectedValue("workflow") === "Bias-correct, then ensemble",
        ensemble_method: $("#ensemble-method").value,
        model_weights: $("#ensemble-method").value === "weighted_mean"
          ? Object.fromEntries(Object.entries(modelWeights()).map(([model, weight]) => [ESGF_MODEL_IDS[model] || model, weight]))
          : null,
        reported_spread: $("#statistics").value
      },
      output: {
        format: "csv",
        keep_downloaded_netcdf: true
      },
      attribution: ["CMIP6", "ESGF"],
      worker: {
        minimum_version: "0.1.0",
        setup_path: "/dmap-local-worker/README.md"
      }
    };
  }

  function validateLocalJob() {
    let message = "";
    const start = $("#hist-period").value;
    const end = $("#future-period").value;
    if (selectedValue("phase") !== "CMIP6") message = "CMIP7 local downloads will be enabled after ESGF publishes stable CMIP7 facets. Choose CMIP6 for now.";
    else if (!stations.length) message = "Add at least one station.";
    else if (!selectedModels().length) message = "Select at least one model.";
    else if (!start || !end || start < "1950-01-01" || end > "2050-01-01" || start > end) message = "Choose dates from 1950-01-01 through 2050-01-01, with the start before the end.";
    else if (!/^[A-Za-z0-9-]+$/.test($("#esgf-member").value.trim())) message = "Enter a valid ESGF member, such as r1i1p1f1.";
    else if (!/^[A-Za-z0-9-]+$/.test($("#esgf-grid").value.trim())) message = "Enter a valid ESGF grid label, such as gn.";
    else if ($("#esgf-version").value.trim() && !/^\d{8}$/.test($("#esgf-version").value.trim())) message = "Enter an eight-digit ESGF version such as 20210308, or leave it blank for the latest version.";
    $("#validation-message").textContent = message;
    $("#validation-message").classList.toggle("show", Boolean(message));
    return !message;
  }

  function downloadEsgfJob() {
    if (!validateLocalJob()) return;
    const job = esgfJobObject();
    downloadFile(JSON.stringify(job, null, 2), `${job.job_id}.dmap-job.json`, "application/json");
    setRunStatus("ESGF local job downloaded. Run it with DMAP Local Worker; the browser can now be closed.", "success");
  }

  function setLocalWorkerStatus(message, kind = "info") {
    const status = $("#local-worker-status");
    status.textContent = message;
    status.classList.toggle("show", Boolean(message));
    status.style.background = kind === "error" ? "#fff0ee" : kind === "success" ? "#e7f6f3" : "#edf5ff";
    status.style.color = kind === "error" ? "#b42318" : kind === "success" ? "#0b5c56" : "#24598c";
  }

  async function pollLocalJob(jobId) {
    clearTimeout(localJobPollTimer);
    try {
      const response = await fetch(`${LOCAL_WORKER_API}/jobs/${encodeURIComponent(jobId)}`);
      const state = await response.json().catch(() => ({}));
      if (response.status === 404) {
        setLocalWorkerStatus("Local job accepted; waiting for discovery to start…");
        localJobPollTimer = setTimeout(() => pollLocalJob(jobId), 1500);
        return;
      }
      if (!response.ok) throw new Error(state.error || "Cannot read local job status.");
      if (state.status === "complete") {
        setLocalWorkerStatus("Local ESGF processing is complete. Results are in the worker's dmap-jobs folder.", "success");
        return;
      }
      if (state.status === "error") {
        setLocalWorkerStatus(`Local job stopped: ${state.message || "Unknown worker error."}`, "error");
        return;
      }
      const progress = state.total_files ? ` ${state.completed_files || 0} of ${state.total_files} files complete.` : "";
      setLocalWorkerStatus(`Local job: ${state.status || "starting"}.${progress}`);
      localJobPollTimer = setTimeout(() => pollLocalJob(jobId), 3000);
    } catch (error) {
      setLocalWorkerStatus(`Local worker connection was lost: ${error.message}`, "error");
    }
  }

  async function sendToLocalWorker() {
    if (!validateLocalJob()) return;
    const button = $("#send-local-worker");
    button.disabled = true;
    setLocalWorkerStatus("Connecting to DMAP Local Worker…");
    try {
      const job = esgfJobObject();
      const response = await fetch(`${LOCAL_WORKER_API}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "The local worker did not accept the job.");
      setLocalWorkerStatus("Local worker accepted the ESGF job. You may close this browser after processing starts.", "success");
      pollLocalJob(payload.job_id);
    } catch (error) {
      setLocalWorkerStatus(`Cannot start the local job: ${error.message} Start “dmap-worker serve”, or download the job for manual execution.`, "error");
    } finally {
      button.disabled = false;
    }
  }

  function validateRequest() {
    let message = "";
    const start = $("#hist-period").value;
    const end = $("#future-period").value;
    if (selectedValue("phase") !== "CMIP6") message = "Choose CMIP6 to run live processing.";
    else if (!stations.length) message = "Add at least one station.";
    else if (stations.length > 25) message = "This first release supports up to 25 stations per request.";
    else if (!selectedModels().length) message = "Select at least one model.";
    else if ($("#ensemble-method").value === "weighted_mean" && Object.values(modelWeights()).reduce((sum, weight) => sum + weight, 0) <= 0) message = "Set at least one model weight greater than zero.";
    else if (!start || !end || start < "1950-01-01" || end > "2050-01-01" || start > end) message = "Choose dates from 1950-01-01 through 2050-01-01, with the start before the end.";
    else if (estimatedApiLoad() > SAFE_REQUEST_API_LIMIT) message = `This request is approximately ${Math.ceil(estimatedApiLoad()).toLocaleString()} API units, above the safe limit of ${SAFE_REQUEST_API_LIMIT.toLocaleString()}. Reduce the station count or date range; one station can request the full period.`;
    $("#validation-message").textContent = message;
    $("#validation-message").classList.toggle("show", Boolean(message));
    return !message;
  }

  function setRunStatus(message, kind = "info") {
    const status = $("#run-status");
    status.textContent = message;
    status.classList.toggle("show", Boolean(message));
    status.style.background = kind === "error" ? "#fff0ee" : kind === "success" ? "#e7f6f3" : "#edf5ff";
    status.style.color = kind === "error" ? "#b42318" : kind === "success" ? "#0b5c56" : "#24598c";
  }

  function percentile(sorted, fraction) {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }

  function round(value, digits = 4) {
    if (!Number.isFinite(value)) return "";
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function aggregateMonthly(rows, rule) {
    const groups = new Map();
    rows.forEach(row => {
      const month = row.date.slice(0, 7);
      const key = `${row.station_index}|${row.model}|${month}`;
      if (!groups.has(key)) groups.set(key, { ...row, date: month, values: [] });
      if (Number.isFinite(row.value)) groups.get(key).values.push(row.value);
    });
    return Array.from(groups.values()).map(group => {
      let value = null;
      if (group.values.length) {
        if (rule === "sum") value = group.values.reduce((sum, item) => sum + item, 0);
        if (rule === "mean") value = group.values.reduce((sum, item) => sum + item, 0) / group.values.length;
        if (rule === "max") value = Math.max(...group.values);
        if (rule === "min") value = Math.min(...group.values);
      }
      delete group.values;
      return { ...group, value: round(value) };
    });
  }

  function calculateEnsemble(rows) {
    const method = $("#ensemble-method").value;
    const weights = modelWeights();
    const spreadMode = $("#statistics").value;
    const groups = new Map();
    rows.forEach(row => {
      const key = `${row.station_index}|${row.date}`;
      if (!groups.has(key)) groups.set(key, { station_index: row.station_index, station_name: row.station_name, latitude: row.latitude, longitude: row.longitude, grid_latitude: row.grid_latitude, grid_longitude: row.grid_longitude, date: row.date, unit: row.unit, values: [] });
      if (row.value !== null && row.value !== "" && Number.isFinite(Number(row.value))) groups.get(key).values.push({ model: row.model, value: Number(row.value) });
    });
    return Array.from(groups.values()).map(group => {
      const entries = group.values;
      const values = entries.map(entry => entry.value).sort((a, b) => a - b);
      const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      const median = percentile(values, .5);
      const trimmedValues = values.length >= 5 ? values.slice(1, -1) : values;
      const trimmedMean = trimmedValues.length ? trimmedValues.reduce((sum, value) => sum + value, 0) / trimmedValues.length : null;
      const weightedEntries = entries.filter(entry => (weights[entry.model] || 0) > 0);
      const weightTotal = weightedEntries.reduce((sum, entry) => sum + weights[entry.model], 0);
      const weightedMean = weightTotal > 0 ? weightedEntries.reduce((sum, entry) => sum + entry.value * weights[entry.model], 0) / weightTotal : null;
      const centers = { equal_mean: mean, median, trimmed_mean: trimmedMean, weighted_mean: weightedMean };
      const variance = values.length && Number.isFinite(mean) ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length : null;
      const output = {
        ...group,
        ensemble_method: ensembleMethodLabel(),
        ensemble_value: round(centers[method]),
        model_count: values.length,
        mean: round(mean),
        median: round(median),
        minimum: round(values[0]),
        maximum: round(values[values.length - 1])
      };
      if (spreadMode === "p10_p90" || spreadMode === "all") {
        output.p10 = round(percentile(values, .1));
        output.p90 = round(percentile(values, .9));
      }
      if (spreadMode === "p25_p75" || spreadMode === "all") {
        output.p25 = round(percentile(values, .25));
        output.p75 = round(percentile(values, .75));
      }
      if (spreadMode === "all") output.standard_deviation = round(variance == null ? null : Math.sqrt(variance));
      delete output.values;
      return output;
    });
  }

  async function fetchClimateData() {
    if (!validateRequest()) return;
    const button = $("#review-button");
    const models = selectedModels();
    const variable = $("#variable").value;
    const rule = VARIABLE_RULES[variable];
    const corrected = selectedValue("workflow") === "Bias-correct, then ensemble";
    const modelRows = [];
    const requestUrls = [];
    button.disabled = true;
    button.textContent = "Retrieving CMIP6 data…";
    $("#results-panel").classList.remove("show");
    setRunStatus("Connecting to the CMIP6 climate-data service…");
    try {
      const chunkSize = 5;
      for (let offset = 0; offset < stations.length; offset += chunkSize) {
        const chunk = stations.slice(offset, offset + chunkSize);
        setRunStatus(`Retrieving stations ${offset + 1}–${Math.min(offset + chunk.length, stations.length)} of ${stations.length}…`);
        const params = new URLSearchParams({
          latitude: chunk.map(station => station.lat).join(","),
          longitude: chunk.map(station => station.lon).join(","),
          start_date: $("#hist-period").value,
          end_date: $("#future-period").value,
          models: models.join(","),
          daily: variable
        });
        if (!corrected) params.set("disable_bias_correction", "true");
        const url = `${CLIMATE_API}?${params}`;
        requestUrls.push(url);
        let payload = climateResponseCache.get(url);
        if (!payload) {
          const response = await fetch(url);
          payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.error) {
            const reason = payload.reason || `Climate service returned HTTP ${response.status}.`;
            if (/hourly api request limit exceeded/i.test(reason)) throw new Error("Open-Meteo's quota for this internet connection is already used. Wait until the next hour, then run a request below the displayed API-load limit. Keep this page open after a successful run so later ensemble changes can reuse the downloaded data.");
            throw new Error(reason);
          }
          climateResponseCache.set(url, payload);
        }
        const locations = Array.isArray(payload) ? payload : [payload];
        locations.forEach((location, locationIndex) => {
          const station = chunk[locationIndex];
          const dates = location.daily?.time || [];
          models.forEach(model => {
            const key = location.daily?.[`${variable}_${model}`] ? `${variable}_${model}` : variable;
            const values = location.daily?.[key] || [];
            dates.forEach((date, dateIndex) => modelRows.push({
              station_index: offset + locationIndex + 1,
              station_name: station.name,
              latitude: station.lat,
              longitude: station.lon,
              station_elevation_m: station.elev === "" ? "" : station.elev,
              grid_latitude: location.latitude,
              grid_longitude: location.longitude,
              grid_elevation_m: location.elevation,
              date,
              model,
              value: Number.isFinite(values[dateIndex]) ? values[dateIndex] : null,
              unit: rule.unit,
              bias_corrected: corrected
            }));
          });
        });
      }
      const finalRows = $("#frequency").value === "Monthly" ? aggregateMonthly(modelRows, rule.monthly) : modelRows;
      const ensembleRows = calculateEnsemble(finalRows);
      resultState = { modelRows: finalRows, ensembleRows, metadata: { ...requestObject(), completed_at: new Date().toISOString(), estimated_api_units: Math.ceil(estimatedApiLoad()), api_requests: requestUrls, model_row_count: finalRows.length, ensemble_row_count: ensembleRows.length } };
      $("#result-row-count").textContent = finalRows.length.toLocaleString();
      $("#results-summary").textContent = `${stations.length} station${stations.length === 1 ? "" : "s"}, ${models.length} model${models.length === 1 ? "" : "s"}, ${$("#frequency").value.toLowerCase()} ${rule.label.toLowerCase()} values, and a ${ensembleMethodLabel().toLowerCase()}.`;
      $("#results-panel").classList.add("show");
      setRunStatus("CMIP6 data retrieved and ensemble statistics calculated.", "success");
      $("#results-tab").disabled = false;
      switchView("results");
      prepareResultsView();
    } catch (error) {
      console.error(error);
      setRunStatus(`Request failed: ${error.message}`, "error");
    } finally {
      button.disabled = selectedValue("phase") !== "CMIP6";
      button.textContent = selectedValue("phase") === "CMIP6" ? "Run CMIP6 request" : "CMIP7 processing coming soon";
    }
  }

  function csvEscape(value) {
    if (value == null) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function rowsToCsv(rows) {
    if (!rows.length) return "";
    const columns = Object.keys(rows[0]);
    return [columns.join(","), ...rows.map(row => columns.map(column => csvEscape(row[column])).join(","))].join("\n");
  }

  function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function switchView(view) {
    const showResults = view === "results";
    $("#request-view").classList.toggle("active", !showResults);
    $("#result-view").classList.toggle("active", showResults);
    $("#request-tab").classList.toggle("active", !showResults);
    $("#results-tab").classList.toggle("active", showResults);
    $("#request-tab").setAttribute("aria-selected", String(!showResults));
    $("#results-tab").setAttribute("aria-selected", String(showResults));
    history.replaceState(null, "", showResults ? "#results" : "#request");
    requestAnimationFrame(() => $(".workspace-tabs").scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function prepareResultsView() {
    const stationSelect = $("#chart-station");
    const seriesSelect = $("#chart-series");
    stationSelect.innerHTML = stations.map((station, index) => `<option value="${index + 1}">${escapeHtml(station.name)}</option>`).join("");
    seriesSelect.innerHTML = `<option value="ensemble">${escapeHtml(ensembleMethodLabel())}</option>${selectedModels().map(model => `<option value="${escapeHtml(model)}">${escapeHtml(modelLabel(model))}</option>`).join("")}`;
    $("#results-tab").disabled = false;
    $("#result-page-summary").textContent = `${stations.length} station${stations.length === 1 ? "" : "s"} · ${selectedModels().length} models · ${VARIABLE_RULES[$("#variable").value].label} · ${$("#frequency").value}`;
    $("#result-method-note").textContent = `${ensembleMethodLabel()} with ${$("#statistics").selectedOptions[0].textContent.toLowerCase()}. ${selectedValue("workflow")}.`;
    requestAnimationFrame(renderResultsChart);
  }

  function chartSeries() {
    const stationIndex = Number($("#chart-station").value);
    const series = $("#chart-series").value;
    if (series === "ensemble") {
      return resultState.ensembleRows.filter(row => row.station_index === stationIndex).map(row => ({ date: row.date, value: Number(row.ensemble_value), unit: row.unit })).filter(row => Number.isFinite(row.value));
    }
    return resultState.modelRows.filter(row => row.station_index === stationIndex && row.model === series).map(row => ({ date: row.date, value: Number(row.value), unit: row.unit })).filter(row => Number.isFinite(row.value));
  }

  function downsampleSeries(rows, maximum = 1200) {
    if (rows.length <= maximum) return rows;
    const step = Math.ceil(rows.length / maximum);
    const sampled = [];
    for (let index = 0; index < rows.length; index += step) {
      const bucket = rows.slice(index, index + step);
      const average = bucket.reduce((sum, row) => sum + row.value, 0) / bucket.length;
      sampled.push({ ...bucket[Math.floor(bucket.length / 2)], value: average });
    }
    return sampled;
  }

  function formatChartValue(value, unit) {
    if (!Number.isFinite(value)) return "—";
    return `${value.toFixed(unit === "mm" ? 2 : 1)} ${unit}`;
  }

  function renderResultsChart() {
    if (!$("#result-view").classList.contains("active")) return;
    const fullRows = chartSeries();
    const rows = downsampleSeries(fullRows);
    const canvas = $("#results-chart");
    const context = canvas.getContext("2d");
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(canvas.clientWidth, 320);
    const height = 390;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!rows.length) {
      context.fillStyle = "#607477";
      context.font = "14px system-ui";
      context.textAlign = "center";
      context.fillText("No values are available for this selection.", width / 2, height / 2);
      return;
    }
    const values = fullRows.map(row => row.value);
    let minimum = Math.min(...values);
    let maximum = Math.max(...values);
    if (minimum === maximum) { minimum -= 1; maximum += 1; }
    const padding = { left: 62, right: 20, top: 24, bottom: 42 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const y = value => padding.top + (maximum - value) / (maximum - minimum) * plotHeight;
    const x = index => padding.left + index / Math.max(rows.length - 1, 1) * plotWidth;
    context.strokeStyle = "#dfe9e7";
    context.fillStyle = "#607477";
    context.lineWidth = 1;
    context.font = "11px system-ui";
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let tick = 0; tick <= 4; tick += 1) {
      const value = minimum + (maximum - minimum) * (4 - tick) / 4;
      const py = padding.top + plotHeight * tick / 4;
      context.beginPath(); context.moveTo(padding.left, py); context.lineTo(width - padding.right, py); context.stroke();
      context.fillText(value.toFixed(1), padding.left - 9, py);
    }
    const fill = context.createLinearGradient(0, padding.top, 0, height - padding.bottom);
    fill.addColorStop(0, "rgba(15,118,110,.22)");
    fill.addColorStop(1, "rgba(15,118,110,.01)");
    context.beginPath();
    rows.forEach((row, index) => index ? context.lineTo(x(index), y(row.value)) : context.moveTo(x(index), y(row.value)));
    context.lineTo(x(rows.length - 1), height - padding.bottom); context.lineTo(padding.left, height - padding.bottom); context.closePath(); context.fillStyle = fill; context.fill();
    context.beginPath();
    rows.forEach((row, index) => index ? context.lineTo(x(index), y(row.value)) : context.moveTo(x(index), y(row.value)));
    context.strokeStyle = "#0f766e"; context.lineWidth = 2; context.lineJoin = "round"; context.stroke();
    context.fillStyle = "#607477"; context.textBaseline = "top";
    const dateIndexes = [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
    dateIndexes.forEach((rowIndex, index) => { context.textAlign = index === 0 ? "left" : index === 2 ? "right" : "center"; context.fillText(rows[rowIndex].date, x(rowIndex), height - padding.bottom + 12); });
    const unit = fullRows[0].unit;
    $("#metric-first").textContent = formatChartValue(fullRows[0].value, unit);
    $("#metric-last").textContent = formatChartValue(fullRows[fullRows.length - 1].value, unit);
    $("#metric-min").textContent = formatChartValue(minimum, unit);
    $("#metric-max").textContent = formatChartValue(maximum, unit);
    $("#chart-title").textContent = `${$("#chart-station").selectedOptions[0].textContent} · ${$("#chart-series").selectedOptions[0].textContent}`;
    $("#chart-range").textContent = `${fullRows[0].date} to ${fullRows[fullRows.length - 1].date}`;
  }

  $("#station-form").addEventListener("submit", event => {
    event.preventDefault();
    stations.push({ name: $("#station-name").value.trim(), lat: Number($("#station-lat").value), lon: Number($("#station-lon").value), elev: $("#station-elev").value });
    event.target.reset();
    renderStations();
  });
  $("#station-rows").addEventListener("click", event => {
    const button = event.target.closest("[data-remove]");
    if (!button) return;
    stations.splice(Number(button.dataset.remove), 1);
    renderStations();
  });
  $("#browse-button").addEventListener("click", () => $("#station-file").click());
  $("#station-file").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    try { stations.splice(0, stations.length, ...parseCsv(await file.text())); renderStations(); } catch (error) { alert(error.message); }
    event.target.value = "";
  });
  const dropzone = $("#dropzone");
  ["dragenter", "dragover"].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove("drag"); }));
  dropzone.addEventListener("drop", async event => {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    try { stations.splice(0, stations.length, ...parseCsv(await file.text())); renderStations(); } catch (error) { alert(error.message); }
  });
  $$("input[name=\"phase\"]").forEach(input => input.addEventListener("change", updatePhase));
  $$("input[name=\"workflow\"]").forEach(input => input.addEventListener("change", updateWorkflow));
  $("#model-grid").addEventListener("change", () => { updateSummary(); renderModelWeights(); });
  $("#toggle-models").addEventListener("click", () => {
    const boxes = $$("#model-grid input");
    const allChecked = boxes.every(box => box.checked);
    boxes.forEach(box => box.checked = !allChecked);
    $("#toggle-models").textContent = allChecked ? "Select all" : "Clear all";
    updateSummary();
    renderModelWeights();
  });
  $("#ensemble-method").addEventListener("change", updateEnsembleMethod);
  ["#variable", "#frequency", "#hist-period", "#future-period"].forEach(selector => {
    $(selector).addEventListener("change", updateSummary);
    $(selector).addEventListener("input", updateSummary);
  });
  $("#review-button").addEventListener("click", fetchClimateData);
  $("#save-button").addEventListener("click", () => { if (validateRequest()) downloadFile(JSON.stringify(requestObject(), null, 2), "dmap-cmip6-request.json", "application/json"); });
  $("#download-esgf-job").addEventListener("click", downloadEsgfJob);
  $("#send-local-worker").addEventListener("click", sendToLocalWorker);
  $("#download-series").addEventListener("click", () => downloadFile(rowsToCsv(resultState.modelRows), "dmap-cmip6-model-series.csv", "text/csv;charset=utf-8"));
  $("#download-ensemble").addEventListener("click", () => downloadFile(rowsToCsv(resultState.ensembleRows), "dmap-cmip6-ensemble-statistics.csv", "text/csv;charset=utf-8"));
  $("#download-metadata").addEventListener("click", () => downloadFile(JSON.stringify(resultState.metadata, null, 2), "dmap-cmip6-metadata.json", "application/json"));
  $("#request-tab").addEventListener("click", () => switchView("request"));
  $("#results-tab").addEventListener("click", () => switchView("results"));
  $("#edit-request-button").addEventListener("click", () => switchView("request"));
  $("#chart-station").addEventListener("change", renderResultsChart);
  $("#chart-series").addEventListener("change", renderResultsChart);
  $("#result-download-series").addEventListener("click", () => downloadFile(rowsToCsv(resultState.modelRows), "dmap-cmip6-model-series.csv", "text/csv;charset=utf-8"));
  $("#result-download-ensemble").addEventListener("click", () => downloadFile(rowsToCsv(resultState.ensembleRows), "dmap-cmip6-ensemble-statistics.csv", "text/csv;charset=utf-8"));
  $("#result-download-metadata").addEventListener("click", () => downloadFile(JSON.stringify(resultState.metadata, null, 2), "dmap-cmip6-metadata.json", "application/json"));
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderResultsChart, 120); });

  renderStations();
  updatePhase();
  updateWorkflow();
  updateEnsembleMethod();
}());
