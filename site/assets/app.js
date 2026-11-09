/* Grow Insights — shell: in-browser database, filters, routing, theming and shared components. */
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

const GI = (window.GI = { views: {}, state: { period: "L52W", group: "All" } });
const $ = (s, el = document) => el.querySelector(s);
GI.$ = $;

// ── database ─────────────────────────────────────────────────────────────
export const TABLES = ["orders", "order_lines", "customers", "products", "channels", "promotions", "subscriptions",
  "channel_costs", "marketing_spend", "inventory_weekly"];

// Semantic layer: the views every page reads. Revenue = net of discounts and refunds; COGS excludes returned
// (restocked) units; contribution = gross margin less channel costs.
const SEMANTIC = `
CREATE OR REPLACE TABLE sales AS
SELECT o.order_id, o.order_date, CAST(date_trunc('week', o.order_date) AS DATE) AS week_start,
       CAST(date_trunc('month', o.order_date) AS DATE) AS month, o.channel, ch.channel_group, o.customer_id, o.region,
       o.promo_code, l.sku, p.product_name, p.category, CAST(l.units AS INTEGER) AS units,
       CAST(l.returned_units AS INTEGER) AS returned_units, l.gross_sales, l.discount, l.net_sales, l.refund,
       l.net_sales - l.refund AS revenue,
       l.cogs * (l.units - l.returned_units) / l.units AS cogs,
       (l.net_sales - l.refund) - l.cogs * (l.units - l.returned_units) / l.units AS gross_margin
FROM order_lines l JOIN orders o USING (order_id) JOIN products p USING (sku) JOIN channels ch USING (channel);

CREATE OR REPLACE TABLE order_summary AS
SELECT o.order_id, o.order_date, o.channel, ch.channel_group, o.customer_id, o.region, o.promo_code, o.shipping_charged,
       SUM(l.net_sales - l.refund) AS revenue, SUM(l.discount) AS discount, CAST(SUM(l.units) AS INTEGER) AS units,
       CAST(SUM(CASE WHEN p.category = 'Sensors' THEN l.units ELSE 0 END + l.units * p.included_sensors) AS INTEGER) AS sensors,
       BOOL_OR(p.is_hub) AS has_hub
FROM orders o JOIN order_lines l USING (order_id) JOIN products p USING (sku) JOIN channels ch USING (channel)
GROUP BY ALL;

CREATE OR REPLACE TABLE first_orders AS
SELECT DISTINCT ON (customer_id) customer_id, order_id, order_date AS first_date, promo_code AS first_promo,
       revenue AS first_revenue, has_hub, sensors,
       CASE WHEN has_hub AND sensors >= 3 THEN 'Hub + 3 or more sensors'
            WHEN has_hub THEN 'Hub, fewer than 3 sensors' ELSE 'No hub' END AS starter_type
FROM order_summary WHERE channel = 'Web Store'
ORDER BY customer_id, order_date, order_id;

CREATE OR REPLACE TABLE dtc_customers AS
SELECT f.customer_id, f.first_date, f.first_promo, f.starter_type, f.first_revenue, c.acquisition_source, c.region,
       MIN(o.order_date) FILTER (WHERE o.order_id <> f.order_id) AS second_date,
       CAST(COUNT(*) AS INTEGER) AS orders, SUM(o.revenue) AS lifetime_revenue,
       SUM(o.revenue) FILTER (WHERE o.order_date < f.first_date + 365) AS revenue_12m,
       COALESCE(ANY_VALUE(s.subscribed), false) AS subscribed
FROM first_orders f JOIN order_summary o USING (customer_id) JOIN customers c USING (customer_id)
LEFT JOIN (SELECT DISTINCT customer_id, true AS subscribed FROM subscriptions) s USING (customer_id)
GROUP BY f.customer_id, f.first_date, f.first_promo, f.starter_type, f.first_revenue, c.acquisition_source, c.region;
`;

let conn;
async function boot() {
  const msg = t => { const el = $("#boot-msg"); if (el) el.textContent = t; };
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  await db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } });
  conn = await db.connect();
  msg("Loading ten tables of Grow Computer data…");
  const base = new URL("data/", location.href).href;
  // the manifest's version changes whenever the data is regenerated, so browsers and CDNs never serve stale files
  const manifest = await (await fetch(base + "manifest.json", { cache: "no-store" })).json();
  GI.manifest = manifest;
  await Promise.all(TABLES.map(t => db.registerFileURL(`${t}.parquet`, `${base}${t}.parquet?v=${manifest.version}`, duckdb.DuckDBDataProtocol.HTTP, false)));
  // materialise into memory once: every query after this is local
  for (const t of TABLES) await conn.query(`CREATE TABLE ${t} AS SELECT * FROM read_parquet('${t}.parquet')`);
  msg("Building the semantic layer…");
  for (const stmt of SEMANTIC.split(";").map(s => s.trim()).filter(Boolean)) await conn.query(stmt);
  GI.db = db;
}

