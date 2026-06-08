// =============== BASIC CONSTANTS ===============
        var DMAP_DEBUG = false;
        var API_BASE = window.location.origin + "/api";

        // Fetch JSON safely. If Nginx returns an HTML error page such as 504 Gateway Time-out,
        // do not try to parse it as JSON. For slow ERA5/CDS first runs, retry is datasource-aware.
        function sleepMs(ms) {
            return new Promise(function (resolve) { setTimeout(resolve, ms); });
        }

        async function fetchJsonWithRetry(url, fetchOptions, retryOptions) {
            fetchOptions = fetchOptions || {};
            retryOptions = retryOptions || {};

            var retries = retryOptions.retries == null ? 1 : retryOptions.retries;
            var retryDelayMs = retryOptions.retryDelayMs || 30000;
            var lastError = null;

            for (var attempt = 0; attempt <= retries; attempt++) {
                var resp = await fetch(url, fetchOptions);
                var contentType = (resp.headers.get("content-type") || "").toLowerCase();

                if (!resp.ok) {
                    var errorText = await resp.text();

                    if (resp.status === 504 && attempt < retries) {
                        log("Gateway timeout; retrying after wait/cache", {
                            attempt: attempt + 1,
                            retryDelayMs: retryDelayMs
                        });
                        await sleepMs(retryDelayMs);
                        continue;
                    }

                    throw new Error(
                        "Server error " + resp.status + ": " +
                        (errorText || "").replace(/\s+/g, " ").slice(0, 300)
                    );
                }

                if (contentType.indexOf("application/json") !== -1 || contentType.indexOf("text/json") !== -1) {
                    return { resp: resp, data: await resp.json() };
                }

                var textResponse = await resp.text();
                try {
                    return { resp: resp, data: JSON.parse(textResponse) };
                } catch (e) {
                    lastError = new Error(
                        "Server returned non-JSON response: " +
                        (textResponse || "").replace(/\s+/g, " ").slice(0, 300)
                    );
                    throw lastError;
                }
            }

            throw lastError || new Error("Request failed.");
        }

        // Normalize backend SPI responses. Current backend may return rows under
        // series, rows, table, spi_table, or tables.monthly_spi.
        function normalizeSpiRecord(row, scale) {
            row = row || {};
            var out = Object.assign({}, row);

            var dateVal = out.end_date || out.date || out.time || out.timestamp || null;
            if (!dateVal && out.year != null) {
                var m0 = out.month != null ? parseInt(out.month, 10) : 12;
                if (!isFinite(m0) || m0 < 1 || m0 > 12) m0 = 12;
                dateVal = String(out.year) + "-" + String(m0).padStart(2, "0") + "-01";
            }
            out.end_date = dateVal || "";

            if (out.year == null && out.end_date) {
                var yy = parseInt(String(out.end_date).slice(0, 4), 10);
                if (isFinite(yy)) out.year = yy;
            }
            if (out.month == null && out.end_date) {
                var mm = parseInt(String(out.end_date).slice(5, 7), 10);
                if (isFinite(mm)) out.month = mm;
            }

            if (out.window_sum_mm == null) {
                var sumCandidates = [
                    "precip_12month_mm", "precip_12_month_mm", "precip12month_mm", "precip_12month",
                    "precipitation_12month_mm", "yearly_precipitation_mm", "annual_precipitation_mm",
                    "precipitation_mm", "precip_mm", "total_precipitation_mm", "total_mm",
                    "obs_sum_mm", "sum_mm", "window_sum", "sum", "precip_sum"
                ];
                for (var i = 0; i < sumCandidates.length; i++) {
                    var k = sumCandidates[i];
                    if (out[k] != null && out[k] !== "") {
                        var num = (typeof out[k] === "string") ? parseFloat(out[k]) : out[k];
                        if (isFinite(num)) {
                            out.window_sum_mm = num;
                            break;
                        }
                    }
                }
            }

            if (out.spi == null) {
                if (out.mean_spi != null) out.spi = out.mean_spi;
                else if (out.min_spi != null) out.spi = out.min_spi;
            }
            if (out.spi_category == null && out.category != null) {
                out.spi_category = out.category;
            }

            return out;
        }

        function extractSpiSeriesFromResponse(data, scale, ywin) {
            data = data || {};
            var rows = [];

            if (Array.isArray(data.series)) rows = data.series;
            else if (Array.isArray(data.rows)) rows = data.rows;
            else if (Array.isArray(data.table)) rows = data.table;
            else if (Array.isArray(data.spi_table)) rows = data.spi_table;
            else if (data.tables && Array.isArray(data.tables.monthly_spi)) rows = data.tables.monthly_spi;
            else if (data.tables && Array.isArray(data.tables.series)) rows = data.tables.series;
            else if (data.tables && Array.isArray(data.tables.spi_table)) rows = data.tables.spi_table;
            else if (Array.isArray(data.annual)) rows = data.annual;
            else if (data.tables && Array.isArray(data.tables.annual_drought_metrics)) rows = data.tables.annual_drought_metrics;

            rows = rows.map(function (r) { return normalizeSpiRecord(r, scale); });

            if (scale === "yearly" && (!ywin || ywin === "jan-dec")) {
                var decRows = rows.filter(function (r) {
                    var m = r.month != null ? parseInt(r.month, 10) : NaN;
                    if (!isFinite(m) && r.end_date) m = parseInt(String(r.end_date).slice(5, 7), 10);
                    return m === 12;
                });
                if (decRows.length) rows = decRows;
            }

            return rows;
        }



        function getSelectedDroughtIndexSelect() {
            return document.getElementById("droughtIndexSelect");
        }

        function getSelectedDroughtIndexValue() {
            var el = getSelectedDroughtIndexSelect();
            return el ? el.value : "spi";
        }

        function getSelectedDroughtIndexText() {
            var el = getSelectedDroughtIndexSelect();
            if (!el) return "SPI — Standardized Precipitation Index (Free / Available)";
            var opt = el.options[el.selectedIndex];
            return opt ? opt.text : "SPI — Standardized Precipitation Index (Free / Available)";
        }

        function getSelectedDroughtIndexName() {
            var txt = getSelectedDroughtIndexText();
            return txt.split(" (")[0].trim();
        }

        async function runSelectedInterpretation() {
            var cfg = getCurrentPlanConfig();
            if (!cfg.aiEnabled) {
                var lockedMsg = document.getElementById("resultOutput");
                if (lockedMsg) {
                    lockedMsg.textContent = "AI Interpretation is not available for this account.";
                }
                return;
            }

            if (!Array.isArray(lastSeries) || !lastSeries.length) {
                var noRunMsg = document.getElementById("resultOutput");
                if (noRunMsg) {
                    noRunMsg.textContent = "Run the SPI analysis first, then request AI interpretation.";
                }
                return;
            }

            if (!hasAiQuotaAvailable()) {
                return;
            }

            var ok = false;
            try {
                ok = await analyzeChartAutomatic();
                if (ok) {
                    consumeAiQuotaAfterSuccess();
                }
            } finally {
                updateAiQuotaUI();
            }
        }

        function toggleDashboard() {
            // Toggle the dashboard visibility
            document.body.classList.toggle("dashboard-closed");

            // After layout changes, tell Leaflet to recalc map size
            // Use a small timeout so the browser has time to apply the new grid width
            setTimeout(function () {
                try {
                    if (window.map && typeof map.invalidateSize === "function") {
                        map.invalidateSize();
                    }
                } catch (e) {
                    console.warn("Could not invalidate Leaflet map size:", e);
                }
            }, 200);
        }


        // On first load: close dashboard on small screens, keep open on desktop
        document.addEventListener("DOMContentLoaded", function () {
            if (window.innerWidth < 1024) {
                document.body.classList.add("dashboard-closed");
            }
            if (typeof updateAiQuotaUI === "function") updateAiQuotaUI();
            if (typeof updateDashboardUpgradeCard === "function") updateDashboardUpgradeCard();
            if (typeof updateDashboardUpgradeCard === "function") updateDashboardUpgradeCard();
        });

        function buildCurrentJsonContext() {
            // No run yet
            if (!lastSeries || !lastSeries.length) {
                return null;
            }

            var ctx = null;

            // If checkbox is ON and project-level builder exists, use multi-scale context
            if (shouldUseProjectContext() &&
                typeof buildJsonContextForProjectFromCurrentRun === "function") {
                ctx = buildJsonContextForProjectFromCurrentRun();
            }

            // Fallback: single-run context
            if (!ctx) {
                ctx = buildJsonContextFromRun();
            }

            return ctx;
        }

        function getCurrentJsonText() {
            var ctx = buildCurrentJsonContext();
            if (!ctx) return null;
            try {
                return JSON.stringify(ctx, null, 2);
            } catch (err) {
                console.warn("Could not stringify JSON context:", err);
                return null;
            }
        }

        function refreshJsonView() {
            var pre = document.getElementById("jsonOutput");
            if (!pre) return;

            var txt = getCurrentJsonText();
            if (!txt) {
                if (!lastSeries || !lastSeries.length) {
                    pre.textContent = "No SPI results available. Please run the SPI analysis first.";
                } else {
                    pre.textContent = "JSON context not available. Check that SPI and wavelet results are ready.";
                }
                return;
            }

            pre.textContent = txt;
        }

        function toggleJsonView() {
            var wrap = document.getElementById("jsonOutputWrap");
            var btn = document.getElementById("toggleJsonBtn");
            var pre = document.getElementById("jsonOutput");
            if (!wrap || !btn || !pre) return;

            var isHidden = wrap.classList.contains("hidden");
            if (isHidden) {
                refreshJsonView();
                wrap.classList.remove("hidden");
                btn.textContent = "Hide JSON";
            } else {
                wrap.classList.add("hidden");
                pre.textContent = "JSON is hidden. Click “Show JSON” to render it here.";
                btn.textContent = "Show JSON";
            }
        }

        async function copyJsonOutput() {
            var btn = document.getElementById("copyJsonBtn");
            var txt = getCurrentJsonText();

            if (!txt) {
                if (btn) {
                    btn.textContent = "No JSON";
                    setTimeout(function () { btn.textContent = "Copy JSON"; }, 1500);
                }
                return;
            }

            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(txt);
                } else {
                    var ta = document.createElement("textarea");
                    ta.value = txt;
                    ta.style.position = "fixed";
                    ta.style.left = "-9999px";
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    document.execCommand("copy");
                    document.body.removeChild(ta);
                }

                if (btn) {
                    var old = btn.textContent;
                    btn.textContent = "Copied";
                    btn.classList.add("bg-emerald-50", "text-emerald-700", "border-emerald-200");
                    setTimeout(function () {
                        btn.textContent = old || "Copy JSON";
                        btn.classList.remove("bg-emerald-50", "text-emerald-700", "border-emerald-200");
                    }, 1500);
                }
            } catch (err) {
                console.warn("Could not copy JSON:", err);
                if (btn) {
                    btn.textContent = "Copy failed";
                    setTimeout(function () { btn.textContent = "Copy JSON"; }, 1500);
                }
            }
        }


        // =============== EXPORT ZIP PACKAGE =================
        function csvEscape(value) {
            if (value == null) return "";
            var s = String(value);
            if (/[",\n\r]/.test(s)) {
                return '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
        }

        function rowsToCsv(columns, rows) {
            rows = rows || [];
            var lines = [columns.map(csvEscape).join(",")];
            rows.forEach(function (row) {
                var vals = Array.isArray(row)
                    ? row
                    : columns.map(function (c) { return row ? row[c] : null; });
                lines.push(vals.map(csvEscape).join(","));
            });
            return lines.join("\n");
        }

        function compactTableToCsv(table) {
            if (!table || !Array.isArray(table.columns)) return "";
            return rowsToCsv(table.columns, table.rows || []);
        }

        function sanitizeExportFilenamePart(value) {
            var s = String(value || "dmap_ai").trim();
            s = s.replace(/[^A-Za-z0-9_\-\.]+/g, "_");
            s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
            return s || "dmap_ai";
        }

        function getExportSelectedItems() {
            return Array.prototype.slice.call(document.querySelectorAll(".export-item-checkbox:checked"))
                .map(function (el) { return el.value; });
        }

        function updateExportSelectedSummary() {
            var el = document.getElementById("exportSelectedSummary");
            if (!el) return;
            var n = getExportSelectedItems().length;
            el.textContent = n ? (n + " export item" + (n === 1 ? "" : "s") + " selected") : "No export items selected";
        }

        function toggleExportItemDropdown() {
            var dd = document.getElementById("exportItemMultiSelectDropdown");
            if (!dd) return;
            dd.classList.toggle("hidden");
            updateExportSelectedSummary();
        }

        function setExportStatus(text, isError) {
            var el = document.getElementById("exportStatus");
            if (!el) return;
            el.textContent = text || "";
            el.classList.toggle("text-rose-600", !!isError);
            el.classList.toggle("text-slate-500", !isError);
        }

        document.addEventListener("click", function (e) {
            var wrap = document.getElementById("exportItemMultiSelectWrap");
            var dd = document.getElementById("exportItemMultiSelectDropdown");
            if (!wrap || !dd) return;
            if (!wrap.contains(e.target)) dd.classList.add("hidden");
        });

        document.addEventListener("DOMContentLoaded", function () {
            document.querySelectorAll(".export-item-checkbox").forEach(function (el) {
                el.addEventListener("change", updateExportSelectedSummary);
            });
            updateExportSelectedSummary();
        });

        function getCurrentProjectExportName() {
            var ctx = buildCurrentJsonContext ? buildCurrentJsonContext() : null;
            var loc = ctx && ctx.project && ctx.project.location ? ctx.project.location : null;
            var locName = loc && loc.name ? loc.name : "selected_point";
            var start = ctx && ctx.run && ctx.run.time_range ? ctx.run.time_range.start : "start";
            var end = ctx && ctx.run && ctx.run.time_range ? ctx.run.time_range.end : "end";
            return sanitizeExportFilenamePart("DMAP_AI_" + locName + "_" + start + "_" + end);
        }

        function getSpiTableCsv() {
            var rows = (lastSeries || []).map(function (d, idx) {
                return {
                    index: idx,
                    year: d && d.year != null ? d.year : (d && d.end_date ? String(d.end_date).slice(0, 4) : ""),
                    end_date: d ? d.end_date : "",
                    window_sum_mm: d ? getWindowSum(d) : null,
                    spi: d ? d.spi : null,
                    category: d ? getSpiCategory(d.spi) : ""
                };
            });
            return rowsToCsv(["index", "year", "end_date", "window_sum_mm", "spi", "category"], rows);
        }

        function getDroughtEventsCsv() {
            var thresholdEl = document.getElementById("severityThreshold");
            var threshold = thresholdEl ? parseFloat(thresholdEl.value || "-0.99") : -0.99;
            if (!isFinite(threshold)) threshold = -0.99;
            var events = detectDroughtEvents(lastSeries || [], threshold).map(function (ev, idx) {
                return {
                    event_id: idx + 1,
                    start_date: ev.startDate,
                    end_date: ev.endDate,
                    duration_steps: ev.duration,
                    min_spi: ev.minSPI,
                    magnitude: ev.magnitude,
                    threshold_spi: threshold
                };
            });
            return rowsToCsv(["event_id", "start_date", "end_date", "duration_steps", "min_spi", "magnitude", "threshold_spi"], events);
        }

        function splitCompactValuesCsv(valuesCsv) {
            if (valuesCsv == null) return [];
            return String(valuesCsv).split(",").map(function (v) { return v.trim(); });
        }

        function inferCompactSeriesDates(seriesMeta, values) {
            seriesMeta = seriesMeta || {};
            if (Array.isArray(seriesMeta.dates) && seriesMeta.dates.length) return seriesMeta.dates.slice(0, values.length);
            if (seriesMeta.date_csv) {
                return String(seriesMeta.date_csv).split(",").map(function (v) { return v.trim(); }).slice(0, values.length);
            }
            var out = [];
            var start = seriesMeta.start_date ? new Date(seriesMeta.start_date) : null;
            if (!start || isNaN(start.getTime())) {
                for (var i = 0; i < values.length; i++) out.push(String(i + 1));
                return out;
            }
            var step = String(seriesMeta.time_step || "daily").toLowerCase();
            for (var j = 0; j < values.length; j++) {
                var d = new Date(start.getTime());
                if (step.indexOf("month") !== -1) d.setMonth(d.getMonth() + j);
                else if (step.indexOf("year") !== -1) d.setFullYear(d.getFullYear() + j);
                else d.setDate(d.getDate() + j);
                out.push(d.toISOString().slice(0, 10));
            }
            return out;
        }

        function getSourcePrecipCompactCsv(ctx) {
            ctx = ctx || (buildCurrentJsonContext ? buildCurrentJsonContext() : null);
            var s = ctx && ctx.source_precipitation_data ? ctx.source_precipitation_data.compact_series : null;
            if (!s) {
                return rowsToCsv(["note"], [{ note: "Source precipitation compact series was not available in the current JSON context." }]);
            }

            var values = splitCompactValuesCsv(s.values_csv);
            var dates = inferCompactSeriesDates(s, values);
            var lines = [];
            lines.push('"metadata_key","metadata_value"');
            [
                ["format", s.format || "compact_csv_values"],
                ["start_date", s.start_date || ""],
                ["end_date", s.end_date || ""],
                ["time_step", s.time_step || ""],
                ["units", s.units || ""],
                ["value_field", s.value_field || "value"],
                ["record_count", s.record_count != null ? s.record_count : values.length],
                ["missing_count", s.missing_count != null ? s.missing_count : ""]
            ].forEach(function (pair) {
                lines.push(csvEscape(pair[0]) + ',' + csvEscape(pair[1]));
            });
            lines.push('');
            lines.push('"Date","Data"');
            for (var i = 0; i < values.length; i++) {
                lines.push(csvEscape(dates[i] != null ? dates[i] : '') + ',' + csvEscape(values[i]));
            }
            return lines.join("\n");
        }

        function getAggregationCsv(ctx) {
            ctx = ctx || (buildCurrentJsonContext ? buildCurrentJsonContext() : null);
            var ag = ctx ? ctx.precipitation_aggregation : null;
            if (ag && Array.isArray(ag.columns)) return compactTableToCsv(ag);
            return rowsToCsv(["note"], [{ note: "Aggregated precipitation table was not available in the current JSON context." }]);
        }

        function exportCanvasBlob(canvas, mimeType) {
            return new Promise(function (resolve, reject) {
                try {
                    if (!canvas || !canvas.toBlob) {
                        reject(new Error("Canvas export is not supported by this browser."));
                        return;
                    }
                    canvas.toBlob(function (blob) {
                        if (blob) resolve(blob);
                        else reject(new Error("Could not export chart image."));
                    }, mimeType || "image/png");
                } catch (err) {
                    reject(err);
                }
            });
        }

        function makeTempCanvas(width, height) {
            var canvas = document.createElement("canvas");
            canvas.width = width || 1200;
            canvas.height = height || 700;
            canvas.style.position = "fixed";
            canvas.style.left = "-99999px";
            canvas.style.top = "-99999px";
            document.body.appendChild(canvas);
            return canvas;
        }

        function waitForChartDraw() {
            return new Promise(function (resolve) {
                requestAnimationFrame(function () {
                    requestAnimationFrame(resolve);
                });
            });
        }

        function getSeriesLabelsAndValuesForExport() {
            var series = lastSeries || [];
            var labels = series.map(function (d) { return d && d.end_date ? d.end_date : ""; });
            var spiVals = series.map(function (d) { return d && d.spi != null && isFinite(+d.spi) ? +d.spi : null; });
            var sums = series.map(getWindowSum);
            return { labels: labels, spi: spiVals, sums: sums };
        }

        function makeExportWhiteBackgroundPlugin() {
            return {
                id: "dmapExportWhiteBackground",
                beforeDraw: function (chart) {
                    var ctx = chart.ctx;
                    ctx.save();
                    ctx.globalCompositeOperation = "destination-over";
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, chart.width, chart.height);
                    ctx.restore();
                }
            };
        }

        function applyExportStyleToChartConfig(config) {
            config = config || {};
            config.options = config.options || {};
            config.options.responsive = false;
            config.options.animation = false;
            config.options.maintainAspectRatio = false;
            config.options.layout = config.options.layout || {};
            config.options.layout.padding = config.options.layout.padding || { top: 12, right: 12, bottom: 12, left: 12 };
            config.options.plugins = config.options.plugins || {};
            if (config.options.plugins.title) {
                config.options.plugins.title.color = '#111827';
                config.options.plugins.title.font = Object.assign({ size: 18, weight: '600' }, config.options.plugins.title.font || {});
            }
            config.options.plugins.legend = config.options.plugins.legend || {};
            config.options.plugins.legend.labels = Object.assign({}, config.options.plugins.legend.labels || {}, { color: '#111827', boxWidth: 26 });

            config.options.scales = config.options.scales || {};
            Object.keys(config.options.scales).forEach(function (axisKey) {
                var axis = config.options.scales[axisKey] || {};
                axis.grid = Object.assign({ color: 'rgba(148,163,184,0.25)' }, axis.grid || {});
                axis.ticks = Object.assign({ color: '#334155' }, axis.ticks || {});
                if (axis.title && axis.title.display) axis.title.color = '#111827';
                config.options.scales[axisKey] = axis;
            });

            var palettes = {
                primary: '#2563eb',
                secondary: '#dc2626',
                tertiary: '#059669',
                quaternary: '#7c3aed'
            };
            if (config.data && Array.isArray(config.data.datasets)) {
                config.data.datasets.forEach(function (ds, idx) {
                    var color = idx === 0 ? palettes.primary : idx === 1 ? palettes.secondary : idx === 2 ? palettes.tertiary : palettes.quaternary;
                    if (!ds.borderColor) ds.borderColor = color;
                    if (ds.type === 'line' || config.type === 'line') {
                        if (ds.backgroundColor == null) ds.backgroundColor = color + '22';
                        if (ds.pointBackgroundColor == null) ds.pointBackgroundColor = color;
                        if (ds.pointBorderColor == null) ds.pointBorderColor = '#ffffff';
                        if (ds.pointRadius == null) ds.pointRadius = 3;
                        if (ds.borderWidth == null) ds.borderWidth = 2.5;
                    } else if (config.type === 'bar') {
                        if (ds.backgroundColor == null) ds.backgroundColor = idx === 0 ? 'rgba(37,99,235,0.75)' : 'rgba(220,38,38,0.75)';
                        if (ds.borderColor == null) ds.borderColor = color;
                        if (ds.borderWidth == null) ds.borderWidth = 1;
                    }
                });
            }

            var plugins = Array.isArray(config.plugins) ? config.plugins.slice() : [];
            plugins.unshift(makeExportWhiteBackgroundPlugin());
            config.plugins = plugins;
            return config;
        }

        async function addChartJsImageToZip(zip, path, config) {
            var canvas = makeTempCanvas(1400, 800);
            var chart = null;
            try {
                chart = new Chart(canvas.getContext("2d"), applyExportStyleToChartConfig(config));
                await waitForChartDraw();
                zip.file(path, await exportCanvasBlob(canvas, "image/png"));
            } finally {
                try { if (chart) chart.destroy(); } catch (e) { }
                try { canvas.remove(); } catch (e2) { }
            }
        }

        async function addSpiLineChartToZip(zip) {
            var d = getSeriesLabelsAndValuesForExport();
            var b = getSpiLineBounds ? getSpiLineBounds() : { upper: 2, lower: -2 };
            await addChartJsImageToZip(zip, "charts/spi_line.png", {
                type: "line",
                data: {
                    labels: d.labels,
                    datasets: [
                        { label: "SPI", data: d.spi, spanGaps: true, tension: 0.2 },
                        { label: "Upper bound", data: buildConstArray(d.labels.length, b.upper), pointRadius: 0, borderDash: [6, 4], borderWidth: 1 },
                        { label: "Lower bound", data: buildConstArray(d.labels.length, b.lower), pointRadius: 0, borderDash: [2, 3], borderWidth: 1 }
                    ]
                },
                options: { responsive: false, animation: false, plugins: { title: { display: true, text: "SPI time series" } }, scales: { y: { suggestedMin: Math.min(-3, b.lower - 0.5), suggestedMax: Math.max(3, b.upper + 0.5) } } }
            });
        }

        async function addAnomalyChartToZip(zip) {
            var d = getSeriesLabelsAndValuesForExport();
            var valid = d.sums.map(function (s, i) { return { i: i, s: s }; }).filter(function (p) { return p.s != null && isFinite(+p.s); });
            var labels2 = valid.map(function (p) { return d.labels[p.i]; });
            var sums2 = valid.map(function (p) { return +p.s; });
            var mu = sums2.length ? sums2.reduce(function (a, b) { return a + b; }, 0) / sums2.length : 0;
            var anomalies = sums2.map(function (s) { return s - mu; });
            await addChartJsImageToZip(zip, "charts/precipitation_anomaly.png", {
                type: "bar",
                data: { labels: labels2, datasets: [{ label: "Sum anomaly (mm)", data: anomalies }] },
                options: { responsive: false, animation: false, plugins: { title: { display: true, text: "Precipitation anomaly" } } }
            });
        }

        async function addBoxplotChartToZip(zip) {
            if (!ensureBoxplotRegistered || !ensureBoxplotRegistered()) {
                zip.file("charts/spi_boxplot_NOT_CREATED.txt", "The Chart.js boxplot plugin was not available.");
                return;
            }
            var vals = (lastSeries || []).map(function (d) { return d && d.spi != null ? +d.spi : null; }).filter(function (v) { return isFinite(v); });
            if (!vals.length) {
                zip.file("charts/spi_boxplot_NOT_CREATED.txt", "No valid SPI values were available.");
                return;
            }
            await addChartJsImageToZip(zip, "charts/spi_boxplot.png", {
                type: "boxplot",
                data: { labels: ["All years"], datasets: [{ label: "SPI", data: [vals], itemRadius: 2, outlierRadius: 2 }] },
                options: { responsive: false, animation: false, plugins: { title: { display: true, text: "SPI boxplot" } }, scales: { y: { suggestedMin: -3, suggestedMax: 3 } } }
            });
        }

        async function addSeverityChartToZip(zip) {
            var d = getSeriesLabelsAndValuesForExport();
            var thresholdEl = document.getElementById("severityThreshold");
            var threshold = thresholdEl ? parseFloat(thresholdEl.value || "-0.99") : -0.99;
            if (!isFinite(threshold)) threshold = -0.99;
            var events = detectDroughtEvents(lastSeries || [], threshold);
            var plugin = {
                id: "dmapSeverityExportShade",
                beforeDatasetsDraw: function (chart) {
                    var ctx = chart.ctx;
                    var xScale = chart.scales.x;
                    var yScale = chart.scales.y;
                    var top = yScale.top;
                    var bottom = yScale.bottom;
                    ctx.save();
                    ctx.fillStyle = "rgba(220,38,38,0.12)";
                    events.forEach(function (ev) {
                        var x0 = xScale.getPixelForValue(ev.startIndex);
                        var x1 = xScale.getPixelForValue(ev.endIndex);
                        ctx.fillRect(x0, top, Math.max(2, x1 - x0), bottom - top);
                    });
                    ctx.restore();
                }
            };
            await addChartJsImageToZip(zip, "charts/drought_severity.png", {
                type: "line",
                data: {
                    labels: d.labels,
                    datasets: [
                        { label: "SPI", data: d.spi, spanGaps: true, tension: 0.2 },
                        { label: "Threshold (" + threshold.toFixed(2) + ")", data: buildConstArray(d.labels.length, threshold), borderDash: [6, 4], pointRadius: 0 }
                    ]
                },
                options: { responsive: false, animation: false, plugins: { title: { display: true, text: "Drought severity" } }, scales: { y: { suggestedMin: -3, suggestedMax: 3 } } },
                plugins: [plugin]
            });
        }

        function drawExportScalogramToCanvas(canvas, power2D) {
            var ctx = canvas.getContext("2d");
            var nTime = power2D.length;
            var nPeriod = power2D[0] ? power2D[0].length : 0;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            if (!nTime || !nPeriod) return;
            var left = 80, right = 30, top = 50, bottom = 70;
            var plotW = canvas.width - left - right;
            var plotH = canvas.height - top - bottom;
            var vals = [];
            for (var i = 0; i < nTime; i++) {
                for (var j = 0; j < nPeriod; j++) {
                    var v = Math.log(power2D[i][j] > 0 ? power2D[i][j] : 1e-6);
                    if (isFinite(v)) vals.push(v);
                }
            }
            var vMin = vals.length ? Math.min.apply(null, vals) : 0;
            var vMax = vals.length ? Math.max.apply(null, vals) : 1;
            if (vMax <= vMin) vMax = vMin + 1;
            function colorFor(v) {
                var t = Math.max(0, Math.min(1, (v - vMin) / (vMax - vMin)));
                var r = Math.round(255 * t);
                var g = Math.round(255 * (t * t));
                var b = Math.round(255 * (1 - t));
                return "rgb(" + r + "," + g + "," + b + ")";
            }
            var cellW = plotW / nTime;
            var cellH = plotH / nPeriod;
            for (var ti = 0; ti < nTime; ti++) {
                for (var pi = 0; pi < nPeriod; pi++) {
                    ctx.fillStyle = colorFor(Math.log(power2D[ti][pi] > 0 ? power2D[ti][pi] : 1e-6));
                    ctx.fillRect(left + ti * cellW, top + (nPeriod - pi - 1) * cellH, cellW + 1, cellH + 1);
                }
            }
            ctx.strokeStyle = "#111827";
            ctx.lineWidth = 1;
            ctx.strokeRect(left, top, plotW, plotH);
            ctx.fillStyle = "#111827";
            ctx.font = "18px Inter, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("Wavelet scalogram (power vs time and period)", canvas.width / 2, 25);
            ctx.font = "13px Inter, sans-serif";
            ctx.fillText("Time index", left + plotW / 2, canvas.height - 25);
            ctx.save();
            ctx.translate(25, top + plotH / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText("Period / scale index", 0, 0);
            ctx.restore();
        }

        async function addScalogramChartToZip(zip) {
            if (!Array.isArray(waveletPower2D) || !waveletPower2D.length) {
                zip.file("charts/wavelet_scalogram_NOT_CREATED.txt", "Wavelet scalogram was not available. Open the Wavelet tab first, then export again.");
                return;
            }
            var canvas = makeTempCanvas(1200, 720);
            try {
                drawExportScalogramToCanvas(canvas, waveletPower2D);
                zip.file("charts/wavelet_scalogram.png", await exportCanvasBlob(canvas, "image/png"));
            } finally {
                try { canvas.remove(); } catch (e) { }
            }
        }

        async function addWaveletGlobalChartToZip(zip) {
            if (!Array.isArray(waveletPeriods) || !waveletPeriods.length || !Array.isArray(waveletGlobalPower) || !waveletGlobalPower.length) {
                zip.file("charts/global_wavelet_spectrum_NOT_CREATED.txt", "Global wavelet spectrum was not available. Open the Wavelet tab first, then export again.");
                return;
            }
            await addChartJsImageToZip(zip, "charts/global_wavelet_spectrum.png", {
                type: "line",
                data: { labels: waveletPeriods, datasets: [{ label: "Global power", data: waveletGlobalPower, spanGaps: true, tension: 0.25 }] },
                options: { responsive: false, animation: false, plugins: { title: { display: true, text: "Global wavelet spectrum (SPI)" } }, scales: { x: { title: { display: true, text: "Period (steps)" } }, y: { title: { display: true, text: "Power" } } } }
            });
        }

        async function addWaveletCoherenceChartToZip(zip) {
            if (!Array.isArray(waveletPeriods) || !waveletPeriods.length || !Array.isArray(waveletCoherenceArray) || !waveletCoherenceArray.length) {
                zip.file("charts/wavelet_coherence_NOT_CREATED.txt", "Wavelet coherence was not available. Open the Wavelet tab first, then export again.");
                return;
            }
            await addChartJsImageToZip(zip, "charts/wavelet_coherence.png", {
                type: "line",
                data: { labels: waveletPeriods, datasets: [{ label: "Coherence", data: waveletCoherenceArray, spanGaps: true, tension: 0.25 }] },
                options: { responsive: false, animation: false, plugins: { title: { display: true, text: "SPI-precipitation coherence vs period" } }, scales: { x: { title: { display: true, text: "Period (steps)" } }, y: { min: 0, max: 1, title: { display: true, text: "Coherence" } } } }
            });
        }

        async function addCopulaChartToZip(zip) {
            var uArr = lastCopulaResult && lastCopulaResult.uv_points ? (lastCopulaResult.uv_points.u || []) : [];
            var vArr = lastCopulaResult && lastCopulaResult.uv_points ? (lastCopulaResult.uv_points.v || []) : [];
            var points = [];
            for (var i = 0; i < Math.min(uArr.length, vArr.length); i++) {
                if (isFinite(uArr[i]) && isFinite(vArr[i])) points.push({ x: +uArr[i], y: +vArr[i] });
            }
            if (!points.length) {
                zip.file("charts/copula_diagnostics_NOT_CREATED.txt", "Copula diagnostics were not available. Run the Copula tab first, then export again.");
                return;
            }
            await addChartJsImageToZip(zip, "charts/copula_diagnostics.png", {
                type: "scatter",
                data: { datasets: [{ label: "Copula pseudo-observations (U, V)", data: points, pointRadius: 3 }] },
                options: { responsive: false, animation: false, plugins: { title: { display: true, text: "Copula dependence diagnostics" }, legend: { display: false } }, scales: { x: { type: "linear", min: 0, max: 1, title: { display: true, text: "U" } }, y: { type: "linear", min: 0, max: 1, title: { display: true, text: "V" } } } }
            });
        }

        function makeExportReadme(selected, skipped) {
            var ctx = buildCurrentJsonContext ? buildCurrentJsonContext() : null;
            var lines = [];
            lines.push("DMAP-AI export package");
            lines.push("Created: " + new Date().toISOString());
            lines.push("");
            if (ctx && ctx.project && ctx.project.location) {
                lines.push("Location: " + ctx.project.location.name + " (" + ctx.project.location.latitude + ", " + ctx.project.location.longitude + ")");
            }
            if (ctx && ctx.run && ctx.run.time_range) {
                lines.push("Period: " + ctx.run.time_range.start + " to " + ctx.run.time_range.end);
            }
            if (ctx && ctx.dataset) {
                lines.push("Dataset: " + (ctx.dataset.display_name || ctx.dataset.name || "") + " / " + (ctx.dataset.provider || ""));
            }
            lines.push("");
            lines.push("Selected items:");
            selected.forEach(function (s) { lines.push("- " + s); });
            if (skipped && skipped.length) {
                lines.push("");
                lines.push("Notes / skipped items:");
                skipped.forEach(function (s) { lines.push("- " + s); });
            }
            return lines.join("\n");
        }

        async function exportSelectedPackage() {
            var btn = document.getElementById("exportZipBtn");
            if (!Array.isArray(lastSeries) || !lastSeries.length) {
                setExportStatus("Run SPI first, then create the ZIP package.", true);
                return;
            }
            if (typeof JSZip === "undefined") {
                setExportStatus("JSZip was not loaded. Please check the internet/CDN connection and refresh the page.", true);
                return;
            }
            var selected = getExportSelectedItems();
            if (!selected.length) {
                setExportStatus("Please select at least one item to export.", true);
                return;
            }

            var ctx = buildCurrentJsonContext ? buildCurrentJsonContext() : null;
            var zip = new JSZip();
            var skipped = [];
            try {
                if (btn) btn.disabled = true;
                setExportStatus("Creating ZIP package...", false);

                if (selected.indexOf("table_spi") !== -1) zip.file("tables/spi_result_table.csv", getSpiTableCsv());
                if (selected.indexOf("table_events") !== -1) zip.file("tables/drought_events.csv", getDroughtEventsCsv());
                if (selected.indexOf("table_aggregation") !== -1) zip.file("tables/precipitation_aggregation.csv", getAggregationCsv(ctx));
                if (selected.indexOf("table_source_precip") !== -1) zip.file("tables/source_precipitation_vertical.csv", getSourcePrecipCompactCsv(ctx));
                if (selected.indexOf("json_full") !== -1) zip.file("json/full_current_run_context.json", getCurrentJsonText() || JSON.stringify(ctx || {}, null, 2));

                if (selected.indexOf("chart_spi_line") !== -1) await addSpiLineChartToZip(zip);
                if (selected.indexOf("chart_anom_bar") !== -1) await addAnomalyChartToZip(zip);
                if (selected.indexOf("chart_boxplot") !== -1) await addBoxplotChartToZip(zip);
                if (selected.indexOf("chart_severity") !== -1) await addSeverityChartToZip(zip);
                if (selected.indexOf("chart_scalogram") !== -1) await addScalogramChartToZip(zip);
                if (selected.indexOf("chart_global") !== -1) await addWaveletGlobalChartToZip(zip);
                if (selected.indexOf("chart_coherence") !== -1) await addWaveletCoherenceChartToZip(zip);
                if (selected.indexOf("chart_copula") !== -1) await addCopulaChartToZip(zip);

                zip.file("README.txt", makeExportReadme(selected, skipped));

                var blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
                var fileName = getCurrentProjectExportName() + "_export.zip";
                var a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                setTimeout(function () {
                    try { URL.revokeObjectURL(a.href); } catch (e) { }
                    try { a.remove(); } catch (e2) { }
                }, 1000);
                setExportStatus("ZIP package created: " + fileName, false);
            } catch (err) {
                console.error("Export ZIP error:", err);
                setExportStatus("Export failed: " + (err && err.message ? err.message : String(err)), true);
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        // Helper: label for datasource code (used by metadata + dashboard)
        function labelForDatasource(code) {
            switch (code) {
                case "nasa_power":
                case "nasa":
                    return "NASA POWER (free, point-based)";
                case "era5":
                case "era5_land_cds":
                    return "ERA5-Land / CDS (advanced)";
                case "gridmet":
                    return "GridMET (CONUS gridded met forcing)";
                case "prism":
                    return "PRISM (US high-resolution climatology)";
                case "gpm":
                    return "GPM IMERG (global satellite precipitation)";
                case "user":
                    return "User upload (station / custom CSV)";
                default:
                    return "NASA POWER (free, point-based)";
            }
        }

        // ---------- Boxplot registration (robust) ----------
        function isBoxplotReady() {
            try {
                Chart.registry.getController("boxplot");
                return true;
            } catch (e) {
                return false;
            }
        }

        function ensureBoxplotRegistered() {
            if (isBoxplotReady()) return true;
            var bp = window.ChartJSBoxPlot ||
                window.ChartBoxPlot ||
                window["chartjs-chart-boxplot"] ||
                window["chartjs-chart-box-and-violin-plot"];
            if (!bp) {
                for (var k in window) {
                    var v = window[k];
                    if (v && typeof v === "object" && (v.BoxPlotController || v.ViolinController)) {
                        bp = v;
                        break;
                    }
                }
            }
            if (!bp) return false;
            try {
                var parts = [
                    bp.BoxPlotChart, bp.BoxPlotController, bp.BoxPlotElement,
                    bp.BoxAndWiskers || bp.BoxAndWhiskers,
                    bp.ViolinChart, bp.ViolinController, bp.ViolinElement, bp.Violin
                ].filter(Boolean);
                if (parts.length) Chart.register.apply(Chart, parts);
            } catch (e) {
                console.warn("Boxplot registration failed (non-fatal):", e);
            }
            return isBoxplotReady();
        }

        // ---------- Logging ----------
        var logPre = document.getElementById("log");
        function log(msg, obj) {
            var line = "[" + new Date().toISOString() + "] " + (msg == null ? "" : msg);
            if (typeof DMAP_DEBUG !== "undefined" && DMAP_DEBUG) {
                console.debug(line, obj || "");
            }
            if (logPre) {
                logPre.textContent += line + (obj
                    ? "\n" + (typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)) + "\n"
                    : "\n");
            }
        }

        

        // =============== AI BACKEND RESPONSE + DAILY QUOTA HELPERS =================
        function extractBackendAiError(result) {
            if (!result) return "";
            if (result.error && result.error.message) return result.error.message;
            if (typeof result.detail === "string") return result.detail;
            if (result.detail && result.detail.message) return result.detail.message;
            if (result.message) return result.message;
            try { return JSON.stringify(result).slice(0, 800); } catch (e) { return ""; }
        }

        function unwrapAiResponse(result) {
            // Supports either direct Gemini response or backend wrappers such as {result: ...}, {data: ...}, or {response: ...}.
            if (!result) return result;
            if (result.candidates) return result;
            if (result.result && result.result.candidates) return result.result;
            if (result.data && result.data.candidates) return result.data;
            if (result.response && result.response.candidates) return result.response;
            return result;
        }

        function formatAiApiError(error, status) {
            var msg = error && error.message ? String(error.message) : String(error || "Unknown error");
            if (status === 401 || msg.indexOf("401") !== -1 || msg.toLowerCase().indexOf("invalid authentication") !== -1) {
                return "AI connection error: the backend AI endpoint returned 401. Please check the server GEMINI_API_KEY and Gemini API access. Your free AI request count was not reduced.";
            }
            if (status === 404 || msg.indexOf("404") !== -1) {
                return "AI endpoint error: the backend route /api/analysis/ai_interpret was not found. Please check ai_routes.py registration and restart the backend. Your free AI request count was not reduced.";
            }
            if (status === 500 || msg.indexOf("Gemini API key is not configured") !== -1) {
                return "AI configuration error: GEMINI_API_KEY is not configured on the backend server. Your free AI request count was not reduced.";
            }
            return "Error: Could not process chart analysis. " + msg + " Your free AI request count was not reduced.";
        }

        function getLocalDateKey() {
            var d = new Date();
            var y = d.getFullYear();
            var m = String(d.getMonth() + 1).padStart(2, "0");
            var day = String(d.getDate()).padStart(2, "0");
            return y + "-" + m + "-" + day;
        }

        function getAiQuotaLimit() {
            var cfg = getCurrentPlanConfig ? getCurrentPlanConfig() : null;
            if (!cfg || cfg.aiDailyLimit == null) return null;
            return cfg.aiDailyLimit;
        }

        function getAiQuotaStorageKey() {
            var email = currentUserEmail || localStorage.getItem("dmapai_current_user") || "anonymous";
            return "dmapai_ai_quota_" + email;
        }

        function getAiQuotaState() {
            var today = getLocalDateKey();
            var key = getAiQuotaStorageKey();
            var state = null;
            try {
                state = JSON.parse(localStorage.getItem(key) || "{}");
            } catch (e) {
                state = {};
            }
            if (!state || state.date !== today) {
                state = { date: today, used: 0 };
                localStorage.setItem(key, JSON.stringify(state));
            }
            state.used = Math.max(0, parseInt(state.used || 0, 10));
            return state;
        }

        function getAiRequestsRemaining() {
            var limit = getAiQuotaLimit();
            if (limit == null) return null;
            var state = getAiQuotaState();
            return Math.max(0, limit - state.used);
        }


        function updateDashboardUpgradeCard() {
            var card = document.getElementById("dashboardUpgradeCard");
            if (!card) return;
            card.style.display = (getCurrentPlanName && getCurrentPlanName() === "paid") ? "none" : "";
        }

        function updateAiQuotaUI() {
            var limit = getAiQuotaLimit();
            var remaining = getAiRequestsRemaining();
            var notice = document.getElementById("aiLockedNotice");
            var remainingEl = document.getElementById("aiQuotaRemaining");
            var limitEl = document.getElementById("aiQuotaLimit");
            var pill = document.getElementById("aiQuotaPill");
            var button = document.getElementById("analyzeButton");

            if (limit == null) {
                if (notice) notice.style.display = "none";
                if (pill) {
                    pill.textContent = "unlimited";
                    pill.classList.remove("empty");
                }
                if (button) button.disabled = false;
                return;
            }

            if (notice) {
                notice.style.display = "";
                notice.classList.toggle("limit-reached", remaining <= 0);
            }
            if (remainingEl) remainingEl.textContent = String(remaining);
            if (limitEl) limitEl.textContent = String(limit);
            if (pill) {
                pill.textContent = remaining + " left";
                pill.classList.toggle("empty", remaining <= 0);
            }
            if (button) {
                button.disabled = remaining <= 0;
            }
        }

        function hasAiQuotaAvailable() {
            var limit = getAiQuotaLimit();
            if (limit == null) return true;

            var state = getAiQuotaState();
            var remaining = Math.max(0, limit - state.used);
            if (remaining <= 0) {
                updateAiQuotaUI();
                var output = document.getElementById("resultOutput");
                if (output) {
                    output.textContent = "You have used all 10 free AI interpretation requests for today. Please try again tomorrow or contact AgriMetSoft when the paid Research features are available.";
                }
                return false;
            }
            return true;
        }

        function consumeAiQuotaAfterSuccess() {
            var limit = getAiQuotaLimit();
            if (limit == null) return;

            var state = getAiQuotaState();
            var remaining = Math.max(0, limit - state.used);
            if (remaining <= 0) {
                updateAiQuotaUI();
                return;
            }

            state.used += 1;
            localStorage.setItem(getAiQuotaStorageKey(), JSON.stringify(state));
            updateAiQuotaUI();
        }


        // =============== PLAN / ACCESS CONTROL =================
        var PLAN_CONFIGS = {
            free: {
                label: "Free Plan",
                allowedDroughtIndex: "spi",
                allowedMode: "historical",
                defaultDatasource: "nasa_power",
                allowedDatasources: ["nasa_power", "era5"],
                allowedScale: "yearly",
                aiEnabled: true,
                aiDailyLimit: 10
            },
            paid: {
                label: "Paid Plan",
                allowedDroughtIndex: null,
                allowedMode: null,
                allowedDatasource: null,
                allowedScale: null,
                aiEnabled: true
            }
        };

        function getUserProfiles() {
            try {
                return JSON.parse(localStorage.getItem("dmapai_user_profiles") || "{}");
            } catch (e) {
                return {};
            }
        }

        function setUserProfiles(obj) {
            localStorage.setItem("dmapai_user_profiles", JSON.stringify(obj || {}));
        }

        function ensureUserProfile(email) {
            if (!email) return { plan: "free" };
            var profiles = getUserProfiles();
            if (!profiles[email] || typeof profiles[email] !== "object") {
                profiles[email] = { plan: "free" };
                setUserProfiles(profiles);
            }
            if (!profiles[email].plan) {
                profiles[email].plan = "free";
                setUserProfiles(profiles);
            }
            return profiles[email];
        }

        function getCurrentPlanName() {
            return currentUserPlanName || localStorage.getItem("dmapai_current_plan") || "free";
        }

        function getCurrentPlanConfig() {
            var planName = getCurrentPlanName();
            return PLAN_CONFIGS[planName] || PLAN_CONFIGS.free;
        }

        function updateUserPlanBadge() {
            var badge = document.getElementById("userPlanBadge");
            if (!badge) return;
            if (!currentUserEmail) {
                badge.classList.add("hidden");
                badge.textContent = "";
                badge.className = "plan-badge hidden";
                return;
            }
            var planName = getCurrentPlanName();
            var cfg = getCurrentPlanConfig();
            badge.className = "plan-badge " + (planName === "paid" ? "paid" : "free");
            badge.textContent = cfg.label;
            badge.classList.remove("hidden");
        }

        function getDroughtIndexSelectEl() {
            return document.getElementById("droughtIndexSelect")
                || document.getElementById("droughtIndex")
                || document.getElementById("drought_index")
                || null;
        }

        function setRadioValue(name, value) {
            var radios = document.querySelectorAll('input[name="' + name + '"]');
            radios.forEach(function (r) {
                r.checked = (r.value === value);
            });
        }

        function lockRadiosToValue(name, value, locked) {
            var radios = document.querySelectorAll('input[name="' + name + '"]');
            radios.forEach(function (r) {
                var isAllowed = (r.value === value);
                if (locked) {
                    r.checked = isAllowed;
                    r.disabled = !isAllowed;
                    r.closest("label") && r.closest("label").classList.toggle("control-locked", !isAllowed);
                } else {
                    r.disabled = false;
                    r.closest("label") && r.closest("label").classList.remove("control-locked");
                }
            });
        }

        function lockSelectToValue(selectEl, value, locked) {
            if (!selectEl) return;
            if (locked) {
                selectEl.value = value;
                Array.prototype.forEach.call(selectEl.options, function (opt) {
                    opt.disabled = (opt.value !== value);
                });
                selectEl.classList.add("control-locked");
            } else {
                Array.prototype.forEach.call(selectEl.options, function (opt) {
                    opt.disabled = false;
                });
                selectEl.classList.remove("control-locked");
            }
        }


        function lockSelectToAllowedValues(selectEl, allowedValues, defaultValue) {
            if (!selectEl) return;
            allowedValues = Array.isArray(allowedValues) ? allowedValues : [];

            var currentValue = selectEl.value;
            var isCurrentAllowed = allowedValues.indexOf(currentValue) !== -1;

            if (!isCurrentAllowed) {
                selectEl.value = defaultValue || (allowedValues.length ? allowedValues[0] : currentValue);
            }

            Array.prototype.forEach.call(selectEl.options, function (opt) {
                opt.disabled = allowedValues.indexOf(opt.value) === -1;
            });

            // Do not add locked style here, because NASA POWER and ERA5 should both remain selectable.
            selectEl.classList.remove("control-locked");
        }

        function updatePlanRestrictionNote() {
            var note = document.getElementById("planRestrictionNote");
            if (!note) return;
            var cfg = getCurrentPlanConfig();
            if (getCurrentPlanName() === "paid") {
                note.innerHTML = "<strong>Licensed access:</strong> this account can unlock additional drought indices, prediction modes, extra data sources, regional workflows, and AI interpretation as licensed features.";
            } else {
                note.innerHTML = "<strong>Research Version rule:</strong> only <strong>SPI</strong>, <strong>Historical</strong>, <strong>NASA POWER or ERA5-Land/CDS</strong>, <strong>Yearly</strong>, and <strong>Point</strong> analysis are active. Other drought indices, regional analysis, and forecast-oriented workflows are reserved for licensed versions. Free users have 10 AI interpretation requests per day.";
            }
        }

        function applyPlanRestrictions() {
            // Important: this function may call updateVisibility(), but updateVisibility() must not call applyPlanRestrictions() back, or it creates a recursive loop.
            var planName = getCurrentPlanName();
            var cfg = getCurrentPlanConfig();

            // Drought index selector
            var droughtSelect = getDroughtIndexSelectEl();
            if (droughtSelect) {
                if (planName === "free" && cfg.allowedDroughtIndex) {
                    lockSelectToValue(droughtSelect, cfg.allowedDroughtIndex, true);
                } else {
                    lockSelectToValue(droughtSelect, droughtSelect.value || "spi", false);
                }
            }

            // Mode / data source / scale
            if (planName === "free") {
                lockRadiosToValue("mode", cfg.allowedMode, true);
                lockSelectToAllowedValues(
                    document.getElementById("obsSrc"),
                    cfg.allowedDatasources || [cfg.defaultDatasource || "nasa_power"],
                    cfg.defaultDatasource || "nasa_power"
                );
                lockRadiosToValue("scale", cfg.allowedScale, true);

                // keep values synchronized, but do not reset datasource if user selected ERA5.
                setRadioValue("mode", cfg.allowedMode);
                setRadioValue("scale", cfg.allowedScale);
            } else {
                lockRadiosToValue("mode", cfg.allowedMode || "historical", false);
                lockRadiosToValue("scale", cfg.allowedScale || "yearly", false);
                lockSelectToValue(document.getElementById("obsSrc"), "nasa_power", false);
            }

            if (typeof updateVisibility === "function") {
                updateVisibility();
            }

            // AI tab/button/panel
            var aiTabBtn = document.querySelector('.tab-btn[data-tab="ai"]');
            var aiPanel = document.getElementById("panel-ai");
            var aiNotice = document.getElementById("aiLockedNotice");
            if (!cfg.aiEnabled) {
                if (aiTabBtn) {
                    aiTabBtn.classList.add("locked");
                    aiTabBtn.title = "Paid feature – upgrade required";
                }
                if (aiPanel) {
                    var controls = aiPanel.querySelectorAll("button, input, select, textarea");
                    controls.forEach(function (el) {
                        if (el.id !== "copyCitationBtn" && el.id !== "aiLockedNotice") {
                            el.disabled = true;
                            el.classList.add("control-locked");
                        }
                    });
                }
                if (aiNotice) {
                    aiNotice.style.display = "";
                }
                // If AI tab was active, fall back to table
                var activeAi = aiTabBtn && aiTabBtn.classList.contains("active");
                if (activeAi && typeof switchTab === "function") {
                    switchTab("table");
                }
            } else {
                if (aiTabBtn) {
                    aiTabBtn.classList.remove("locked");
                    aiTabBtn.title = "";
                    aiTabBtn.style.pointerEvents = "";
                }
                if (aiPanel) {
                    var controls2 = aiPanel.querySelectorAll("button, input, select, textarea");
                    controls2.forEach(function (el) {
                        el.disabled = false;
                        el.classList.remove("control-locked");
                    });
                }
                if (aiNotice) {
                    aiNotice.style.display = (planName === "free") ? "" : "none";
                }
            }

            updateUserPlanBadge();
            updatePlanRestrictionNote();
            if (typeof updateAiQuotaUI === "function") updateAiQuotaUI();
        }

        function getSelectedDroughtIndexValue() {
            var el = getDroughtIndexSelectEl();
            return el ? el.value : "spi";
        }

        function getSelectedDroughtIndexText() {
            var el = getDroughtIndexSelectEl();
            if (!el) return "SPI";
            return el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : "SPI";
        }



        // ---------- Data-source rules for NASA POWER and ERA5-Land/CDS ----------
        function parseYearFromDate(value, fallback) {
            if (!value) return fallback;
            var s = String(value).trim();
            var m = s.match(/(19|20)\d{2}/);
            if (!m) return fallback;
            var y = parseInt(m[0], 10);
            return isFinite(y) ? y : fallback;
        }

        function parseBaselineYearRange(value) {
            if (!value) return null;
            var years = String(value).match(/(?:19|20)\d{2}/g);
            if (!years || years.length < 2) return null;
            return { start: parseInt(years[0], 10), end: parseInt(years[1], 10) };
        }

        function getTodayIsoDate() {
            return new Date().toISOString().slice(0, 10);
        }

        function updateDatasourceHelp() {
            var obsSrcEl = document.getElementById("obsSrc");
            var helpEl = document.getElementById("obsSrcHelp");
            if (!obsSrcEl || !helpEl) return;

            var ds = obsSrcEl.value || "nasa_power";
            if (ds === "nasa_power") {
                helpEl.innerHTML = "<strong>NASA POWER:</strong> default free source for point-based SPI. Use start/baseline years from <strong>1981 onward</strong>. No CDS key is required.";
            } else if (ds === "era5" || ds === "era5_land_cds") {
                helpEl.innerHTML = "<strong>ERA5-Land/CDS:</strong> enabled as an advanced source for longer historical records. It requires the server CDS token/license, and first-time long downloads may take several minutes.";
            } else {
                helpEl.innerHTML = "This datasource is listed for future/licensed workflows and may not be active in the Research Version.";
            }
        }

        function applyDatasourceDateDefaults() {
            var obsSrcEl = document.getElementById("obsSrc");
            var startEl = document.getElementById("startDate");
            var endEl = document.getElementById("endDate");
            if (!obsSrcEl || !startEl) return;

            var ds = obsSrcEl.value || "nasa_power";
            var startYear = parseYearFromDate(startEl.value, 2000);
            var today = getTodayIsoDate();

            if (endEl && endEl.value && endEl.value > today) {
                endEl.value = today;
            }

            // NASA POWER begins in 1981 for this workflow. Auto-adjust very old dates
            // so the user does not trigger a long/invalid request by mistake.
            if (ds === "nasa_power" && startYear < 1981) {
                startEl.value = "1981-01-01";
            }

            updateDatasourceHelp();
        }

        function validateDatasourceBeforeRun(obsSrc, start, end, baseline) {
            var startYear = parseYearFromDate(start, null);
            var endYear = parseYearFromDate(end, null);
            if (startYear == null || endYear == null) {
                throw new Error("Please enter valid start and end dates.");
            }
            if (endYear < startYear) {
                throw new Error("End date must be after the start date.");
            }

            var baselineRange = parseBaselineYearRange(baseline);
            var downloadStartYear = baselineRange ? Math.min(startYear, baselineRange.start) : startYear;
            var downloadEndYear = baselineRange ? Math.max(endYear, baselineRange.end) : endYear;

            if (obsSrc === "nasa_power") {
                if (downloadStartYear < 1981) {
                    throw new Error("NASA POWER is available from 1981 onward for this workflow. Please use a start date and baseline from 1981 or later, or choose ERA5-Land/CDS for older years.");
                }
            }

            if (obsSrc === "era5" || obsSrc === "era5_land_cds") {
                if (downloadStartYear < 1950) {
                    throw new Error("ERA5-Land/CDS monthly data should use 1950 or later. Please change the start date or baseline.");
                }

                var totalYears = downloadEndYear - downloadStartYear + 1;
                if (totalYears > 45) {
                    var ok = confirm(
                        "ERA5-Land/CDS request covers about " + totalYears + " years (" +
                        downloadStartYear + "-" + downloadEndYear + ").\n\n" +
                        "The first run may take several minutes and can time out in the browser while the backend is still downloading/caching the data.\n\n" +
                        "Continue?"
                    );
                    if (!ok) {
                        throw new Error("ERA5-Land/CDS long request was cancelled. Use NASA POWER for faster free point analysis, or reduce the date range.");
                    }
                }
            }

            return {
                startYear: startYear,
                endYear: endYear,
                downloadStartYear: downloadStartYear,
                downloadEndYear: downloadEndYear
            };
        }

        function getFetchRetryOptionsForDatasource(obsSrc, start, end, baseline) {
            if (obsSrc === "era5" || obsSrc === "era5_land_cds") {
                return { retries: 2, retryDelayMs: 60000 };
            }
            return { retries: 1, retryDelayMs: 30000 };
        }

        document.addEventListener("DOMContentLoaded", function () {
            var obsSrcEl = document.getElementById("obsSrc");
            var startEl = document.getElementById("startDate");
            var baselineEl = document.getElementById("baseline");

            if (obsSrcEl) {
                obsSrcEl.addEventListener("change", function () {
                    applyDatasourceDateDefaults();
                });
            }
            if (startEl) {
                startEl.addEventListener("change", function () {
                    applyDatasourceDateDefaults();
                });
            }
            if (baselineEl) {
                baselineEl.addEventListener("change", function () {
                    updateDatasourceHelp();
                });
            }

            applyDatasourceDateDefaults();
        });


        // =============== LEAFLET MAP - OPENSTREETMAP ======================
        var map = L.map("map").setView([42, -93.66], 6);

        // OpenStreetMap tiles are more stable for the public/free version.
        var baseMap = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19
        }).addTo(map);

        var pointMarker = null, boxRect = null, firstCorner = null;

        function wrapLon(lon) {
            lon = ((lon + 180) % 360 + 360) % 360 - 180;
            return lon;
        }

        function setPoint(lat, lon) {
            lon = wrapLon(lon);
            if (pointMarker) map.removeLayer(pointMarker);
            pointMarker = L.marker([lat, lon]).addTo(map);
            document.getElementById("lat").value = (+lat).toFixed(4);
            document.getElementById("lon").value = (+lon).toFixed(4);
        }

        // helper used when loading a saved run
        window.DMAPAI_setPointFromSavedRun = function (lat, lon) {
            setPoint(lat, lon);
            map.setView([lat, lon], map.getZoom() || 6);
        };

        function setBox(sw, ne) {
            if (boxRect) map.removeLayer(boxRect);
            var swW = [sw[0], wrapLon(sw[1])];
            var neW = [ne[0], wrapLon(ne[1])];
            boxRect = L.rectangle([swW, neW], { color: "#2563eb", weight: 1 }).addTo(map);

            var lat1 = swW[0], lon1 = swW[1];
            var lat2 = neW[0], lon2 = neW[1];
            var swLat = Math.min(lat1, lat2), swLon = Math.min(lon1, lon2);
            var neLat = Math.max(lat1, lat2), neLon = Math.max(lon1, lon2);
            document.getElementById("startLat").value = swLat.toFixed(4);
            document.getElementById("startLon").value = swLon.toFixed(4);
            document.getElementById("endLat").value = neLat.toFixed(4);
            document.getElementById("endLon").value = neLon.toFixed(4);
        }

        map.on("click", function (e) {
            var aoi = document.querySelector('input[name="aoi"]:checked').value;
            if (aoi === "point") {
                setPoint(e.latlng.lat, e.latlng.lng);
                document.getElementById("mapHint").textContent = "Point set. Click elsewhere to move it.";
            } else {
                if (!firstCorner) {
                    firstCorner = [e.latlng.lat, e.latlng.lng];
                    if (boxRect) { map.removeLayer(boxRect); boxRect = null; }
                    document.getElementById("mapHint").textContent =
                        "Now click again to set the End (NE) corner.";
                } else {
                    var second = [e.latlng.lat, e.latlng.lng];
                    setBox(firstCorner, second);
                    firstCorner = null;
                    document.getElementById("mapHint").textContent =
                        "Rectangle set. Click again to start over.";
                }
            }
        });

        setTimeout(function () { map.invalidateSize(); }, 0);
        window.addEventListener("resize", function () { map.invalidateSize(); });

        document.querySelectorAll('input[name="aoi"]').forEach(function (r) {
            r.addEventListener("change", function () {
                var isPoint = document.querySelector('input[name="aoi"]:checked').value === "point";
                document.getElementById("pointInputs").classList.toggle("hidden", !isPoint);
                document.getElementById("boxInputs").classList.toggle("hidden", isPoint);
                document.getElementById("mapHint").textContent = isPoint
                    ? "Click the map to set Lat/Lon."
                    : "Rectangle mode: click SW, then NE.";
                setTimeout(function () { map.invalidateSize(); }, 0);
            });
        });

        // =============== AUTH0 / GOOGLE AUTH =================
        var authShell = document.getElementById("authShell");
        var appShell = document.getElementById("appShell");
        var authEmail = document.getElementById("authEmail");
        var authPassword = document.getElementById("authPassword");
        var authSignInBtn = document.getElementById("authSignInBtn");
        var authError = document.getElementById("authError");
        var userEmailLabel = document.getElementById("userEmailLabel");
        var signOutBtn = document.getElementById("signOutBtn");

        var currentUserEmail = null;
        var currentUserPlanName = localStorage.getItem("dmapai_current_plan") || "free";
        var auth0Client = null;

        var AUTH0_DOMAIN = "agrimetsoft.us.auth0.com";
        var AUTH0_CLIENT_ID = "OSqukLHglzE9hqQCrxPrz859FKUpNm7F";
        var AUTH0_AUDIENCE = "https://dmap-ai-api";

        function getAuthToken() {
            return localStorage.getItem("dmapai_auth_token") || "";
        }

        function authHeaders(extra) {
            var h = extra ? Object.assign({}, extra) : {};
            var token = getAuthToken();
            if (token) {
                h["Authorization"] = "Bearer " + token;
            }
            var emailForHeader = currentUserEmail || localStorage.getItem("dmapai_current_user") || "";
            if (emailForHeader) {
                h["X-DMAP-User-Email"] = emailForHeader;
            }
            return h;
        }

        function setUserFromPayload(payload) {
            var user = payload && payload.user ? payload.user : payload;
            if (!user || !user.email) return;

            currentUserEmail = user.email;
            currentUserPlanName = user.plan || "free";

            localStorage.setItem("dmapai_current_user", currentUserEmail);
            localStorage.setItem("dmapai_current_plan", currentUserPlanName);

            if (authShell) authShell.classList.add("hidden");
            if (appShell) appShell.classList.remove("hidden");

            if (userEmailLabel) {
                userEmailLabel.textContent = currentUserEmail;
                userEmailLabel.classList.remove("hidden");
            }

            setTimeout(function () {
                if (window.map && typeof map.invalidateSize === "function") {
                    map.invalidateSize();
                }
            }, 50);

            updateUserPlanBadge();
            applyPlanRestrictions();
            renderDashboard();

            setTimeout(function () {
                if (typeof loadDashboardFromServer === "function") {
                    loadDashboardFromServer();
                }
            }, 300);
        }

        function clearUserLocalOnly() {
            currentUserEmail = null;
            currentUserPlanName = "free";
            localStorage.removeItem("dmapai_current_user");
            localStorage.removeItem("dmapai_current_plan");
            localStorage.removeItem("dmapai_auth_token");

            if (authShell) authShell.classList.remove("hidden");
            if (appShell) appShell.classList.add("hidden");

            if (userEmailLabel) {
                userEmailLabel.textContent = "";
                userEmailLabel.classList.add("hidden");
            }

            updateUserPlanBadge();
        }

        async function refreshBackendUserFromAuth0() {
            var token = await auth0Client.getTokenSilently({
                authorizationParams: {
                    audience: AUTH0_AUDIENCE
                }
            });

            localStorage.setItem("dmapai_auth_token", token);

            var auth0Profile = {};
            try {
                auth0Profile = await auth0Client.getUser();
            } catch (profileErr) {
                console.warn("Could not read Auth0 user profile:", profileErr);
            }

            var meHeaders = authHeaders({
                "X-DMAP-User-Email": auth0Profile && auth0Profile.email ? auth0Profile.email : "",
                "X-DMAP-User-Name": auth0Profile && auth0Profile.name ? auth0Profile.name : "",
                "X-DMAP-User-Sub": auth0Profile && auth0Profile.sub ? auth0Profile.sub : ""
            });

            var resp = await fetch(API_BASE + "/account/me", {
                headers: meHeaders
            });

            var data = await resp.json().catch(function () { return {}; });

            if (!resp.ok) {
                throw new Error(data && data.detail && data.detail.message ? data.detail.message : "Could not load account.");
            }

            setUserFromPayload(data);
        }

        async function initAuth0Login() {
            if (authEmail && authEmail.closest("label")) {
                authEmail.closest("label").style.display = "none";
            }
            if (authPassword && authPassword.closest("label")) {
                authPassword.closest("label").style.display = "none";
            }
            if (authSignInBtn) {
                authSignInBtn.textContent = "Sign in with Google";
            }

            auth0Client = await auth0.createAuth0Client({
                domain: AUTH0_DOMAIN,
                clientId: AUTH0_CLIENT_ID,
                cacheLocation: "localstorage",
                // DMAP-AI does not need refresh tokens for the current Research Version.
                // Keeping refresh tokens enabled without Auth0 refresh-token rotation can cause
                // "Missing Refresh Token" errors after redirect or browser cache changes.
                useRefreshTokens: false,
                authorizationParams: {
                    redirect_uri: window.location.origin + "/DMAP_AI_App",
                    audience: AUTH0_AUDIENCE,
                    scope: "openid profile email"
                }
            });

            if (window.location.search.includes("code=") && window.location.search.includes("state=")) {
                await auth0Client.handleRedirectCallback();
                window.history.replaceState({}, document.title, window.location.pathname);
            }

            var isAuthenticated = await auth0Client.isAuthenticated();

            if (isAuthenticated) {
                await refreshBackendUserFromAuth0();
            } else {
                clearUserLocalOnly();
                if (typeof renderDashboard === "function") renderDashboard();
                applyPlanRestrictions();
            }
        }

        if (authSignInBtn) {
            authSignInBtn.addEventListener("click", async function () {
                if (!auth0Client) return;
                await auth0Client.loginWithRedirect({
                    authorizationParams: {
                        redirect_uri: window.location.origin + "/DMAP_AI_App",
                        audience: AUTH0_AUDIENCE,
                        scope: "openid profile email"
                    }
                });
            });
        }

        if (signOutBtn) {
            signOutBtn.addEventListener("click", async function () {
                try {
                    localStorage.removeItem("dmapai_auth_token");
                    if (auth0Client) {
                        await auth0Client.logout({
                            logoutParams: {
                                returnTo: window.location.origin + "/"
                            }
                        });
                    }
                } catch (e) {
                    clearUserLocalOnly();
                }
            });
        }

        window.addEventListener("DOMContentLoaded", async function () {
            try {
                await initAuth0Login();
            } catch (e) {
                console.error("Auth0 initialization error:", e);
                if (authError) {
                    authError.textContent = e.message || String(e);
                    authError.classList.remove("hidden");
                }
                clearUserLocalOnly();
            }

            var droughtIndexSelect = getSelectedDroughtIndexSelect();
            if (droughtIndexSelect) {
                droughtIndexSelect.addEventListener("change", function () {
                    console.log("Selected drought index:", getSelectedDroughtIndexValue(), getSelectedDroughtIndexText());
                });
            }
        });


        // =============== ACCOUNT DASHBOARD LOADING =================
        // Saved projects/runs are handled by dashboard_db.js through the account database.

        // =============== WAVELET SCALOGRAM DRAWING =================
        function drawWaveletScalogram(power2D) {
            // ---- NEW: store scalogram data for JSON/AI context ----
            try {
                if (Array.isArray(power2D) && power2D.length) {
                    waveletPower2D = power2D.map(function (row) {
                        return Array.isArray(row) ? row.slice() : [];
                    });
                    waveletTimeIndices = [];
                    var nTimeLocal = power2D.length;
                    for (var ti = 0; ti < nTimeLocal; ti++) {
                        waveletTimeIndices.push(ti);
                    }

                    waveletYears = [];
                    if (Array.isArray(lastSeries) && lastSeries.length === nTimeLocal) {
                        for (var i = 0; i < lastSeries.length; i++) {
                            var rec = lastSeries[i] || {};
                            var yr = null;
                            if (rec.end_date) {
                                var yStr = String(rec.end_date).slice(0, 4);
                                var yNum = parseInt(yStr, 10);
                                if (!isNaN(yNum)) yr = yNum;
                            } else if (rec.year != null) {
                                var yNum2 = parseInt(rec.year, 10);
                                if (!isNaN(yNum2)) yr = yNum2;
                            }
                            waveletYears.push(yr);
                        }
                    }
                }
            } catch (e) {
                console.warn("Could not store wavelet scalogram for JSON:", e);
            }

            // ---- original drawing code ----
            var canvas = document.getElementById("waveletScalogram");
            if (!canvas) return;
            var ctx = canvas.getContext("2d");

            var nTime = power2D.length;
            var nPeriod = power2D[0] ? power2D[0].length : 0;
            if (!nTime || !nPeriod) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                return;
            }

            var MARGIN_LEFT = 60;
            var MARGIN_BOTTOM = 40;
            var MARGIN_TOP = 20;
            var MARGIN_RIGHT = 10;

            var SCALOGRAM_WIDTH = 800;
            var SCALOGRAM_HEIGHT = 320;
            var W_total = SCALOGRAM_WIDTH;
            var H_total = SCALOGRAM_HEIGHT;
            canvas.width = W_total;
            canvas.height = H_total;

            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, W_total, H_total);

            ctx.strokeStyle = "black";
            ctx.fillStyle = "#333";
            ctx.lineWidth = 1;
            ctx.font = "12px Inter, sans-serif";

            var plotW = W_total - MARGIN_LEFT - MARGIN_RIGHT;
            var plotH = H_total - MARGIN_BOTTOM - MARGIN_TOP;

            var cellW = plotW / nTime;
            var cellH = plotH / nPeriod;

            var vMin = Infinity, vMax = -Infinity;
            var logPower2D = power2D.map(function (row) {
                return row.map(function (v) { return Math.log(v > 0 ? v : 1e-6); });
            });

            var i, j;
            for (i = 0; i < nTime; i++) {
                for (j = 0; j < nPeriod; j++) {
                    var v = logPower2D[i][j];
                    if (!isFinite(v)) continue;
                    if (v < vMin) vMin = v;
                    if (v > vMax) vMax = v;
                }
            }
            if (!isFinite(vMin) || !isFinite(vMax) || vMax <= vMin) {
                vMin = 0; vMax = 1;
            }

            function colorFor(v) {
                var t = Math.max(0, Math.min(1, (v - vMin) / (vMax - vMin)));
                var r = Math.round(255 * t);
                var g = Math.round(255 * (t * t));
                var b = Math.round(255 * (1 - t));
                return "rgb(" + r + "," + g + "," + b + ")";
            }

            for (i = 0; i < nTime; i++) {
                for (j = 0; j < nPeriod; j++) {
                    ctx.fillStyle = colorFor(logPower2D[i][j]);
                    var x = MARGIN_LEFT + i * cellW;
                    var y = H_total - MARGIN_BOTTOM - (j + 1) * cellH;
                    ctx.fillRect(x, y, cellW + 1, cellH + 1);
                }
            }

            ctx.fillStyle = "black";

            var plotBottom = H_total - MARGIN_BOTTOM;
            var plotLeft = MARGIN_LEFT;
            var plotTop = MARGIN_TOP;
            var plotRight = W_total - MARGIN_RIGHT;

            ctx.beginPath();
            ctx.moveTo(plotLeft, plotBottom);
            ctx.lineTo(plotRight, plotBottom);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(plotLeft, plotTop);
            ctx.lineTo(plotLeft, plotBottom);
            ctx.stroke();

            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            var xTickStep = Math.max(1, Math.floor(nTime / 8));
            for (i = 0; i < nTime; i += xTickStep) {
                var xPos = plotLeft + i * cellW;
                ctx.beginPath();
                ctx.moveTo(xPos, plotBottom);
                ctx.lineTo(xPos, plotBottom + 5);
                ctx.stroke();
                ctx.fillText(String(i), xPos, plotBottom + 8);
            }
            ctx.fillText("Time Index", plotLeft + plotW / 2, H_total - 18);

            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            var yTickStep = Math.max(1, Math.floor(nPeriod / 5));
            for (j = 0; j < nPeriod; j += yTickStep) {
                var yPos = plotBottom - (j * cellH);
                ctx.beginPath();
                ctx.moveTo(plotLeft, yPos);
                ctx.lineTo(plotLeft - 5, yPos);
                ctx.stroke();
                ctx.fillText(String(j), plotLeft - 8, yPos);
            }

            ctx.save();
            ctx.translate(15, plotTop + plotH / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = "center";
            ctx.fillText("Scale Index (Period)", 0, 0);
            ctx.restore();
        }
        // =============== COPULA ANALYSIS (BIVARIATE) =================
        function copulaGuessPrecipValue(row) {
            var cand = [
                "window_sum_mm",
                "obs_sum_mm",
                "sum_mm",
                "windowmm",
                "window_sum",
                "sum",
                "obs_sum",
                "precip_sum",
                "p_sum",
                "total_mm",
                "sum_mm_window"
            ];
            for (var i = 0; i < cand.length; i++) {
                var k = cand[i];
                if (row && Object.prototype.hasOwnProperty.call(row, k)) {
                    var v = row[k];
                    if (v !== null && v !== undefined && !isNaN(v)) return +v;
                }
            }
            return null;
        }

        function copulaMakePseudoObs(arr) {
            // convert numeric array to U[0,1] via ranks
            var n = arr.length;
            if (!n) return [];
            var pairs = arr.map(function (v, i) { return { v: v, i: i }; })
                .filter(function (p) { return p.v !== null && !isNaN(p.v); });
            pairs.sort(function (a, b) { return a.v - b.v; });
            var ranks = new Array(n).fill(null);
            for (var r = 0; r < pairs.length; r++) {
                ranks[pairs[r].i] = (r + 1) / (pairs.length + 1);
            }
            return ranks;
        }

        function buildCopulaPairFromSeries(series, pairType) {
            console.log("[copula] buildCopulaPairFromSeries, pairType=", pairType, "len=", series ? series.length : 0);
            if (!Array.isArray(series) || series.length < 10) {
                console.warn("[copula] series too short or missing");
                return null;
            }

            var precip = [];
            var spi = [];

            series.forEach(function (row) {
                if (!row) return;
                var s = row.spi;
                var p = copulaGuessPrecipValue(row);
                if (s !== null && s !== undefined && !isNaN(s) && p !== null && !isNaN(p)) {
                    spi.push(+s);
                    precip.push(+p);
                }
            });

            console.log("[copula] raw precip/spi counts:", precip.length, spi.length);
            var rawSpiSeries = spi.slice();

            if (pairType === "spi_lag1") {
                // align SPI_t and SPI_{t-1}
                var spiLag = [];
                var spiCur = [];
                for (var i = 1; i < spi.length; i++) {
                    if (!isNaN(spi[i]) && !isNaN(spi[i - 1])) {
                        spiCur.push(spi[i]);
                        spiLag.push(spi[i - 1]);
                    }
                }
                spi = spiCur;
                precip = spiLag;  // here "precip" stands for previous SPI
                console.log("[copula] prepared lag-1 SPI pairs:", precip.length);
            }

            var n = Math.min(precip.length, spi.length);
            if (!n) {
                console.warn("[copula] no valid paired values");
                return null;
            }
            precip = precip.slice(0, n);
            spi = spi.slice(0, n);

            var rawX = precip.slice();
            var rawY = spi.slice();

            var U = copulaMakePseudoObs(precip);
            var V = copulaMakePseudoObs(spi);

            console.log("[copula] pseudo-obs sizes U,V:", U.length, V.length);

            return {
                U: U,
                V: V,
                n: n,
                raw_x: rawX,
                raw_y: rawY,
                raw_spi_series: rawSpiSeries
            };
        }

        function formatCopulaSummary(resp) {
            if (!resp) return "No copula result.";
            function fmt(x) {
                return (typeof x === "number" && isFinite(x)) ? x.toFixed(3) : "NA";
            }
            var lines = [];
            lines.push("Pair type: " + (resp.pair_type || "unknown"));
            lines.push("Family: " + (resp.family || "gaussian"));

            if (resp.params && typeof resp.params.rho === "number") {
                lines.push("Gaussian rho (correlation): " + fmt(resp.params.rho));
            }
            if (typeof resp.kendall_tau === "number") {
                lines.push("Kendall tau: " + fmt(resp.kendall_tau));
            }
            if (typeof resp.n === "number") {
                lines.push("Sample size used: " + resp.n);
            }
            lines.push("");

            var sev = resp.severity_stats || {};
            if (sev.mode === "precip_spi") {
                lines.push("Event-like probabilities (per time step):");
                var m = sev.marginal_probs || {};
                var c = sev.conditional_probs || {};
                lines.push("P(SPI ≤ -1.0)                 ≈ " + fmt(m.P_drought));
                lines.push("P(SPI ≤ -2.0)                 ≈ " + fmt(m.P_extreme));
                lines.push("P(precip ≤ 20th percentile)   ≈ " + fmt(m.P_lowP));
                lines.push("P(precip ≤ 10th percentile)   ≈ " + fmt(m.P_veryLowP));
                lines.push("P(drought | low precip)       ≈ " + fmt(c.P_drought_given_lowP));
                lines.push("P(extreme drought | very low precip) ≈ " + fmt(c.P_extreme_given_veryLowP));
            } else if (sev.mode === "spi_lag1") {
                var threshold = (typeof sev.threshold === "number") ? sev.threshold : -1.0;
                lines.push("Persistence / duration (SPI ≤ " + threshold.toFixed(1) + "):");
                var t = sev.transition_probs || {};
                lines.push("P(drought continues next step) ≈ " + fmt(t.P_persist));
                lines.push("P(new drought next step)       ≈ " + fmt(t.P_onset));
                lines.push("Approx. mean drought length    ≈ " + fmt(t.approx_mean_length));
                if (sev.transition_counts) {
                    var c = sev.transition_counts;
                    lines.push("Drought-event count            = " + (typeof c.drought_events === "number" ? c.drought_events : "NA"));
                }
            }

            return lines.join("\n");
        }
        function renderCopulaPlots(resp) {
            console.log("[copula] renderCopulaPlots", resp);

            // 1) Update the text summary
            var pre = document.getElementById("copulaSummary");
            if (pre && typeof formatCopulaSummary === "function") {
                pre.textContent = formatCopulaSummary(resp);
            } else if (pre) {
                pre.textContent = JSON.stringify(resp, null, 2);
            }

            // 2) Prepare the canvas
            var canvas = document.getElementById("copulaScatterCanvas");
            if (!canvas || !canvas.getContext) {
                console.warn("[copula] copulaScatterCanvas missing or no context");
                return;
            }

            // Fix the size once to avoid resize loops
            var wrapper = canvas.parentElement;
            var targetHeight = 260; // px – adjust if you like
            if (wrapper) {
                wrapper.style.height = targetHeight + "px";
            }
            canvas.style.width = "100%";
            canvas.style.height = targetHeight + "px";
            canvas.width = canvas.offsetWidth || 400;
            canvas.height = targetHeight;

            // 3) Build scatter points from uv_points returned by the API
            var uArr = (resp.uv_points && resp.uv_points.u) || [];
            var vArr = (resp.uv_points && resp.uv_points.v) || [];

            var points = [];
            var n = Math.min(uArr.length, vArr.length);
            for (var i = 0; i < n; i++) {
                var u = uArr[i];
                var v = vArr[i];
                if (u != null && v != null && isFinite(u) && isFinite(v)) {
                    points.push({ x: u, y: v });
                }
            }

            if (!points.length) {
                console.warn("[copula] no points to plot from uv_points; lengths:", uArr.length, vArr.length);
                return;
            }

            // 4) Destroy old scatter chart if it exists
            if (copulaScatterChart) {
                try { copulaScatterChart.destroy(); } catch (e) { }
                copulaScatterChart = null;
            }

            // 5) Draw new scatter chart (fixed size, not responsive)
            var ctx = canvas.getContext("2d");
            copulaScatterChart = new Chart(ctx, {
                type: "scatter",
                data: {
                    datasets: [{
                        label: "Copula pseudo-observations (U, V)",
                        data: points,
                        pointRadius: 2
                    }]
                },
                options: {
                    responsive: false,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        x: {
                            type: "linear",
                            min: 0,
                            max: 1,
                            title: { display: true, text: "U" }
                        },
                        y: {
                            type: "linear",
                            min: 0,
                            max: 1,
                            title: { display: true, text: "V" }
                        }
                    }
                }
            });
        }


        async function runCopulaAnalysisAndDraw() {
            console.log("[copula] runCopulaAnalysisAndDraw called");

            // Check that SPI has been run and lastSeries is populated
            console.log("[copula] lastSeries type:",
                Array.isArray(lastSeries) ? "array" : typeof lastSeries,
                "length:", Array.isArray(lastSeries) ? lastSeries.length : "n/a");

            if (!Array.isArray(lastSeries) || lastSeries.length < 10) {
                console.warn("[copula] lastSeries missing or too short; need SPI run first");
                alert("Please run SPI first (click Run on the SPI section), then compute the copula.");
                return;
            }

            var pairSelect = document.getElementById("copulaPairSelect");
            var pairType = pairSelect ? pairSelect.value : "precip_spi";
            console.log("[copula] pairType =", pairType);

            // Build pseudo-observations U,V
            var pair = buildCopulaPairFromSeries(lastSeries, pairType);
            if (!pair) {
                console.warn("[copula] buildCopulaPairFromSeries returned null/undefined");
                alert("Could not build copula sample from the current SPI run.");
                return;
            }
            console.log("[copula] pair sizes: U =", pair.U ? pair.U.length : "n/a",
                "V =", pair.V ? pair.V.length : "n/a");

            if (!pair.U || !pair.V || !pair.U.length) {
                console.warn("[copula] no valid pseudo-observations in U/V arrays");
                alert("Not enough valid points to fit the copula.");
                return;
            }

            var pre = document.getElementById("copulaSummary");
            if (pre) {
                pre.textContent = "Computing copula on " + pair.U.length + " points...";
            }

            var payload = {
                project_id: (typeof currentProjectId !== "undefined" && currentProjectId) ? currentProjectId : "demo_project",
                pair_type: pairType,
                // backend expects x and y as pseudo-observations U and V
                x: pair.U,
                y: pair.V,
                // raw values allow backend to calculate SPI-threshold persistence from real SPI
                raw_x: pair.raw_x || [],
                raw_y: pair.raw_y || [],
                raw_spi_series: pair.raw_spi_series || [],
                drought_threshold: -1.0
            };
            console.log("[copula] sending payload to API:", API_BASE + "/analysis/copula_bivariate", payload);

            try {
                var resp = await fetch(API_BASE + "/analysis/copula_bivariate", {
                    method: "POST",
                    headers: authHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify(payload)
                });
                console.log("[copula] API response status:", resp.status);

                if (!resp.ok) {
                    var txt = await resp.text();
                    console.error("[copula] API not OK:", txt);
                    if (pre) pre.textContent = "Copula API error " + resp.status + ": " + txt;
                    return;
                }

                var data = await resp.json();
                console.log("[copula] API response keys:", Object.keys(data));

                // Ensure the current-run JSON always has the U/V pseudo-observations used for plotting and validation.
                if (!data.uv_points || !Array.isArray(data.uv_points.u) || !Array.isArray(data.uv_points.v)) {
                    data.uv_points = {
                        u: pair.U ? pair.U.slice() : [],
                        v: pair.V ? pair.V.slice() : []
                    };
                }
                if (!data.raw_pair_values) {
                    data.raw_pair_values = {
                        raw_x: pair.raw_x ? pair.raw_x.slice() : [],
                        raw_y: pair.raw_y ? pair.raw_y.slice() : []
                    };
                }

                // Store result for JSON / AI
                lastCopulaResult = data;
                lastCopulaPairType = pairType;
                lastCopulaScale = lastScale || (lastRunMeta && lastRunMeta.scale) || "yearly";

                // Draw scatter + update summary – now only needs resp
                renderCopulaPlots(data);
                if (typeof enableCopulaChartOption === "function") {
                    enableCopulaChartOption();
                }



            } catch (err) {
                console.error("[copula] fetch error:", err);
                if (pre) pre.textContent = "Error computing copula: " + err.message;
                alert("Error computing copula. See console for details.");
            }
        }


        // Wire up the copula button after DOM is ready
        document.addEventListener("DOMContentLoaded", function () {
            var btn = document.getElementById("copulaRunBtn");
            if (btn) {
                console.log("[copula] attaching click handler to copulaRunBtn");
                btn.addEventListener("click", function () {
                    runCopulaAnalysisAndDraw();
                });
            } else {
                console.log("[copula] copulaRunBtn not found at DOMContentLoaded");
            }
        });

        // =============== VISIBILITY (mode/horizon/scale) ============
        var horizonCard = document.getElementById("horizonCard");
        var fcstSrcWrap = document.getElementById("fcstSrcWrap");
        var gcmSrcWrap = document.getElementById("gcmSrcWrap");
        var biasWrap = document.getElementById("biasWrap");
        var monthlyWindow = document.getElementById("monthlyWindow");
        var yearlyWindow = document.getElementById("yearlyWindow");
        var rollingCfg = document.getElementById("rollingCfg");

        function updateVisibility() {
            var mode = document.querySelector('input[name="mode"]:checked').value;
            var horizonInput = document.querySelector('input[name="horizon"]:checked');
            var horizon = horizonInput ? horizonInput.value : "30";
            var scale = document.querySelector('input[name="scale"]:checked').value;
            var ywinInput = document.querySelector('input[name="ywin"]:checked');
            var ywin = ywinInput ? ywinInput.value : "jan-dec";

            horizonCard.classList.toggle("hidden", mode !== "prediction");
            fcstSrcWrap.classList.toggle(
                "hidden",
                !(mode === "prediction" && horizon !== "gcm")
            );
            gcmSrcWrap.classList.toggle(
                "hidden",
                !(mode === "prediction" && horizon === "gcm")
            );
            biasWrap.classList.toggle(
                "hidden",
                !(mode === "prediction" && horizon === "gcm")
            );

            monthlyWindow.classList.toggle("hidden", scale !== "monthly");
            yearlyWindow.classList.toggle("hidden", scale !== "yearly");
            rollingCfg.classList.toggle(
                "hidden",
                !(scale === "yearly" && ywin === "rolling")
            );
        }

        document.querySelectorAll('input[name="mode"]').forEach(function (r) {
            r.addEventListener("change", updateVisibility);
        });
        document.querySelectorAll('input[name="horizon"]').forEach(function (r) {
            r.addEventListener("change", updateVisibility);
        });
        document.querySelectorAll('input[name="scale"]').forEach(function (r) {
            r.addEventListener("change", updateVisibility);
        });
        document.querySelectorAll('input[name="ywin"]').forEach(function (r) {
            r.addEventListener("change", updateVisibility);
        });
        updateVisibility();

        // =============== TABS ==========================
        var tabButtons = document.querySelectorAll(".tab-btn");
        var tabPanels = {
            table: document.getElementById("panel-table"),
            charts: document.getElementById("panel-charts"),
            severity: document.getElementById("panel-severity"),
            wavelet: document.getElementById("panel-wavelet"),
            copula: document.getElementById("panel-copula"),
            ai: document.getElementById("panel-ai"),
            json: document.getElementById("panel-json"),
            export: document.getElementById("panel-export"),
            debug: document.getElementById("panel-debug")
        };
        var lastSeries = [];
        var lastScale = "yearly";
        var lastRunRaw = null;
        var lastRunMeta = null;
        var lastCopulaResult = null;
        var lastCopulaPairType = null;
        var lastCopulaScale = null;
        var categoryMethod = "classic";
        var spiCategorizationStats = null;
        var spiKMeansConfig = null;


        function switchTab(name) {
            if (name === "ai" && !getCurrentPlanConfig().aiEnabled) {
                var lockedMsg = document.getElementById("resultOutput");
                if (lockedMsg) {
                    lockedMsg.textContent = "AI Interpretation is reserved for licensed versions.";
                }
                name = "table";
            }
            tabButtons.forEach(function (b) { b.classList.remove("active"); });
            for (var k in tabPanels) {
                if (tabPanels[k]) tabPanels[k].classList.remove("active");
            }
            var btn = document.querySelector('.tab-btn[data-tab="' + name + '"]');
            if (btn) btn.classList.add("active");
            if (tabPanels[name]) tabPanels[name].classList.add("active");

            if (name === "charts") {
                requestAnimationFrame(function () { buildCharts(lastSeries, lastScale); });
            } else {
                destroyCharts();
            }
            if (name === "severity") {
                requestAnimationFrame(function () { buildSeverityChart(lastSeries); });
            }
            if (name === "wavelet") {
                requestAnimationFrame(function () { computeWaveletFromSeries(lastSeries); });
            }
            if (name === "json") {
                requestAnimationFrame(function () { refreshJsonView(); });
            }
            if (name === "export") {
                requestAnimationFrame(function () {
                    updateExportSelectedSummary();
                    setExportStatus(lastSeries && lastSeries.length ? "Select items, then create the ZIP package." : "Run SPI first, then export.", false);
                });
            }
        }


        tabButtons.forEach(function (btn) {
            btn.addEventListener("click", function () {
                switchTab(btn.getAttribute("data-tab"));
            });
        });

        // =============== HELPERS ========================
        function spiCategoryClassic(v) {
            if (v == null || isNaN(+v)) return "—";
            v = +v;
            if (v <= -2.0) return "Extreme drought";
            if (v <= -1.5) return "Severe drought";
            if (v <= -1.0) return "Moderate drought";
            if (v < 1.0) return "Near normal";
            if (v < 1.5) return "Moderately wet";
            if (v < 2.0) return "Very wet";
            return "Extremely wet";
        }

        // U.S. Drought Monitor (USDM)-style categories based on the official SPI/SPEI ranges.
        // D0 is abnormally dry; D1-D4 are drought categories. Positive or near-normal SPI is treated as "No drought".
        function spiCategoryUsdm(v) {
            if (v == null || isNaN(+v)) return "—";
            v = +v;
            if (v <= -2.0) return "D4 – Exceptional drought";
            if (v <= -1.6) return "D3 – Extreme drought";
            if (v <= -1.3) return "D2 – Severe drought";
            if (v <= -0.8) return "D1 – Moderate drought";
            if (v <= -0.5) return "D0 – Abnormally dry";
            return "No drought";
        }

        // Data-driven AI/ML-style categorization based on SPI percentiles.
        // Uses the distribution from the current series (lowest 5%, 5–20%,
        // central 60%, 80–95%, and top 5%).
        
        // Percentile-based stats for SPI (still useful as a statistical baseline)
        function computeSpiCategorizationStats(values) {
            if (!values || !values.length) return null;
            var filtered = values.filter(function (v) {
                return v != null && isFinite(v);
            });
            if (!filtered.length) return null;
            var sorted = filtered.slice().sort(function (a, b) { return a - b; });

            function q(p) {
                var idx = (sorted.length - 1) * p;
                var lo = Math.floor(idx);
                var hi = Math.ceil(idx);
                if (lo === hi) return sorted[lo];
                var w = idx - lo;
                return sorted[lo] * (1 - w) + sorted[hi] * w;
            }

            return {
                q05: q(0.05),
                q20: q(0.20),
                q80: q(0.80),
                q95: q(0.95)
            };
        }

        // Simple 1-D k-means clustering for SPI (unsupervised ML)
        function computeSpiKMeansConfig(values, k) {
            if (!values || !values.length) return null;
            var data = values.filter(function (v) {
                return v != null && isFinite(v);
            });
            if (!data.length) return null;
            k = k || 7;
            if (data.length < k) {
                // Not enough data for full clustering; fall back to null
                return null;
            }
            data = data.slice().sort(function (a, b) { return a - b; });

            // Initialize centers using evenly spaced quantiles
            var centers = [];
            for (var j = 0; j < k; j++) {
                var idx = Math.floor((j + 0.5) * data.length / k);
                if (idx < 0) idx = 0;
                if (idx >= data.length) idx = data.length - 1;
                centers.push(data[idx]);
            }

            var assignments = new Array(data.length);
            var maxIter = 50;
            for (var iter = 0; iter < maxIter; iter++) {
                var changed = false;

                // Assignment step
                for (var i = 0; i < data.length; i++) {
                    var x = data[i];
                    var bestIdx = 0;
                    var bestDist = Math.abs(x - centers[0]);
                    for (var c = 1; c < k; c++) {
                        var d = Math.abs(x - centers[c]);
                        if (d < bestDist) {
                            bestDist = d;
                            bestIdx = c;
                        }
                    }
                    if (assignments[i] !== bestIdx) {
                        assignments[i] = bestIdx;
                        changed = true;
                    }
                }

                // Update step
                var sums = new Array(k).fill(0);
                var counts = new Array(k).fill(0);
                for (var i2 = 0; i2 < data.length; i2++) {
                    var ac = assignments[i2];
                    sums[ac] += data[i2];
                    counts[ac]++;
                }
                for (var c2 = 0; c2 < k; c2++) {
                    if (counts[c2] > 0) {
                        centers[c2] = sums[c2] / counts[c2];
                    }
                }

                if (!changed) break;
            }

            // Order centers from driest to wettest
            centers.sort(function (a, b) { return a - b; });

            var labels = [
                "AI: Extreme drought (cluster 1 driest)",
                "AI: Severe drought",
                "AI: Moderate drought",
                "AI: Near normal",
                "AI: Moderately wet",
                "AI: Very wet",
                "AI: Extremely wet (cluster K wettest)"
            ];

            return {
                k: k,
                centers: centers,
                labels: labels
            };
        }

        function spiCategoryQuantile(v) {
            if (v == null || isNaN(+v)) return "—";
            if (!spiCategorizationStats) return spiCategoryClassic(v);
            var stats = spiCategorizationStats;
            v = +v;
            // Conceptual percentile bands: ~lowest 5%, 5–20%, 20–80%, 80–95%, top 5%
            if (v <= stats.q05) return "Extreme drought (≈lowest 5%)";
            if (v <= stats.q20) return "Moderate drought (≈5–20%)";
            if (v >= stats.q95) return "Extreme wet (≈top 5%)";
            if (v >= stats.q80) return "Moderate wet (≈80–95%)";
            return "Near normal (≈20–80%)";
        }

        function spiCategoryKMeans(v) {
            if (v == null || isNaN(+v)) return "—";
            if (!spiKMeansConfig || !spiKMeansConfig.centers || !spiKMeansConfig.centers.length) {
                return spiCategoryClassic(v);
            }
            var centers = spiKMeansConfig.centers;
            var labels = spiKMeansConfig.labels || [];
            var x = +v;
            var bestIdx = 0;
            var bestDist = Math.abs(x - centers[0]);
            for (var i = 1; i < centers.length; i++) {
                var d = Math.abs(x - centers[i]);
                if (d < bestDist) {
                    bestDist = d;
                    bestIdx = i;
                }
            }
            if (labels[bestIdx]) {
                return labels[bestIdx];
            }
            return "AI: Cluster " + (bestIdx + 1);
        }

        function getSpiCategory(v) {
            if (categoryMethod === "usdm") return spiCategoryUsdm(v);
            if (categoryMethod === "quantile") return spiCategoryQuantile(v);
            if (categoryMethod === "kmeans") return spiCategoryKMeans(v);
            return spiCategoryClassic(v);
        }

