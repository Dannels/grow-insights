/* Grow Insights — SQL Lab (query the data yourself) and How it's built (architecture, data checks, dictionary). */
const GI = window.GI;
const { sql, fmt, esc, card, table } = GI;

const EXAMPLES = [
  ["Revenue by channel and year", `SELECT channel, year(order_date) AS year, ROUND(SUM(revenue)) AS revenue
FROM sales
GROUP BY ALL
ORDER BY channel, year`],
  ["Top 10 products, last 90 days", `SELECT product_name, SUM(units) AS units, ROUND(SUM(revenue)) AS revenue,
       ROUND(SUM(gross_margin) / SUM(revenue) * 100, 1) AS gm_pct
FROM sales
WHERE order_date > (SELECT MAX(order_date) FROM orders) - 90
GROUP BY 1
ORDER BY revenue DESC
LIMIT 10`],
  ["Customers who bought a hub but no sensors", `SELECT COUNT(*) AS customers, ROUND(AVG(lifetime_revenue), 2) AS avg_lifetime_revenue
FROM dtc_customers
WHERE starter_type = 'Hub, fewer than 3 sensors'
  AND customer_id NOT IN (SELECT customer_id FROM sales WHERE category = 'Sensors' AND customer_id IS NOT NULL)`],
  ["Promo vs non-promo first orders", `SELECT COALESCE(first_promo, '(none)') AS first_promo, COUNT(*) AS customers,
       ROUND(AVG(first_revenue), 2) AS first_order, ROUND(AVG(lifetime_revenue), 2) AS lifetime_value
FROM dtc_customers
GROUP BY 1
ORDER BY customers DESC`],
  ["Day-of-week pattern", `SELECT dayname(order_date) AS day, COUNT(*) AS orders, ROUND(AVG(revenue), 2) AS avg_order
FROM order_summary
WHERE channel = 'Web Store'
GROUP BY 1, isodow(order_date)
ORDER BY isodow(order_date)`],
  ["Amazon fees per unit by month", `SELECT c.month, ROUND(SUM(c.amount) FILTER (WHERE cost_type = 'FBA fulfilment fee')
         / ANY_VALUE(u.units), 2) AS fba_per_unit
FROM channel_costs c
JOIN (SELECT month, SUM(units) AS units FROM sales WHERE channel = 'Amazon' GROUP BY 1) u USING (month)
WHERE c.channel = 'Amazon'
GROUP BY 1 ORDER BY 1`],
];

