# Private MCP analytics dashboard

The private page is `/admin/mcp-analytics/`. It is deliberately absent from the public navigation and sitemap and contains `noindex,nofollow,noarchive`. Hiding the URL is not a security boundary: the MCP backend validates every access token and administrator permission.

The page reuses the site's Auth0 tenant, client ID, API audience, Auth0 SPA SDK, global navigation, colors, and Leaflet 1.9.4. Its Auth0 cache uses the SDK's in-memory default. It requests `read:dmap-analytics` and calls same-origin `/admin/analytics/*`. If deployment later separates origins, set `window.DMAP_ANALYTICS_API_BASE` in deployment-managed configuration before this script loads; do not put administrator subjects or secrets in JavaScript.

Local static smoke test:

```powershell
python -m http.server 8765 --bind 127.0.0.1
# Open http://127.0.0.1:8765/admin/mcp-analytics/
node --check assets\mcp-analytics.js
```

The Auth0 application must allow `https://droughtanalysis.com/admin/mcp-analytics/` as a callback URL and the production origin as an allowed web origin. Cloudflare Pages deploys this repository through its existing Git workflow; no new frontend dependency or build step is required.
