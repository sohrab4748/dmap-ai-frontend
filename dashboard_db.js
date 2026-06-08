(function () {
  let projectsCache = [];
  let runsCache = [];

  function apiBase() {
    return window.API_BASE || (window.location.origin + "/api");
  }

  function token() {
    if (typeof window.getAuthToken === "function") return window.getAuthToken();
    return localStorage.getItem("dmapai_auth_token") || "";
  }

  function headers(extra) {
    if (typeof window.authHeaders === "function") return window.authHeaders(extra || {});
    const h = extra ? Object.assign({}, extra) : {};
    if (token()) h["Authorization"] = "Bearer " + token();
    return h;
  }

  async function dmapApi(path, options) {
    options = options || {};
    options.headers = headers(options.headers || {});
    const resp = await fetch(apiBase() + path, options);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data?.detail?.message || data?.detail || ("Request failed: " + resp.status);
      throw new Error((typeof msg === "string" ? msg : JSON.stringify(msg)) + " [" + path + "]");
    }
    return data;
  }

  function esc(x) {
    return String(x == null ? "" : x)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizeDatasource(code) {
    code = String(code || "nasa_power").toLowerCase();
    if (code === "nasa" || code === "power" || code === "nasa-power") return "nasa_power";
    if (code === "era5_land_cds" || code === "era5-land-cds" || code === "era5land" || code === "cds") return "era5";
    if (code === "era5") return "era5";
    return code;
  }

  function dsLabel(code) {
    code = normalizeDatasource(code);
    if (code === "nasa_power") return "NASA POWER";
    if (code === "era5") return "ERA5-Land / CDS";
    if (code === "gridmet") return "GridMET";
    if (code === "prism") return "PRISM";
    if (code === "gpm") return "GPM";
    if (code === "user") return "User upload";
    return code || "NASA POWER";
  }

  function detachOldDashboardHandlers() {
    const oldBtn = document.getElementById("saveRunBtn");
    if (oldBtn && oldBtn.parentNode) {
      const newBtn = oldBtn.cloneNode(true);
      oldBtn.parentNode.replaceChild(newBtn, oldBtn);
      window.saveRunBtn = newBtn;
    }

    const oldList = document.getElementById("dashboardList");
    if (oldList && oldList.parentNode) {
      const newList = oldList.cloneNode(false);
      oldList.parentNode.replaceChild(newList, oldList);
      window.dashboardList = newList;
    }
  }

  function updateDashboardText() {
    const card = document.getElementById("dashboardCard");
    if (!card) return;
    const p = card.querySelector("p.muted");
    if (p) {
      p.textContent = "Saved SPI runs are stored in your DMAP-AI account. Select a run to reload it.";
    }
  }

  window.getUserRuns = function () {
    return runsCache || [];
  };

  window.setUserRuns = function (runs) {
    runsCache = Array.isArray(runs) ? runs : [];
  };

  window.renderDashboard = function () {
    const list = document.getElementById("dashboardList");
    const empty = document.getElementById("dashboardEmpty");
    if (!list || !empty) return;

    list.innerHTML = "";

    if (!token()) {
      empty.textContent = "Please sign in with Google to see your saved runs.";
      empty.classList.remove("hidden");
      return;
    }

    if (!runsCache.length) {
      empty.textContent = "No saved runs yet. Run SPI and click “Save current run”.";
      empty.classList.remove("hidden");
      return;
    }

    empty.classList.add("hidden");

    runsCache
      .slice()
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
      .forEach((run) => {
        const div = document.createElement("div");
        div.className = "border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50";

        div.innerHTML =
          '<div class="flex items-start justify-between gap-3">' +
            '<div class="min-w-0">' +
              '<div class="font-medium truncate">' + esc(run.title || "Saved SPI run") + '</div>' +
              '<div class="text-xs text-slate-500">' +
                'Lat ' + esc(run.lat) + ', Lon ' + esc(run.lon) +
                ' · ' + esc(dsLabel(run.datasource)) +
                ' · ' + esc(run.scale || "yearly") +
              '</div>' +
              '<div class="text-xs text-slate-400 mt-0.5">' +
                esc(run.project_name || "Project") +
                (run.created_at ? " · " + esc(String(run.created_at).replace("T", " ").slice(0, 16)) : "") +
              '</div>' +
            '</div>' +
            '<div class="flex flex-col gap-1 shrink-0">' +
              '<button data-db-action="load" data-id="' + esc(run.id) + '" class="text-xs px-2 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100">Load</button>' +
              '<button data-db-action="delete" data-id="' + esc(run.id) + '" class="text-xs px-2 py-1 rounded-lg border border-rose-200 text-rose-700 bg-white hover:bg-rose-50">Delete</button>' +
            '</div>' +
          '</div>';

        list.appendChild(div);
      });
  };

  window.loadDashboardFromServer = async function () {
    if (!token()) {
      window.renderDashboard();
      return;
    }

    const empty = document.getElementById("dashboardEmpty");
    if (empty) {
      empty.textContent = "Loading saved runs from your DMAP-AI account...";
      empty.classList.remove("hidden");
    }

    try {
      const pr = await dmapApi("/account/projects");
      projectsCache = pr.projects || [];
      const allRuns = [];

      for (const p of projectsCache) {
        const projectKey = p.id || p.project_id;
        const rr = await dmapApi("/account/projects/" + encodeURIComponent(projectKey) + "/runs");
        (rr.runs || []).forEach((r) => {
          allRuns.push(Object.assign({}, r, {
            lat: p.lat,
            lon: p.lon,
            project_name: p.project_name,
            aoi_type: p.aoi_type
          }));
        });
      }

      runsCache = allRuns;
      window.renderDashboard();
    } catch (err) {
      console.error(err);
      if (empty) {
        empty.textContent = "Could not load saved runs: " + (err.message || err);
        empty.classList.remove("hidden");
      }
    }
  };

  async function createOrFindProject(lat, lon, projectName) {
    const latN = parseFloat(lat);
    const lonN = parseFloat(lon);

    const existing = projectsCache.find(p =>
      Math.abs(parseFloat(p.lat) - latN) < 1e-6 &&
      Math.abs(parseFloat(p.lon) - lonN) < 1e-6
    );

    if (existing) return existing;

    const created = await dmapApi("/account/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        lat: latN,
        lon: lonN,
        aoi_type: "point"
      })
    });

    return created.project;
  }

  function buildResultJson(meta, title, projectId) {
    let context = null;
    try {
      if (typeof window.buildJsonContextFromRun === "function") {
        context = window.buildJsonContextFromRun();
      }
    } catch (e) {}

    return {
      app: "DMAP-AI Research Version",
      storage_version: 1,
      saved_at: new Date().toISOString(),
      title: title,
      project_id: projectId,
      meta: {
        lat: meta.lat,
        lon: meta.lon,
        start_date: meta.start_date,
        end_date: meta.end_date,
        baseline: meta.baseline,
        scale: meta.scale || "yearly",
        ywin: meta.ywin || "jan-dec",
        datasource: normalizeDatasource(meta.datasource),
        drought_index: "spi",
        mode: "historical",
        yearly_method: "total"
      },
      series: Array.isArray(window.lastSeries) ? window.lastSeries : [],
      json_context: context
    };
  }

  async function saveCurrentRunToDatabase() {
    if (!token()) {
      alert("Please sign in first.");
      return;
    }

    if (!window.lastSeries || !window.lastSeries.length || !window.lastRunMeta) {
      alert("Run SPI first, then save it.");
      return;
    }

    const meta = window.lastRunMeta;
    const datasource = normalizeDatasource(meta.datasource || "nasa_power");
    const scale = String(meta.scale || "yearly").toLowerCase();
    const allowedDatasource = (datasource === "nasa_power" || datasource === "era5");

    if (!allowedDatasource || scale !== "yearly") {
      alert("DMAP-AI Research Version can save only SPI + NASA POWER or ERA5-Land/CDS + Yearly + Point runs.");
      return;
    }

    const defaultTitle = "SPI Yearly · " + dsLabel(datasource) + " · " + meta.start_date + "–" + meta.end_date;
    const title = (prompt("Name this run:", defaultTitle) || "").trim();
    if (!title) return;

    const defaultProject = "Point " + meta.lat + ", " + meta.lon;
    const projectName = (prompt("Project name:", defaultProject) || "").trim();
    if (!projectName) return;

    const btn = document.getElementById("saveRunBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving...";
    }

    try {
      const project = await createOrFindProject(meta.lat, meta.lon, projectName);
      const projectKey = project.id || project.project_id;
      const resultJson = buildResultJson(meta, title, projectKey);

      await dmapApi("/account/projects/" + encodeURIComponent(projectKey) + "/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title,
          drought_index: "spi",
          datasource: datasource,
          mode: "historical",
          scale: "yearly",
          yearly_method: "total",
          start_date: meta.start_date,
          end_date: meta.end_date,
          baseline: meta.baseline,
          result_json: resultJson
        })
      });

      await window.loadDashboardFromServer();
      alert("Run saved to your DMAP-AI account.");
    } catch (err) {
      console.error(err);
      alert("Could not save run: " + (err.message || err));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Save current run";
      }
    }
  }

  async function loadRunFromDatabase(runId) {
    const data = await dmapApi("/account/runs/" + encodeURIComponent(runId));
    const run = data.run;
    const result = run.result_json || {};
    const meta = result.meta || {};
    const series = Array.isArray(result.series) ? result.series : [];

    document.getElementById("lat").value = meta.lat || run.lat || "";
    document.getElementById("lon").value = meta.lon || run.lon || "";
    document.getElementById("startDate").value = meta.start_date || run.start_date || "";
    document.getElementById("endDate").value = meta.end_date || run.end_date || "";
    document.getElementById("baseline").value = meta.baseline || run.baseline || "";
    const restoredDatasource = normalizeDatasource(meta.datasource || run.datasource || "nasa_power");
    const obsSrcEl = document.getElementById("obsSrc");
    if (obsSrcEl) obsSrcEl.value = restoredDatasource;

    window.lastRunMeta = {
      lat: meta.lat || run.lat,
      lon: meta.lon || run.lon,
      start_date: meta.start_date || run.start_date,
      end_date: meta.end_date || run.end_date,
      baseline: meta.baseline || run.baseline,
      scale: "yearly",
      ywin: "jan-dec",
      datasource: restoredDatasource
    };

    if (series.length) {
      window.lastSeries = series;
      if (typeof window.applySeriesToUI === "function") {
        window.applySeriesToUI(series, "yearly", { series: series, restored_from: "account_database" });
      }
      if (typeof window.computeWaveletFromSeries === "function") {
        window.computeWaveletFromSeries(series);
      }
    } else if (window.runBtn) {
      window.runBtn.click();
    }
  }

  function attachDashboardEvents() {
    const btn = document.getElementById("saveRunBtn");
    if (btn) btn.addEventListener("click", saveCurrentRunToDatabase);

    const list = document.getElementById("dashboardList");
    if (list) {
      list.addEventListener("click", async function (e) {
        const b = e.target.closest("button[data-db-action]");
        if (!b) return;

        const action = b.getAttribute("data-db-action");
        const id = b.getAttribute("data-id");

        try {
          if (action === "delete") {
            if (!confirm("Delete this saved run from your DMAP-AI account?")) return;
            await dmapApi("/account/runs/" + encodeURIComponent(id), { method: "DELETE" });
            await window.loadDashboardFromServer();
          } else if (action === "load") {
            await loadRunFromDatabase(id);
          }
        } catch (err) {
          alert("Dashboard action failed: " + (err.message || err));
        }
      });
    }
  }

  function wrapLoginSuccess() {
    if (typeof window.setUserFromPayload === "function" && !window.__dmapWrappedSetUserPayload) {
      window.__dmapWrappedSetUserPayload = true;
      const old = window.setUserFromPayload;
      window.setUserFromPayload = function (payload) {
        const r = old.apply(this, arguments);
        setTimeout(window.loadDashboardFromServer, 500);
        return r;
      };
    }
  }

  function init() {
    updateDashboardText();
    detachOldDashboardHandlers();
    attachDashboardEvents();
    wrapLoginSuccess();

    setTimeout(window.loadDashboardFromServer, 1500);
    setTimeout(window.loadDashboardFromServer, 3500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
