(function () {
  "use strict";

  var AUTH0_DOMAIN = "agrimetsoft.us.auth0.com";
  var AUTH0_CLIENT_ID = "OSqukLHglzE9hqQCrxPrz859FKUpNm7F";
  var AUTH0_AUDIENCE = "https://dmap-ai-api";
  var API_BASE = window.DMAP_ANALYTICS_API_BASE || window.location.origin;
  var auth0Client, accessToken, map, markerLayer, refreshTimer;
  var selectedWindow = "live";

  var $ = function (id) { return document.getElementById(id); };
  var dashboard = $("dashboard");
  var statusPanel = $("statusPanel");
  var statusMessage = $("statusMessage");

  function showState(message, login) {
    dashboard.classList.add("hidden");
    statusPanel.classList.remove("hidden");
    statusMessage.textContent = message;
    $("loginButton").classList.toggle("hidden", !login);
  }

  function showDashboard() {
    statusPanel.classList.add("hidden");
    dashboard.classList.remove("hidden");
    if (!map) {
      map = L.map("analyticsMap").setView([39, -96], 4);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18, attribution: "&copy; OpenStreetMap contributors"
      }).addTo(map);
      markerLayer = L.layerGroup().addTo(map);
    }
    setTimeout(function () { map.invalidateSize(); }, 0);
  }

  function queryString() {
    var query = new URLSearchParams({window: selectedWindow, timezone: "America/Chicago"});
    if (selectedWindow === "custom") {
      var start = $("customStart").value;
      var end = $("customEnd").value;
      if (!start || !end) throw new Error("Choose both start and end for the custom range.");
      var startDate = new Date(start), endDate = new Date(end);
      if (isNaN(startDate) || isNaN(endDate) || startDate >= endDate) throw new Error("The custom start must be before the end.");
      query.set("start", startDate.toISOString()); query.set("end", endDate.toISOString());
    }
    return query.toString();
  }

  async function api(report) {
    var response = await fetch(API_BASE + "/admin/analytics/" + report + "?" + queryString(), {
      headers: {Authorization: "Bearer " + accessToken}, cache: "no-store"
    });
    var data = await response.json().catch(function () { return {}; });
    if (response.status === 401) throw Object.assign(new Error("Authentication required."), {status: 401});
    if (response.status === 403) throw Object.assign(new Error("You do not have permission to access this page."), {status: 403});
    if (!response.ok) throw new Error(data.detail || "Analytics API unavailable.");
    return data;
  }

  function metric(label, value, suffix) {
    var display = value === null || value === undefined ? "Unavailable" : Number(value).toLocaleString() + (suffix || "");
    return '<article class="metric card"><span>' + label + '</span><strong>' + display + '</strong></article>';
  }

  function renderSummary(data) {
    $("summaryCards").innerHTML = metric("Tool Calls", data.tool_calls) + metric("Successful Analyses", data.successful_calls) +
      metric("Failed Calls", data.failed_calls) + metric("Estimated Sessions", data.estimated_sessions) +
      metric("Authenticated Users", data.authenticated_users) + metric("Active Sessions", data.active_sessions) +
      metric("Average Duration", data.average_duration_ms, data.average_duration_ms === null ? "" : " ms");
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (char) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char];
    });
  }

  function time(value) { return value ? new Intl.DateTimeFormat([], {dateStyle: "medium", timeStyle: "short"}).format(new Date(value)) : "—"; }
  function duration(value) { return value === null || value === undefined ? "—" : Number(value).toLocaleString() + " ms"; }
  function emptyRow(columns, message) { return '<tr><td colspan="' + columns + '" class="empty-row">' + message + '</td></tr>'; }

  function renderMap(points) {
    markerLayer.clearLayers();
    var bounds = [];
    points.forEach(function (point) {
      var tools = Object.keys(point.tool_breakdown || {}).map(function (name) { return escapeHtml(name) + ": " + point.tool_breakdown[name]; }).join("<br>");
      L.circleMarker([point.latitude, point.longitude], {radius: Math.min(18, 6 + Math.log2(point.total_analyses + 1) * 2), color: "#1d4ed8", fillColor: "#3b82f6", fillOpacity: .65})
        .bindPopup("<strong>Analyzed location</strong><br>" + point.latitude.toFixed(2) + ", " + point.longitude.toFixed(2) +
          "<br>Total: " + point.total_analyses + "<br>Successful: " + point.successful_analyses + "<br>Failed: " + point.failed_analyses +
          "<br><br>" + tools + "<br><br>First: " + escapeHtml(time(point.first_activity_utc)) + "<br>Last: " + escapeHtml(time(point.last_activity_utc)))
        .addTo(markerLayer);
      bounds.push([point.latitude, point.longitude]);
    });
    $("mapEmpty").classList.toggle("hidden", points.length > 0);
    if (bounds.length === 1) map.setView(bounds[0], 7);
    else if (bounds.length > 1) map.fitBounds(bounds, {padding: [25, 25], maxZoom: 9});
    else map.setView([39, -96], 4);
  }

  function renderTimeline(points) {
    if (!points.length) { $("timelineChart").innerHTML = '<p class="empty">No activity in this period.</p>'; return; }
    var width = 700, height = 240, pad = 35, max = Math.max.apply(null, points.map(function (p) { return p.calls; })) || 1;
    var x = function (i) { return pad + (points.length === 1 ? (width - 2 * pad) / 2 : i * (width - 2 * pad) / (points.length - 1)); };
    var y = function (value) { return height - pad - value * (height - 2 * pad) / max; };
    var path = points.map(function (p, i) { return (i ? "L" : "M") + x(i) + " " + y(p.calls); }).join(" ");
    var dots = points.map(function (p, i) { return '<circle cx="' + x(i) + '" cy="' + y(p.calls) + '" r="4"><title>' + escapeHtml(time(p.bucket_utc)) + ": " + p.calls + " calls</title></circle>"; }).join("");
    $("timelineChart").innerHTML = '<svg viewBox="0 0 ' + width + " " + height + '" aria-hidden="true"><line x1="' + pad + '" y1="' + (height-pad) + '" x2="' + (width-pad) + '" y2="' + (height-pad) + '" stroke="#cbd5e1"/><path d="' + path + '" fill="none" stroke="#2563eb" stroke-width="3"/>' + dots.replace(/<circle/g, '<circle fill="#2563eb"') + '<text x="' + pad + '" y="18" class="axis-label">Peak: ' + max + " calls</text></svg>";
  }

  function renderTables(tools, recent, errors) {
    $("toolsBody").innerHTML = tools.length ? tools.map(function (row) { return "<tr><td>" + escapeHtml(row.tool_name) + "</td><td>" + row.calls + "</td><td>" + row.successes + "</td><td>" + row.failures + "</td><td>" + duration(row.average_duration_ms) + "</td></tr>"; }).join("") : emptyRow(5, "No tool calls in this period.");
    $("recentBody").innerHTML = recent.length ? recent.map(function (row) { var coords = row.latitude === null ? "—" : Number(row.latitude).toFixed(2) + ", " + Number(row.longitude).toFixed(2); return "<tr><td>" + escapeHtml(time(row.started_at_utc)) + "</td><td>" + escapeHtml(row.tool_name) + "</td><td>" + coords + '</td><td class="status status-' + row.status + '">' + escapeHtml(row.status) + "</td><td>" + duration(row.duration_ms) + "</td><td>" + (row.is_test ? "Test" : "Production") + "</td></tr>"; }).join("") : emptyRow(6, "No recent analyses in this period.");
    $("errorsBody").innerHTML = errors.length ? errors.map(function (row) { return "<tr><td>" + escapeHtml(time(row.started_at_utc)) + "</td><td>" + escapeHtml(row.tool_name) + "</td><td>" + escapeHtml(row.error_type || "ToolReportedError") + "</td><td>" + duration(row.duration_ms) + "</td></tr>"; }).join("") : emptyRow(4, "No errors in this period.");
  }

  async function refresh() {
    clearTimeout(refreshTimer); $("alert").classList.add("hidden"); $("refreshButton").disabled = true;
    try {
      var results = await Promise.all([api("summary"), api("map"), api("timeline"), api("tools"), api("recent"), api("errors")]);
      renderSummary(results[0]); renderMap(results[1].points); renderTimeline(results[2].points);
      renderTables(results[3].tools, results[4].recent, results[5].errors);
      $("lastRefreshed").textContent = "Last refreshed " + time(new Date().toISOString());
    } catch (error) {
      if (error.status === 401 || error.status === 403) { showState(error.message, error.status === 401); return; }
      $("alert").textContent = error.message; $("alert").classList.remove("hidden");
    } finally {
      $("refreshButton").disabled = false;
      refreshTimer = setTimeout(refresh, selectedWindow === "live" ? 30000 : 300000);
    }
  }

  async function initialize() {
    try {
      auth0Client = await auth0.createAuth0Client({domain: AUTH0_DOMAIN, clientId: AUTH0_CLIENT_ID, authorizationParams: {redirect_uri: window.location.origin + "/admin/mcp-analytics/", audience: AUTH0_AUDIENCE, scope: "openid profile email"}});
      if (location.search.includes("code=") && location.search.includes("state=")) { await auth0Client.handleRedirectCallback(); history.replaceState({}, document.title, location.pathname); }
      if (!await auth0Client.isAuthenticated()) { showState("Sign in to access the private analytics dashboard.", true); return; }
      accessToken = await auth0Client.getTokenSilently({authorizationParams: {audience: AUTH0_AUDIENCE, scope: "openid profile email"}});
      showDashboard(); await refresh();
    } catch (error) { showState("Authentication could not be completed. " + error.message, true); }
  }

  $("loginButton").addEventListener("click", function () { auth0Client.loginWithRedirect({authorizationParams: {redirect_uri: window.location.origin + "/admin/mcp-analytics/", audience: AUTH0_AUDIENCE, scope: "openid profile email"}}); });
  $("logoutButton").addEventListener("click", function () { auth0Client.logout({logoutParams: {returnTo: window.location.origin + "/"}}); });
  $("refreshButton").addEventListener("click", refresh); $("applyCustom").addEventListener("click", refresh);
  document.querySelectorAll(".filter").forEach(function (button) { button.addEventListener("click", function () { selectedWindow = button.dataset.window; document.querySelectorAll(".filter").forEach(function (item) { item.classList.toggle("active", item === button); }); $("customRange").classList.toggle("hidden", selectedWindow !== "custom"); if (selectedWindow !== "custom") refresh(); }); });
  $("exportButton").addEventListener("click", async function () { try { var response = await fetch(API_BASE + "/admin/analytics/export.csv?" + queryString(), {headers: {Authorization: "Bearer " + accessToken}, cache: "no-store"}); if (!response.ok) throw new Error("CSV export failed."); var link = document.createElement("a"); link.href = URL.createObjectURL(await response.blob()); link.download = "dmap-analytics.csv"; link.click(); setTimeout(function () { URL.revokeObjectURL(link.href); }, 0); } catch (error) { $("alert").textContent = error.message; $("alert").classList.remove("hidden"); } });

  initialize();
}());
