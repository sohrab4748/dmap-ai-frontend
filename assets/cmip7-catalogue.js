(function () {
  "use strict";

  const SEARCH_ENDPOINT = "https://metagrid-ceda.east.esgf.io/proxy/search";
  const MAX_RECORDS = 1000;
  const $ = selector => document.querySelector(selector);
  const filterMap = {
    "filter-model": "source_id",
    "filter-experiment": "experiment_id",
    "filter-variable": "variable_id",
    "filter-frequency": "frequency",
    "filter-realm": "realm",
    "filter-grid": "grid_label"
  };
  let catalogue = [];
  let totalFound = 0;

  function first(record, key) {
    const value = record?.[key];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
  }

  function escapeAttribute(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function uniqueValues(key) {
    return [...new Set(catalogue.map(record => String(first(record, key))).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  }

  function populateFilters() {
    Object.entries(filterMap).forEach(([id, key]) => {
      const select = $(`#${id}`);
      const previous = select.value;
      const allLabel = select.options[0].textContent;
      select.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>` + uniqueValues(key)
        .map(value => `<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`).join("");
      if ([...select.options].some(option => option.value === previous)) select.value = previous;
    });
  }

  function visibleRecords() {
    return catalogue.filter(record => Object.entries(filterMap).every(([id, key]) => {
      const requested = $(`#${id}`).value;
      return !requested || String(first(record, key)) === requested;
    }));
  }

  function dateOnly(value) {
    return value ? String(value).slice(0, 10) : "—";
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
  }

  function renderMetrics() {
    $("#metric-datasets").textContent = totalFound.toLocaleString();
    $("#metric-models").textContent = uniqueValues("source_id").length.toLocaleString();
    $("#metric-experiments").textContent = uniqueValues("experiment_id").length.toLocaleString();
    $("#metric-variables").textContent = uniqueValues("variable_id").length.toLocaleString();
  }

  function renderTable() {
    const records = visibleRecords();
    const limited = totalFound > catalogue.length;
    $("#result-summary").textContent = `${records.length.toLocaleString()} matching record${records.length === 1 ? "" : "s"}` +
      (limited ? ` in the first ${catalogue.length.toLocaleString()} of ${totalFound.toLocaleString()} returned by the index.` : ` from ${totalFound.toLocaleString()} published dataset${totalFound === 1 ? "" : "s"}.`);
    $("#download-csv").disabled = !records.length;
    $("#download-json").disabled = !catalogue.length;

    if (!records.length) {
      $("#catalogue-rows").innerHTML = '<tr><td colspan="10" class="empty">No published dataset matches these filters.</td></tr>';
      return;
    }

    $("#catalogue-rows").innerHTML = records.map(record => {
      const variable = first(record, "variable_id") || first(record, "variable");
      const branded = first(record, "branded_variable");
      const longName = first(record, "variable_long_name");
      const start = dateOnly(first(record, "datetime_start"));
      const end = dateOnly(first(record, "datetime_end"));
      return `<tr>
        <td><strong>${escapeHtml(first(record, "source_id") || "—")}</strong><span class="small">${escapeHtml(first(record, "institution_id"))}</span></td>
        <td>${escapeHtml(first(record, "experiment_id") || "—")}<span class="small">${escapeHtml(first(record, "activity_id"))}</span></td>
        <td><strong>${escapeHtml(variable || "—")}</strong><span class="small">${escapeHtml(longName || branded)}</span></td>
        <td>${escapeHtml(first(record, "frequency") || "—")}</td>
        <td>${escapeHtml(first(record, "realm") || "—")}</td>
        <td>${escapeHtml(first(record, "grid_label") || "—")}<span class="small">${escapeHtml(first(record, "nominal_resolution"))}</span></td>
        <td>${escapeHtml(first(record, "version") || "—")}</td>
        <td>${escapeHtml(start)}<span class="small">to ${escapeHtml(end)}</span></td>
        <td>${Number(first(record, "number_of_files") || 0).toLocaleString()}<span class="small">${escapeHtml(formatBytes(first(record, "size")))}</span></td>
        <td>${escapeHtml(first(record, "data_node") || "—")}</td>
      </tr>`;
    }).join("");
  }

  function searchUrl() {
    const parameters = new URLSearchParams({
      project: "CMIP7",
      offset: "0",
      limit: String(MAX_RECORDS),
      type: "Dataset",
      format: "application/solr+json",
      facets: "activity_id,data_node,source_id,institution_id,experiment_id,variant_label,grid_label,nominal_resolution,frequency,realm,variable_id,branded_variable,version",
      latest: "true",
      replica: "false",
      query: "*"
    });
    return `${SEARCH_ENDPOINT}?${parameters}`;
  }

  async function refreshCatalogue() {
    const button = $("#refresh-catalogue");
    button.disabled = true;
    button.textContent = "Checking ESGF…";
    $("#live-badge").innerHTML = '<span class="dot"></span>Connecting to ESGF';
    $("#catalogue-notice").classList.remove("error");
    $("#catalogue-notice").innerHTML = "<strong>Reading current publications.</strong> Results may take a few seconds while the distributed index responds.";

    try {
      const response = await fetch(searchUrl(), { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`ESGF returned HTTP ${response.status}`);
      const payload = await response.json();
      catalogue = Array.isArray(payload?.response?.docs) ? payload.response.docs : [];
      totalFound = Number(payload?.response?.numFound) || catalogue.length;
      populateFilters();
      renderMetrics();
      renderTable();
      const checked = new Date();
      $("#checked-at").textContent = `Checked ${checked.toLocaleString()}`;
      $("#live-badge").innerHTML = '<span class="dot"></span>Live ESGF response';
      $("#catalogue-notice").innerHTML = totalFound
        ? `<strong>CMIP7 model output is present.</strong> ${totalFound.toLocaleString()} latest, non-replica dataset record${totalFound === 1 ? " is" : "s are"} currently indexed. Sparse results are real publication status, not a DMAP error.`
        : "<strong>No CMIP7 model-output record was returned.</strong> The index may be updating or temporarily unavailable; refresh later and compare with MetaGrid.";
    } catch (error) {
      catalogue = [];
      totalFound = 0;
      renderMetrics();
      renderTable();
      $("#live-badge").innerHTML = '<span class="dot"></span>ESGF unavailable';
      $("#catalogue-notice").classList.add("error");
      $("#catalogue-notice").innerHTML = `<strong>The catalogue could not be read.</strong> ${escapeHtml(error.message)}. This can be a temporary ESGF-node or browser-network issue; it is unrelated to the Open-Meteo quota.`;
      $("#checked-at").textContent = "Check failed";
    } finally {
      button.disabled = false;
      button.textContent = "Refresh live catalogue";
    }
  }

  function csvCell(value) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
  }

  function download(content, filename, type) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type }));
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function downloadCsv() {
    const keys = ["source_id", "institution_id", "activity_id", "experiment_id", "variant_label", "variable_id", "branded_variable", "variable_long_name", "frequency", "realm", "grid_label", "nominal_resolution", "version", "datetime_start", "datetime_end", "number_of_files", "size", "data_node", "id"];
    const lines = [keys.map(csvCell).join(",")];
    visibleRecords().forEach(record => lines.push(keys.map(key => csvCell(first(record, key))).join(",")));
    download(lines.join("\r\n"), "dmap-cmip7-visible-catalogue.csv", "text/csv;charset=utf-8");
  }

  function resetFilters() {
    Object.keys(filterMap).forEach(id => { $(`#${id}`).value = ""; });
    renderTable();
  }

  Object.keys(filterMap).forEach(id => $(`#${id}`).addEventListener("change", renderTable));
  $("#refresh-catalogue").addEventListener("click", refreshCatalogue);
  $("#reset-filters").addEventListener("click", resetFilters);
  $("#download-csv").addEventListener("click", downloadCsv);
  $("#download-json").addEventListener("click", () => download(JSON.stringify({ checked_at: new Date().toISOString(), source: searchUrl(), total_found: totalFound, datasets: catalogue }, null, 2), "dmap-cmip7-catalogue.json", "application/json"));

  refreshCatalogue();
}());