GI.views.lab = {
  title: "SQL Lab", intro: "The whole dataset is loaded into DuckDB running in this browser tab. Query anything — nothing leaves your machine.", filters: [],
  async html() {
    const cols = await sql(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'main' ORDER BY table_name, ordinal_position`);
    const counts = Object.fromEntries((await Promise.all([...new Set(cols.map(c => c.table_name))].map(async t => [t, (await sql(`SELECT COUNT(*) AS n FROM ${t}`))[0].n]))));
    const sem = ["sales", "order_summary", "first_orders", "dtc_customers"];
    const tables = [...new Set(cols.map(c => c.table_name))].sort((a, b) => (sem.includes(b) - sem.includes(a)) || a.localeCompare(b));
    const short = t => t.replace("TIMESTAMP WITH TIME ZONE", "timestamptz").replace("CHARACTER VARYING", "varchar").toLowerCase();
    this.draft = this.draft || EXAMPLES[0][1];
    return `<div class="lab">
      ${card("Schema", "Click a column to insert it", `<div class="schema">${tables.map((t, i) => `<details ${i < 1 ? "open" : ""}><summary>${t}${sem.includes(t) ? " ★" : ""}<small>${fmt.int(counts[t])}</small></summary><ul>${cols.filter(c => c.table_name === t).map(c => `<li data-c="${esc(c.column_name)}">${esc(c.column_name)}<i>${esc(short(c.data_type))}</i></li>`).join("")}</ul></details>`).join("")}</div><p class="note">★ semantic layer, built in the browser from the raw tables</p>`)}
      <div class="stack">
        ${card("", "", `<div class="chips" id="ex">${EXAMPLES.map((e, i) => `<button type="button" data-i="${i}">${esc(e[0])}</button>`).join("")}</div>
          <textarea class="sql" id="q" spellcheck="false" aria-label="SQL query">${esc(this.draft)}</textarea>
          <div class="lab-bar"><button class="btn primary" id="run" type="button">Run ▸</button><span class="note" style="margin:0">⌘/Ctrl + Enter</span>
            <button class="btn" id="csv" type="button" hidden>Download CSV</button><span class="meta" id="meta"></span></div>
          <div id="out"></div>`)}
      </div></div>`;
  },
  async after() {
    const q = GI.$("#q");
    const run = async () => {
      this.draft = q.value;
      const out = GI.$("#out"), meta = GI.$("#meta");
      meta.textContent = "Running…";
      try {
        const { rows, ms } = await GI.timedSql(q.value);
        this.last = rows;
        const keys = rows.length ? Object.keys(rows[0]) : [];
        const isNum = k => rows.every(r => r[k] == null || typeof r[k] === "number");
        const show = v => (typeof v === "number" ? (Number.isInteger(v) ? fmt.int(v) : v.toLocaleString("en-US", { maximumFractionDigits: 4 })) : v == null ? '<span style="color:var(--faint)">null</span>' : esc(typeof v === "object" ? JSON.stringify(v) : v));
        out.innerHTML = rows.length ? `<div class="scroll">${table(keys.map(k => ({ k, l: esc(k), r: isNum(k), f: show })), rows, { max: 1000 })}</div>` : `<p class="note">No rows.</p>`;
        meta.textContent = `${fmt.int(rows.length)} row${rows.length === 1 ? "" : "s"} · ${ms.toFixed(0)} ms${rows.length > 1000 ? " · showing 1,000" : ""}`;
        GI.$("#csv").hidden = !rows.length;
      } catch (e) { out.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; meta.textContent = ""; GI.$("#csv").hidden = true; }
    };
    GI.$("#run").addEventListener("click", run);
    q.addEventListener("keydown", e => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); }
      if (e.key === "Tab") { e.preventDefault(); q.setRangeText("  ", q.selectionStart, q.selectionEnd, "end"); }
    });
    GI.$("#ex").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { q.value = EXAMPLES[+b.dataset.i][1]; run(); } });
    document.querySelectorAll(".schema li").forEach(li => li.addEventListener("click", () => { q.setRangeText(li.dataset.c, q.selectionStart, q.selectionEnd, "end"); q.focus(); }));
    GI.$("#csv").addEventListener("click", () => {
      const rows = this.last || []; if (!rows.length) return;
      const keys = Object.keys(rows[0]), cell = v => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const blob = new Blob([[keys.join(","), ...rows.map(r => keys.map(k => cell(r[k])).join(","))].join("\n")], { type: "text/csv" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "grow-insights-query.csv" });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    run();
  },
};

// ── data checks: the reconciliation suite, run against the loaded data every time this page opens ──
const CHECKS = [
  ["Order lines tie to orders", "Every order has at least one line, and every line belongs to an order.",
    `SELECT (SELECT COUNT(*) FROM orders WHERE order_id NOT IN (SELECT order_id FROM order_lines)) + (SELECT COUNT(*) FROM order_lines WHERE order_id NOT IN (SELECT order_id FROM orders)) AS bad`],
  ["Semantic layer reconciles to source", "Revenue in the sales table equals net sales less refunds in the raw order lines, to the cent.",
    `SELECT ABS((SELECT SUM(revenue) FROM sales) - (SELECT SUM(net_sales - refund) FROM order_lines)) > 0.01 AS bad`],
  ["Order summary reconciles to line detail", "Order-level revenue rolls up to exactly the line-level total.",
    `SELECT ABS((SELECT SUM(revenue) FROM order_summary) - (SELECT SUM(revenue) FROM sales)) > 0.01 AS bad`],
  ["Every SKU is in the catalog", "No order line references a product that doesn't exist.",
    `SELECT COUNT(*) AS bad FROM order_lines WHERE sku NOT IN (SELECT sku FROM products)`],
  ["Every named order has a customer", "Web Store and B2B orders all link to a customer record (Amazon orders are anonymous by design).",
    `SELECT COUNT(*) AS bad FROM orders WHERE channel <> 'Amazon' AND (customer_id IS NULL OR customer_id NOT IN (SELECT customer_id FROM customers))`],
  ["Returns never exceed units sold", "Returned units are between zero and units sold on every line.",
    `SELECT COUNT(*) AS bad FROM order_lines WHERE returned_units < 0 OR returned_units > units`],
  ["Discounts are sane", "Net sales never exceed gross sales and are never negative.",
    `SELECT COUNT(*) AS bad FROM order_lines WHERE net_sales > gross_sales + 0.005 OR net_sales < 0`],
  ["Nothing sold before launch", "No product sells before its launch date.",
    `SELECT COUNT(*) AS bad FROM sales s JOIN products p USING (sku) WHERE s.order_date < p.launch_date`],
  ["Nothing sold while out of stock", "Weeks with stock-out days carry no sales for that SKU beyond the partial week.",
    `SELECT COUNT(*) AS bad FROM inventory_weekly i JOIN sales s ON s.sku = i.sku AND s.week_start = i.week_start WHERE i.days_out_of_stock = 7`],
  ["Subscriptions belong to hub owners", "Every Grow Cloud subscriber bought a hub or kit first.",
    `SELECT COUNT(*) AS bad FROM subscriptions s WHERE NOT EXISTS (SELECT 1 FROM order_summary o WHERE o.customer_id = s.customer_id AND o.has_hub AND o.order_date <= s.start_date)`],
  ["Channel costs cover every channel-month with sales", "No month of sales is missing its fees and fulfilment costs.",
    `SELECT COUNT(*) AS bad FROM (SELECT DISTINCT month, channel FROM sales) s WHERE NOT EXISTS (SELECT 1 FROM channel_costs c WHERE c.month = s.month AND c.channel = s.channel)`],
  ["No future-dated activity", "No order, subscription or cost is dated after the data cut-off.",
    `SELECT (SELECT COUNT(*) FROM orders WHERE order_date > (SELECT MAX(order_date) FROM orders)) + (SELECT COUNT(*) FROM subscriptions WHERE start_date > (SELECT MAX(order_date) FROM orders)) AS bad`],
];
GI.runChecks = async () => Promise.all(CHECKS.map(async ([name, desc, q]) => {
  const t = performance.now();
  try { const [r] = await sql(q); const bad = Number(r.bad); return { name, desc, ok: !bad, detail: bad ? `${bad} failing` : "", ms: performance.now() - t }; }
  catch (e) { return { name, desc, ok: false, detail: e.message, ms: 0 }; }
}));

const ARCH = () => {
  const c = k => GI.css(k);
  const box = (x, y, w, h, title, lines, accent) => `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${c("surface")}" stroke="${accent ? c("accent") : c("border")}" stroke-width="${accent ? 2 : 1.2}"/>
    <text x="${x + 16}" y="${y + 26}" font-size="14" font-weight="700" fill="${c("text")}">${title}</text>
    ${lines.map((l, i) => `<text x="${x + 16}" y="${y + 48 + i * 18}" font-size="12" fill="${c("muted")}">${l}</text>`).join("")}</g>`;
  const arrow = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c("accent")}" stroke-width="2" marker-end="url(#ah)"/>`;
  return `<svg viewBox="0 0 980 300" role="img" aria-label="Architecture: generator to Parquet to DuckDB-WASM to pages">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c("accent")}"/></marker></defs>
    ${box(10, 30, 210, 120, "Simulator", ["Python, seeded", "3 years of orders, accounts,", "subscriptions, stock, fees", "+ planted business stories"])}
    ${box(260, 30, 200, 120, "Parquet files", ["10 tables, ~2 MB, ZSTD", "served as static files", "from a CDN"])}
    ${box(500, 30, 220, 120, "DuckDB-WASM", ["a full SQL engine running", "in this browser tab", "builds the semantic layer", "on load"], true)}
    ${box(760, 10, 210, 72, "Dashboards", ["Chart.js · one theme file"])}
    ${box(760, 92, 210, 72, "Findings engine", ["SQL rules → plain English"])}
    ${box(760, 174, 210, 72, "SQL Lab + data checks", ["query it yourself"])}
    ${arrow(220, 90, 256, 90)}${arrow(460, 90, 496, 90)}${arrow(720, 70, 756, 46)}${arrow(720, 90, 756, 128)}${arrow(720, 110, 756, 208)}
    <text x="10" y="200" font-size="12" font-weight="700" fill="${c("muted")}" letter-spacing=".06em">IN PRODUCTION THE LEFT SIDE IS REAL:</text>
    <text x="10" y="222" font-size="12" fill="${c("muted")}">Shopify · Amazon SP-API · ERP · 3PLs · QuickBooks → Python loaders → Postgres (views, materialised views,</text>
    <text x="10" y="240" font-size="12" fill="${c("muted")}">scheduled refreshes) → the same pages. This demo swaps the warehouse for files + an in-browser engine so it</text>
    <text x="10" y="258" font-size="12" fill="${c("muted")}">runs anywhere with no servers, logins or credentials.</text>
  </svg>`;
};

GI.views.about = {
  title: "How it's built", intro: "A commerce analytics platform, rebuilt on synthetic data so it can be shown publicly", filters: [],
  async html() {
    const res = await GI.runChecks();
    this.res = res;
    const pass = res.filter(r => r.ok).length;
    const sizes = await Promise.all(GI.TABLES.map(async t => ({ t, n: (await sql(`SELECT COUNT(*) AS n FROM ${t}`))[0].n })));
    const DESC = { orders: "One row per order: date, channel, customer, region, promo code", order_lines: "Line items: SKU, units, gross, discount, net, COGS, returns, refunds",
      customers: "Consumers (DTC) and B2B accounts, with acquisition source, tier and rep", products: "29 SKUs: category, MSRP, unit cost, launch date, kit contents",
      channels: "Web Store, Amazon, Retail Partners, Pro Installers, Distributors", promotions: "Promo codes with dates and discount",
      subscriptions: "Grow Cloud subscriptions: plan, MRR, start and end", channel_costs: "Monthly fees, fulfilment, freight and marketplace ads by channel",
      marketing_spend: "Monthly DTC marketing spend by source", inventory_weekly: "Weekly on-hand, inbound and stock-out days by SKU" };
    return `<div class="grid g-21">
      <div class="stack">
        ${card("Architecture", "", `<div class="diagram">${ARCH()}</div>`)}
        ${card("What this demonstrates", "", `<div class="prose">
          <p>This is a working rebuild of an analytics platform I designed and run for a consumer-products company — the warehouse model, the semantic layer, the reporting pages and the reconciliation tests — re-pointed at a fictional company so it can be shown in public. <b>Grow Computer's numbers here are invented.</b> A seeded simulator generates three years of orders, accounts, subscriptions, stock and channel costs, with realistic seasonality, cohort behaviour and wholesale reorder cycles.</p>
          <h3>Findings, not just charts</h3>
          <p>The simulator plants a handful of business problems — a promotion that bought low-quality customers, a launch that cannibalised the flagship, an account drifting away, a stock-out, a fee change eating marketplace margin. Nothing on the Overview is hard-coded: each card is a SQL rule run against the data on load, with the numbers written into plain-English sentences.</p>
          <h3>One definition of every number</h3>
          <p>Every page reads the same semantic tables (<code>sales</code>, <code>order_summary</code>, <code>first_orders</code>, <code>dtc_customers</code>). Revenue is net of discounts and refunds; COGS excludes restocked returns; contribution is gross margin less each channel's fees, fulfilment and freight. The checks on the right prove the layer ties back to source to the cent.</p>
          <h3>White-label in one file</h3>
          <p>Every colour, font, logo and name comes from <code>theme.js</code>. Try the swatches in the header — the third one rebrands the whole site as a different company.</p>
          <h3>Stack</h3>
          <p>Python (NumPy, pandas, DuckDB) for generation · Parquet · DuckDB-WASM · vanilla JavaScript (no framework, no build step) · Chart.js · static hosting. In production: Python loaders, Postgres with views, materialised views and scheduled refreshes, and API connectors to Shopify, Amazon, the ERP, 3PLs and QuickBooks.</p>
        </div>`)}
      </div>
      <div class="stack">
        ${card("Data checks", "Run in your browser just now, against the loaded data", `<p><span class="badge ${pass === res.length ? "" : "bad"}">${pass === res.length ? "✓" : "✕"} ${pass} of ${res.length} checks passing</span></p>
          <ul class="checks">${res.map(r => `<li><span class="${r.ok ? "ok" : "no"}">${r.ok ? "✓" : "✕"}</span><div>${esc(r.name)}<small>${esc(r.desc)}${r.detail ? ` — <b>${esc(r.detail)}</b>` : ""}</small></div><small class="num">${r.ms.toFixed(0)} ms</small></li>`).join("")}</ul>`)}
        ${card("Data dictionary", "Raw tables, loaded from Parquet", table([{ k: "t", l: "Table", f: v => `<code>${v}</code>` }, { k: "n", l: "Rows", r: 1, f: fmt.int }, { k: "d", l: "What's in it", f: v => `<span style="white-space:normal">${esc(v)}</span>` }], sizes.map(s => ({ ...s, d: DESC[s.t] }))))}
      </div></div>`;
  },
};
