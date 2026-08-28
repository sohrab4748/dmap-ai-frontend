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
  const VARIABLE_RULES = {
    precipitation_sum: { label: "Precipitation", unit: "mm", monthly: "sum" },
    temperature_2m_mean: { label: "Mean temperature", unit: "°C", monthly: "mean" },
    temperature_2m_max: { label: "Maximum temperature", unit: "°C", monthly: "max" },
    temperature_2m_min: { label: "Minimum temperature", unit: "°C", monthly: "min" }
  };
  let resultState = { modelRows: [], ensembleRows: [], metadata: null };

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
        const response = await fetch(url);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.error) throw new Error(payload.reason || `Climate service returned HTTP ${response.status}.`);
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
      resultState = { modelRows: finalRows, ensembleRows, metadata: { ...requestObject(), completed_at: new Date().toISOString(), api_requests: requestUrls, model_row_count: finalRows.length, ensemble_row_count: ensembleRows.length } };
      $("#result-row-count").textContent = finalRows.length.toLocaleString();
      $("#results-summary").textContent = `${stations.length} station${stations.length === 1 ? "" : "s"}, ${models.length} model${models.length === 1 ? "" : "s"}, ${$("#frequency").value.toLowerCase()} ${rule.label.toLowerCase()} values, and a ${ensembleMethodLabel().toLowerCase()}.`;
      $("#results-panel").classList.add("show");
      setRunStatus("CMIP6 data retrieved and ensemble statistics calculated.", "success");
      $("#outputs").scrollIntoView({ behavior: "smooth", block: "start" });
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
  ["#variable", "#frequency", "#hist-period", "#future-period"].forEach(selector => $(selector).addEventListener("change", updateSummary));
  $("#review-button").addEventListener("click", fetchClimateData);
  $("#save-button").addEventListener("click", () => { if (validateRequest()) downloadFile(JSON.stringify(requestObject(), null, 2), "dmap-cmip6-request.json", "application/json"); });
  $("#download-series").addEventListener("click", () => downloadFile(rowsToCsv(resultState.modelRows), "dmap-cmip6-model-series.csv", "text/csv;charset=utf-8"));
  $("#download-ensemble").addEventListener("click", () => downloadFile(rowsToCsv(resultState.ensembleRows), "dmap-cmip6-ensemble-statistics.csv", "text/csv;charset=utf-8"));
  $("#download-metadata").addEventListener("click", () => downloadFile(JSON.stringify(resultState.metadata, null, 2), "dmap-cmip6-metadata.json", "application/json"));

  renderStations();
  updatePhase();
  updateWorkflow();
  updateEnsembleMethod();
}());
