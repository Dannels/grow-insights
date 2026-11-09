# Grow Insights

A commerce analytics platform for **Grow Computer**, a smart-home IoT hardware company (hubs, sensors, plugs, lighting,
climate, water and security devices, plus the Grow Cloud subscription). **All company data is synthetic.**

The whole dataset ships as Parquet files and is queried in the visitor's browser by DuckDB-WASM, so the site is fully
static: no servers, logins or credentials. Open it from any computer or phone with a modern browser.

## What's in it
- **Overview** with KPIs and *What the platform caught*: SQL rules that detect business problems in the data on load
  and write them up in plain English (promo quality, launch cannibalisation, account churn, stock-outs, a change-point
  scan for channel margin, low stock, best first-order bundle).
- Sales · Products · Customers (cohorts, CAC) · Accounts (reorder health) · Grow Cloud (MRR, churn) · Promotions ·
  Inventory · Channel P&L (contribution after fees, fulfilment and freight).
- **SQL Lab**: query everything yourself, export CSV.
- **How it's built**: architecture, data dictionary and 12 reconciliation checks run live in the browser.
- **One-file theming** (`site/assets/theme.js`): Grow light, Grow Night and a white-label example.

## Layout
```
generator/generate.py   seeded simulator → site/data/*.parquet + manifest.json
site/                   the static site (index.html, assets/, data/)
scripts/check_leaks.sh  fails if any real client name, system, key or id appears anywhere
netlify.toml            publish site/, cache headers
```

## Regenerate the data
```bash
python3 -m venv .venv && .venv/bin/pip install duckdb numpy pandas pyarrow
.venv/bin/python generator/generate.py
./scripts/check_leaks.sh
```

## Run locally
```bash
python3 -m http.server 8765 --directory site
```
Then open http://localhost:8765. Opening `index.html` directly from disk won't work, because browsers block
`file://` fetches of the data files.

## Deploy
Every push to `main` runs the leak check and publishes `site/` to GitHub Pages (`.github/workflows/pages.yml`).
Any other static host works too: Netlify can use `netlify.toml` (publish dir `site`, no build command).

## Planted stories (what the findings should detect)
1. SPRING25 (Apr 14–27 2025): orders roughly doubled, margin fell, and the customers it brought rarely returned.
2. Grow Hub Mini launch (Mar 3 2025): took half of hub units and cannibalised the Hub 8; fewer sensors per hub order.
3. Brightline Electronics (retail account): reorder cadence stretching from mid-2025, last order June 2026.
4. Soil Moisture Sensor stock-out (Aug 4 – Sep 14 2025).
5. Amazon fulfilment fee increase (Feb 2026): contribution margin steps down.
6. Low cover on the Air Quality Sensor and Hub Mini at the data cut-off.
7. Hub + 3 sensors starters: higher first-year value and Grow Cloud attach.
