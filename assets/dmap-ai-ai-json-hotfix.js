(function () {
  "use strict";

  var state = {
    latestChartId: null,
    latest: {
      request: null,
      response: null,
      audit: null
    },
    byChart: {},
    shown: "request"
  };

  window.dmapAiAuditByChart = state.byChart;
  window.dmapLastAiStructuredRequest = null;
  window.dmapLastAiResponse = null;
  window.dmapLastAiAudit = null;

  function addStyle() {
    if (document.getElementById("dmapAiAuditStyle")) return;

    var s = document.createElement("style");
    s.id = "dmapAiAuditStyle";
    s.textContent = `
      #resultOutput {
        max-height: none !important;
        min-height: 520px !important;
        overflow: visible !important;
        white-space: pre-wrap !important;
        line-height: 1.7 !important;
        font-size: 14px !important;
      }

      #dmapAiAuditBox pre {
        max-height: 520px !important;
        overflow: auto !important;
        white-space: pre-wrap !important;
      }

      .dmap-ai-export-disabled {
        opacity: 0.55;
      }
    `;
    document.head.appendChild(s);
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function isAiInterpretUrl(url) {
    return typeof url === "string" && (
      url.indexOf("/analysis/ai_interpret") !== -1 ||
      url.indexOf("/api/analysis/ai_interpret") !== -1
    );
  }

  function getFetchUrl(input) {
    if (typeof input === "string") return input;
    if (input && input.url) return input.url;
    return "";
  }

  function getFetchBody(init) {
    try {
      if (!init || typeof init.body !== "string") return null;
      return JSON.parse(init.body);
    } catch (e) {
      return null;
    }
  }

  function cleanModelResponse(data) {
    if (!data || typeof data !== "object") return data;

    var copy = JSON.parse(JSON.stringify(data));
    delete copy._dmap_ai_audit;
    delete copy.audit;
    return copy;
  }

  function getChartIdFromPayload(payload) {
    if (!payload || typeof payload !== "object") return "unknown_chart";
    return String(payload.selected_chart_id || "unknown_chart")
      .replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function getChartIdFromResponse(data) {
    if (!data || typeof data !== "object") return null;

    if (data._dmap_ai_audit && data._dmap_ai_audit.selected_chart_id) {
      return String(data._dmap_ai_audit.selected_chart_id).replace(/[^a-zA-Z0-9_-]/g, "_");
    }

    if (data.audit && data.audit.selected_chart_id) {
      return String(data.audit.selected_chart_id).replace(/[^a-zA-Z0-9_-]/g, "_");
    }

    return null;
  }

  function ensureChartRecord(chartId) {
    if (!state.byChart[chartId]) {
      state.byChart[chartId] = {
        request: null,
        response: null,
        audit: null
      };
    }

    return state.byChart[chartId];
  }

  function ensureAiAuditBox() {
    addStyle();

    var panel = document.getElementById("panel-ai");
    if (!panel) return;

    var box = document.getElementById("dmapAiAuditBox");
    if (box) return;

    box = document.createElement("div");
    box.id = "dmapAiAuditBox";
    box.className = "card p-4 mt-4";
    box.innerHTML = `
      <h4 class="font-medium mb-2">AI request/audit JSON for research</h4>

      <p class="text-xs text-slate-500 leading-relaxed mb-3">
        This section stores the structured request sent to the AI endpoint and the returned response/audit.
        For the paper, run AI interpretation separately for severity and global wavelet spectrum before exporting.
      </p>

      <div class="flex flex-wrap items-center gap-2 mb-3">
        <button type="button" data-ai-audit-view="request"
          class="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-100">
          Structured request
        </button>

        <button type="button" data-ai-audit-view="audit"
          class="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-100">
          Backend audit / prompt
        </button>

        <button type="button" data-ai-audit-view="response"
          class="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-100">
          Model response only
        </button>

        <button type="button" id="copyAiAuditJsonBtn"
          class="px-3 py-1.5 rounded-lg text-xs font-medium border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100">
          Copy shown
        </button>
      </div>

      <div id="aiAuditStatus" class="text-xs text-slate-500 mb-2">
        No AI request captured yet.
      </div>

      <pre id="aiAuditOutput"
        class="text-xs leading-snug bg-slate-950 text-slate-100 p-3 rounded-lg border border-slate-800 overflow-auto whitespace-pre">
AI request/audit JSON will appear here after requesting AI interpretation.
      </pre>
    `;

    var resultOutput = document.getElementById("resultOutput");
    var parentCard = resultOutput ? resultOutput.closest(".card") : null;

    if (parentCard && parentCard.parentNode) {
      parentCard.parentNode.insertBefore(box, parentCard.nextSibling);
    } else {
      panel.appendChild(box);
    }

    box.addEventListener("click", function (e) {
      var viewBtn = e.target.closest("[data-ai-audit-view]");
      if (viewBtn) {
        renderAiAudit(viewBtn.getAttribute("data-ai-audit-view"));
        return;
      }

      if (e.target.id === "copyAiAuditJsonBtn") {
        var out = document.getElementById("aiAuditOutput");
        if (out) {
          navigator.clipboard.writeText(out.textContent || "");
          var st = document.getElementById("aiAuditStatus");
          if (st) st.textContent = "Copied shown AI request/audit JSON.";
        }
      }
    });
  }

  function setStatus(message) {
    ensureAiAuditBox();
    var st = document.getElementById("aiAuditStatus");
    if (st && message) st.textContent = message;
  }

  function renderAiAudit(kind) {
    ensureAiAuditBox();
    state.shown = kind;

    var out = document.getElementById("aiAuditOutput");
    if (!out) return;

    var record = state.latest || {};
    var data = null;

    if (kind === "request") {
      data = record.request;
    } else if (kind === "audit") {
      data = record.audit;
    } else if (kind === "response") {
      data = cleanModelResponse(record.response);
    }

    if (!data) {
      out.textContent = "No data captured for: " + kind;
    } else if (typeof data === "string") {
      out.textContent = data;
    } else {
      out.textContent = JSON.stringify(data, null, 2);
    }
  }

  function updateExportAiAvailability() {
    var hasAnyAi = Object.keys(state.byChart).length > 0;

    document.querySelectorAll(
      '.export-item-checkbox[value="json_ai_request"],' +
      '.export-item-checkbox[value="json_ai_audit"],' +
      '.export-item-checkbox[value="json_ai_response"]'
    ).forEach(function (input) {
      input.disabled = !hasAnyAi;
      input.closest("label")?.classList.toggle("dmap-ai-export-disabled", !hasAnyAi);
    });
  }

  function captureRequest(payload) {
    if (!payload) return;

    var chartId = getChartIdFromPayload(payload);
    var record = ensureChartRecord(chartId);

    record.request = payload;
    state.latestChartId = chartId;
    state.latest = record;

    window.dmapLastAiStructuredRequest = payload;

    setStatus("Captured structured AI request for chart: " + chartId + ". Waiting for model response...");
    renderAiAudit("request");
    updateExportAiAvailability();
  }

  function captureResponse(data) {
    if (!data) return;

    var chartId = getChartIdFromResponse(data) || state.latestChartId || "unknown_chart";
    var record = ensureChartRecord(chartId);

    record.response = cleanModelResponse(data);

    var audit =
      data._dmap_ai_audit ||
      data.audit ||
      {
        note: "Backend did not return _dmap_ai_audit. Full model response is available.",
        possible_fix: "Confirm ai_routes.py returns _dmap_ai_audit with structured_request, normalized request, and prompt_text."
      };

    record.audit = audit;

    state.latestChartId = chartId;
    state.latest = record;

    window.dmapLastAiResponse = record.response;
    window.dmapLastAiAudit = record.audit;

    setStatus("Captured AI response/audit for chart: " + chartId + ".");
    renderAiAudit(state.shown || "request");
    updateExportAiAvailability();
  }

  function patchFetch() {
    if (!window.fetch || window.__dmapAiAuditPatchInstalled) return;
    window.__dmapAiAuditPatchInstalled = true;

    var originalFetch = window.fetch.bind(window);

    window.fetch = function (input, init) {
      var url = getFetchUrl(input);
      var body = getFetchBody(init);

      if (isAiInterpretUrl(url)) {
        captureRequest(body);
      }

      return originalFetch(input, init).then(function (response) {
        if (isAiInterpretUrl(url)) {
          response.clone().text().then(function (txt) {
            captureResponse(safeJsonParse(txt) || { raw_response_text: txt });
          }).catch(function () {});
        }

        return response;
      });
    };
  }

  function addExportOptions() {
    var dropdown = document.getElementById("exportItemMultiSelectDropdown");
    if (!dropdown) return;

    if (dropdown.querySelector('[value="json_ai_request"]')) {
      updateExportAiAvailability();
      return;
    }

    var holder = dropdown.querySelector(".p-2") || dropdown;
    var div = document.createElement("div");
    div.innerHTML = `
      <div class="px-2 pt-2 pb-0.5 text-xs font-bold uppercase tracking-wide text-slate-400">AI audit — available after AI interpretation</div>

      <label class="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 dmap-ai-export-disabled">
        <input type="checkbox" class="export-item-checkbox" value="json_ai_request" checked disabled>
        <span>AI structured request JSON — after AI interpretation</span>
      </label>

      <label class="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 dmap-ai-export-disabled">
        <input type="checkbox" class="export-item-checkbox" value="json_ai_audit" checked disabled>
        <span>AI backend audit / prompt JSON — after AI interpretation</span>
      </label>

      <label class="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 dmap-ai-export-disabled">
        <input type="checkbox" class="export-item-checkbox" value="json_ai_response" checked disabled>
        <span>AI model response JSON only — after AI interpretation</span>
      </label>
    `;
    holder.appendChild(div);

    updateExportAiAvailability();
  }

  function patchZipExport() {
    if (!window.JSZip || !window.JSZip.prototype || window.__dmapAiZipPatchInstalled) return;
    window.__dmapAiZipPatchInstalled = true;

    var originalGenerateAsync = window.JSZip.prototype.generateAsync;

    window.JSZip.prototype.generateAsync = function () {
      try {
        var selected = Array.prototype.slice.call(
          document.querySelectorAll(".export-item-checkbox:checked")
        ).map(function (x) { return x.value; });

        Object.keys(state.byChart).forEach(function (chartId) {
          var record = state.byChart[chartId] || {};
          var base = "ai/" + chartId + "/";

          if (selected.indexOf("json_ai_request") !== -1 && record.request) {
            this.file(base + "ai_structured_request.json", JSON.stringify(record.request, null, 2));
          }

          if (selected.indexOf("json_ai_audit") !== -1 && record.audit) {
            this.file(base + "ai_backend_audit_prompt.json", JSON.stringify(record.audit, null, 2));
          }

          if (selected.indexOf("json_ai_response") !== -1 && record.response) {
            this.file(base + "ai_model_response.json", JSON.stringify(cleanModelResponse(record.response), null, 2));
          }
        }, this);

      } catch (e) {
        console.warn("AI audit export patch failed:", e);
      }

      return originalGenerateAsync.apply(this, arguments);
    };
  }

  function removeOldAiJsonTabIfPresent() {
    var oldBtn = document.getElementById("aiJsonTabButton");
    if (oldBtn && oldBtn.parentNode) oldBtn.parentNode.removeChild(oldBtn);

    var oldPanel = document.getElementById("panel-ai-json");
    if (oldPanel && oldPanel.parentNode) oldPanel.parentNode.removeChild(oldPanel);
  }

  function init() {
    removeOldAiJsonTabIfPresent();
    addStyle();
    ensureAiAuditBox();
    patchFetch();
    addExportOptions();
    patchZipExport();

    setInterval(function () {
      removeOldAiJsonTabIfPresent();
      ensureAiAuditBox();
      addExportOptions();
      patchZipExport();
    }, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