function plain(v) {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v && typeof v === "object" && typeof v.valueOf === "function" && typeof v.valueOf() === "bigint") return Number(v.valueOf());
  return v;
}
export async function sql(q) {
  const res = await conn.query(q);
  const fields = res.schema.fields;
  const dateCols = new Set(fields.filter(f => String(f.type).startsWith("Date")).map(f => f.name));
  const tsCols = new Set(fields.filter(f => String(f.type).startsWith("Timestamp")).map(f => f.name));
  return res.toArray().map(r => {
    const o = r.toJSON();
    for (const k in o) {
      let v = plain(o[k]);
      if ((dateCols.has(k) || tsCols.has(k)) && typeof v === "number") v = new Date(v).toISOString().slice(0, 10);
      o[k] = v;
    }
    return o;
  });
}
GI.sql = sql;
GI.TABLES = TABLES;
GI.timedSql = async q => { const t = performance.now(); const rows = await sql(q); return { rows, ms: performance.now() - t }; };

// ── formatting ───────────────────────────────────────────────────────────
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export const fmt = {
  money(v, d) { if (v == null || isNaN(v)) return "–"; const a = Math.abs(v), s = v < 0 ? "−" : "";
    if (d === "full") return s + "$" + nf0.format(a);
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
    if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(0)}K`;
    if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
    return `${s}$${a.toFixed(a < 100 && a % 1 ? 2 : 0)}`; },
  int: v => (v == null || isNaN(v) ? "–" : nf0.format(v)),
  pct: (v, d = 1) => (v == null || !isFinite(v) ? "–" : `${(v * 100).toFixed(d)}%`),
  delta(cur, prev) { if (!prev) return `<span class="flat">new</span>`; const c = cur / prev - 1;
    const cls = Math.abs(c) < 0.005 ? "flat" : c > 0 ? "up" : "down";
    return `<span class="${cls}">${c > 0 ? "▲" : c < 0 ? "▼" : ""} ${Math.abs(c * 100).toFixed(1)}%</span>`; },
  pp(cur, prev) { const c = (cur - prev) * 100; const cls = Math.abs(c) < 0.05 ? "flat" : c > 0 ? "up" : "down";
    return `<span class="${cls}">${c > 0 ? "+" : c < 0 ? "−" : ""}${Math.abs(c).toFixed(1)} pts</span>`; },
  date: s => new Date(s + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
  mon: s => new Date(s + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
};
GI.fmt = fmt;
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
GI.esc = esc;

// ── periods (anchored to the last day of data, so the demo never goes stale) ──
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
GI.addDays = addDays;
export const PERIODS = { L13W: "Last 13 weeks", L52W: "Last 52 weeks", YTD: "Year to date", FY25: "2025", FY24: "2024" };
export function period(key = GI.state.period) {
  const end = GI.asOf;
  let start, e = end, label = PERIODS[key];
  if (key === "L13W") start = addDays(end, -90);
  else if (key === "YTD") start = end.slice(0, 4) + "-01-01";
  else if (key === "FY25") { start = "2025-01-01"; e = "2025-12-31"; }
  else if (key === "FY24") { start = "2024-01-01"; e = "2024-12-31"; }
  else start = addDays(end, -363);
  const pStart = addDays(start, -364), pEnd = addDays(e, -364);
  return { start, end: e, pStart, pEnd, label, hasPrior: pStart >= "2024-01-01" };
}
GI.period = period;
export const groupWhere = (alias = "") => GI.state.group === "All" ? "" : ` AND ${alias}channel_group = '${GI.state.group}'`;
GI.groupWhere = groupWhere;

// ── components ───────────────────────────────────────────────────────────
GI.css = name => getComputedStyle(document.documentElement).getPropertyValue("--" + name).trim();
GI.series = i => GI.theme.series[i % GI.theme.series.length];

export function card(title, sub, body, extra = "") {
  return `<section class="card">${title ? `<div class="card-h"><div><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ""}</div>${extra}</div>` : ""}${body}</section>`;
}
GI.card = card;
GI.chartBox = (id, cls = "") => `<div class="chart ${cls}"><canvas id="${id}"></canvas></div>`;

const charts = new Set();
export function chart(id, cfg) {
  const el = document.getElementById(id);
  if (!el) return;
  const grid = GI.css("grid"), muted = GI.css("muted"), body = GI.css("body");
  Chart.defaults.font.family = body; Chart.defaults.color = muted; Chart.defaults.borderColor = grid;
  cfg.options = cfg.options || {};
  const o = cfg.options;
  o.responsive = true; o.maintainAspectRatio = false; o.animation = o.animation ?? { duration: 450 };
  o.interaction = o.interaction || { mode: "index", intersect: false };
  o.plugins = o.plugins || {};
  o.plugins.legend = Object.assign({ position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "rectRounded", padding: 14, font: { size: 11 } } }, o.plugins.legend || {});
  o.plugins.tooltip = Object.assign({ backgroundColor: GI.css("text"), titleColor: GI.css("surface"), bodyColor: GI.css("surface"), padding: 10, cornerRadius: 8, boxPadding: 4 }, o.plugins.tooltip || {});
  if (cfg.type !== "doughnut") {
    o.scales = o.scales || {};
    for (const ax of ["x", "y"]) {
      o.scales[ax] = Object.assign({ grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { padding: 6, font: { size: 11 } } }, o.scales[ax] || {});
    }
    o.scales.x.grid = Object.assign({ display: false }, o.scales.x.grid);
  }
  const c = new Chart(el, cfg);
  charts.add(c);
  return c;
}
GI.chart = chart;
GI.moneyTick = { callback: v => fmt.money(v) };
GI.pctTick = { callback: v => `${Math.round(v * 100)}%` };
GI.moneyTip = { callbacks: { label: c => ` ${c.dataset.label}: ${fmt.money(c.parsed.y ?? c.parsed, "full")}` } };

// Sortable table. cols: [{k, l, f (formatter), r (right-align), w (bar width source)}]
export function table(cols, rows, { id, foot, max, sort } = {}) {
  const tid = id || "t" + Math.random().toString(36).slice(2, 8);
  const body = rows.slice(0, max || rows.length);
  const barMax = {};
  cols.filter(c => c.bar).forEach(c => (barMax[c.k] = Math.max(...rows.map(r => Math.abs(r[c.k]) || 0), 1)));
  const td = (c, r) => {
    const v = r[c.k];
    let h = c.f ? c.f(v, r) : esc(v);
    if (c.bar) h = `<span class="bar" style="width:${Math.max(2, (Math.abs(v) / barMax[c.k]) * 60)}px"></span>${h}`;
    return `<td class="${c.r ? "r" : ""}">${h}</td>`;
  };
  const html = `<div class="tw"><table class="t" id="${tid}"><thead><tr>${cols.map((c, i) => `<th data-i="${i}" class="${c.r ? "r" : ""}" ${sort && sort === c.k ? 'aria-sort="descending"' : ""}>${c.l}</th>`).join("")}</tr></thead>
    <tbody>${body.map(r => `<tr>${cols.map(c => td(c, r)).join("")}</tr>`).join("")}</tbody>
    ${foot ? `<tfoot><tr>${cols.map(c => `<td class="${c.r ? "r" : ""}">${foot[c.k] != null ? (c.f ? c.f(foot[c.k], foot) : esc(foot[c.k])) : ""}</td>`).join("")}</tr></tfoot>` : ""}</table></div>`;
  setTimeout(() => {
    const t = document.getElementById(tid);
    if (!t) return;
    t.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
      const c = cols[+th.dataset.i], asc = th.getAttribute("aria-sort") === "descending";
      t.querySelectorAll("th").forEach(x => x.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", asc ? "ascending" : "descending");
      const sorted = [...rows].sort((a, b) => { const x = a[c.k], y = b[c.k]; const r = typeof x === "number" || typeof y === "number" ? (x ?? -Infinity) - (y ?? -Infinity) : String(x ?? "").localeCompare(String(y ?? "")); return asc ? r : -r; });
      t.tBodies[0].innerHTML = sorted.slice(0, max || sorted.length).map(r => `<tr>${cols.map(cc => td(cc, r)).join("")}</tr>`).join("");
    }));
  });
  return html;
}
GI.table = table;

GI.kpi = (label, value, delta, sparkId) => `<div class="kpi"><div class="l">${label}</div><div class="v num">${value}</div><div class="d">${delta || "&nbsp;"}</div>${sparkId ? `<canvas id="${sparkId}"></canvas>` : ""}</div>`;
GI.spark = (id, values, color) => {
  const el = document.getElementById(id); if (!el) return;
  const c = new Chart(el, { type: "line", data: { labels: values.map((_, i) => i), datasets: [{ data: values, borderColor: color || GI.series(0), borderWidth: 1.6, pointRadius: 0, tension: .35, fill: { target: "origin", above: (color || GI.series(0)) + "18" } }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } } } });
  charts.add(c);
};
GI.seg = (id, options, current) => `<div class="seg" id="${id}" role="group">${options.map(o => `<button type="button" data-v="${esc(o)}" aria-pressed="${o === current}">${esc(o)}</button>`).join("")}</div>`;
GI.onSeg = (id, fn) => { const el = document.getElementById(id); if (!el) return; el.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; el.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); fn(b.dataset.v); }); };

// ── theming ──────────────────────────────────────────────────────────────
function applyTheme(key) {
  const t = window.GI_THEMES[key] || window.GI_THEMES.grow;
  GI.theme = t; GI.themeKey = key;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty("--" + k, v);
  root.style.setProperty("--body", t.fonts.body); root.style.setProperty("--display", t.fonts.display);
  root.style.colorScheme = t.mode; root.dataset.theme = key;
  const logo = $("#brand-logo");
  if (t.logo) { logo.src = t.logo; logo.hidden = false; $("#brand .mark")?.remove(); }
  else { logo.hidden = true; if (!$("#brand .mark")) logo.insertAdjacentHTML("afterend", `<span class="mark"></span>`); $("#brand .mark").textContent = t.mark; }
  $("#brand-name").textContent = t.company; $("#brand-product").textContent = t.product;
  document.title = `${t.company} ${t.product}`;
  document.querySelectorAll("#themes button").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === key));
  try { localStorage.setItem("gi-theme", key); } catch (e) { /* storage unavailable */ }
}
function themePicker() {
  $("#themes").innerHTML = Object.entries(window.GI_THEMES).map(([k, t]) =>
    `<button type="button" data-k="${k}" title="${esc(t.label)}" aria-label="${esc(t.label)} theme" style="background:${t.vars.grad.includes("gradient") ? t.vars.grad : t.vars.accent}${t.mode === "dark" ? `;box-shadow:inset 0 0 0 5px ${t.vars.bg}` : ""}"></button>`).join("");
  $("#themes").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { applyTheme(b.dataset.k); render(); } });
}

// ── routing ──────────────────────────────────────────────────────────────
export const NAV = [["overview", "Overview"], ["sales", "Sales"], ["products", "Products"], ["customers", "Customers"],
  ["accounts", "Accounts"], ["cloud", "Grow Cloud"], ["promotions", "Promotions"], ["inventory", "Inventory"],
  ["margin", "Channel P&L"], ["lab", "SQL Lab"], ["about", "How it's built"]];
GI.NAV = NAV; GI.PERIODS = PERIODS;
const route = () => (location.hash.replace(/^#\/?/, "").split("?")[0] || "overview");

function filterBar(v) {
  const f = v.filters || [];
  const parts = [`<h1>${esc(v.title)}<small>${v.intro || ""}</small></h1>`];
  if (f.includes("period")) parts.push(`<span class="fl">Period</span>${GI.seg("f-period", Object.values(PERIODS), PERIODS[GI.state.period])}`);
  if (f.includes("group")) parts.push(`<span class="fl">Channel</span>${GI.seg("f-group", ["All", "DTC", "Marketplace", "B2B"], GI.state.group)}`);
  $("#filters").innerHTML = parts.join("");
  GI.onSeg("f-period", label => { GI.state.period = Object.keys(PERIODS).find(k => PERIODS[k] === label); render(); });
  GI.onSeg("f-group", g => { GI.state.group = g; render(); });
}

let renderSeq = 0;
export async function render() {
  const seq = ++renderSeq;
  charts.forEach(c => c.destroy()); charts.clear();
  const r = route();
  const v = GI.views[r] || GI.views.overview;
  $("#tabs").innerHTML = NAV.map(([k, l]) => `<a href="#/${k}" ${k === r ? 'aria-current="page"' : ""} class="${k === "lab" ? "lab" : ""}">${l}</a>`).join("");
  filterBar(v);
  const el = $("#view");
  el.innerHTML = `<div class="grid g3">${'<div class="card"><div class="skel"></div></div>'.repeat(3)}</div>`;
  try {
    const html = await v.html();
    if (seq !== renderSeq) return;
    el.innerHTML = html;
    await v.after?.();
  } catch (e) {
    console.error(e);
    if (seq === renderSeq) el.innerHTML = card("Something went wrong", "", `<div class="err">${esc(e.message || e)}</div>`);
  }
}
GI.render = render;

// ── start ────────────────────────────────────────────────────────────────
let saved = "grow";
try { saved = localStorage.getItem("gi-theme") || "grow"; } catch (e) { /* storage unavailable */ }
themePicker(); applyTheme(saved);
await import("./views.js");
await import("./lab.js");
try {
  await boot();
  const [m] = await sql(`SELECT CAST(MAX(order_date) AS VARCHAR) AS d, COUNT(*) AS n FROM orders`);
  GI.asOf = m.d;
  $("#asof").innerHTML = `<i></i>Data through ${fmt.date(m.d)} · ${fmt.int(m.n)} orders`;
  window.addEventListener("hashchange", render);
  render();
} catch (e) {
  console.error(e);
  $("#view").innerHTML = card("Couldn't start the in-browser database", "This demo runs DuckDB-WASM in your browser; it needs a recent Chrome, Edge, Firefox or Safari.", `<div class="err">${esc(e.message || e)}</div>`);
}