function getWindowSum(rec) {
            var cand = [
                "window_sum_mm", "obs_sum_mm", "sum_mm", "windowmm", "window_sum",
                "sum", "obs_sum", "precip_sum", "p_sum", "total_mm", "sum_mm_window"
            ];
            var k, v, num;
            for (var i = 0; i < cand.length; i++) {
                k = cand[i];
                if (k in rec) {
                    v = rec[k];
                    num = (typeof v === "string") ? parseFloat(v) : v;
                    if (isFinite(num)) return num;
                }
            }
            for (k in rec) {
                if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
                v = rec[k];
                if (typeof v === "string" || typeof v === "number") {
                    if (k.toLowerCase().indexOf("sum") !== -1) {
                        num = (typeof v === "string") ? parseFloat(v) : v;
                        if (isFinite(num)) return num;
                    }
                }
            }
            return null;
        }
        // Simple helper to show/hide the wavelet loading banner
        function setWaveletLoading(isLoading, msg) {
            var box = document.getElementById("waveletLoading");
            if (!box) return;

            var textEl = document.getElementById("waveletLoadingText");
            if (msg && textEl) {
                textEl.textContent = msg;
            }

            if (isLoading) {
                box.classList.remove("hidden");
            } else {
                box.classList.add("hidden");
            }
        }

        // =============== CHARTS (line / bar / boxplot) =======
        var lineChart = null, anomChart = null, boxChart = null, copulaScatterChart = null;

        // ---- SPI line chart bounds (upper/lower reference lines) ----
        var lastAppliedSpiBounds = null;

        function getSpiLineBounds() {
            var ubEl = document.getElementById("spiUpperBound");
            var lbEl = document.getElementById("spiLowerBound");

            var ub = ubEl ? parseFloat(ubEl.value) : 2.0;
            var lb = lbEl ? parseFloat(lbEl.value) : -2.0;

            if (!isFinite(ub)) ub = 2.0;
            if (!isFinite(lb)) lb = -2.0;

            // If user accidentally swaps them, normalize
            if (lb > ub) {
                var tmp = lb;
                lb = ub;
                ub = tmp;
            }

            return { upper: ub, lower: lb };
        }

        function buildConstArray(n, value) {
            var arr = new Array(n);
            for (var i = 0; i < n; i++) arr[i] = value;
            return arr;
        }

        function updateSpiLineBoundsOnChart() {
            if (!lineChart || !lineChart.data) return;

            var labels = lineChart.data.labels || [];
            var n = labels.length;

            var b = getSpiLineBounds();
            var ubArr = buildConstArray(n, b.upper);
            var lbArr = buildConstArray(n, b.lower);

            // We expect datasets: [0]=SPI, [1]=Upper, [2]=Lower
            if (lineChart.data.datasets && lineChart.data.datasets.length >= 3) {
                lineChart.data.datasets[1].data = ubArr;
                lineChart.data.datasets[2].data = lbArr;
            }

            // Update y-axis range so the bound lines are always visible
            lineChart.options = lineChart.options || {};
            lineChart.options.scales = lineChart.options.scales || {};
            lineChart.options.scales.y = lineChart.options.scales.y || {};

            lineChart.options.scales.y.suggestedMin = Math.min(-3, b.lower - 0.5);
            lineChart.options.scales.y.suggestedMax = Math.max(3, b.upper + 0.5);

            

            // Remember what was last applied so click-outside can detect pending edits
            lastAppliedSpiBounds = { upper: b.upper, lower: b.lower };
try { lineChart.update(); } catch (e) { }
        }

        

        // Attach simple listeners directly to SPI bound inputs (similar to severity threshold)
        var spiUpperInput = document.getElementById("spiUpperBound");
        var spiLowerInput = document.getElementById("spiLowerBound");

        function attachSpiBoundsListeners() {
            function bindInput(input) {
                if (!input) return;
                // Apply when value is committed
                ["change", "blur"].forEach(function (evt) {
                    input.addEventListener(evt, function () {
                        updateSpiLineBoundsOnChart();
                    });
                });
                // Apply on Enter key
                input.addEventListener("keydown", function (e) {
                    if (e.key === "Enter" || e.keyCode === 13) {
                        updateSpiLineBoundsOnChart();
                        try { input.blur(); } catch (err) {}
                    }
                });
            }
            bindInput(spiUpperInput);
            bindInput(spiLowerInput);
        }

        attachSpiBoundsListeners();

        function destroyCharts() {
            [lineChart, anomChart, boxChart].forEach(function (ch) {
                try { if (ch) ch.destroy(); } catch (e) { }
            });
            lineChart = anomChart = boxChart = null;
        }


        function destroyCopulaChart() {
            // Clear the copula scatter chart and reset the summary text
            console.log("[copula] destroyCopulaChart");
            if (copulaScatterChart) {
                try { copulaScatterChart.destroy(); } catch (e) { }
                copulaScatterChart = null;
            }
            var pre = document.getElementById("copulaSummary");
            if (pre) {
                pre.textContent = 'Click "Compute copula" after running SPI.';
            }

            // Clear stored copula diagnostics for JSON / AI
            lastCopulaResult = null;
            lastCopulaPairType = null;
            lastCopulaScale = null;
        }


        function buildCharts(series, scale) {
            destroyCharts();
            if (!series || !series.length) return;

            var labels = series.map(function (d) { return d.end_date; });
            var spiVals = series.map(function (d) {
                return d.spi == null || isNaN(+d.spi) ? null : +d.spi;
            });
            var commonOpts = {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                resizeDelay: 120
            };

            // SPI bounds (reference lines on the SPI chart)
            var bnd = getSpiLineBounds();
            var ub = bnd.upper, lb = bnd.lower;

            
            lastAppliedSpiBounds = { upper: ub, lower: lb };lineChart = new Chart(document.getElementById("lineChart"), {
                type: "line",
                data: {
                    labels: labels,
                    datasets: [
                        { label: "SPI", data: spiVals, spanGaps: true },
                        {
                            label: "Upper bound",
                            data: buildConstArray(labels.length, ub),
                            pointRadius: 0,
                            borderDash: [6, 4],
                            borderWidth: 1,
                            tension: 0,
                            fill: false,
                            borderColor: "rgba(100,116,139,0.9)",
                            backgroundColor: "rgba(100,116,139,0.9)"
                        },
                        {
                            label: "Lower bound",
                            data: buildConstArray(labels.length, lb),
                            pointRadius: 0,
                            borderDash: [2, 3],
                            borderWidth: 1,
                            tension: 0,
                            fill: false,
                            borderColor: "rgba(100,116,139,0.9)",
                            backgroundColor: "rgba(100,116,139,0.9)"
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    resizeDelay: 120,
                    scales: { y: { suggestedMin: Math.min(-3, lb - 0.5), suggestedMax: Math.max(3, ub + 0.5) } }
                }
            });

            var sums = series.map(getWindowSum);
            var valid = series.map(function (d, i) { return { i: i, s: sums[i] }; })
                .filter(function (p) { return p.s != null; });

            var labels2 = valid.map(function (p) { return labels[p.i]; });
            var sums2 = valid.map(function (p) { return p.s; });

            var baseMeans;
            if (scale === "monthly") {
                var byM = {};
                valid.forEach(function (p) {
                    var m = new Date(labels[p.i]).getMonth();
                    if (!byM[m]) byM[m] = [];
                    byM[m].push(sums[p.i]);
                });
                baseMeans = valid.map(function (p) {
                    var m = new Date(labels[p.i]).getMonth();
                    var arr = byM[m] || [];
                    var total = 0;
                    for (var i = 0; i < arr.length; i++) total += arr[i];
                    return total / Math.max(1, arr.length);
                });
            } else {
                var total2 = 0;
                for (var i2 = 0; i2 < sums2.length; i2++) total2 += sums2[i2];
                var mu = total2 / Math.max(1, sums2.length);
                baseMeans = sums2.map(function () { return mu; });
            }
            var anomalies = sums2.map(function (s, i) { return s - baseMeans[i]; });

            anomChart = new Chart(document.getElementById("anomChart"), {
                type: "bar",
                data: { labels: labels2, datasets: [{ label: "Sum anomaly (mm)", data: anomalies }] },
                options: commonOpts
            });

            var boxWarn = document.getElementById("boxplotWarn");
            if (!ensureBoxplotRegistered()) {
                if (boxWarn) boxWarn.classList.remove("hidden");
                return;
            }
            if (boxWarn) boxWarn.classList.add("hidden");

            var labelsBox = [], boxData = [];
            if (scale === "monthly") {
                var groups = {};
                series.forEach(function (d) {
                    if (d.spi != null && isFinite(+d.spi)) {
                        var m = new Date(d.end_date).getMonth();
                        if (!groups[m]) groups[m] = [];
                        groups[m].push(+d.spi);
                    }
                });
                var monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                for (var m2 = 0; m2 < 12; m2++) {
                    var arr2 = (groups[m2] || []).filter(function (x) { return isFinite(x); });
                    if (arr2.length) { labelsBox.push(monthNames[m2]); boxData.push(arr2); }
                }
            } else {
                var arr3 = spiVals.filter(function (x) { return isFinite(x); });
                if (arr3.length) { labelsBox.push("All years"); boxData.push(arr3); }
            }

            boxChart = new Chart(document.getElementById("boxChart"), {
                type: "boxplot",
                data: {
                    labels: labelsBox,
                    datasets: [{ label: "SPI", data: boxData, itemRadius: 2, outlierRadius: 2 }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    resizeDelay: 120,
                    scales: { y: { suggestedMin: -3, suggestedMax: 3 } }
                }
            });
        }

        // =============== SEVERITY CHART + EVENTS ============
        var severityChart = null;
        var severityThresholdInput = document.getElementById("severityThreshold");

        function detectDroughtEvents(series, threshold) {
            var events = [];
            if (!series || !series.length) return events;
            var spiVals = series.map(function (d) { return d.spi == null ? NaN : +d.spi; });
            var dates = series.map(function (d) { return d.end_date; });
            var inEvent = false, startIdx = 0, currentMag = 0, minSPI = Infinity;

            for (var i = 0; i < spiVals.length; i++) {
                var v = spiVals[i];
                if (!isFinite(v)) continue;
                if (v <= threshold) {
                    var deficit = (threshold - v);
                    if (!inEvent) {
                        inEvent = true; startIdx = i; currentMag = deficit; minSPI = v;
                    } else {
                        currentMag += deficit;
                        if (v < minSPI) minSPI = v;
                    }
                } else if (inEvent) {
                    events.push({
                        startIndex: startIdx,
                        endIndex: i - 1,
                        startDate: dates[startIdx],
                        endDate: dates[i - 1],
                        duration: (i - 1 - startIdx + 1),
                        minSPI: minSPI,
                        magnitude: currentMag
                    });
                    inEvent = false; currentMag = 0; minSPI = Infinity;
                }
            }
            if (inEvent) {
                var last = spiVals.length - 1;
                events.push({
                    startIndex: startIdx,
                    endIndex: last,
                    startDate: dates[startIdx],
                    endDate: dates[last],
                    duration: (last - startIdx + 1),
                    minSPI: minSPI,
                    magnitude: currentMag
                });
            }
            return events;
        }

        function buildSeverityChart(series) {
            var ctx = document.getElementById("severityChart");
            if (!ctx || !series || !series.length) return;
            if (severityChart) {
                try { severityChart.destroy(); } catch (e) { }
                severityChart = null;
            }

            var threshold = parseFloat(severityThresholdInput.value || "-0.99");
            var labels = series.map(function (d) { return d.end_date; });
            var spiVals = series.map(function (d) { return d.spi == null ? null : +d.spi; });
            var events = detectDroughtEvents(series, threshold);
            var eventSpans = events.map(function (ev) {
                return { start: ev.startIndex, end: ev.endIndex, magnitude: ev.magnitude };
            });

            var datasets = [
                { label: "SPI", data: spiVals, spanGaps: true, tension: 0.2 },
                {
                    label: "Threshold (" + threshold.toFixed(2) + ")",
                    data: spiVals.map(function () { return threshold; }),
                    borderDash: [6, 4],
                    pointRadius: 0
                }
            ];

            severityChart = new Chart(ctx, {
                type: "line",
                data: { labels: labels, datasets: datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    resizeDelay: 120,
                    plugins: {
                        tooltip: { mode: "index", intersect: false },
                        legend: { display: true }
                    },
                    scales: { y: { suggestedMin: -3, suggestedMax: 3 } },
                    pluginsCustom: { eventSpans: eventSpans }
                }
            });

            var origDraw = severityChart.draw.bind(severityChart);
            severityChart.draw = function () {
                origDraw();
                var chart = this;
                var spans = chart.options.pluginsCustom ? chart.options.pluginsCustom.eventSpans : [];
                if (!spans || !spans.length) return;
                var ctx2 = chart.ctx;
                var xScale = chart.scales.x;
                var yScale = chart.scales.y;
                var baseY = yScale.getPixelForValue(threshold);

                spans.forEach(function (span) {
                    var x0 = xScale.getPixelForValue(span.start);
                    var x1 = xScale.getPixelForValue(span.end);
                    var grad = ctx2.createLinearGradient(0, yScale.bottom, 0, yScale.top);
                    grad.addColorStop(0, "rgba(185,28,28,0.05)");
                    grad.addColorStop(1, "rgba(220,38,38,0.25)");
                    ctx2.save();
                    ctx2.beginPath();
                    ctx2.moveTo(x0, baseY);
                    for (var i = span.start; i <= span.end; i++) {
                        var v = spiVals[i];
                        if (v == null) continue;
                        var xi = xScale.getPixelForValue(i);
                        var yi = yScale.getPixelForValue(v);
                        ctx2.lineTo(xi, yi);
                    }
                    ctx2.lineTo(x1, baseY);
                    ctx2.closePath();
                    ctx2.fillStyle = grad;
                    ctx2.fill();
                    ctx2.restore();

                    var centerX = (x0 + x1) / 2;
                    var textY = baseY - 8;
                    ctx2.save();
                    ctx2.fillStyle = "#b91c1c";
                    ctx2.font = "10px Inter";
                    ctx2.textAlign = "center";
                    ctx2.fillText(span.magnitude.toFixed(2), centerX, textY);
                    ctx2.restore();
                });
            };
            severityChart.draw();

            var tbody = document.querySelector("#eventsTable tbody");
            if (tbody) {
                tbody.innerHTML = "";
                events.forEach(function (ev, idx) {
                    var tr = document.createElement("tr");
                    tr.innerHTML =
                        '<td class="px-3 py-1">' + (idx + 1) + "</td>" +
                        '<td class="px-3 py-1">' + ev.startDate + "</td>" +
                        '<td class="px-3 py-1">' + ev.endDate + "</td>" +
                        '<td class="px-3 py-1">' + ev.duration + "</td>" +
                        '<td class="px-3 py-1">' + ev.minSPI.toFixed(3) + "</td>" +
                        '<td class="px-3 py-1">' + ev.magnitude.toFixed(2) + "</td>";
                    tbody.appendChild(tr);
                });
            }
        }

        severityThresholdInput.addEventListener("change", function () {
            buildSeverityChart(lastSeries);
        });

        // SPI line bounds: rebuild SPI chart when bounds change (same behavior as severity threshold)
        if (typeof spiUpperInput !== "undefined" && spiUpperInput) {
            spiUpperInput.addEventListener("change", function () {
                if (lastSeries && lastSeries.length) {
                    buildCharts(lastSeries, lastScale);
                }
            });
        }
        if (typeof spiLowerInput !== "undefined" && spiLowerInput) {
            spiLowerInput.addEventListener("change", function () {
                if (lastSeries && lastSeries.length) {
                    buildCharts(lastSeries, lastScale);
                }
            });
        }

        // =============== WAVELET (backend call -> scalogram + 2 charts) ============
        var waveletGlobalChart = null, waveletCohChart = null;

        // Store wavelet arrays for AI / JSON context
        var waveletPeriods = [];        // 1D: scale axis (periods from backend)
        var waveletGlobalPower = [];    // 1D: global spectrum power
        var waveletCoherenceArray = []; // 1D: optional coherence vs precip

        // NEW: full 2D scalogram and time axes for JSON context
        var waveletPower2D = [];        // 2D: [time_index][scale_index]
        var waveletTimeIndices = [];    // 1D: [0, 1, ..., N-1]
        var waveletYears = [];          // 1D: calendar years aligned to scalogram
        var waveletReliability = null;  // reliability-ranked peaks from power + coherence
        var waveletSummaryText = "";   // UI summary text for wavelet interpretation
        var waveletSummaryData = null;   // machine-readable summary block for JSON / AI

        function computeWaveletReliability(periods, globalPower, coherence, nSteps) {
            if (!Array.isArray(periods) || !Array.isArray(globalPower) || !Array.isArray(coherence)) return null;
            if (!periods.length || periods.length !== globalPower.length || periods.length !== coherence.length) return null;

            var finitePowers = globalPower.filter(function (v) { return isFinite(v); });
            var maxPower = finitePowers.length ? Math.max.apply(null, finitePowers) : 1;
            if (!isFinite(maxPower) || maxPower <= 0) maxPower = 1;

            var rows = periods.map(function (p, i) {
                var pow = isFinite(globalPower[i]) ? +globalPower[i] : 0;
                var coh = isFinite(coherence[i]) ? +coherence[i] : 0;
                var normPow = pow / maxPower;
                var reliability = normPow * coh * coh;
                var flags = [];
                var supportRatio = (nSteps && isFinite(p) && nSteps > 0) ? (+p / nSteps) : null;

                if (coh < 0.20) flags.push('low_coherence');
                else if (coh < 0.40) flags.push('weak_coherence');
                if (supportRatio != null && supportRatio > 0.25) flags.push('long_period_low_support');

                return {
                    period: isFinite(p) ? +p : null,
                    power: pow,
                    coherence: coh,
                    normalized_power: normPow,
                    reliability: reliability,
                    support_ratio: supportRatio,
                    flags: flags,
                    caution: flags.length ? 'Interpret cautiously.' : 'No extra caution.'
                };
            }).filter(function (row) {
                return row.period != null;
            });

            rows.sort(function (a, b) {
                return b.reliability - a.reliability;
            });

            var reliable = rows.filter(function (row) {
                return row.coherence >= 0.20 && (!row.support_ratio || row.support_ratio <= 0.25);
            });

            return {
                ranked_periods: rows,
                best_reliable_peak: reliable.length ? reliable[0] : (rows.length ? rows[0] : null),
                highest_power_peak: rows.length ? rows.slice().sort(function (a, b) { return b.power - a.power; })[0] : null,
                interpretation_rule: 'Reliability = normalized_power × coherence², with caution flags for low coherence and long periods relative to record length.'
            };
        }

        function describeCoherenceLevel(coh) {
            if (coh == null || !isFinite(coh)) return 'unknown coherence';
            if (coh < 0.05) return 'near-zero coherence';
            if (coh < 0.20) return 'very low coherence';
            if (coh < 0.40) return 'weak coherence';
            if (coh < 0.70) return 'moderate coherence';
            return 'strong coherence';
        }

        function buildWaveletCautionNote(waveletRel) {
            if (!waveletRel || !waveletRel.highest_power_peak) return null;
            var raw = waveletRel.highest_power_peak;
            var cohTxt = (raw.coherence != null && isFinite(raw.coherence)) ? raw.coherence.toFixed(2) : 'NA';
            var cohLabel = describeCoherenceLevel(raw.coherence);
            if (raw.coherence < 0.20) {
                return 'Because the highest-power band has ' + cohLabel + ' with precipitation (about ' + cohTxt + '), it should be treated as a low-confidence or potentially index-driven feature rather than a robust physical cycle.';
            }
            if (raw.flags && raw.flags.indexOf('long_period_low_support') !== -1) {
                return 'The strongest low-frequency band spans a large fraction of the record length, so support for that period is limited even though its coherence is about ' + cohTxt + '.';
            }
            return null;
        }

        function buildWaveletSummaryPayload(waveletRel, coherenceArray) {
            var rawPeak = waveletRel && waveletRel.highest_power_peak ? waveletRel.highest_power_peak : null;
            var reliablePeak = waveletRel && waveletRel.best_reliable_peak ? waveletRel.best_reliable_peak : null;
            var avgCoherence = null;

            if (Array.isArray(coherenceArray) && coherenceArray.length) {
                var sumC = 0, countC = 0;
                for (var i = 0; i < coherenceArray.length; i++) {
                    if (isFinite(coherenceArray[i])) {
                        sumC += +coherenceArray[i];
                        countC++;
                    }
                }
                if (countC) avgCoherence = sumC / countC;
            }

            var parts = [];
            if (rawPeak && rawPeak.period != null) {
                parts.push(
                    'The highest-power band in the SPI spectrum is around ' +
                    (rawPeak.period.toFixed ? rawPeak.period.toFixed(1) : rawPeak.period) +
                    ' time steps, with ' + describeCoherenceLevel(rawPeak.coherence) +
                    ' about ' + ((rawPeak.coherence != null && isFinite(rawPeak.coherence)) ? rawPeak.coherence.toFixed(2) : 'NA') + '.'
                );
            }
            if (reliablePeak && reliablePeak.period != null) {
                parts.push(
                    'After coherence weighting, the most reliable band is around ' +
                    (reliablePeak.period.toFixed ? reliablePeak.period.toFixed(1) : reliablePeak.period) +
                    ' time steps with ' + describeCoherenceLevel(reliablePeak.coherence) +
                    ' about ' + ((reliablePeak.coherence != null && isFinite(reliablePeak.coherence)) ? reliablePeak.coherence.toFixed(2) : 'NA') + '.'
                );
            }
            if (avgCoherence != null && isFinite(avgCoherence)) {
                parts.push(
                    'Average SPI–precipitation coherence across all periods is about ' +
                    avgCoherence.toFixed(2) + ' (0–1 range).'
                );
            }

            var cautionNote = buildWaveletCautionNote(waveletRel);
            if (cautionNote) parts.push(cautionNote);

            parts.push(
                'Warm colors in the scalogram highlight intervals where SPI variance is concentrated at specific time scales; near-vertical streaks indicate persistent oscillations, while isolated patches mark more transient events.'
            );

            return {
                highest_power_peak: rawPeak,
                best_reliable_peak: reliablePeak,
                average_coherence: avgCoherence,
                caution_note: cautionNote,
                summary_text: parts.join(' ')
            };
        }

        function destroyWaveletCharts() {
            [waveletGlobalChart, waveletCohChart].forEach(function (ch) {
                try { if (ch) ch.destroy(); } catch (e) { }
            });
            waveletGlobalChart = waveletCohChart = null;
            var canvas = document.getElementById("waveletScalogram");
            if (canvas) {
                var ctx = canvas.getContext("2d");
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
        }

        // =============== WAVELET COMPUTATION ===================
        async function computeWaveletFromSeries(series) {
            destroyWaveletCharts();
            destroyCopulaChart();
            var interpEl = document.getElementById("waveletInterp");
            waveletPeriods = [];
            waveletGlobalPower = [];
            waveletCoherenceArray = [];
            waveletReliability = null;
            waveletSummaryText = "";
            waveletSummaryData = null;
            waveletScalogramMatrix = null;

            if (!series || !series.length) {
                if (interpEl) interpEl.textContent = "No SPI series available for wavelet analysis.";
                return;
            }

            try {
                var spi = series.map(function (d) { return d.spi == null ? NaN : +d.spi; });
                var precip = series.map(getWindowSum);

                var body = {
                    spi: spi,
                    precip: precip,
                    dt: 1.0,
                    min_period: 1,
                    max_period: Math.max(4, Math.min(48, Math.floor(spi.length / 2))),
                    n_scales: 24
                };

                log("Wavelet request", body);
                var resp = await fetch(API_BASE + "/analysis/spi_wavelet", {
                    method: "POST",
                    headers: authHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify(body)
                });

                var data = await resp.json();
                log("Wavelet response keys", Object.keys(data));

                if (!resp.ok) {
                    throw new Error(data && data.detail ? data.detail : JSON.stringify(data));
                }

                var periods = data.periods || [];
                var globalPower = data.global_power || [];
                var scalogram = data.scalogram || [];
                var coherence = data.coherence || null;

                waveletPeriods = periods.slice();
                waveletGlobalPower = globalPower.slice();
                waveletCoherenceArray = Array.isArray(coherence) ? coherence.slice() : [];
                waveletReliability = computeWaveletReliability(
                    waveletPeriods,
                    waveletGlobalPower,
                    waveletCoherenceArray,
                    spi.length
                );

                // ---------- build scalogram heatmap ----------
                if (Array.isArray(scalogram) && scalogram.length) {
                    var nScales = scalogram.length;
                    var nTime = scalogram[0] ? scalogram[0].length : 0;

                    // Backend gives [scale][time]; convert to [time][scale] for drawing + JSON
                    var power2D = [];
                    for (var t = 0; t < nTime; t++) {
                        var row = [];
                        for (var s = 0; s < nScales; s++) {
                            row.push(scalogram[s][t]);
                        }
                        power2D.push(row);
                    }

                    // ✅ Save full 2D power into global variable for JSON context
                    waveletPower2D = power2D.map(function (row) {
                        return row.map(function (v) { return v; });
                    });

                    // ✅ Build & save time axes (indices + years) from the same 'series'
                    waveletTimeIndices = [];
                    waveletYears = [];
                    for (var ti = 0; ti < nTime; ti++) {
                        waveletTimeIndices.push(ti);

                        var yr = null;
                        if (series[ti]) {
                            // Prefer end_date if present: "1988-12-31" → 1988
                            if (series[ti].end_date) {
                                var yStr = String(series[ti].end_date).slice(0, 4);
                                var yNum = parseInt(yStr, 10);
                                if (!isNaN(yNum)) yr = yNum;
                            } else if (series[ti].year != null) {
                                var yNum2 = parseInt(series[ti].year, 10);
                                if (!isNaN(yNum2)) yr = yNum2;
                            }
                        }
                        waveletYears.push(yr);
                    }

                    // Draw the scalogram on canvas as before
                    drawWaveletScalogram(power2D);
                }


                var specCtx = document.getElementById("waveletGlobalChart");
                if (specCtx && periods.length && globalPower.length) {
                    waveletGlobalChart = new Chart(specCtx, {
                        type: "line",
                        data: {
                            labels: periods,
                            datasets: [{
                                label: "Global power",
                                data: globalPower,
                                tension: 0.25,
                                spanGaps: true
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: {
                                x: {
                                    title: { display: true, text: "Period (steps)" },
                                    ticks: {
                                        callback: function (value) {
                                            return Number(this.getLabelForValue(value)).toFixed(1);
                                        }
                                    }
                                },
                                y: {
                                    title: { display: true, text: "Power (arb. units)" },
                                    ticks: { callback: function (value) { return Number(value).toFixed(1); } }
                                }
                            }
                        }
                    });
                }

                var cohCtx = document.getElementById("waveletCohChart");
                if (cohCtx && periods.length && Array.isArray(coherence)) {
                    waveletCohChart = new Chart(cohCtx, {
                        type: "line",
                        data: {
                            labels: periods,
                            datasets: [{
                                label: "Coherence (SPI vs precip)",
                                data: coherence,
                                tension: 0.25,
                                spanGaps: true
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: {
                                x: {
                                    title: { display: true, text: "Period (steps)" },
                                    ticks: {
                                        callback: function (value) {
                                            return Number(this.getLabelForValue(value)).toFixed(1);
                                        }
                                    }
                                },
                                y: {
                                    min: 0,
                                    max: 1,
                                    title: { display: true, text: "Coherence (0–1)" },
                                    ticks: { callback: function (value) { return Number(value).toFixed(2); } }
                                }
                            }
                        }
                    });
                }

                waveletSummaryData = buildWaveletSummaryPayload(waveletReliability, coherence);
                waveletSummaryText = waveletSummaryData && waveletSummaryData.summary_text
                    ? waveletSummaryData.summary_text
                    : "";

                if (interpEl) {
                    interpEl.textContent = waveletSummaryText || 'Wavelet summary is not available for this run.';
                }


            } catch (err) {
                log("Wavelet error", { message: err && err.message ? err.message : String(err) });
                if (interpEl) {
                    interpEl.textContent =
                        "Wavelet analysis error: " + (err && err.message ? err.message : String(err));
                }
            }
        }

        // =============== RUN SPI REQUEST ===================
        var runBtn = document.getElementById("runBtn");
        var runState = document.getElementById("runState");
        var runDone = document.getElementById("runDone");
        var runErr = document.getElementById("runErr");
        var outPre = document.getElementById("out");
        var tableBody = document.querySelector("#resultTable tbody");
        var sumBadge = document.getElementById("sumBadge");

        var categoryMethodSelect = document.getElementById("categoryMethodSelect");
        if (categoryMethodSelect) {
            categoryMethod = categoryMethodSelect.value || "classic";
            categoryMethodSelect.addEventListener("change", function () {
                categoryMethod = categoryMethodSelect.value || "classic";
                if (lastSeries && lastSeries.length) {
                    applySeriesToUI(lastSeries, lastScale, lastRunRaw);
                }
            });
        }

        var toggleJsonBtn = document.getElementById("toggleJson");
        if (toggleJsonBtn) {
            toggleJsonBtn.addEventListener("click", function () {
                var jsonPanel = document.getElementById("panel-json");
                if (jsonPanel) jsonPanel.classList.toggle("hidden");
            });
        }

        function applySeriesToUI(series, scale, rawData) {
            lastSeries = Array.isArray(series) ? series : [];
            lastScale = scale || "yearly";
            lastRunRaw = rawData || null;

            destroyCharts();
            destroyWaveletCharts();

            if (!tableBody) return;
            tableBody.innerHTML = "";

            if (!lastSeries.length) {
                if (outPre) {
                    outPre.textContent = rawData
                        ? JSON.stringify(rawData, null, 2)
                        : "No series returned.";
                }
                if (sumBadge) {
                    sumBadge.classList.remove("hidden");
                    sumBadge.className = "badge badge-warn";
                    sumBadge.textContent = "0 rows";
                }
                return;
            }

            var missing = 0;
            var fieldHit = {
                window_sum_mm: 0, obs_sum_mm: 0, sum_mm: 0, windowmm: 0, window_sum: 0,
                sum: 0, obs_sum: 0, precip_sum: 0, p_sum: 0, total_mm: 0, sum_mm_window: 0
            };

            var spiValuesForCat = lastSeries
                .map(function (d) { return d && d.spi != null ? +d.spi : null; })
                .filter(function (v) { return v != null && isFinite(v); });
            spiCategorizationStats = computeSpiCategorizationStats(spiValuesForCat);
            spiKMeansConfig = computeSpiKMeansConfig(spiValuesForCat, 7);

            lastSeries.forEach(function (d) {
                for (var k in fieldHit) {
                    if (Object.prototype.hasOwnProperty.call(d, k) && d[k] != null) {
                        fieldHit[k]++;
                    }
                }
                if (getWindowSum(d) == null) missing++;

                var sumVal = getWindowSum(d);
                var tr = document.createElement("tr");
                tr.innerHTML =
                    '<td class="px-3 py-2">' + (d.end_date ? d.end_date : "—") + "</td>" +
                    '<td class="px-3 py-2">' + (sumVal == null ? "—" : (+sumVal).toFixed(2)) + "</td>" +
                    '<td class="px-3 py-2">' + (d.spi == null ? "—" : (+d.spi).toFixed(3)) + "</td>" +
                    '<td class="px-3 py-2">' + getSpiCategory(d.spi) + "</td>";
                tableBody.appendChild(tr);
            });

            log("Sum field hit counts (applySeries)", fieldHit);
            log("Missing window sums (applySeries)", { missing: missing, total: lastSeries.length });

            if (sumBadge) {
                sumBadge.classList.remove("hidden");
                if (missing === 0) {
                    sumBadge.className = "badge badge-ok";
                    sumBadge.textContent = "All rows include window_sum";
                } else {
                    sumBadge.className = "badge badge-warn";
                    sumBadge.textContent =
                        missing + "/" + lastSeries.length + " rows missing window_sum";
                }
            }

            if (outPre) {
                outPre.textContent = rawData
                    ? JSON.stringify(rawData, null, 2)
                    : JSON.stringify({ series: lastSeries }, null, 2);
            }

            var activeBtn = document.querySelector(".tab-btn.active");
            var activeTab = activeBtn ? activeBtn.getAttribute("data-tab") : "table";

            if (activeTab === "charts") {
                requestAnimationFrame(function () { buildCharts(lastSeries, lastScale); });
            } else if (activeTab === "severity") {
                requestAnimationFrame(function () { buildSeverityChart(lastSeries); });
            } else if (activeTab === "wavelet") {
                // Show banner while wavelet API is running
                setWaveletLoading(true, "Computing wavelet charts… this may take a few seconds.");

                requestAnimationFrame(function () {
                    if (Array.isArray(lastSeries) && lastSeries.length) {
                        var p = computeWaveletFromSeries(lastSeries);
                        // computeWaveletFromSeries is async; hide banner when it resolves
                        if (p && typeof p.finally === "function") {
                            p.finally(function () {
                                setWaveletLoading(false);
                            });
                        } else {
                            // fallback: hide even if no promise
                            setWaveletLoading(false);
                        }
                    } else {
                        setWaveletLoading(false);
                    }
                });
            }

        }

        runBtn.addEventListener("click", async function () {
            applyPlanRestrictions();
            if (runErr) { runErr.classList.add("hidden"); runErr.textContent = ""; }
            if (runDone) runDone.classList.add("hidden");
            if (runState) runState.classList.remove("hidden");
            if (sumBadge) sumBadge.classList.add("hidden");
            if (logPre) logPre.textContent = "";

            try {
                var scale = document.querySelector('input[name="scale"]:checked').value;
                var ywinInput = document.querySelector('input[name="ywin"]:checked');
                var ywin = ywinInput ? ywinInput.value : "jan-dec";

                var lat = document.getElementById("lat").value;
                var lon = document.getElementById("lon").value;
                if (!lat || !lon) {
                    throw new Error("Please click on the map to set Latitude/Longitude.");
                }

                var start = document.getElementById("startDate").value || "2000-01-01";
                var end = document.getElementById("endDate").value || (new Date()).toISOString().slice(0, 10);
                var baselineEl = document.getElementById("baseline");
                var baseline = baselineEl ? (baselineEl.value || "").trim() : "";

                var obsSrc = document.getElementById("obsSrc").value || "nasa_power";

                // Apply datasource-specific rules before calling the backend.
                // NASA POWER: 1981+ only. ERA5-Land/CDS: older records allowed, but long first-time requests warn the user.
                validateDatasourceBeforeRun(obsSrc, start, end, baseline);

                var rollingN = "";
                var anchor = "";
                if (scale === "yearly" && ywin === "rolling") {
                    rollingN = document.getElementById("rollingN").value || "30";
                    var anchorStr = (document.getElementById("anchor").value || "12-31").trim();
                    var parts = anchorStr.split("-");
                    var mm = parseInt(parts[0] || "12", 10);
                    var dd = parseInt(parts[1] || "31", 10);
                    anchor = String(mm).padStart(2, "0") + "-" + String(dd).padStart(2, "0");
                }

                var metaForThisRun = {
                    lat: String(lat),
                    lon: String(lon),
                    start_date: start,
                    end_date: end,
                    baseline: baseline || "same_as_analysis_period",
                    scale: scale,
                    ywin: ywin,
                    rollingN: rollingN,
                    anchor: anchor,
                    datasource: obsSrc
                };

                var url = new URL(API_BASE + "/demo/spi_gamma_series");
                url.searchParams.set("lat", lat);
                url.searchParams.set("lon", lon);
                url.searchParams.set("start_date", start);
                url.searchParams.set("end_date", end);
                if (baseline) {
                    url.searchParams.set("baseline", baseline);
                }
                url.searchParams.set("datasource", obsSrc);

                if (scale === "monthly") {
                    url.searchParams.set("step", "month");
                    url.searchParams.set("yearly_method", "total");
                } else {
                    url.searchParams.set("step", "year");
                    if (ywin === "rolling") {
                        url.searchParams.set("yearly_method", "window");
                        url.searchParams.set("window_days", rollingN);
                        var parts2 = anchor.split("-");
                        var mm2 = parseInt(parts2[0] || "12", 10);
                        var dd2 = parseInt(parts2[1] || "31", 10);
                        url.searchParams.set("anchor_mm", String(Math.max(1, Math.min(12, mm2))));
                        url.searchParams.set("anchor_dd", String(Math.max(1, Math.min(31, dd2))));
                    } else {
                        url.searchParams.set("yearly_method", "total");
                    }
                }

                log("Request URL", url.toString());
                var fetchResult = await fetchJsonWithRetry(
                    url.toString(),
                    { headers: authHeaders() },
                    getFetchRetryOptionsForDatasource(obsSrc, start, end, baseline)
                );
                var resp = fetchResult.resp;
                var data = fetchResult.data;
                log("HTTP status", resp.status);
                log("Top-level keys", Object.keys(data));

                var series = extractSpiSeriesFromResponse(data, scale, ywin);
                log("Series length", series.length);
                if (series[0]) log("First item keys", Object.keys(series[0]));

                if (!resp.ok) {
                    throw new Error(
                        data && data.detail && data.detail.message
                            ? data.detail.message
                            : JSON.stringify(data)
                    );
                }

                applySeriesToUI(series, scale, data);
                lastRunMeta = metaForThisRun;  // ✅ store for JSON mode

                if (runDone) runDone.classList.remove("hidden");
            } catch (err) {
                if (runErr) {
                    runErr.textContent = "Error: " + (err && err.message ? err.message : String(err));
                    runErr.classList.remove("hidden");
                }
                log("Run error", { message: err && err.message ? err.message : String(err) });
            } finally {
                if (runState) runState.classList.add("hidden");
            }
        });

        // =============== DASHBOARD (save/load runs per user) ==============
        var saveRunBtn = document.getElementById("saveRunBtn");
        var dashboardList = document.getElementById("dashboardList");
        var dashboardEmpty = document.getElementById("dashboardEmpty");

        function getUserRuns() {
            if (!currentUserEmail) return [];
            try {
                return JSON.parse(localStorage.getItem("dmapai_runs_" + currentUserEmail) || "[]");
            } catch (e) {
                console.error("Error reading saved runs:", e);
                return [];
            }
        }

        function setUserRuns(runs) {
            if (!currentUserEmail) return;
            localStorage.setItem("dmapai_runs_" + currentUserEmail, JSON.stringify(runs));
        }

        function getRunsForProject(projectId, lat, lon) {
            var runs = getUserRuns() || [];

            // Prefer explicit project_id if available
            if (projectId) {
                var byProject = runs.filter(function (r) {
                    return r.project_id === projectId;
                });
                if (byProject.length) {
                    return byProject;
                }
            }

            // Fallback: group by exact lat/lon string match
            if (lat != null && lon != null) {
                var latStr = String(lat);
                var lonStr = String(lon);
                var byLocation = runs.filter(function (r) {
                    return String(r.lat) === latStr && String(r.lon) === lonStr;
                });
                if (byLocation.length) {
                    return byLocation;
                }
            }

            return [];
        }

        function makeScaleKeyFromRun(run) {
            var s = (run && run.scale) || "yearly";
            if (s === "monthly") return "monthly";
            if (s === "yearly") return "yearly";
            return s;
        }


        function labelForDatasourceDashboard(code) {
            switch (code) {
                case "nasa_power":
                case "nasa":
                    return "NASA POWER (free, point-based)";
                case "era5":
                case "era5_land_cds":
                    return "ERA5-Land / CDS (advanced)";
                case "gridmet":
                    return "GridMET (CONUS)";
                case "prism":
                    return "PRISM (US, high-res)";
                case "gpm":
                    return "GPM IMERG (global)";
                case "user":
                    return "User upload (CSV/station)";
                default:
                    return "NASA POWER (free, point-based)";
            }
        }

        function renderDashboard() {
            if (!dashboardList || !dashboardEmpty) return;

            var runs = getUserRuns();
            dashboardList.innerHTML = "";

            if (!runs.length) {
                dashboardEmpty.classList.remove("hidden");
                return;
            }
            dashboardEmpty.classList.add("hidden");

            runs.sort(function (a, b) {
                return (b.saved_at || "").localeCompare(a.saved_at || "");
            });

            runs.forEach(function (run, idx) {
                var div = document.createElement("div");
                div.className = "border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50";

                var title = run.title || ("Run " + (idx + 1));
                var dsLabel = run.datasource_label || labelForDatasourceDashboard(run.datasource || "era5");
                var scaleLabel = run.scale === "monthly" ? "Monthly" : "Yearly";
                var nPts = run.series && Array.isArray(run.series) ? run.series.length : null;
                var extraInfo = nPts ? (" · " + nPts + " rows saved") : " · no series saved";

                var html =
                    '<div class="flex items-start justify-between gap-3">' +
                    '<div>' +
                    '<div class="font-medium">' + title + '</div>' +
                    '<div class="text-xs text-slate-500">' +
                    'Lat ' + (run.lat || "?") +
                    ', Lon ' + (run.lon || "?") +
                    ' · ' + (run.start_date || "?") +
                    ' → ' + (run.end_date || "?") +
                    ' · ' + scaleLabel +
                    ' · ' + dsLabel +
                    extraInfo +
                    (run.project_id ? (' · Project: ' + run.project_id) : '') +
                    '</div>' +
                    '</div>' +
                    '<div class="flex gap-2">' +
                    '<button class="px-2 py-1 rounded-lg bg-blue-600 text-white text-xs hover:bg-blue-700" ' +
                    'data-action="load" data-id="' + run.id + '">Load</button>' +
                    '<button class="px-2 py-1 rounded-lg bg-rose-50 text-rose-700 text-xs hover:bg-rose-100" ' +
                    'data-action="delete" data-id="' + run.id + '">Delete</button>' +
                    '</div>' +
                    '</div>';

                div.innerHTML = html;
                dashboardList.appendChild(div);
            });
        }

        if (saveRunBtn) {
            saveRunBtn.addEventListener("click", function () {
                if (!currentUserEmail) {
                    alert("Please sign in first.");
                    return;
                }
                if (!lastSeries || !lastSeries.length || !lastRunMeta) {
                    alert("Run SPI first, then you can save it.");
                    return;
                }

                var meta = lastRunMeta;

                var lat = meta.lat;
                var lon = meta.lon;
                var start = meta.start_date;
                var end = meta.end_date;
                var baseline = meta.baseline;
                var scale = meta.scale;
                var ywin = meta.ywin || "jan-dec";
                var rollingN = meta.rollingN || "";
                var anchor = meta.anchor || "";
                var dsCode = meta.datasource || "nasa_power";
                var dsLabel = labelForDatasourceDashboard(dsCode);

                var runs = getUserRuns();
                var now = new Date().toISOString();

                var defaultTitle =
                    "SPI " + scale + " · " + dsCode.toUpperCase() +
                    " · " + start + "–" + end;

                var userTitle = prompt("Name this run (for your dashboard):", defaultTitle);
                if (userTitle === null) {
                    return;
                }
                userTitle = userTitle.trim() || defaultTitle;

                var defaultProjectId = "proj_" + String(lat || "").trim() + "_" + String(lon || "").trim();
                var projectPrompt = "Project ID (use the same ID for monthly/yearly runs at this location):";
                var projectId = prompt(projectPrompt, defaultProjectId);
                if (projectId === null) {
                    return;
                }
                projectId = projectId.trim() || defaultProjectId;

                var rec = {
                    id: now + "_" + Math.random().toString(36).slice(2, 8),
                    saved_at: now,
                    title: userTitle,
                    project_id: projectId,
                    lat: lat,
                    lon: lon,
                    start_date: start,
                    end_date: end,
                    baseline: baseline,
                    scale: scale,
                    ywin: ywin,
                    rollingN: rollingN,
                    anchor: anchor,
                    datasource: dsCode,
                    datasource_label: dsLabel,
                    n_points: lastSeries.length,
                    series: lastSeries
                };

                runs.push(rec);
                setUserRuns(runs);
                renderDashboard();
            });
        }

        if (dashboardList) {
            dashboardList.addEventListener("click", function (e) {
                var btn = e.target.closest("button[data-action]");
                if (!btn) return;

                var action = btn.getAttribute("data-action");
                var id = btn.getAttribute("data-id");
                var runs = getUserRuns();
                var idx = runs.findIndex(function (r) { return r.id === id; });
                if (idx === -1) return;

                if (action === "delete") {
                    runs.splice(idx, 1);
                    setUserRuns(runs);
                    renderDashboard();
                } else if (action === "load") {
                    restoreRun(runs[idx]);
                }
            });
        }

        function restoreRun(run) {
            if (!run) return;

            document.getElementById("lat").value = run.lat || "";
            document.getElementById("lon").value = run.lon || "";
            document.getElementById("startDate").value = run.start_date || "";
            document.getElementById("endDate").value = run.end_date || "";
            document.getElementById("baseline").value = run.baseline || "";
            document.getElementById("obsSrc").value = run.datasource || "nasa_power";

            var aoiPoint = document.querySelector('input[name="aoi"][value="point"]');
            if (aoiPoint) aoiPoint.checked = true;

            if (run.scale === "monthly") {
                var mRadio = document.querySelector('input[name="scale"][value="monthly"]');
                if (mRadio) mRadio.checked = true;
            } else {
                var yRadio = document.querySelector('input[name="scale"][value="yearly"]');
                if (yRadio) yRadio.checked = true;
            }

            if (run.ywin) {
                var ywinRadio = document.querySelector('input[name="ywin"][value="' + run.ywin + '"]');
                if (ywinRadio) ywinRadio.checked = true;
            }
            if (run.rollingN) {
                document.getElementById("rollingN").value = run.rollingN;
            }
            if (run.anchor) {
                document.getElementById("anchor").value = run.anchor;
            }

            if (typeof updateVisibility === "function") {
                updateVisibility();
            }

            // set lastRunMeta for JSON mode
            lastRunMeta = {
                lat: run.lat,
                lon: run.lon,
                start_date: run.start_date,
                end_date: run.end_date,
                baseline: run.baseline,
                scale: run.scale,
                ywin: run.ywin,
                rollingN: run.rollingN,
                anchor: run.anchor,
                datasource: run.datasource,
                project_id: run.project_id
            };

            if (run.lat && run.lon) {
                var latNum = parseFloat(run.lat);
                var lonNum = parseFloat(run.lon);
                if (!isNaN(latNum) && !isNaN(lonNum)) {
                    if (typeof window.DMAPAI_setPointFromSavedRun === "function") {
                        window.DMAPAI_setPointFromSavedRun(latNum, lonNum);
                    } else if (window.map) {
                        if (window.pointMarker) {
                            window.pointMarker.setLatLng([latNum, lonNum]);
                        } else {
                            window.pointMarker = L.marker([latNum, lonNum]).addTo(window.map);
                        }
                        window.map.setView([latNum, lonNum], 6);
                    }
                }
            }

            if (run.series && Array.isArray(run.series) && run.series.length) {
                applySeriesToUI(run.series, run.scale || "yearly", {
                    series: run.series,
                    restored_from: "dashboard"
                });

                // Recompute wavelet for restored series and show loading banner
                if (typeof computeWaveletFromSeries === "function") {
                    setWaveletLoading(true, "Restoring wavelet charts from saved run…");

                    setTimeout(function () {
                        if (Array.isArray(lastSeries) && lastSeries.length) {
                            var p = computeWaveletFromSeries(lastSeries);
                            if (p && typeof p.finally === "function") {
                                p.finally(function () {
                                    setWaveletLoading(false);
                                });
                            } else {
                                setWaveletLoading(false);
                            }
                        } else {
                            setWaveletLoading(false);
                        }
                    }, 50);
                }
            } else if (typeof runBtn !== "undefined" && runBtn) {
                // legacy runs with no series: re-call API
                runBtn.click();
            }

        }

        // ================= GEMINI / AI INTERPRETATION =================
        var API_URL = API_BASE + "/analysis/ai_interpret";

        // --------- BASIC INTERPRETATION PROMPT (JSON-BASED) ----------
        var CHART_PROMPT = `
You are a climate scientist assistant specializing in drought indices and time-series charts.
You will receive a JSON context containing ONLY ONE chart plus basic metadata.
Focus entirely on that chart (do not invent other figures).

Explain the chart in clear, technical language suitable for an applied user
(e.g., agronomist, water manager), not a layperson.

Structure your answer with the following section titles, each on its own line:

1. Overview of the selected chart
2. Key patterns and anomalies
3. Drought / wetness signal in context
4. Data and method notes

Use short paragraphs and avoid bullet lists unless they are really helpful.
If a strong wavelet-power peak has low coherence, describe it as weakly supported or potentially index-driven rather than as a robust forecast cycle.
Do not add extra sections beyond these four.
`.trim();


        // --------- SYSTEM MESSAGE (JSON-BASED) ----------
        var SYSTEM_INSTRUCTION =
            "You are a specialized expert in geophysical and climate time-series analysis using drought indices and wavelet-based diagnostics. " +
            "Interpret the provided JSON context (SPI series, anomalies, severity events, boxplot groups, scalogram, and global spectrum) together with the textual metadata. " +
            "Explicitly reference the drought index name, the analysis period, and the approximate location. " +
            "Respond with a concise, professional, and clear description without introductory phrases like 'Here is the analysis'. " +
            "If the JSON includes wavelet_summary, use its numeric values and caution note consistently. If the JSON includes wavelet_reliability or a high-power / low-coherence mismatch, explicitly mention that such bands should be interpreted cautiously rather than as reliable forecast signals.";

        // ========= PRO-LEVEL INTERPRETATION PROMPTS (JSON-BASED) =========
        var PRO_CHART_PROMPT = `
You are a senior climate scientist writing a short results-style summary
of a drought analysis project using SPI and wavelet diagnostics.

You will receive a JSON context that includes SPI time series, drought
severity counts, and wavelet results. Use all relevant information, but
do not invent years or SPI values that are not present in the JSON.

Write in concise scientific language, as for a methods/results section.

Structure your answer with the following section titles, each on its own line:

Overview
Drought and wetness by year
Drought severity and threshold-based events
Cycles and variability (wavelet/scalogram)
Data and method notes

Keep each section to a few short paragraphs. Avoid policy recommendations
or management prescriptions; focus on describing patterns and limitations.
If a highest-power wavelet peak has low coherence, treat it as weakly supported and say so clearly.
`.trim();


        var PRO_SYSTEM_INSTRUCTION =
            "You are a senior climate scientist specializing in drought, hydrology, and wavelet-based time–frequency diagnostics. " +
            "Interpret the JSON context at a professional level, as if writing a short results section of a paper. " +
            "If drought events are listed, refer to them as Event #1, Event #2, etc., and indicate which are flash, multi-season, or multi-year when distinguishable. " +
            "If a strong narrowband signal appears (e.g., 2–7 year scales), you may cautiously mention ENSO-like or low-frequency variability, but do not overclaim. " +
            "If the JSON includes wavelet_summary, use its summary_text only as a compact guide and keep your statements aligned with the numeric fields. If the highest-power band has low coherence with precipitation, explicitly state that it is a low-confidence or potentially index-driven feature rather than a robust physical oscillation. " +
            "Use clear, dense scientific language but keep the answer readable in a few short paragraphs.";


        // JSON mode system/task (farmer audience)
        var JSON_SYSTEM_MESSAGE =
            "You are a climate scientist assistant specializing in drought indices and wavelet analysis. " +
            "Your audience is a non-scientist. Please describe the results simply for a farmer in Iowa who has a corn field. " +
            "Use only the numeric and categorical information given in the JSON context, including wavelet_summary if it is present. " +
            "Do not invent years, SPI values, or trends that are not explicitly present.";

        var JSON_TASK_TEXT =
            "Use the JSON context below to explain the drought behavior at this location based on SPI.\n\n" +
            "Focus on:\n" +
            "1) which years or periods were notably dry or wet,\n" +
            "2) how often moderate/severe/extreme drought occurred (when SPI goes below the threshold),\n" +
            "3) what cycles or recurrent ups-and-downs appear in the wavelet results (if available),\n" +
            "4) any important limitations.\n\n" +
            "Please write your answer with these headings:\n\n" +
            "Overview\n\n" +
            "Drought and wetness by year\n\n" +
            "Drought severity and threshold-based events\n\n" +
            "Cycles and variability (wavelet/scalogram)\n\n" +
            "Data and method notes";

        var analyzeButton = document.getElementById("analyzeButton");
        var copyCitationBtn = document.getElementById("copyCitationBtn");
        var citationTextEl = document.getElementById("citationText");
        var citationCopyHint = document.getElementById("citationCopyHint");

        if (copyCitationBtn && citationTextEl) {
            copyCitationBtn.addEventListener("click", async function () {
                var citation = citationTextEl.innerText.replace(/\s+/g, " ").trim();
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(citation);
                    } else {
                        var ta = document.createElement("textarea");
                        ta.value = citation;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand("copy");
                        document.body.removeChild(ta);
                    }
                    copyCitationBtn.classList.add("copied");
                    copyCitationBtn.innerHTML = "<span>Copied</span>";
                    if (citationCopyHint) citationCopyHint.textContent = "Citation copied to clipboard";
                    setTimeout(function () {
                        copyCitationBtn.classList.remove("copied");
                        copyCitationBtn.innerHTML = "<span>Copy citation</span>";
                        if (citationCopyHint) citationCopyHint.textContent = "APA-style software citation";
                    }, 2200);
                } catch (err) {
                    if (citationCopyHint) citationCopyHint.textContent = "Copy failed — please select the citation text manually.";
                }
            });
        }

        var buttonText = document.getElementById("buttonText");
        var loadingIndicator = document.getElementById("loadingIndicator");
        var resultOutput = document.getElementById("resultOutput");
        var aiChartSelect = document.getElementById("aiChartSelect");

        function shouldUseProjectContext() {
            // Research Free Version: one selected chart only.
            return false;
        }

        function getSelectedAiChartIds() {
            if (aiChartSelect && aiChartSelect.value) {
                return [aiChartSelect.value];
            }
            return ["scalogram"];
        }

        function getPrimaryAiChartId() {
            return getSelectedAiChartIds()[0] || "scalogram";
        }

        function updateAiChartMultiSelectLabel() {
            // Backward-compatible no-op. The UI now uses a standard single-select dropdown.
            return;
        }

        function enableCopulaChartOption() {
            var selectOpt = document.getElementById("aiChartCopulaOptionSelect");
            if (selectOpt) {
                selectOpt.disabled = false;
                selectOpt.textContent = "Copula dependence diagnostics";
            }
        }

        function buildOffscreenChartImage(choice) {
            var canvas = document.getElementById("aiTempCanvas");
            if (!canvas) {
                canvas = document.createElement("canvas");
                canvas.id = "aiTempCanvas";
                canvas.width = 800;
                canvas.height = 320;
                canvas.style.display = "none";
                document.body.appendChild(canvas);
            }

            var ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            var tmpChart = null;

            try {
                if (choice === "spi_line") {
                    if (!lastSeries || !lastSeries.length) return null;
                    var labels = lastSeries.map(function (d) { return d.end_date; });
                    var spiVals = lastSeries.map(function (d) {
                        return d.spi == null || isNaN(+d.spi) ? null : +d.spi;
                    });

                    tmpChart = new Chart(ctx, {
                        type: "line",
                        data: {
                            labels: labels,
                            datasets: [{
                                label: "SPI",
                                data: spiVals,
                                spanGaps: true,
                                tension: 0.2
                            }]
                        },
                        options: {
                            responsive: false,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: { y: { suggestedMin: -3, suggestedMax: 3 } }
                        }
                    });

                } else if (choice === "anom_bar") {
                    if (!lastSeries || !lastSeries.length) return null;
                    var sums = lastSeries.map(getWindowSum);
                    var valid = lastSeries.map(function (d, i) {
                        return { i: i, s: sums[i] };
                    }).filter(function (p) { return p.s != null; });

                    var labels2 = valid.map(function (p) { return lastSeries[p.i].end_date; });
                    var sums2 = valid.map(function (p) { return p.s; });
                    var total = 0;
                    for (var i = 0; i < sums2.length; i++) total += sums2[i];
                    var mu = sums2.length ? total / sums2.length : 0;
                    var anomalies = sums2.map(function (s) { return s - mu; });

                    tmpChart = new Chart(ctx, {
                        type: "bar",
                        data: {
                            labels: labels2,
                            datasets: [{
                                label: "Sum anomaly (mm)",
                                data: anomalies
                            }]
                        },
                        options: {
                            responsive: false,
                            maintainAspectRatio: false,
                            animation: false
                        }
                    });

                } else if (choice === "global") {
                    if (!waveletPeriods.length || !waveletGlobalPower.length) return null;
                    tmpChart = new Chart(ctx, {
                        type: "line",
                        data: {
                            labels: waveletPeriods,
                            datasets: [{
                                label: "Global power",
                                data: waveletGlobalPower,
                                tension: 0.25,
                                spanGaps: true
                            }]
                        },
                        options: {
                            responsive: false,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: {
                                x: { title: { display: true, text: "Period (steps)" } },
                                y: { title: { display: true, text: "Power (arb. units)" } }
                            }
                        }
                    });

                } else if (choice === "coherence") {
                    if (!waveletPeriods.length || !waveletCoherenceArray.length) return null;
                    tmpChart = new Chart(ctx, {
                        type: "line",
                        data: {
                            labels: waveletPeriods,
                            datasets: [{
                                label: "Coherence (SPI vs precip)",
                                data: waveletCoherenceArray,
                                tension: 0.25,
                                spanGaps: true
                            }]
                        },
                        options: {
                            responsive: false,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: {
                                x: { title: { display: true, text: "Period (steps)" } },
                                y: {
                                    min: 0,
                                    max: 1,
                                    title: { display: true, text: "Coherence (0–1)" }
                                }
                            }
                        }
                    });

                } else if (choice === "severity") {
                    if (!lastSeries || !lastSeries.length) return null;
                    var labelsS = lastSeries.map(function (d) { return d.end_date; });
                    var spiValsS = lastSeries.map(function (d) {
                        return d.spi == null || isNaN(+d.spi) ? null : +d.spi;
                    });
                    var thr = parseFloat(severityThresholdInput.value || "-0.99");
                    var thrArr = spiValsS.map(function () { return thr; });

                    tmpChart = new Chart(ctx, {
                        type: "line",
                        data: {
                            labels: labelsS,
                            datasets: [
                                { label: "SPI", data: spiValsS, spanGaps: true, tension: 0.2 },
                                {
                                    label: "Threshold (" + thr.toFixed(2) + ")",
                                    data: thrArr,
                                    borderDash: [6, 4],
                                    pointRadius: 0
                                }
                            ]
                        },
                        options: {
                            responsive: false,
                            maintainAspectRatio: false,
                            animation: false,
                            scales: { y: { suggestedMin: -3, suggestedMax: 3 } }
                        }
                    });

                } else {
                    console.error("buildOffscreenChartImage: unsupported choice:", choice);
                    return null;
                }

                var dataURL = canvas.toDataURL("image/png");
                var idxBase64 = dataURL.indexOf("base64,");
                if (idxBase64 === -1) {
                    console.error("Off-screen chart dataURL has no base64 marker.");
                    return null;
                }
                var base64Data = dataURL.substring(idxBase64 + "base64,".length);
                return { mimeType: "image/png", base64Data: base64Data };

            } catch (e) {
                console.error("Error building off-screen chart for AI:", choice, e);
                return null;

            } finally {
                if (tmpChart) {
                    try { tmpChart.destroy(); } catch (e2) { }
                }
            }
        }

        function getCanvasBase64Data() {
            if (!aiChartSelect) {
                console.error("aiChartSelect not found.");
                return null;
            }

            var choice = aiChartSelect.value || "scalogram";

            if (choice === "scalogram") {
                var canvas = document.getElementById("waveletScalogram");
                if (!canvas) {
                    console.error("waveletScalogram canvas not found.");
                    return null;
                }
                var dataURL = canvas.toDataURL("image/png");
                var idxBase64 = dataURL.indexOf("base64,");
                if (idxBase64 === -1) {
                    console.error("No 'base64,' marker in scalogram dataURL.");
                    return null;
                }
                var base64Data = dataURL.substring(idxBase64 + "base64,".length);
                return { mimeType: "image/png", base64Data: base64Data };
            }

            var offscreen = buildOffscreenChartImage(choice);
            if (!offscreen) {
                console.error("Failed to build off-screen chart image for choice:", choice);
            }
            return offscreen;
        }

        function buildMetadataText() {
            var scaleInput = document.querySelector('input[name="scale"]:checked');
            var scale = scaleInput ? scaleInput.value : "unknown";

            var ywinInput = document.querySelector('input[name="ywin"]:checked');
            var ywin = ywinInput ? ywinInput.value : "jan-dec";

            var startDateEl = document.getElementById("startDate");
            var endDateEl = document.getElementById("endDate");
            var latEl = document.getElementById("lat");
            var lonEl = document.getElementById("lon");
            var baselineEl = document.getElementById("baseline");

            var startDate = startDateEl && startDateEl.value ? startDateEl.value : "(not set)";
            var endDate = endDateEl && endDateEl.value ? endDateEl.value : "(not set)";
            var lat = latEl && latEl.value ? latEl.value : "NA";
            var lon = lonEl && lonEl.value ? lonEl.value : "NA";
            var baseline = baselineEl && baselineEl.value ? baselineEl.value : "1981–2010";

            var obsEl = document.getElementById("obsSrc");
            var dsCode = obsEl && obsEl.value ? obsEl.value : "era5";
            var dsLabel = labelForDatasource(dsCode);

            var severityThresholdVal = null;
            if (typeof severityThresholdInput !== "undefined" && severityThresholdInput) {
                severityThresholdVal = severityThresholdInput.value;
            } else {
                var thrEl = document.getElementById("severityThreshold");
                if (thrEl && thrEl.value) severityThresholdVal = thrEl.value;
            }

            var severityMinDurVal = null;
            var mdEl = document.getElementById("severityMinDur");
            if (mdEl && mdEl.value) severityMinDurVal = mdEl.value;

            var nPoints = 0, missingSPI = 0;
            if (Array.isArray(lastSeries)) {
                nPoints = lastSeries.length;
                for (var i = 0; i < lastSeries.length; i++) {
                    if (lastSeries[i].spi == null || isNaN(+lastSeries[i].spi)) missingSPI++;
                }
            }

            var droughtIndexName = getSelectedDroughtIndexName();
            var chartLabel = "Wavelet scalogram";
            if (aiChartSelect) {
                var val = aiChartSelect.value;
                if (val === "global") chartLabel = "Global wavelet spectrum of SPI";
                else if (val === "coherence") chartLabel = "SPI–precipitation coherence spectrum";
                else if (val === "spi_line") chartLabel = "SPI time series line chart";
                else if (val === "anom_bar") chartLabel = "Precipitation anomaly bar chart";
                else if (val === "severity")
                    chartLabel = "Drought severity SPI line with threshold and events";
            }

            var metadataText =
                "Wavelet / SPI chart metadata:\n" +
                "- Chart type: " + chartLabel + "\n" +
                "- Drought index: " + droughtIndexName + "\n" +
                "- Location (lat, lon): (" + lat + ", " + lon + ")\n" +
                "- Data source: " + dsLabel + "\n" +
                "- Temporal aggregation scale: " + scale + "\n" +
                "- Yearly window method: " + ywin + "\n" +
                "- Analysis period: " + startDate + " to " + endDate + "\n" +
                "- Climatological baseline: " + baseline + "\n" +
                "- Number of time steps in series: " + nPoints +
                (nPoints ? " (missing SPI values: " + missingSPI + ")" : "") + "\n";

            if (aiChartSelect && aiChartSelect.value === "severity") {
                metadataText +=
                    "- Severity threshold (SPI): " +
                    (severityThresholdVal != null ? severityThresholdVal : "(not specified)") + "\n" +
                    "- Minimum event duration (time steps): " +
                    (severityMinDurVal != null ? severityMinDurVal : "(not specified)") + "\n";
            }

            metadataText +=
                "\nWhen interpreting the image, explicitly consider this metadata " +
                "(location, time period, aggregation scale, baseline, data source, and any severity settings).";

            return metadataText;
        }

        function buildProfessionalMetadataText() {
            var base = buildMetadataText();

            var eventSummaryLines = [];
            var events = [];
            var inEvent = false;
            var startIdx = -1;
            var minSPI = 0;

            if (Array.isArray(lastSeries) && lastSeries.length) {
                for (var i = 0; i < lastSeries.length; i++) {
                    var d = lastSeries[i];
                    var spiVal = (d && d.spi != null) ? +d.spi : NaN;

                    if (!isNaN(spiVal) && spiVal <= -1.0) {
                        if (!inEvent) {
                            inEvent = true;
                            startIdx = i;
                            minSPI = spiVal;
                        } else {
                            if (spiVal < minSPI) minSPI = spiVal;
                        }
                    } else {
                        if (inEvent) {
                            var endIdx = i - 1;
                            var startDate = lastSeries[startIdx].end_date || "(unknown)";
                            var endDate = lastSeries[endIdx].end_date || "(unknown)";
                            events.push({
                                startDate: startDate,
                                endDate: endDate,
                                duration: endIdx - startIdx + 1,
                                minSPI: minSPI
                            });
                            inEvent = false;
                        }
                    }
                }
                if (inEvent) {
                    var endIdx2 = lastSeries.length - 1;
                    events.push({
                        startDate: lastSeries[startIdx].end_date || "(unknown)",
                        endDate: lastSeries[endIdx2].end_date || "(unknown)",
                        duration: endIdx2 - startIdx + 1,
                        minSPI: minSPI
                    });
                }
            }

            if (events.length) {
                eventSummaryLines.push("Derived drought events (SPI ≤ -1.0):");
                for (var eIdx = 0; eIdx < events.length; eIdx++) {
                    var ev = events[eIdx];
                    eventSummaryLines.push(
                        "Event #" + (eIdx + 1) + ": " +
                        ev.startDate + " to " + ev.endDate +
                        " (duration ~" + ev.duration + " time steps, " +
                        "minimum SPI ≈ " + ev.minSPI.toFixed(2) + ")"
                    );
                }
            } else {
                eventSummaryLines.push("No contiguous SPI ≤ -1.0 events detected in this series.");
            }

            var waveletLines = [];
            if (Array.isArray(waveletPeriods) && waveletPeriods.length &&
                Array.isArray(waveletGlobalPower) && waveletGlobalPower.length === waveletPeriods.length) {

                var rawPeak = waveletReliability && waveletReliability.highest_power_peak ? waveletReliability.highest_power_peak : null;
                var reliablePeak = waveletReliability && waveletReliability.best_reliable_peak ? waveletReliability.best_reliable_peak : null;

                if (rawPeak && rawPeak.period != null) {
                    waveletLines.push(
                        "Highest-power wavelet band: " +
                        (rawPeak.period && rawPeak.period.toFixed ? rawPeak.period.toFixed(2) : String(rawPeak.period)) +
                        " time steps (coherence ≈ " +
                        (isFinite(rawPeak.coherence) ? rawPeak.coherence.toFixed(2) : 'NA') + ")."
                    );
                }
                if (reliablePeak && reliablePeak.period != null) {
                    waveletLines.push(
                        "Most reliable wavelet band after coherence weighting: " +
                        (reliablePeak.period && reliablePeak.period.toFixed ? reliablePeak.period.toFixed(2) : String(reliablePeak.period)) +
                        " time steps."
                    );
                }
                var cautionNoteMeta = buildWaveletCautionNote(waveletReliability);
                if (cautionNoteMeta) {
                    waveletLines.push(cautionNoteMeta);
                }

                var shortPower = 0, shortCount = 0;
                var seasonalPower = 0, seasonalCount = 0;
                var multiYearPower = 0, multiYearCount = 0;

                for (var k = 0; k < waveletPeriods.length; k++) {
                    var p = waveletPeriods[k];
                    var val = waveletGlobalPower[k];
                    if (p == null || val == null || isNaN(+val)) continue;
                    if (p < 3) {
                        shortPower += +val; shortCount++;
                    } else if (p >= 3 && p <= 12) {
                        seasonalPower += +val; seasonalCount++;
                    } else if (p > 12) {
                        multiYearPower += +val; multiYearCount++;
                    }
                }

                function avgOrNA(sum, count) {
                    return count ? (sum / count).toFixed(3) : "NA";
                }

                waveletLines.push(
                    "Average wavelet power by scale band (arbitrary units): " +
                    "short-term (<3 steps) ~ " + avgOrNA(shortPower, shortCount) + ", " +
                    "seasonal (3–12 steps) ~ " + avgOrNA(seasonalPower, seasonalCount) + ", " +
                    "multi-year (>12 steps) ~ " + avgOrNA(multiYearPower, multiYearCount) + "."
                );
            } else {
                waveletLines.push("Wavelet global spectrum was not available for extended scale diagnostics.");
            }

            var spiStatsLines = [];
            if (Array.isArray(lastSeries) && lastSeries.length) {
                var spiValsAll = [];
                for (var s = 0; s < lastSeries.length; s++) {
                    var vv = lastSeries[s].spi;
                    if (vv != null && !isNaN(+vv)) spiValsAll.push(+vv);
                }
                if (spiValsAll.length) {
                    var minV = Math.min.apply(null, spiValsAll);
                    var maxV = Math.max.apply(null, spiValsAll);
                    spiStatsLines.push(
                        "SPI range in the series: from " + minV.toFixed(2) +
                        " (driest) to " + maxV.toFixed(2) + " (wettest)."
                    );
                }
            }

            var extended =
                base +
                "\n\nExtended diagnostics for professional interpretation:\n" +
                eventSummaryLines.join("\n") + "\n" +
                waveletLines.join("\n") + "\n" +
                (spiStatsLines.length ? spiStatsLines.join("\n") + "\n" : "");

            return extended;
        }

        async function ensureAiChartPrepared() {
            if (!lastSeries || !lastSeries.length) {
                if (resultOutput) {
                    resultOutput.textContent =
                        "Please run the SPI analysis first, then try AI interpretation.";
                }
                return false;
            }

            var selectEl = document.getElementById("aiChartSelect");
            var choice = selectEl ? selectEl.value : "scalogram";

            if (choice === "scalogram" || choice === "global" || choice === "coherence") {
                try {
                    await computeWaveletFromSeries(lastSeries);
                } catch (e) {
                    console.error("Error computing wavelet before AI:", e);
                    if (resultOutput) {
                        resultOutput.textContent =
                            "Wavelet computation failed. Please check the Wavelet tab first.";
                    }
                    return false;
                }
                return true;
            }

            if (choice === "spi_line" || choice === "anom_bar" || choice === "severity") {
                try {
                    buildCharts(lastSeries, lastScale);
                } catch (e2) {
                    console.error("Error building charts before AI:", e2);
                    if (resultOutput) {
                        resultOutput.textContent =
                            "Chart computation failed. Please check the Charts tab first.";
                    }
                    return false;
                }
                return true;
            }

            return true;
        }

        async function analyzeChartAutomatic() {
            if (!resultOutput) return false;

            var prepared = await ensureAiChartPrepared();
            if (!prepared) {
                return false;
            }

            var select = document.getElementById("aiChartSelect");
            var selectedChartId = select ? select.value : "scalogram";

            var fullContext = buildJsonContextFromRun();
            if (!fullContext) {
                resultOutput.textContent = "No SPI run available. Please run the analysis first.";
                return false;
            }

            var payload = buildAiInterpretationRequest(fullContext, selectedChartId);
            if (!payload) {
                resultOutput.textContent = "Could not build AI request for the selected chart.";
                return false;
            }

            try {
                setLoading(true);

                var response = await fetch(API_URL, {
                    method: "POST",
                    headers: authHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify(payload)
                });
                var result = await response.json().catch(function () { return {}; });
                var modelResult = unwrapAiResponse(result);

                if (!response.ok || (modelResult && modelResult.error)) {
                    var msg = "Backend AI call failed with status " + response.status;
                    var detailMsg = extractBackendAiError(result) || extractBackendAiError(modelResult);
                    if (detailMsg) {
                        msg += " - " + detailMsg;
                    }
                    var apiErr = new Error(msg);
                    apiErr.status = response.status;
                    throw apiErr;
                }

                var textOut = "";
                if (modelResult.candidates && modelResult.candidates.length > 0) {
                    var cand = modelResult.candidates[0];
                    if (cand.content && cand.content.parts) {
                        textOut = cand.content.parts.map(function (p) {
                            return p.text || "";
                        }).join("\n");
                    }
                }
                if (!textOut) textOut = "[No text returned from model]";

                resultOutput.textContent = textOut;
                return true;
            } catch (error) {
                console.error("Gemini API Error:", error);
                resultOutput.textContent = formatAiApiError(error, error && error.status ? error.status : null);
                return false;
            } finally {
                setLoading(false);
            }
        }

        async function analyzeChartProfessional() {
            if (!resultOutput) return;

            var prepared = await ensureAiChartPrepared();
            if (!prepared) {
                return;
            }

            var context = null;

            if (shouldUseProjectContext() &&
                typeof buildJsonContextForProjectFromCurrentRun === "function") {
                context = buildJsonContextForProjectFromCurrentRun();
            }

            if (!context) {
                context = buildJsonContextFromRun();
            }

            if (!context) {
                resultOutput.textContent = "No SPI run available. Please run the analysis first.";
                return;
            }


            var systemInstruction = PRO_SYSTEM_INSTRUCTION;
            var userText =
                PRO_CHART_PROMPT +
                "\n\nCONTEXT_JSON:\n" +
                JSON.stringify(context);


            var payload = {
                contents: [{
                    role: "user",
                    parts: [{ text: userText }]
                }],
                systemInstruction: {
                    parts: [{ text: systemInstruction }]
                }
            };


            try {
                setLoading(true);

                var response = await fetch(API_URL, {
                    method: "POST",
                    headers: authHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify(payload)
                });
                var result = await response.json();

                if (!response.ok || result.error) {
                    var msg = "API call failed with status " + response.status;
                    if (result && result.error && result.error.message) {
                        msg += " - " + result.error.message;
                    }
                    throw new Error(msg);
                }

                var textOut = "";
                if (result.candidates && result.candidates.length > 0) {
                    var cand = result.candidates[0];
                    if (cand.content && cand.content.parts) {
                        textOut = cand.content.parts.map(function (p) { return p.text || ""; }).join("\n");
                    }
                }
                if (!textOut) textOut = "[No text returned from model]";

                resultOutput.textContent = textOut;
            } catch (error) {
                console.error("Gemini PRO API Error:", error);
                resultOutput.textContent =
                    "Error: Could not process chart analysis. " + error.message;
            } finally {
                setLoading(false);
            }
        }


        // ================= JSON CONTEXT BUILDER (ALL CHART DATA) =================

        function getCategoryMethodLabel(method) {
            method = method || categoryMethod || "classic";
            if (method === "usdm") return "USDM-style SPI/SPEI ranges";
            if (method === "quantile") return "Percentile bands (statistical)";
            if (method === "kmeans") return "AI/ML – k-means clusters";
            return "Classic SPI thresholds";
        }

        function getCategoryMethodNote(method) {
            method = method || categoryMethod || "classic";
            if (method === "usdm") {
                return "SPI categories are converted to USDM-style labels for communication. This is not an official U.S. Drought Monitor map.";
            }
            if (method === "quantile") {
                return "Percentile bands are data-driven and depend on the current SPI distribution. They should not be interpreted as an official drought-monitor classification.";
            }
            if (method === "kmeans") {
                return "K-means labels are unsupervised, data-driven clusters from the current SPI distribution. They are useful for exploratory grouping but are not official drought categories.";
            }
            return "Classic SPI drought/wetness categories are used for the table and AI interpretation.";
        }

        function getCategoryThresholdReference(method) {
            method = method || categoryMethod || "classic";
            if (method === "usdm") {
                return {
                    D0_abnormally_dry: "-0.8 < SPI <= -0.5",
                    D1_moderate_drought: "-1.3 < SPI <= -0.8",
                    D2_severe_drought: "-1.6 < SPI <= -1.3",
                    D3_extreme_drought: "-2.0 < SPI <= -1.6",
                    D4_exceptional_drought: "SPI <= -2.0"
                };
            }
            if (method === "quantile") {
                return spiCategorizationStats ? {
                    q05: spiCategorizationStats.q05,
                    q20: spiCategorizationStats.q20,
                    q80: spiCategorizationStats.q80,
                    q95: spiCategorizationStats.q95
                } : null;
            }
            if (method === "kmeans") {
                return (spiKMeansConfig && spiKMeansConfig.centers) ? {
                    k: spiKMeansConfig.k,
                    centers: spiKMeansConfig.centers,
                    labels: spiKMeansConfig.labels || null
                } : null;
            }
            return {
                extreme_drought: "SPI <= -2.0",
                severe_drought: "-2.0 < SPI <= -1.5",
                moderate_drought: "-1.5 < SPI <= -1.0",
                near_normal: "-1.0 < SPI < 1.0",
                moderately_wet: "1.0 <= SPI < 1.5",
                very_wet: "1.5 <= SPI < 2.0",
                extremely_wet: "SPI >= 2.0"
            };
        }


        function getDatasetProviderForJson(code) {
            code = code || "";
            if (code === "nasa_power" || code === "nasa") return "NASA POWER";
            if (code === "era5" || code === "era5_land_cds") return "ECMWF / Copernicus CDS";
            if (code === "gridmet") return "University of Idaho GridMET";
            if (code === "prism") return "PRISM Climate Group";
            if (code === "gpm") return "NASA GPM IMERG";
            if (code === "user") return "User-provided data";
            return "Unknown / selected data source";
        }

        function getLocationContextForJson() {
            var latVal = (lastRunMeta && lastRunMeta.lat != null) ? parseFloat(lastRunMeta.lat) : null;
            var lonVal = (lastRunMeta && lastRunMeta.lon != null) ? parseFloat(lastRunMeta.lon) : null;

            if (!isFinite(latVal)) {
                var latEl = document.getElementById("lat");
                latVal = latEl && latEl.value ? parseFloat(latEl.value) : null;
            }
            if (!isFinite(lonVal)) {
                var lonEl = document.getElementById("lon");
                lonVal = lonEl && lonEl.value ? parseFloat(lonEl.value) : null;
            }

var name = null;

// Coordinate-based label only. Do not hard-code any city name without verified reverse geocoding.
if (isFinite(latVal) && isFinite(lonVal)) {
    name = "Selected point (" + latVal.toFixed(4) + ", " + lonVal.toFixed(4) + ")";
}
if (!name) name = "Selected point";

            return {
                name: name,
                latitude: isFinite(latVal) ? latVal : null,
                longitude: isFinite(lonVal) ? lonVal : null,
                naming_method: "coordinate_based_label_without_reverse_geocoding"
            };
        }

        function getBaselineContextForJson(startDate, endDate, baselineText) {
            var baseline = (baselineText || "").trim();
            var years = baseline.match(/(?:19|20)\d{2}/g);

            if (years && years.length >= 2) {
                return {
                    mode: "custom_baseline_years",
                    label: baseline,
                    start: years[0] + "-01-01",
                    end: years[1] + "-12-31"
                };
            }

            return {
                mode: "same_as_analysis_period",
                label: "same_as_analysis_period",
                start: startDate || null,
                end: endDate || null
            };
        }

        function getRawSourcePrecipitationFromBackend(rawData) {
            if (!rawData || typeof rawData !== "object") return null;
            var candidates = [
                "precipitation_input_series",
                "raw_precipitation",
                "raw_precipitation_series",
                "source_precipitation",
                "source_precipitation_series",
                "daily_precipitation",
                "monthly_precipitation",
                "downloaded_precipitation",
                "precipitation_rows"
            ];
            for (var i = 0; i < candidates.length; i++) {
                var k = candidates[i];
                if (rawData[k] != null) return rawData[k];
            }
            if (rawData.data && typeof rawData.data === "object") {
                for (var j = 0; j < candidates.length; j++) {
                    var kk = candidates[j];
                    if (rawData.data[kk] != null) return rawData.data[kk];
                }
            }
            return null;
        }

        function getTopLevelKeysForJson(obj) {
            if (!obj || typeof obj !== "object") return [];
            try { return Object.keys(obj); } catch (e) { return []; }
        }



        function detectDateField(row) {
            if (!row || typeof row !== "object") return null;
            var keys = ["date", "time", "datetime", "end_date", "month", "year"];
            for (var i = 0; i < keys.length; i++) {
                if (row[keys[i]] != null) return keys[i];
            }
            return null;
        }

        function detectValueField(row) {
            if (!row || typeof row !== "object") return null;
            var preferred = [
                "precipitation_mm_day",
                "precip_mm",
                "precipitation_mm",
                "prcp_mm",
                "ppt_mm",
                "value",
                "window_sum_mm",
                "spi",
                "anomaly_mm"
            ];
            for (var i = 0; i < preferred.length; i++) {
                if (row[preferred[i]] != null && isFinite(parseFloat(row[preferred[i]]))) return preferred[i];
            }
            var keys = Object.keys(row);
            for (var j = 0; j < keys.length; j++) {
                var k = keys[j];
                if (k === "index" || k === "year" || k === "month") continue;
                if (row[k] != null && isFinite(parseFloat(row[k]))) return k;
            }
            return null;
        }

        function inferTimeStepFromDates(startDate, secondDate, fallback) {
            if (!startDate || !secondDate) return fallback || "unknown";
            var d1 = new Date(startDate);
            var d2 = new Date(secondDate);
            if (!isFinite(d1.getTime()) || !isFinite(d2.getTime())) return fallback || "unknown";
            var days = Math.round((d2.getTime() - d1.getTime()) / 86400000);
            if (days === 1) return "daily";
            if (days >= 27 && days <= 31) return "monthly";
            if (days >= 365 && days <= 366) return "yearly";
            return days + "_days";
        }

        function compactNumericRows(rows, options) {
            options = options || {};
            if (!Array.isArray(rows) || !rows.length) return null;

            var first = rows[0] || {};
            var second = rows.length > 1 ? rows[1] : null;
            var dateField = options.dateField || detectDateField(first);
            var valueField = options.valueField || detectValueField(first);
            if (!valueField) return null;

            var dates = dateField ? rows.map(function (r) { return r ? r[dateField] : null; }) : [];
            var values = rows.map(function (r) {
                var v = r ? parseFloat(r[valueField]) : null;
                if (!isFinite(v)) return null;
                return Math.round(v * 1000000) / 1000000;
            });

            var start = dates.length ? dates[0] : null;
            var end = dates.length ? dates[dates.length - 1] : null;
            var step = options.timeStep || inferTimeStepFromDates(start, dates.length > 1 ? dates[1] : null, options.fallbackTimeStep || "unknown");

            var missingCount = values.filter(function (v) { return v == null; }).length;
            var cleanValues = values.map(function (v) { return v == null ? "" : String(v); });

            return {
                format: "compact_csv_values",
                description: options.description || "Compact horizontal numeric time series. Dates are represented by start/end/time_step and values_csv.",
                start_date: start,
                end_date: end,
                time_step: step,
                units: options.units || "mm",
                value_field: valueField,
                record_count: rows.length,
                missing_count: missingCount,
                values_csv: cleanValues.join(",")
            };
        }

        function compactTableRows(rows, columns, options) {
            options = options || {};
            if (!Array.isArray(rows) || !rows.length || !Array.isArray(columns) || !columns.length) return null;
            return {
                format: "columns_with_rows",
                description: options.description || "Compact table format using one columns list and row arrays.",
                columns: columns,
                row_count: rows.length,
                rows: rows.map(function (r) {
                    return columns.map(function (c) { return r ? r[c] : null; });
                })
            };
        }

        function summarizeBackendRawResponse(rawData) {
            if (!rawData || typeof rawData !== "object") {
                return {
                    included: false,
                    note: "No original backend response was available."
                };
            }

            var keys = getTopLevelKeysForJson(rawData);
            return {
                included: false,
                reason: "The full backend response is not duplicated in the copied JSON because it can contain large daily rows. Important source series are stored in compact_csv_values format instead.",
                top_level_keys: keys
            };
        }


        function buildCopulaUvPointsForJson(c, years) {
            c = c || {};
            years = Array.isArray(years) ? years : [];

            var uv = c.uv_points || null;
            var uArr = [];
            var vArr = [];

            if (uv && Array.isArray(uv.u) && Array.isArray(uv.v)) {
                uArr = uv.u.slice();
                vArr = uv.v.slice();
            } else if (Array.isArray(uv)) {
                uv.forEach(function (row) {
                    if (!row) return;
                    if (Array.isArray(row)) {
                        uArr.push(row[0]);
                        vArr.push(row[1]);
                    } else {
                        uArr.push(row.u != null ? row.u : row.U);
                        vArr.push(row.v != null ? row.v : row.V);
                    }
                });
            } else if (Array.isArray(c.u) && Array.isArray(c.v)) {
                uArr = c.u.slice();
                vArr = c.v.slice();
            }

            var n = Math.min(uArr.length, vArr.length);
            var rows = [];
            var minU = null, maxU = null, minV = null, maxV = null;
            var invalidCount = 0;
            var pairType = lastCopulaPairType || c.pair_type || null;

            for (var i = 0; i < n; i++) {
                var u = parseFloat(uArr[i]);
                var v = parseFloat(vArr[i]);
                var valid = isFinite(u) && isFinite(v) && u >= 0 && u <= 1 && v >= 0 && v <= 1;
                if (!valid) {
                    invalidCount++;
                    continue;
                }

                if (minU == null || u < minU) minU = u;
                if (maxU == null || u > maxU) maxU = u;
                if (minV == null || v < minV) minV = v;
                if (maxV == null || v > maxV) maxV = v;

                var yearT = null;
                var yearTPlus1 = null;
                if (pairType === "spi_lag1") {
                    yearT = years[i] != null ? years[i] : null;
                    yearTPlus1 = years[i + 1] != null ? years[i + 1] : null;
                } else {
                    yearT = years[i] != null ? years[i] : null;
                }

                rows.push([i, yearT, yearTPlus1, u, v]);
            }

            return {
                format: "columns_with_rows",
                description: "Copula pseudo-observations in the unit square. U and V are rank-based values used to fit and plot the copula.",
                columns: ["index", "year_t", "year_t_plus_1", "u", "v"],
                row_count: rows.length,
                validation: {
                    expected_range: "0 <= U,V <= 1",
                    in_unit_square: invalidCount === 0 && rows.length === n,
                    invalid_or_out_of_range_count: invalidCount,
                    u_min: minU,
                    u_max: maxU,
                    v_min: minV,
                    v_max: maxV
                },
                rows: rows
            };
        }

        function buildCopulaTransitionTableForJson(series, threshold) {
            series = Array.isArray(series) ? series : [];
            threshold = (typeof threshold === "number" && isFinite(threshold)) ? threshold : -1.0;
            var rows = [];

            for (var i = 1; i < series.length; i++) {
                var prev = series[i - 1] || {};
                var curr = series[i] || {};
                var prevSpi = prev.spi != null ? parseFloat(prev.spi) : null;
                var currSpi = curr.spi != null ? parseFloat(curr.spi) : null;
                if (!isFinite(prevSpi) || !isFinite(currSpi)) continue;

                var prevDry = prevSpi <= threshold;
                var currDry = currSpi <= threshold;
                var transition = prevDry && currDry ? "drought_to_drought" :
                    prevDry && !currDry ? "drought_to_no_drought" :
                    !prevDry && currDry ? "no_drought_to_drought" :
                    "no_drought_to_no_drought";

                rows.push([
                    i - 1,
                    prev.year != null ? prev.year : (prev.end_date ? String(prev.end_date).slice(0, 4) : null),
                    curr.year != null ? curr.year : (curr.end_date ? String(curr.end_date).slice(0, 4) : null),
                    prevSpi,
                    currSpi,
                    prevDry,
                    currDry,
                    transition
                ]);
            }

            return {
                format: "columns_with_rows",
                description: "Lag-1 SPI drought transition table used to validate copula persistence diagnostics.",
                threshold_spi: threshold,
                columns: ["pair_index", "year_t", "year_t_plus_1", "spi_t", "spi_t_plus_1", "drought_t", "drought_t_plus_1", "transition"],
                row_count: rows.length,
                rows: rows
            };
        }


        function buildCategoryContext() {
            var method = categoryMethod || "classic";
            return {
                selected_method: method,
                selected_method_label: getCategoryMethodLabel(method),
                note: getCategoryMethodNote(method),
                threshold_reference: getCategoryThresholdReference(method),
                severity_threshold_for_events: parseFloat(severityThresholdInput.value || "-0.99"),
                row_category_source: "Each SPI table row includes the category label generated by the selected method."
            };
        }

        function getChartLabel(chartId) {
            var labels = {
                spi_line: "SPI time series (line chart)",
                anom_bar: "Precipitation anomaly (bar chart)",
                severity: "Drought severity — SPI line with shaded events",
                scalogram: "Wavelet scalogram (power vs time & period)",
                global: "Global wavelet spectrum (SPI)",
                coherence: "SPI–precipitation coherence vs period",
                copula: "Copula dependence diagnostics"
            };
            return labels[chartId] || labels.scalogram;
        }

        function getChartOutputTitles(chartId) {
            var titles = {
                spi_line: [
                    "1. Overview of SPI conditions",
                    "2. Main dry and wet periods",
                    "3. Drought-category interpretation",
                    "4. Data and method notes"
                ],
                anom_bar: [
                    "1. Overview of precipitation anomalies",
                    "2. Years with strong dry or wet departures",
                    "3. Link between precipitation and SPI behavior",
                    "4. Data and method notes"
                ],
                severity: [
                    "1. Overview of drought severity",
                    "2. Drought events and duration",
                    "3. Magnitude and minimum SPI interpretation",
                    "4. Threshold and method notes"
                ],
                scalogram: [
                    "1. Overview of the scalogram",
                    "2. Strong fluctuation periods",
                    "3. Timing of drought variability",
                    "4. Reliability and method notes"
                ],
                global: [
                    "1. Overview of dominant periods",
                    "2. Main spectral peaks",
                    "3. Possible drought-cycle interpretation",
                    "4. Reliability and method notes"
                ],
                coherence: [
                    "1. Overview of coherence",
                    "2. Periods with stronger SPI–precipitation linkage",
                    "3. Periods with weak linkage or uncertainty",
                    "4. Reliability and method notes"
                ],
                copula: [
                    "1. Overview of dependence structure",
                    "2. Drought persistence probability",
                    "3. New drought probability and event length",
                    "4. Method notes and caution"
                ]
            };
            return titles[chartId] || titles.scalogram;
        }

        function getChartInterpretationLimits(chartId) {
            var common = [
                "Use only values included in the JSON request.",
                "Do not refer to charts or fields that are not included in the selected chart context.",
                "Do not provide legal, financial, insurance, or emergency-management advice."
            ];
            var chartSpecific = {
                spi_line: [
                    "SPI is a standardized index; negative values indicate dryness and positive values indicate wetness.",
                    "Category labels must follow only the active category method included in category_context."
                ],
                anom_bar: [
                    "Precipitation anomalies are departures from the baseline mean and are not the same as SPI values.",
                    "Discuss how precipitation departures help explain SPI behavior without implying causality beyond the data."
                ],
                severity: [
                    "Magnitude is the accumulated drought deficit below the selected SPI threshold, not wetness magnitude.",
                    "Event duration is in time steps of the selected scale."
                ],
                scalogram: [
                    "Wavelet power shows time-frequency variability, not direct causality.",
                    "Long-period peaks should be interpreted carefully when the record length is limited."
                ],
                global: [
                    "Global wavelet power summarizes average power across time and should be interpreted with reliability/coherence information.",
                    "Do not treat high power alone as a forecast."
                ],
                coherence: [
                    "Coherence ranges from 0 to 1 and indicates scale-dependent association between SPI and precipitation.",
                    "Low coherence weakens confidence in a physical precipitation-linked interpretation."
                ],
                copula: [
                    "Gaussian copula diagnostics describe dependence and persistence; they are not deterministic forecasts.",
                    "Probability values are empirical/model diagnostics from the current series and threshold."
                ]
            };
            return common.concat(chartSpecific[chartId] || chartSpecific.scalogram);
        }

        function buildGeneralAiContext(fullCtx) {
            fullCtx = fullCtx || {};
            var project = fullCtx.project || {};
            var run = fullCtx.run || {};
            var spiCfg = fullCtx.spi_config || {};
            var dataset = fullCtx.dataset || {};
            return {
                platform: "DMAP-AI",
                version: "Research Free Version",
                analysis_type: "point-based historical SPI analysis",
                drought_index: getSelectedDroughtIndexValue().toUpperCase(),
                drought_index_label: getSelectedDroughtIndexName(),
                location: fullCtx.location || project.location || null,
                time_scale: fullCtx.scale || lastScale || "yearly",
                time_period: run.time_range || null,
                baseline: {
                    label: (lastRunMeta && lastRunMeta.baseline) || "same_as_analysis_period",
                    baseline_start: spiCfg.baseline_start || null
                },
                data_source: dataset.name || (lastRunMeta && lastRunMeta.datasource) || null,
                units: {
                    precipitation: "mm",
                    SPI: "unitless standardized index"
                },
                drought_threshold: spiCfg.severity_threshold_spi != null ? ("SPI <= " + spiCfg.severity_threshold_spi) : "SPI <= -1.0"
            };
        }

        function buildAiInterpretationRequest(fullCtx, chartId) {
            var chartCtx = buildJsonContextForSelectedChart(fullCtx, chartId);
            if (!chartCtx) return null;
            var titles = getChartOutputTitles(chartId);

            return {
                mode: "research_free_chart_interpretation",
                selected_chart_id: chartId,
                selected_chart_label: getChartLabel(chartId),
                general_context: buildGeneralAiContext(fullCtx),
                category_context: fullCtx.category_context || buildCategoryContext(),
                chart_context: chartCtx,
                output_contract: {
                    audience: "researchers, engineers, consultants, water managers, and applied climate users",
                    tone: "clear, technical, concise, and readable",
                    required_output_titles: titles,
                    instructions: [
                        "Use the required output titles exactly and in the same order.",
                        "Focus only on the selected chart and the JSON fields included in chart_context.",
                        "Mention location, time period, time scale, baseline, data source, drought index, and active category method when useful.",
                        "Use numeric values from the JSON when discussing peaks, drought years, event counts, probabilities, thresholds, or categories.",
                        "Do not invent missing values, methods, datasets, charts, or management recommendations."
                    ],
                    interpretation_limits: getChartInterpretationLimits(chartId)
                }
            };
        }


        function buildJsonContextFromRun() {
            if (!lastSeries || !lastSeries.length) {
                return null;
            }

            var series = lastSeries;
            var scale = lastScale || "yearly";

            // ---- 1) SPI line series + table ----
            var spiTableRows = [];
            var years = [];
            var spiValues = [];

            for (var i = 0; i < series.length; i++) {
                var rec = series[i] || {};
                var endDate = rec.end_date || rec.date || null;

                var yr = null;
                if (rec.year != null) {
                    var yNum2 = parseInt(rec.year, 10);
                    if (!isNaN(yNum2)) yr = yNum2;
                }
                if (yr == null && endDate) {
                    var yStr = String(endDate).slice(0, 4);
                    var yNum = parseInt(yStr, 10);
                    if (!isNaN(yNum)) yr = yNum;
                }

                var spi = (rec.spi != null && isFinite(+rec.spi)) ? +rec.spi : null;
                var sum = getWindowSum(rec);
                var cat = getSpiCategory(spi);

                spiTableRows.push({
                    index: i,
                    year: yr,
                    end_date: endDate,
                    window_sum_mm: sum,
                    spi: spi,
                    category: cat
                });

                years.push(yr);
                spiValues.push(spi);
            }

            // SPI summary stats
            var cleanSPI = spiValues.filter(function (v) { return v != null && isFinite(v); });
            var spiMin = null, spiMax = null, spiMean = null;
            if (cleanSPI.length) {
                spiMin = cleanSPI[0];
                spiMax = cleanSPI[0];
                var sumSPI = 0;
                for (var j = 0; j < cleanSPI.length; j++) {
                    if (cleanSPI[j] < spiMin) spiMin = cleanSPI[j];
                    if (cleanSPI[j] > spiMax) spiMax = cleanSPI[j];
                    sumSPI += cleanSPI[j];
                }
                spiMean = sumSPI / cleanSPI.length;
            }

            // Time range & baseline from meta if available
            var startDate = (lastRunMeta && lastRunMeta.start_date) ||
                (years.length ? String(years[0]) + "-01-01" : null);
            var endDate = (lastRunMeta && lastRunMeta.end_date) ||
                (years.length ? String(years[years.length - 1]) + "-12-31" : null);
            var baseline = (lastRunMeta && lastRunMeta.baseline) || "same_as_analysis_period";
            var baselineContext = getBaselineContextForJson(startDate, endDate, baseline);
            var datasourceCode = (lastRunMeta && lastRunMeta.datasource) || "nasa_power";
            var locationContext = getLocationContextForJson();


            // ---- 2) Base context: project/dataset/SPI config ----
            var isMonthlyScale = (scale === "monthly");
            var datasetVariableLabel = isMonthlyScale ? "Monthly total precipitation" : "Yearly total precipitation";
            var aggregationLabel = isMonthlyScale ? "calendar_month" : "calendar_year";
            var spiTableDescription = isMonthlyScale
                ? "Monthly SPI (SPI-1) values for each month in the analysis period."
                : "Yearly SPI (SPI-12) values for each calendar year in the analysis period.";
            var spiLineDescription = isMonthlyScale
                ? "Monthly SPI values (SPI-1) for plotting the SPI line chart."
                : "Annual SPI values (SPI-12) for plotting the SPI line chart.";

            var sourcePrecipRows = getRawSourcePrecipitationFromBackend(lastRunRaw);
            var sourcePrecipCompact = compactNumericRows(sourcePrecipRows, {
                units: "mm",
                fallbackTimeStep: "daily",
                description: "Downloaded source precipitation. This compact format avoids thousands of repeated date/value objects."
            });
            var sourceTemporalResolution = sourcePrecipCompact && sourcePrecipCompact.time_step
                ? sourcePrecipCompact.time_step
                : (datasourceCode === "nasa_power" || datasourceCode === "nasa" ? "daily" : (isMonthlyScale ? "monthly" : "source_resolution_unknown"));

            var ctx = {
                scale: scale,
                location: locationContext,
                project: {
                    id: "P_spi_" +
                        (years.length ? years[0] : "start") + "_" +
                        (years.length ? years[years.length - 1] : "end"),
                    title: "Location Drought Monitor – " + getSelectedDroughtIndexValue().toUpperCase() + " (" +
                        (years.length ? years[0] : "?") + "–" +
                        (years.length ? years[years.length - 1] : "?") + ")",
                    location: locationContext
                },
                dataset: {
                    name: datasourceCode,
                    display_name: labelForDatasource(datasourceCode),
                    variable: datasetVariableLabel,
                    temporal_resolution: scale,
                    source_temporal_resolution: sourceTemporalResolution,
                    analysis_temporal_resolution: scale,
                    spatial_resolution_deg: null,
                    spatial_resolution_note: "Source-dependent point-query value. Do not assume 0.25 degrees for every datasource or parameter.",
                    provider: getDatasetProviderForJson(datasourceCode),
                    units: "mm"
                },
                spi_config: {
                    index_type: getSelectedDroughtIndexValue().toUpperCase(),
                    aggregation: aggregationLabel,
                    method: "Gamma with empirical fallback",
                    primary_distribution: "Gamma",
                    fallback_distribution: "Empirical distribution when Gamma fit returns invalid or NaN values",
                    baseline: baselineContext,
                    baseline_start: baselineContext.start,
                    baseline_end: baselineContext.end,
                    severity_threshold_spi: parseFloat(severityThresholdInput.value || "-0.99"),
                    scale: scale,
                    category_method: categoryMethod,
                    ai_quantile_thresholds: (categoryMethod === "quantile" && spiCategorizationStats) ? {
                        q05: spiCategorizationStats.q05,
                        q20: spiCategorizationStats.q20,
                        q80: spiCategorizationStats.q80,
                        q95: spiCategorizationStats.q95
                    } : null,
                    ai_kmeans: (categoryMethod === "kmeans" && spiKMeansConfig && spiKMeansConfig.centers) ? {
                        k: spiKMeansConfig.k,
                        centers: spiKMeansConfig.centers
                    } : null
                },
                run: {
                    id: (lastRunMeta && lastRunMeta.run_id) ||
                        ("RUN_spi_" +
                            (years.length ? years[0] : "") + "_" +
                            (years.length ? years[years.length - 1] : "")),
                    status: "success",
                    scale: scale,
                    time_range: {
                        start: startDate,
                        end: endDate
                    },
                    summary_stats: {
                        spi_min: spiMin,
                        spi_max: spiMax,
                        spi_mean: spiMean
                    }
                },
                spi_yearly_table: {
                    description: spiTableDescription,
                    columns: ["index", "year", "end_date", "window_sum_mm", "spi", "category"],
                    rows: spiTableRows
                },
                spi_line_series: {
                    description: spiLineDescription,
                    years: years,
                    spi_values: spiValues
                },
                spi_line_bounds: {
                    description: "Upper/lower reference lines shown on the SPI line chart (user-defined).",
                    lower: getSpiLineBounds().lower,
                    upper: getSpiLineBounds().upper
                },
                category_context: buildCategoryContext(),
                calculation_workflow: {
                    description: "End-to-end calculation workflow represented in this JSON.",
                    steps: [
                        "Select point, datasource, dates, baseline, and scale.",
                        "Download precipitation data from the selected datasource.",
                        "Aggregate precipitation to the selected SPI window/scale.",
                        "Fit SPI using Gamma distribution first.",
                        "Use empirical fallback if Gamma returns invalid or NaN values.",
                        "Assign drought/wetness categories using the active category method.",
                        "Detect drought events and calculate duration, minimum SPI, and drought magnitude.",
                        "Calculate wavelet diagnostics after the Wavelet tab is opened.",
                        "Calculate copula diagnostics after the Copula tab is run."
                    ],
                    validation_layers: [
                        "source precipitation data",
                        "aggregated precipitation totals",
                        "SPI calculation",
                        "category assignment",
                        "drought event and magnitude calculation",
                        "wavelet diagnostics",
                        "copula diagnostics"
                    ]
                },
                source_precipitation_data: {
                    description: "Raw/source-resolution precipitation data returned by the backend, stored in compact horizontal format when available.",
                    available_in_this_json: sourcePrecipRows != null,
                    compact_series: sourcePrecipCompact,
                    note: sourcePrecipRows == null
                        ? "The current frontend JSON contains aggregated window_sum_mm values. To validate downloaded daily/monthly precipitation before aggregation, the backend should return source-resolution precipitation rows."
                        : "Source-resolution precipitation data are included as start_date/end_date/time_step plus values_csv."
                },
                backend_raw_response: summarizeBackendRawResponse(lastRunRaw)
            };

            // ---- 3) Anomaly bar chart data (precip anomalies) ----
            var labels = series.map(function (d) { return d.end_date || d.date || null; });
            var sums = series.map(getWindowSum);
            var valid = series.map(function (d, i) { return { i: i, s: sums[i] }; })
                .filter(function (p) { return p.s != null; });

            var labels2 = valid.map(function (p) { return labels[p.i]; });
            var sums2 = valid.map(function (p) { return p.s; });

            var baseMeans;
            if (scale === "monthly") {
                var byM = {};
                valid.forEach(function (p) {
                    var m = new Date(labels[p.i]).getMonth();
                    if (!byM[m]) byM[m] = [];
                    byM[m].push(sums[p.i]);
                });
                baseMeans = valid.map(function (p) {
                    var m = new Date(labels[p.i]).getMonth();
                    var arr = byM[m] || [];
                    var total = 0;
                    for (var ii = 0; ii < arr.length; ii++) total += arr[ii];
                    return total / Math.max(1, arr.length);
                });
            } else {
                var total2 = 0;
                for (var i2 = 0; i2 < sums2.length; i2++) total2 += sums2[i2];
                var mu = sums2.length ? total2 / sums2.length : 0;
                baseMeans = sums2.map(function () { return mu; });
            }
            var anomalies = sums2.map(function (s, i) { return s - baseMeans[i]; });

            ctx.spi_anomaly_series = {
                format: "columns_with_rows",
                description: "Precipitation window sum anomalies relative to baseline mean.",
                columns: ["index", "end_date", "window_sum_mm", "baseline_mean_mm", "anomaly_mm"],
                row_count: valid.length,
                rows: valid.map(function (p, idx) {
                    return [p.i, labels2[idx], sums2[idx], baseMeans[idx], anomalies[idx]];
                })
            };


            var cumulativePrecip = 0;
            var cumulativeAnomaly = 0;
            ctx.precipitation_aggregation = {
                format: "columns_with_rows",
                description: "Aggregated precipitation used as SPI input.",
                source_resolution: sourceTemporalResolution,
                source_temporal_resolution: sourceTemporalResolution,
                target_resolution: scale,
                analysis_temporal_resolution: scale,
                aggregation_method: isMonthlyScale ? "calendar-month total precipitation" : "calendar-year total precipitation",
                units: "mm",
                columns: ["index", "year", "end_date", "window_sum_mm"],
                row_count: spiTableRows.length,
                rows: spiTableRows.map(function (row) {
                    return [row.index, row.year, row.end_date, row.window_sum_mm];
                })
            };

            ctx.precipitation_cumulative_series = {
                format: "columns_with_rows",
                description: "Cumulative precipitation and cumulative anomaly across the displayed analysis period.",
                units: "mm",
                columns: [
                    "index",
                    "end_date",
                    "window_sum_mm",
                    "baseline_mean_mm",
                    "anomaly_mm",
                    "cumulative_precipitation_mm",
                    "cumulative_anomaly_mm"
                ],
                row_count: valid.length,
                rows: valid.map(function (p, idx) {
                    cumulativePrecip += (sums2[idx] != null && isFinite(sums2[idx])) ? +sums2[idx] : 0;
                    cumulativeAnomaly += (anomalies[idx] != null && isFinite(anomalies[idx])) ? +anomalies[idx] : 0;
                    return [
                        p.i,
                        labels2[idx],
                        sums2[idx],
                        baseMeans[idx],
                        anomalies[idx],
                        Math.round(cumulativePrecip * 1000000) / 1000000,
                        Math.round(cumulativeAnomaly * 1000000) / 1000000
                    ];
                })
            };

            ctx.spi_calculation = {
                description: "SPI calculation metadata for validation.",
                input_variable: "aggregated precipitation",
                input_units: "mm",
                output_variable: "SPI",
                output_units: "unitless standardized index",
                primary_distribution: "Gamma",
                fallback_distribution: "Empirical distribution when Gamma fit returns invalid or NaN values",
                baseline: baselineContext,
                sample_size: cleanSPI.length,
                summary_stats: {
                    spi_min: spiMin,
                    spi_max: spiMax,
                    spi_mean: spiMean
                },
                active_category_method: buildCategoryContext()
            };

            ctx.validation_readiness = {
                description: "Shows which calculation layers can be checked from the copied JSON.",
                source_precipitation_downloaded_values_available: getRawSourcePrecipitationFromBackend(lastRunRaw) != null,
                aggregated_precipitation_available: spiTableRows.some(function (r) { return r.window_sum_mm != null; }),
                spi_values_available: cleanSPI.length > 0,
                category_labels_available: spiTableRows.some(function (r) { return r.category != null; }),
                drought_events_available: false,
                wavelet_available: false,
                copula_available: false
            };

            // ---- 4) Boxplot data (SPI distributions) ----
            var labelsBox = [];
            var boxData = [];
            var spiValsAll = spiValues.filter(function (x) { return x != null && isFinite(x); });

            if (scale === "monthly") {
                var groups = {};
                series.forEach(function (d) {
                    if (d.spi != null && isFinite(+d.spi) && d.end_date) {
                        var mm = new Date(d.end_date).getMonth();
                        if (!groups[mm]) groups[mm] = [];
                        groups[mm].push(+d.spi);
                    }
                });
                var monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                for (var m2 = 0; m2 < 12; m2++) {
                    var arr2 = (groups[m2] || []).filter(function (x) { return isFinite(x); });
                    if (arr2.length) {
                        labelsBox.push(monthNames[m2]);
                        boxData.push(arr2);
                    }
                }
            } else {
                if (spiValsAll.length) {
                    labelsBox.push("All years");
                    boxData.push(spiValsAll);
                }
            }

            ctx.spi_boxplot = {
                description: "SPI distribution groups used in the boxplot.",
                groups: labelsBox.map(function (label, idx) {
                    return {
                        label: label,
                        values: boxData[idx]
                    };
                })
            };

            // ---- 5) Drought severity / threshold-based events ----
            var threshold = parseFloat(severityThresholdInput.value || "-0.99");
            var events = detectDroughtEvents(series, threshold) || [];

            function classifySeverity(minSPI) {
                if (minSPI == null || !isFinite(minSPI)) return "none";
                if (minSPI <= -2.0) return "extreme";
                if (minSPI <= -1.5) return "severe";
                if (minSPI <= -1.0) return "moderate";
                return "none";
            }

            var eventRows = events.map(function (ev, idx) {
                var minSPI = ev.minSPI;
                var sevClass = classifySeverity(minSPI);
                return {
                    event_id: idx + 1,
                    start_index: ev.startIndex,
                    end_index: ev.endIndex,
                    start_date: ev.startDate,
                    end_date: ev.endDate,
                    duration_steps: ev.duration,
                    min_spi: minSPI,
                    magnitude: ev.magnitude,
                    severity_class: sevClass
                };
            });

            var yearsEventCount = {};
            eventRows.forEach(function (ev) {
                var yStart = ev.start_date ? parseInt(String(ev.start_date).slice(0, 4), 10) : null;
                var yEnd = ev.end_date ? parseInt(String(ev.end_date).slice(0, 4), 10) : yStart;
                if (yStart == null) return;
                if (yEnd == null) yEnd = yStart;
                for (var yy = yStart; yy <= yEnd; yy++) {
                    yearsEventCount[yy] = (yearsEventCount[yy] || 0) + 1;
                }
            });
            var yearsWithAny = Object.keys(yearsEventCount);
            var maxEventsYear = null, maxEventsCount = 0;
            yearsWithAny.forEach(function (y) {
                var c = yearsEventCount[y];
                if (c > maxEventsCount) {
                    maxEventsCount = c;
                    maxEventsYear = y;
                }
            });

            ctx.spi_drought_events = {
                threshold_spi: threshold,
                events: eventRows,
                summary: {
                    total_events: eventRows.length,
                    years_with_any_event: yearsWithAny.length,
                    year_with_most_events: maxEventsYear,
                    max_events_in_that_year: maxEventsCount
                }
            };
            if (ctx.validation_readiness) ctx.validation_readiness.drought_events_available = true;

            // ---- 6) Wavelet scalogram + global spectrum + coherence ----
            if (Array.isArray(waveletPower2D) && waveletPower2D.length &&
                Array.isArray(waveletPeriods) && waveletPeriods.length) {

                var nTime = waveletPower2D.length;
                var idxRange = [0, nTime - 1];

                var indicesArr = waveletTimeIndices && waveletTimeIndices.length ?
                    waveletTimeIndices.slice() :
                    Array.from({ length: nTime }, function (_, ii) { return ii; });

                var yearsArr = waveletYears && waveletYears.length ? waveletYears.slice() : years.slice();

                ctx.wavelet_scalogram = {
                    description: "Raw wavelet power of SPI, time vs period.",
                    time_axis: {
                        units: "index",
                        index_range: idxRange,
                        indices: indicesArr,
                        years: yearsArr
                    },
                    period_axis: {
                        units: "time_steps",
                        values: waveletPeriods.slice()
                    },
                    power_matrix: waveletPower2D.map(function (row) {
                        return row.map(function (v) { return v; });
                    })
                };
                if (ctx.validation_readiness) ctx.validation_readiness.wavelet_available = true;
            }

            if (Array.isArray(waveletPeriods) && waveletPeriods.length &&
                Array.isArray(waveletGlobalPower) &&
                waveletGlobalPower.length === waveletPeriods.length) {

                var dominantIndex = 0;
                for (var k = 1; k < waveletGlobalPower.length; k++) {
                    if (waveletGlobalPower[k] > waveletGlobalPower[dominantIndex]) {
                        dominantIndex = k;
                    }
                }
                var rawPeakJson = waveletReliability && waveletReliability.highest_power_peak ? waveletReliability.highest_power_peak : null;
                var reliablePeakJson = waveletReliability && waveletReliability.best_reliable_peak ? waveletReliability.best_reliable_peak : null;

                ctx.global_wavelet_spectrum = {
                    description: "Global wavelet spectrum of SPI. Highest-power peaks should be checked against coherence before being treated as reliable forecast bands.",
                    periods: waveletPeriods.slice(),
                    powers: waveletGlobalPower.slice(),
                    highest_power_peak: rawPeakJson || {
                        period: waveletPeriods[dominantIndex],
                        power: waveletGlobalPower[dominantIndex]
                    },
                    reliable_peak: reliablePeakJson,
                    significant_peaks: [
                        {
                            period: waveletPeriods[dominantIndex],
                            power: waveletGlobalPower[dominantIndex],
                            significant: !!(rawPeakJson && rawPeakJson.coherence >= 0.20 && !(rawPeakJson.flags || []).length),
                            note: rawPeakJson && rawPeakJson.coherence < 0.20
                                ? "Highest-power peak has low coherence with precipitation; interpret cautiously."
                                : "Highest-power peak by amplitude; no formal statistical significance test applied."
                        }
                    ]
                };
            }

            if (Array.isArray(waveletPeriods) && waveletPeriods.length &&
                Array.isArray(waveletCoherenceArray) &&
                waveletCoherenceArray.length === waveletPeriods.length) {

                ctx.wavelet_coherence = {
                    description: "Scale-dependent coherence between SPI and precipitation (0–1).",
                    periods: waveletPeriods.slice(),
                    coherence: waveletCoherenceArray.slice()
                };
            }

            if (waveletSummaryData) {
                ctx.wavelet_summary = {
                    description: "Compact wavelet summary used in the UI and passed to the AI for consistent interpretation.",
                    highest_power_peak: waveletSummaryData.highest_power_peak,
                    highest_power_coherence: waveletSummaryData.highest_power_peak && isFinite(waveletSummaryData.highest_power_peak.coherence)
                        ? waveletSummaryData.highest_power_peak.coherence
                        : null,
                    best_reliable_peak: waveletSummaryData.best_reliable_peak,
                    best_reliable_coherence: waveletSummaryData.best_reliable_peak && isFinite(waveletSummaryData.best_reliable_peak.coherence)
                        ? waveletSummaryData.best_reliable_peak.coherence
                        : null,
                    average_coherence: waveletSummaryData.average_coherence,
                    caution_note: waveletSummaryData.caution_note,
                    summary_text: waveletSummaryData.summary_text
                };
            }

            if (waveletReliability && waveletReliability.ranked_periods) {
                ctx.wavelet_reliability = {
                    description: "Reliability-weighted wavelet ranking based on normalized global power and coherence penalties.",
                    interpretation_rule: waveletReliability.interpretation_rule,
                    highest_power_peak: waveletReliability.highest_power_peak,
                    best_reliable_peak: waveletReliability.best_reliable_peak,
                    top_ranked_periods: waveletReliability.ranked_periods.slice(0, 8)
                };
            }

            // ---- 7) Copula diagnostics (if available) ----
            if (lastCopulaResult && typeof lastCopulaResult === "object") {
                // Only attach if the copula was computed for this same scale
                if (!lastCopulaScale || lastCopulaScale === scale) {
                    var c = lastCopulaResult;
                    var copulaPairType = lastCopulaPairType || c.pair_type || null;
                    var copulaThreshold = -1.0;
                    if (c.severity_stats && typeof c.severity_stats.threshold === "number") {
                        copulaThreshold = c.severity_stats.threshold;
                    }
                    ctx.copula = {
                        description: "Bivariate copula diagnostics relating SPI to precipitation or lagged SPI, focused on dependence and persistence-style summaries.",
                        pair_type: copulaPairType,
                        family: c.family || null,
                        params: c.params || null,
                        kendall_tau: (typeof c.kendall_tau === "number" ? c.kendall_tau : null),
                        n: (typeof c.n === "number" ? c.n : null),
                        uv_points: buildCopulaUvPointsForJson(c, years),
                        severity_stats: c.severity_stats || null,
                        transition_table: copulaPairType === "spi_lag1"
                            ? buildCopulaTransitionTableForJson(series, copulaThreshold)
                            : null,
                        method_note: "Gaussian copula tail dependence should not be emphasized as meaningful tail-dependence evidence; use these diagnostics mainly for dependence and persistence summaries.",
                        // Human-readable text summary so the LLM can echo/interpret it
                        text_summary: (typeof formatCopulaSummary === "function"
                            ? formatCopulaSummary(c)
                            : null)
                    };
                    if (ctx.validation_readiness) ctx.validation_readiness.copula_available = true;
                }
            }

            return ctx;
        }
        /**
* Build a smaller JSON context focused ONLY on the selected chart.
* The original buildJsonContextFromRun() still returns the full run
* (all charts). We slice it here only for Mode 1.
*/

        function buildJsonContextForProjectFromCurrentRun() {
            // Build single-run context first for fallback
            var singleCtx = buildJsonContextFromRun();
            if (!singleCtx) return null;

            var projectId = (lastRunMeta && lastRunMeta.project_id) || null;
            var lat = lastRunMeta && lastRunMeta.lat;
            var lon = lastRunMeta && lastRunMeta.lon;

            var runs = getRunsForProject(projectId, lat, lon);

            // If we have no saved runs for this project/location, just wrap the current context
            if (!runs || !runs.length) {
                var singleKey = makeScaleKeyFromRun({ scale: singleCtx.scale || (lastScale || "yearly") });
                var singleLocation = (singleCtx.project && singleCtx.project.location)
                    ? {
                        lat: singleCtx.project.location.latitude,
                        lon: singleCtx.project.location.longitude
                    }
                    : {
                        lat: lat != null ? parseFloat(lat) : null,
                        lon: lon != null ? parseFloat(lon) : null
                    };
                var singleWrapper = {
                    project_id: projectId || "current_run_project",
                    project_title: (singleCtx.project && singleCtx.project.title) || "Location Drought Monitor – SPI",
                    common_location: singleLocation,
                    scales: {}
                };
                singleWrapper.scales[singleKey] = singleCtx;
                return singleWrapper;
            }

            // Helper to build a full context for each saved run
            function contextFromRun(run) {
                var savedSeries = lastSeries;
                var savedScale = lastScale;
                var savedMeta = lastRunMeta;

                lastSeries = Array.isArray(run.series) ? run.series : [];
                lastScale = run.scale || "yearly";
                lastRunMeta = {
                    lat: run.lat,
                    lon: run.lon,
                    start_date: run.start_date,
                    end_date: run.end_date,
                    baseline: run.baseline,
                    scale: run.scale,
                    ywin: run.ywin,
                    rollingN: run.rollingN,
                    anchor: run.anchor,
                    datasource: run.datasource,
                    project_id: run.project_id
                };

                var ctx = buildJsonContextFromRun();

                lastSeries = savedSeries;
                lastScale = savedScale;
                lastRunMeta = savedMeta;
                return ctx;
            }

            var firstRun = runs[0] || {};
            var baseLocation = (singleCtx.project && singleCtx.project.location)
                ? {
                    lat: singleCtx.project.location.latitude,
                    lon: singleCtx.project.location.longitude
                }
                : {
                    lat: firstRun.lat != null ? parseFloat(firstRun.lat) : (lat != null ? parseFloat(lat) : null),
                    lon: firstRun.lon != null ? parseFloat(firstRun.lon) : (lon != null ? parseFloat(lon) : null)
                };

            var wrapper = {
                project_id: projectId || firstRun.project_id || "current_run_project",
                project_title: firstRun.title || (singleCtx.project && singleCtx.project.title) || "Location Drought Monitor – SPI",
                common_location: baseLocation,
                scales: {}
            };

            runs.forEach(function (run) {
                var key = makeScaleKeyFromRun(run);
                wrapper.scales[key] = contextFromRun(run);
            });

            return wrapper;
        }

        function buildJsonContextForSelectedChart(fullCtx, chartId) {
            if (!fullCtx || typeof fullCtx !== "object") return null;
            if (!chartId) chartId = "scalogram";

            // Always keep core metadata and the active category method.
            var ctx = {
                focus_chart: {
                    id: chartId,
                    label: getChartLabel(chartId),
                    output_titles: getChartOutputTitles(chartId),
                    interpretation_limits: getChartInterpretationLimits(chartId)
                },
                project: fullCtx.project || null,
                location: fullCtx.location || (fullCtx.project ? fullCtx.project.location : null),
                dataset: fullCtx.dataset || null,
                spi_config: fullCtx.spi_config || null,
                category_context: fullCtx.category_context || buildCategoryContext(),
                run: fullCtx.run || null,
                calculation_workflow: fullCtx.calculation_workflow || null,
                validation_readiness: fullCtx.validation_readiness || null
            };

            switch (chartId) {
                case "spi_line":
                    if (fullCtx.spi_yearly_table) ctx.spi_yearly_table = fullCtx.spi_yearly_table;
                    if (fullCtx.spi_line_series) ctx.spi_line_series = fullCtx.spi_line_series;
                    if (fullCtx.spi_line_bounds) ctx.spi_line_bounds = fullCtx.spi_line_bounds;
                    if (fullCtx.precipitation_aggregation) ctx.precipitation_aggregation = fullCtx.precipitation_aggregation;
                    if (fullCtx.precipitation_cumulative_series) ctx.precipitation_cumulative_series = fullCtx.precipitation_cumulative_series;
                    if (fullCtx.spi_calculation) ctx.spi_calculation = fullCtx.spi_calculation;
                    break;

                case "anom_bar":
                    if (fullCtx.spi_anomaly_series) ctx.spi_anomaly_series = fullCtx.spi_anomaly_series;
                    if (fullCtx.precipitation_aggregation) ctx.precipitation_aggregation = fullCtx.precipitation_aggregation;
                    if (fullCtx.precipitation_cumulative_series) ctx.precipitation_cumulative_series = fullCtx.precipitation_cumulative_series;
                    if (fullCtx.spi_line_series) ctx.spi_line_series = fullCtx.spi_line_series;
                    break;

                case "severity":
                    if (fullCtx.spi_line_series) ctx.spi_line_series = fullCtx.spi_line_series;
                    if (fullCtx.spi_line_bounds) ctx.spi_line_bounds = fullCtx.spi_line_bounds;
                    if (fullCtx.spi_drought_events) ctx.spi_drought_events = fullCtx.spi_drought_events;
                    if (fullCtx.spi_calculation) ctx.spi_calculation = fullCtx.spi_calculation;
                    if (fullCtx.precipitation_cumulative_series) ctx.precipitation_cumulative_series = fullCtx.precipitation_cumulative_series;
                    break;

                case "scalogram":
                    if (fullCtx.spi_line_series) ctx.spi_line_series = fullCtx.spi_line_series;
                    if (fullCtx.wavelet_scalogram) ctx.wavelet_scalogram = fullCtx.wavelet_scalogram;
                    if (fullCtx.wavelet_summary) ctx.wavelet_summary = fullCtx.wavelet_summary;
                    if (fullCtx.wavelet_reliability) ctx.wavelet_reliability = fullCtx.wavelet_reliability;
                    break;

                case "global":
                    if (fullCtx.spi_line_series) ctx.spi_line_series = fullCtx.spi_line_series;
                    if (fullCtx.global_wavelet_spectrum) ctx.global_wavelet_spectrum = fullCtx.global_wavelet_spectrum;
                    if (fullCtx.wavelet_summary) ctx.wavelet_summary = fullCtx.wavelet_summary;
                    if (fullCtx.wavelet_reliability) ctx.wavelet_reliability = fullCtx.wavelet_reliability;
                    break;

                case "coherence":
                    if (fullCtx.spi_line_series) ctx.spi_line_series = fullCtx.spi_line_series;
                    if (fullCtx.wavelet_coherence) ctx.wavelet_coherence = fullCtx.wavelet_coherence;
                    if (fullCtx.wavelet_summary) ctx.wavelet_summary = fullCtx.wavelet_summary;
                    if (fullCtx.wavelet_reliability) ctx.wavelet_reliability = fullCtx.wavelet_reliability;
                    break;

                case "copula":
                    if (fullCtx.spi_line_series) ctx.spi_line_series = fullCtx.spi_line_series;
                    if (fullCtx.spi_drought_events) ctx.spi_drought_events = fullCtx.spi_drought_events;
                    if (fullCtx.copula) ctx.copula = fullCtx.copula;
                    break;

                default:
                    return null;
            }

            return ctx;
        }




        // ---- NEW: JSON-based analysis for farmer ----
        async function analyzeJsonForFarmer() {
            if (!resultOutput) return;

            // 1) Build FULL JSON context (prefer project-level if multiple scales are saved)
            // 1) Build FULL JSON context
            var ctx = null;
            if (shouldUseProjectContext() &&
                typeof buildJsonContextForProjectFromCurrentRun === "function") {
                ctx = buildJsonContextForProjectFromCurrentRun();
            }
            if (!ctx) {
                ctx = buildJsonContextFromRun();
            }
            if (!ctx) {
                resultOutput.textContent = "No SPI run available. Please run the analysis first.";
                return;
            }


            // 2) Read crop from the farmerCrop select (default: corn)
            var cropSel = document.getElementById("farmerCrop");
            var cropValue = "corn";
            var cropLabel = "corn";

            if (cropSel) {
                var idx = cropSel.selectedIndex;
                if (idx >= 0) {
                    cropValue = cropSel.value || "corn";
                    cropLabel = cropSel.options[idx].text || cropValue;
                }
            }

            // 3) Get location name from JSON if available
            var locName = "this area";
            if (ctx.project && ctx.project.location && ctx.project.location.name) {
                locName = ctx.project.location.name;
            }

            // 4) System message: talk to a farmer in simple language
            var systemInstruction =
                "You are a climate scientist assistant specializing in drought indices. " +
                "Your audience is a non-scientist farmer. Explain in simple, practical " +
                "language using short paragraphs and no technical jargon. Avoid equations, " +
                "citations, and any legal or financial advice. Use short section titles like:" +
                "1. Recent rain pattern" +
                "2. What this means for your soil and corn" +
                "3. How dry or wet years affect your farming" +
                "4. Practical ideas" +
                "Put each title on its own line, then a blank line, then the explanation.";

            // 5) User prompt: drought + SPI + crop-specific advice
            var userLines = [
                "You are helping a farmer understand drought conditions using SPI.",
                "Location: " + locName + ".",
                "Main crop of interest: " + cropLabel + ".",
                "",
                "Using the SPI JSON context below, explain in simple language:",
                "1) Whether recent years have been mostly dry, wet, or in between.",
                "2) What that means for soil moisture and stress risk for " + cropLabel + ".",
                "3) How drought or very wet years could affect planting, growth, and yield risk.",
                "4) A few practical, high-level suggestions (for example, watching soil moisture,",
                "   scouting for stress, or adjusting planting/irrigation timing), but do NOT give",
                "   legal, financial, or insurance advice.",
                "",
                "Talk directly to the farmer (use 'you').",
                "",
                "CONTEXT_JSON:",
                JSON.stringify(ctx)
            ];

            var userText = userLines.join("\n");

            console.log("[FARMER] systemInstruction:", systemInstruction);
            console.log("[FARMER] crop:", cropValue, "label:", cropLabel);
            console.log("[FARMER] user text:", userText);
            console.log("[FARMER] context JSON object:", ctx);

            var payload = {
                contents: [{
                    role: "user",
                    parts: [{ text: userText }]
                }],
                systemInstruction: {
                    parts: [{ text: systemInstruction }]
                }
            };

            try {
                setLoading(true);

                var response = await fetch(API_URL, {
                    method: "POST",
                    headers: authHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify(payload)
                });
                var result = await response.json();

                if (!response.ok || result.error) {
                    var msg = "API call failed with status " + response.status;
                    if (result && result.error && result.error.message) {
                        msg += " - " + result.error.message;
                    }
                    throw new Error(msg);
                }

                var textOut = "";
                if (result.candidates && result.candidates.length > 0) {
                    var cand = result.candidates[0];
                    if (cand.content && cand.content.parts) {
                        textOut = cand.content.parts.map(function (p) {
                            return p.text || "";
                        }).join("\n");
                    }
                }
                if (!textOut) textOut = "[No text returned from model]";

                resultOutput.textContent = textOut;
            } catch (error) {
                console.error("Gemini API Error (farmer):", error);
                resultOutput.textContent =
                    "Error: Could not generate farmer explanation. " + error.message;
            } finally {
                setLoading(false);
            }
        }


        function displayResult(result) {
            var text = result &&
                result.candidates &&
                result.candidates[0] &&
                result.candidates[0].content &&
                result.candidates[0].content.parts &&
                result.candidates[0].content.parts[0] &&
                result.candidates[0].content.parts[0].text;
            if (text) {
                if (resultOutput) resultOutput.textContent = text;
            } else {
                if (resultOutput) {
                    resultOutput.textContent =
                        "Analysis failed: No content generated by the model. Check the console for details.";
                }
                console.log("Raw API Response (Failure):", result);
            }
        }

        function setLoading(isLoading) {
            if (!analyzeButton) return;
            analyzeButton.disabled = isLoading;
            if (buttonText) {
                buttonText.textContent = isLoading ? "Analyzing…" : "Get Expert Interpretation";
            }
            if (loadingIndicator) {
                loadingIndicator.style.display = isLoading ? "inline-block" : "none";
            }
        }

        document.addEventListener("DOMContentLoaded", function () {
            if (typeof setLoading === "function") {
                setLoading(false);
            } else {
                var li = document.getElementById("loadingIndicator");
                if (li) li.classList.add("hidden");
            }
        });
        window.addEventListener("resize", function () {
            if (window.map && typeof map.invalidateSize === "function") {
                map.invalidateSize();
            }
        });


    
        document.addEventListener("DOMContentLoaded", function () {
            var droughtSelect = getDroughtIndexSelectEl();
            if (droughtSelect) {
                droughtSelect.addEventListener("change", function () {
                    if (getCurrentPlanName() === "free") {
                        applyPlanRestrictions();
                    }
                });
            }

            var obsSrcEl = document.getElementById("obsSrc");
            if (obsSrcEl) {
                obsSrcEl.addEventListener("change", function () {
                    if (getCurrentPlanName() === "free") {
                        applyPlanRestrictions();
                    }
                });
            }

            document.querySelectorAll('input[name="mode"], input[name="scale"]').forEach(function (el) {
                el.addEventListener("change", function () {
                    if (getCurrentPlanName() === "free") {
                        applyPlanRestrictions();
                    }
                });
            });

            applyPlanRestrictions();
        });
