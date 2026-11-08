# DMAP-AI Web Frontend

This is the web frontend for **DMAP-AI**, the drought-analysis web app at
[droughtanalysis.com](https://droughtanalysis.com). A user picks a location and
a time period, and the app runs historical drought analysis in the browser.

## What it does

- Runs drought analysis for any location using the Standardized Precipitation
  Index (SPI) and wavelet analysis.
- Works with two climate datasets: ERA5 and NASA POWER.
- Shows SPI values and categories, precipitation–SPI tables, SPI drought
  events, and wavelet charts (scalogram and global spectrum).
- Includes tutorial and help pages (SPI, SV, method comparison) and a
  knowledge section.
- Calls the DMAP-AI analysis backend and displays the results.

## Tech

- Plain HTML, CSS, and JavaScript (no framework).
- Auth0 for user sign-in (single-page app).
- Static hosting on Cloudflare Pages (`_headers`, `_redirects`).
- Talks to the DMAP-AI backend API at `/api`.

## Structure

- `index.html` — the main app page.
- `assets/dmap-ai-app.js` — the main app logic (requests data, draws results).
- `assets/dmap-ai-app.css` — styles.
- `assets/` — logos, icons, and shared scripts.
- Tutorial and info pages: `spi_tutorial.html`, `tutorials.html`, and others.

## Notes

- This repository holds the public web frontend only. The analysis engine
  (backend) is a separate, private project.
- The Auth0 Client ID in the code is the public single-page-app client ID; it
  is not a secret.
