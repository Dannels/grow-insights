/* Grow Insights — dashboard pages and the findings engine.
   Every number is a live DuckDB query over the semantic tables (sales, order_summary, first_orders, dtc_customers). */
const GI = window.GI;
const { sql, fmt, esc, card, table, chart, kpi } = GI;
const P = () => GI.period();
const inCur = p => `order_date BETWEEN DATE '${p.start}' AND DATE '${p.end}'`;
const inPrev = p => `order_date BETWEEN DATE '${p.pStart}' AND DATE '${p.pEnd}'`;
const D = s => `DATE '${s}'`;
const memo = {};
const once = (k, fn) => (memo[k] ??= fn());
const gm = r => (r.rev ? r.gm / r.rev : null);
const ratio = (a, b) => (b ? a / b : null);
const priorNote = p => (p.hasPrior ? `vs ${fmt.date(p.pStart)} – ${fmt.date(p.pEnd)}` : "no prior-year data before 2024");
const deltaOr = (p, cur, prev) => (p.hasPrior ? `${fmt.delta(cur, prev)} vs prior year` : "");
const link = (route, text) => `<a href="#/${route}">${text}</a>`;

// ═════════════════════════ shared analyses (filter-independent, cached) ═════════════════════════

GI.promoStats = () => once("promo", async () => {
  const rows = await sql(`
    WITH daily AS (SELECT order_date AS d, COUNT(DISTINCT order_id) AS orders, SUM(revenue) AS rev, SUM(gross_margin) AS gm,
                          SUM(discount) AS disc, SUM(gross_sales) AS gross
                   FROM sales WHERE channel = 'Web Store' GROUP BY 1),
         p AS (SELECT * FROM promotions WHERE promo_code <> 'WELCOME10' AND start_date <= ${D(GI.asOf)}),
         base AS (SELECT p.promo_code,
                         SUM(orders) FILTER (WHERE d BETWEEN p.start_date AND p.end_date) AS orders,
                         SUM(orders) FILTER (WHERE d BETWEEN p.start_date - 28 AND p.start_date - 1) / 28.0 AS base_opd,
                         SUM(rev) FILTER (WHERE d BETWEEN p.start_date AND p.end_date) AS rev,
                         SUM(rev) FILTER (WHERE d BETWEEN p.start_date - 28 AND p.start_date - 1) / 28.0 AS base_rpd,
                         SUM(gm) FILTER (WHERE d BETWEEN p.start_date AND p.end_date) AS gm,
                         SUM(disc) FILTER (WHERE d BETWEEN p.start_date AND p.end_date) AS disc,
                         SUM(gm) FILTER (WHERE d BETWEEN p.start_date - 28 AND p.start_date - 1) /
                           SUM(rev) FILTER (WHERE d BETWEEN p.start_date - 28 AND p.start_date - 1) AS base_gm_pct
                  FROM p JOIN daily ON d BETWEEN p.start_date - 28 AND p.end_date GROUP BY 1),
         cust AS (SELECT p.promo_code,
                         COUNT(*) FILTER (WHERE c.first_promo = p.promo_code) AS new_customers,
                         AVG(CASE WHEN c.second_date <= c.first_date + 180 THEN 1 ELSE 0 END)
                           FILTER (WHERE c.first_promo = p.promo_code AND c.first_date <= ${D(GI.asOf)} - 180) AS repeat_180,
                         AVG(CASE WHEN c.second_date <= c.first_date + 180 THEN 1 ELSE 0 END)
                           FILTER (WHERE (c.first_promo IS NULL OR c.first_promo = 'WELCOME10')
                                     AND c.first_date BETWEEN p.start_date - 90 AND p.end_date + 90
                                     AND c.first_date <= ${D(GI.asOf)} - 180) AS base_repeat_180
                  FROM p JOIN dtc_customers c ON c.first_date BETWEEN p.start_date - 90 AND p.end_date + 90 GROUP BY 1)
    SELECT p.promo_code, p.promo_name, CAST(p.start_date AS VARCHAR) AS start_date, CAST(p.end_date AS VARCHAR) AS end_date,
           p.discount_pct, date_diff('day', p.start_date, p.end_date) + 1 AS days, base.*, cust.new_customers, cust.repeat_180, cust.base_repeat_180
    FROM p JOIN base USING (promo_code) LEFT JOIN cust USING (promo_code) ORDER BY p.start_date`);
  return rows.map(r => ({ ...r, opd: r.orders / r.days, lift: r.orders / r.days / r.base_opd - 1, gm_pct: r.gm / r.rev,
    rev_lift: r.rev / r.days / r.base_rpd - 1, repeat_index: r.repeat_180 != null && r.base_repeat_180 ? r.repeat_180 / r.base_repeat_180 : null }));
});

GI.accountHealth = () => once("acct", async () => {
  const a = D(GI.asOf);
  const rows = await sql(`
    WITH o AS (SELECT customer_id, order_date, revenue,
                      LAG(order_date) OVER (PARTITION BY customer_id ORDER BY order_date, order_id) AS prev_date
               FROM order_summary WHERE channel_group = 'B2B'),
         g AS (SELECT customer_id, CAST(COUNT(*) AS INTEGER) AS orders, CAST(MIN(order_date) AS VARCHAR) AS first_order,
                      CAST(MAX(order_date) AS VARCHAR) AS last_order, MEDIAN(date_diff('day', prev_date, order_date)) AS cadence,
                      date_diff('day', MAX(order_date), ${a}) AS since,
                      COALESCE(SUM(revenue) FILTER (WHERE order_date > ${a} - 365), 0) AS t12,
                      COALESCE(SUM(revenue) FILTER (WHERE order_date BETWEEN ${a} - 729 AND ${a} - 365), 0) AS p12,
                      SUM(revenue) AS lifetime
               FROM o GROUP BY 1)
    SELECT c.customer_name AS name, c.customer_type AS type, c.account_tier AS tier, c.region, c.sales_rep AS rep, g.*
    FROM g JOIN customers c USING (customer_id) ORDER BY t12 DESC`);
  return rows.map(r => {
    const ratio = r.cadence ? r.since / r.cadence : 0;
    let status = ["On track", "good"];
    if (r.since > 180 || (r.orders >= 6 && ratio > 3)) status = ["Lapsed", "bad"];
    else if (r.orders >= 4 && ratio > 1.8) status = ["At risk", "bad"];
    else if (r.orders >= 4 && ratio > 1.25) status = ["Overdue", "warn"];
    if (r.since <= 180 && GI.addDays(r.first_order, 150) > GI.asOf) status = ["New", "info"];
    return { ...r, overdue_ratio: ratio, status: status[0], status_cls: status[1], change: r.p12 ? r.t12 / r.p12 - 1 : null };
  });
});

GI.inventoryPosition = () => once("inv", async () => sql(`
  WITH last AS (SELECT MAX(week_start) AS w FROM inventory_weekly),
       rate AS (SELECT sku, SUM(units) / 8.0 AS weekly_units FROM sales WHERE order_date > ${D(GI.asOf)} - 56 GROUP BY sku)
  SELECT p.sku, p.product_name, p.category, i.on_hand_units, i.inbound_units, r.weekly_units,
         i.on_hand_units / NULLIF(r.weekly_units, 0) AS cover_weeks, i.on_hand_units * p.base_unit_cost AS stock_value
  FROM inventory_weekly i JOIN last ON i.week_start = last.w JOIN products p USING (sku) LEFT JOIN rate r USING (sku)
  ORDER BY cover_weeks`));

GI.stockouts = () => once("oos", async () => sql(`
  WITH ep AS (SELECT sku, MIN(week_start) AS s, MAX(week_start) + 6 AS e, CAST(SUM(days_out_of_stock) AS INTEGER) AS days
              FROM inventory_weekly WHERE days_out_of_stock > 0 GROUP BY sku),
       around AS (SELECT ep.sku, SUM(x.units) / 16.0 AS wk_units, SUM(x.revenue) / NULLIF(SUM(x.units), 0) AS price
                  FROM ep JOIN sales x ON x.sku = ep.sku
                   AND (x.order_date BETWEEN ep.s - 56 AND ep.s - 1 OR x.order_date BETWEEN ep.e + 1 AND ep.e + 56)
                  GROUP BY 1)
  SELECT ep.sku, p.product_name, CAST(ep.s AS VARCHAR) AS start_week, CAST(ep.e AS VARCHAR) AS end_week, ep.days,
         around.wk_units, around.price, around.wk_units * ep.days / 7.0 AS lost_units,
         around.wk_units * ep.days / 7.0 * around.price AS lost_revenue
  FROM ep JOIN products p USING (sku) JOIN around USING (sku) ORDER BY lost_revenue DESC`));

GI.channelMonthly = () => once("cm", async () => sql(`
  WITH s AS (SELECT month, channel, SUM(revenue) AS rev, SUM(cogs) AS cogs, SUM(gross_margin) AS gm, SUM(units) AS units
             FROM sales GROUP BY ALL),
       c AS (SELECT month, channel, SUM(amount) AS cost,
                    SUM(amount) FILTER (WHERE cost_type = 'FBA fulfilment fee') AS fba
             FROM channel_costs GROUP BY ALL)
  SELECT CAST(s.month AS VARCHAR) AS month, s.channel, s.rev, s.cogs, s.gm, s.units, COALESCE(c.cost, 0) AS cost, c.fba,
         s.gm - COALESCE(c.cost, 0) AS contribution
  FROM s LEFT JOIN c USING (month, channel) ORDER BY 1, 2`));

GI.starterStats = () => once("starter", async () => sql(`
  SELECT starter_type, COUNT(*) AS customers, AVG(first_revenue) AS first_order,
         AVG(revenue_12m) FILTER (WHERE first_date <= ${D(GI.asOf)} - 365) AS value_12m,
         AVG(CASE WHEN second_date <= first_date + 365 THEN 1 ELSE 0 END) FILTER (WHERE first_date <= ${D(GI.asOf)} - 365) AS repeat_12m,
         AVG(CASE WHEN subscribed THEN 1 ELSE 0 END) AS sub_rate
  FROM dtc_customers GROUP BY 1 ORDER BY value_12m DESC`));

GI.hubLaunch = () => once("hub", async () => {
  const [l] = await sql(`SELECT sku, product_name, CAST(launch_date AS VARCHAR) AS launch FROM products
                         WHERE category = 'Hubs & Controllers' AND launch_date > DATE '2024-01-01' AND launch_date <= ${D(GI.asOf)} - 365
                         ORDER BY launch_date DESC LIMIT 1`);
  if (!l) return null;
  const L = D(l.launch);
  const skus = await sql(`SELECT sku, product_name,
      SUM(units) FILTER (WHERE order_date BETWEEN ${L} - 365 AND ${L} - 1) AS u_before, SUM(units) FILTER (WHERE order_date BETWEEN ${L} AND ${L} + 364) AS u_after,
      SUM(revenue) FILTER (WHERE order_date BETWEEN ${L} - 365 AND ${L} - 1) AS r_before, SUM(revenue) FILTER (WHERE order_date BETWEEN ${L} AND ${L} + 364) AS r_after
    FROM sales WHERE category = 'Hubs & Controllers' GROUP BY ALL`);
  const [tot] = await sql(`SELECT SUM(revenue) FILTER (WHERE order_date BETWEEN ${L} - 365 AND ${L} - 1) AS before,
      SUM(revenue) FILTER (WHERE order_date BETWEEN ${L} AND ${L} + 364) AS after FROM sales`);
  const [att] = await sql(`SELECT AVG(sensors) FILTER (WHERE order_date BETWEEN ${L} - 365 AND ${L} - 1) AS before,
      AVG(sensors) FILTER (WHERE order_date BETWEEN ${L} AND ${L} + 364) AS after
    FROM order_summary WHERE channel = 'Web Store' AND has_hub`);
  const flagship = skus.filter(s => s.sku !== l.sku).sort((a, b) => b.r_before - a.r_before)[0];
  const nw = skus.find(s => s.sku === l.sku) || {};
  const hubU0 = skus.reduce((a, s) => a + (s.u_before || 0), 0), hubU1 = skus.reduce((a, s) => a + (s.u_after || 0), 0);
  const hubR0 = skus.reduce((a, s) => a + (s.r_before || 0), 0), hubR1 = skus.reduce((a, s) => a + (s.r_after || 0), 0);
  return { launch: l, flagship, nw, total: tot, attach: att, hubU0, hubU1, hubR0, hubR1, share: nw.u_after / hubU1 };
});

GI.channelShift = () => once("shift", async () => {
  // change-point scan: for each channel and each month in the last 18, compare contribution margin in the
  // 6 full months before it with up to 6 from it onwards (at least 3); report each channel's biggest step down.
  const rows = await GI.channelMonthly();
  const full = [...new Set(rows.map(r => r.month))].sort().filter(m => m.slice(0, 7) < GI.asOf.slice(0, 7));
  const out = [];
  for (const ch of [...new Set(rows.map(r => r.channel))]) {
    const by = Object.fromEntries(rows.filter(r => r.channel === ch).map(r => [r.month, r]));
    const sum = (ms, k) => ms.reduce((a, m) => a + ((by[m] || {})[k] || 0), 0);
    let best = null;
    for (let i = Math.max(6, full.length - 18); i <= full.length - 3; i++) {
      const before = full.slice(i - 6, i), after = full.slice(i, i + 6);
      const b = sum(before, "contribution") / sum(before, "rev"), a = sum(after, "contribution") / sum(after, "rev");
      if (!best || a - b < best.after - best.before) best = { channel: ch, month: full[i], before: b, after: a,
        fbaBefore: sum(before, "fba") / sum(before, "units"), fbaAfter: sum(after, "fba") / sum(after, "units"), months: after.length };
    }
    if (best) out.push(best);
  }
  return out.sort((x, y) => (x.after - x.before) - (y.after - y.before));
});

// ═════════════════════════ findings ═════════════════════════
GI.findings = () => once("findings", async () => {
  const [promos, accts, oos, inv, starter, hub, shift] = await Promise.all([GI.promoStats(), GI.accountHealth(), GI.stockouts(),
    GI.inventoryPosition(), GI.starterStats(), GI.hubLaunch(), GI.channelShift()]);
  const F = [];
  const pr = promos.filter(p => p.repeat_index != null && p.repeat_index < .8 && p.lift > .5).sort((a, b) => a.repeat_index - b.repeat_index)[0];
  if (pr) F.push({ key: "promo", tone: "bad", tag: "Promotion", route: "promotions",
    title: `${pr.promo_code} ${pr.lift >= .9 ? "doubled orders" : `lifted orders ${fmt.pct(pr.lift, 0)}`}, then the customers vanished`,
    big: `${fmt.pct(pr.repeat_180, 0)} came back`,
    text: `${fmt.date(pr.start_date)}: orders ran ${fmt.pct(pr.lift, 0)} above the run-rate and brought in ${fmt.int(pr.new_customers)} new customers, but gross margin fell from ${fmt.pct(pr.base_gm_pct, 0)} to ${fmt.pct(pr.gm_pct, 0)} and only ${fmt.pct(pr.repeat_180, 0)} reordered within 180 days (vs ${fmt.pct(pr.base_repeat_180, 0)} normally).` });
  if (hub && hub.flagship) {
    const chg = hub.flagship.r_after / hub.flagship.r_before - 1, coChg = hub.total.after / hub.total.before - 1;
    F.push({ key: "hub", tone: chg < coChg - .1 ? "warn" : "info", tag: "Product launch", route: "products",
      title: `${hub.nw.product_name} took ${fmt.pct(hub.share, 0)} of hub sales — mostly from the ${hub.flagship.product_name}`,
      big: `${hub.flagship.product_name.replace("Grow ", "")} ${chg >= 0 ? "+" : "−"}${fmt.pct(Math.abs(chg), 0)} · company +${fmt.pct(coChg, 0)}`,
      text: `In the year after launch, hub units rose ${fmt.pct(hub.hubU1 / hub.hubU0 - 1, 0)} but ${hub.flagship.product_name} revenue moved ${chg >= 0 ? "+" : "−"}${fmt.pct(Math.abs(chg), 0)} while the business grew ${fmt.pct(coChg, 0)}. Sensors per hub order fell from ${hub.attach.before.toFixed(1)} to ${hub.attach.after.toFixed(1)}.` });
  }
  const risk = accts.filter(a => a.status === "At risk" || a.status === "Lapsed").sort((a, b) => b.p12 + b.t12 - (a.p12 + a.t12))[0];
  if (risk) F.push({ key: "acct", tone: "bad", tag: "Account health", route: "accounts",
    title: `${risk.name} has gone quiet`, big: `${fmt.int(risk.since)} days since last order`,
    text: `A ${risk.type.toLowerCase().replace(/s$/, "")} that used to reorder every ~${Math.round(risk.cadence)} days. Last order ${fmt.date(risk.last_order)}; trailing-12-month sales ${fmt.money(risk.t12)} vs ${fmt.money(risk.p12)} the year before.` });
  const o = oos[0];
  if (o) F.push({ key: "oos", tone: "bad", tag: "Inventory", route: "inventory",
    title: `${o.product_name} stock-out cost about ${fmt.money(o.lost_revenue)}`, big: `${Math.round(o.days / 7)} weeks out of stock`,
    text: `Nothing to sell from ${fmt.date(o.start_week)} to ${fmt.date(o.end_week)}. At the run-rate either side (${fmt.int(o.wk_units)} units a week) that's roughly ${fmt.int(o.lost_units)} units of missed sales.` });
  const s = shift[0];
  if (s && s.after - s.before < -0.02) F.push({ key: "shift", tone: "warn", tag: "Channel margin", route: "margin",
    title: `${s.channel} contribution margin stepped down from ${fmt.mon(s.month).replace(" ", " '")}`,
    big: `${fmt.pct(s.before, 0)} → ${fmt.pct(s.after, 0)}`,
    text: `Found by scanning every channel for the sharpest sustained change: the ${s.months} months from then vs the 6 before.` +
      (s.fbaBefore && s.fbaAfter ? ` Fulfilment fees per unit went from $${s.fbaBefore.toFixed(2)} to $${s.fbaAfter.toFixed(2)} (+${fmt.pct(s.fbaAfter / s.fbaBefore - 1, 0)}) and prices didn't move with them.` : "") });
  const low = inv.filter(i => i.cover_weeks != null && i.cover_weeks < 3 && i.weekly_units > 5);
  if (low.length) F.push({ key: "low", tone: "warn", tag: "Reorder now", route: "inventory",
    title: `${low.length === 1 ? low[0].product_name + " is" : low.length + " products are"} under 3 weeks of cover`,
    big: `${low[0].cover_weeks.toFixed(1)} weeks left`,
    text: `${low.map(i => `${i.product_name} (${fmt.int(i.on_hand_units)} on hand, selling ${fmt.int(i.weekly_units)}/week)`).join("; ")}. Lead time on new stock is about 8 weeks.` });
  const top = starter[0], rest = starter.find(x => x.starter_type === "Hub, fewer than 3 sensors");
  if (top && rest) F.push({ key: "starter", tone: "good", tag: "Opportunity", route: "customers",
    title: `Hub + 3 sensors starters are your best customers`, big: `${(top.value_12m / rest.value_12m).toFixed(1)}× first-year value`,
    text: `Customers whose first order is a hub with 3+ sensors spend ${fmt.money(top.value_12m)} in year one (vs ${fmt.money(rest.value_12m)}) and subscribe to Grow Cloud ${(top.sub_rate / rest.sub_rate).toFixed(1)}× as often. Worth bundling.` });
  return F;
});
const findingCard = f => `<a class="finding" href="#/${f.route}"><span class="tag ${f.tone}">${f.tag}</span><h3>${esc(f.title)}</h3><div class="big num">${esc(f.big)}</div><p>${esc(f.text)}</p><span class="go">See the analysis →</span></a>`;
const callout = async key => { const f = (await GI.findings()).find(x => x.key === key); return f ? `<div class="callout"><span class="tag ${f.tone}">${f.tag}</span><div><b>${esc(f.title)}.</b> ${esc(f.text)}</div></div>` : ""; };

// ═════════════════════════ Overview ═════════════════════════
GI.views.overview = {
  title: "Overview", intro: "Grow Computer at a glance — revenue, margin, customers and Grow Cloud, with what the platform flagged",
  filters: ["period", "group"],
  async html() {
    const p = P(), g = GI.groupWhere();
    const [k] = await sql(`SELECT SUM(revenue) FILTER (WHERE ${inCur(p)}) AS rev, SUM(revenue) FILTER (WHERE ${inPrev(p)}) AS prev_rev,
        SUM(gross_margin) FILTER (WHERE ${inCur(p)}) AS gm, SUM(gross_margin) FILTER (WHERE ${inPrev(p)}) AS prev_gm,
        COUNT(DISTINCT order_id) FILTER (WHERE ${inCur(p)}) AS orders, COUNT(DISTINCT order_id) FILTER (WHERE ${inPrev(p)}) AS prev_orders,
        SUM(units) FILTER (WHERE ${inCur(p)}) AS units, SUM(units) FILTER (WHERE ${inPrev(p)}) AS prev_units
      FROM sales WHERE (${inCur(p)} OR ${inPrev(p)}) ${g}`);
    const [c] = await sql(`SELECT COUNT(*) FILTER (WHERE first_date BETWEEN ${D(p.start)} AND ${D(p.end)}) AS cur,
        COUNT(*) FILTER (WHERE first_date BETWEEN ${D(p.pStart)} AND ${D(p.pEnd)}) AS prev FROM dtc_customers`);
    const [m] = await sql(`SELECT SUM(mrr) FILTER (WHERE start_date <= ${D(p.end)} AND (end_date IS NULL OR end_date > ${D(p.end)})) AS cur,
        SUM(mrr) FILTER (WHERE start_date <= ${D(p.pEnd)} AND (end_date IS NULL OR end_date > ${D(p.pEnd)})) AS prev FROM subscriptions`);
    this.k = k; this.p = p;
    const F = await GI.findings();
    return `<div class="kpis">
        ${kpi("Revenue", fmt.money(k.rev), deltaOr(p, k.rev, k.prev_rev), "sp-rev")}
        ${kpi("Gross margin", fmt.pct(k.gm / k.rev), p.hasPrior ? `${fmt.pp(k.gm / k.rev, k.prev_gm / k.prev_rev)} vs prior year` : "", "sp-gm")}
        ${kpi("Orders", fmt.int(k.orders), deltaOr(p, k.orders, k.prev_orders), "sp-ord")}
        ${kpi("Avg order value", fmt.money(k.rev / k.orders), deltaOr(p, k.rev / k.orders, k.prev_rev / k.prev_orders), "sp-aov")}
        ${kpi("New DTC customers", fmt.int(c.cur), deltaOr(p, c.cur, c.prev), "sp-new")}
        ${kpi("Grow Cloud MRR", fmt.money(m.cur), p.hasPrior ? `${fmt.delta(m.cur, m.prev)} vs a year earlier` : "", "sp-mrr")}
      </div>
      <div class="findings-h"><h2>What the platform caught</h2><span>Detected by SQL on load — not hand-written. Click through for the analysis.</span></div>
      <div class="findings">${F.map(findingCard).join("")}</div>
      <div class="grid g-21" style="margin-top:16px">
        ${card("Weekly revenue", `${p.label} ${priorNote(p)}`, GI.chartBox("ov-weekly", "tall"))}
        ${card("Channel mix", `Revenue by channel, ${p.label.toLowerCase()}`, GI.chartBox("ov-mix", "tall"))}
      </div>`;
  },
  async after() {
    const p = this.p, g = GI.groupWhere();
    const w = await sql(`SELECT CAST(date_diff('day', ${D(p.start)}, order_date) / 7 AS INTEGER) AS i,
        SUM(revenue) AS rev, SUM(gross_margin) AS gm, COUNT(DISTINCT order_id) AS orders, MIN(order_date) AS d
      FROM sales WHERE ${inCur(p)} ${g} GROUP BY 1 ORDER BY 1`);
    const pw = await sql(`SELECT CAST(date_diff('day', ${D(p.pStart)}, order_date) / 7 AS INTEGER) AS i, SUM(revenue) AS rev
      FROM sales WHERE ${inPrev(p)} ${g} GROUP BY 1 ORDER BY 1`);
    const nw = await sql(`SELECT CAST(date_diff('day', ${D(p.start)}, first_date) / 7 AS INTEGER) AS i, COUNT(*) AS n
      FROM dtc_customers WHERE first_date BETWEEN ${D(p.start)} AND ${D(p.end)} GROUP BY 1 ORDER BY 1`);
    const mrr = await sql(`SELECT m, SUM(mrr) FILTER (WHERE start_date <= m AND (end_date IS NULL OR end_date > m)) AS v
      FROM subscriptions, (SELECT CAST(range AS DATE) AS m FROM range(${D(p.start)}, ${D(p.end)} + 1, INTERVAL 7 DAY)) GROUP BY m ORDER BY m`);
    const full = w.filter(r => GI.addDays(r.d, 6) <= p.end || r === w[w.length - 1]);
    GI.spark("sp-rev", full.map(r => r.rev)); GI.spark("sp-gm", full.map(r => r.gm / r.rev), GI.series(1));
    GI.spark("sp-ord", full.map(r => r.orders)); GI.spark("sp-aov", full.map(r => r.rev / r.orders), GI.series(2));
    GI.spark("sp-new", nw.map(r => r.n), GI.series(1)); GI.spark("sp-mrr", mrr.map(r => r.v), GI.series(2));
    const pmap = Object.fromEntries(pw.map(r => [r.i, r.rev]));
    chart("ov-weekly", { type: "line", data: { labels: w.map(r => fmt.date(GI.addDays(p.start, r.i * 7)).replace(/, \d{4}/, "")),
      datasets: [{ label: p.label, data: w.map(r => r.rev), borderColor: GI.series(0), backgroundColor: GI.series(0) + "22", fill: true, tension: .3, pointRadius: 0, borderWidth: 2 },
        ...(p.hasPrior ? [{ label: "Prior year", data: w.map(r => pmap[r.i] ?? null), borderColor: GI.css("faint"), borderDash: [4, 4], tension: .3, pointRadius: 0, borderWidth: 1.5 }] : [])] },
      options: { scales: { y: { ticks: GI.moneyTick, beginAtZero: true }, x: { ticks: { maxTicksLimit: 10, autoSkip: true } } }, plugins: { tooltip: GI.moneyTip } } });
    const mix = await sql(`SELECT channel, SUM(revenue) AS rev FROM sales WHERE ${inCur(p)} ${g} GROUP BY 1 ORDER BY 2 DESC`);
    chart("ov-mix", { type: "doughnut", data: { labels: mix.map(r => r.channel), datasets: [{ data: mix.map(r => r.rev), backgroundColor: mix.map((_, i) => GI.series(i)), borderColor: GI.css("surface"), borderWidth: 3 }] },
      options: { cutout: "62%", plugins: { tooltip: { callbacks: { label: c => ` ${c.label}: ${fmt.money(c.parsed, "full")} (${fmt.pct(c.parsed / mix.reduce((a, r) => a + r.rev, 0))})` } } } } });
  },
};

// ═════════════════════════ Sales ═════════════════════════
GI.views.sales = {
  title: "Sales", intro: "Revenue by channel, region and category · revenue is net of discounts and refunds", filters: ["period", "group"],
  async html() {
    const p = P(), g = GI.groupWhere();
    const by = async dim => (await sql(`SELECT ${dim} AS k, SUM(revenue) FILTER (WHERE ${inCur(p)}) AS rev, SUM(revenue) FILTER (WHERE ${inPrev(p)}) AS prev,
        SUM(gross_margin) FILTER (WHERE ${inCur(p)}) AS gm, COUNT(DISTINCT order_id) FILTER (WHERE ${inCur(p)}) AS orders,
        SUM(units) FILTER (WHERE ${inCur(p)}) AS units, SUM(discount) FILTER (WHERE ${inCur(p)}) AS disc
      FROM sales WHERE (${inCur(p)} OR ${inPrev(p)}) ${g} GROUP BY 1 ORDER BY rev DESC NULLS LAST`)).map(r => ({ ...r, gm_pct: gm(r), aov: ratio(r.rev, r.orders), chg: r.prev ? r.rev / r.prev - 1 : null }));
    const [ch, reg, cat] = await Promise.all([by("channel"), by("region"), by("category")]);
    const tot = ch.reduce((a, r) => a + (r.rev || 0), 0);
    ch.forEach(r => (r.share = r.rev / tot));
    const chg = (v, r) => (r.prev ? fmt.delta(r.rev, r.prev) : "–");
    const cols = name => [{ k: "k", l: name }, { k: "rev", l: "Revenue", r: 1, f: v => fmt.money(v), bar: 1 }, { k: "chg", l: "vs PY", r: 1, f: chg },
      { k: "gm_pct", l: "GM %", r: 1, f: v => fmt.pct(v) }, { k: "orders", l: "Orders", r: 1, f: fmt.int }, { k: "aov", l: "AOV", r: 1, f: v => fmt.money(v) }];
    return `<div class="stack">
      ${card("Monthly revenue by channel", "All history · the shape of the business: Q4 peaks, spring garden season, Prime Day in July", GI.chartBox("s-monthly", "tall"))}
      ${card("By channel", `${p.label} ${priorNote(p)}`, table([...cols("Channel"), { k: "share", l: "Share", r: 1, f: v => fmt.pct(v) }, { k: "disc", l: "Discounts", r: 1, f: v => fmt.money(v) }], ch, { sort: "rev" }))}
      <div class="grid g2">
        ${card("By region", p.label, table(cols("Region"), reg, { sort: "rev" }))}
        ${card("By category", p.label, table(cols("Category"), cat, { sort: "rev" }))}
      </div></div>`;
  },
  async after() {
    const rows = await sql(`SELECT CAST(month AS VARCHAR) AS m, channel, SUM(revenue) AS rev FROM sales WHERE month < date_trunc('month', ${D(GI.asOf)}) ${GI.groupWhere()} GROUP BY 1, 2 ORDER BY 1`);
    const months = [...new Set(rows.map(r => r.m))], chans = [...new Set(rows.map(r => r.channel))];
    const order = ["Web Store", "Amazon", "Retail Partners", "Pro Installers", "Distributors"].filter(c => chans.includes(c));
    chart("s-monthly", { type: "bar", data: { labels: months.map(fmt.mon), datasets: order.map((c, i) => ({ label: c, data: months.map(m => rows.find(r => r.m === m && r.channel === c)?.rev ?? 0), backgroundColor: GI.series(i), borderRadius: 3, borderSkipped: false })) },
      options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: GI.moneyTick } }, plugins: { tooltip: GI.moneyTip } } });
  },
};

// ═════════════════════════ Products ═════════════════════════
GI.views.products = {
  title: "Products", intro: "29 SKUs across hubs, sensors, plugs, lighting, climate, water and security", filters: ["period", "group"],
  async html() {
    const p = P(), g = GI.groupWhere();
    const skus = (await sql(`SELECT sku, product_name AS name, category,
        SUM(units) FILTER (WHERE ${inCur(p)}) AS units, SUM(revenue) FILTER (WHERE ${inCur(p)}) AS rev, SUM(revenue) FILTER (WHERE ${inPrev(p)}) AS prev,
        SUM(gross_margin) FILTER (WHERE ${inCur(p)}) AS gm, SUM(returned_units) FILTER (WHERE ${inCur(p)}) AS ret
      FROM sales WHERE (${inCur(p)} OR ${inPrev(p)}) ${g} GROUP BY ALL ORDER BY rev DESC NULLS LAST`))
      .map(r => ({ ...r, gm_pct: gm(r), ret_rate: ratio(r.ret, r.units), chg: r.prev ? r.rev / r.prev - 1 : null }));
    const hub = await GI.hubLaunch();
    return `${await callout("hub")}
      <div class="grid g-21">
        ${card("Hub family by quarter", "Revenue by hub product (bars) and sensors attached per DTC hub order (line)", GI.chartBox("p-hub", "tall"))}
        ${card("New launch ramp", "Weekly units of the newest product since launch", GI.chartBox("p-launch", "tall"))}
      </div>
      <div style="margin-top:16px">${card("SKU performance", `${p.label} ${priorNote(p)} · click a column to sort`, `<div class="scroll">${table([
        { k: "name", l: "Product" }, { k: "category", l: "Category" }, { k: "units", l: "Units", r: 1, f: fmt.int },
        { k: "rev", l: "Revenue", r: 1, f: v => fmt.money(v), bar: 1 }, { k: "chg", l: "vs PY", r: 1, f: (v, r) => (r.prev ? fmt.delta(r.rev, r.prev) : r.rev ? '<span class="pill info">new</span>' : "–") },
        { k: "gm_pct", l: "GM %", r: 1, f: v => fmt.pct(v) }, { k: "ret_rate", l: "Return rate", r: 1, f: v => fmt.pct(v) }], skus, { sort: "rev" })}</div>`)}</div>
      ${hub ? `<p class="note">Launch comparison window: ${fmt.date(GI.addDays(hub.launch.launch, -365))} – ${fmt.date(hub.launch.launch)} vs the 52 weeks after.</p>` : ""}`;
  },
  async after() {
    const q = await sql(`SELECT CAST(date_trunc('quarter', order_date) AS VARCHAR) AS q, product_name AS name, SUM(revenue) AS rev
      FROM sales WHERE category IN ('Hubs & Controllers', 'Kits') AND order_date < date_trunc('quarter', ${D(GI.asOf)}) GROUP BY 1, 2 ORDER BY 1`);
    const att = await sql(`SELECT CAST(date_trunc('quarter', order_date) AS VARCHAR) AS q, AVG(sensors) AS s FROM order_summary
      WHERE channel = 'Web Store' AND has_hub AND order_date < date_trunc('quarter', ${D(GI.asOf)}) GROUP BY 1 ORDER BY 1`);
    const qs = [...new Set(q.map(r => r.q))], names = [...new Set(q.map(r => r.name))];
    const qLabel = s => `Q${Math.floor((+s.slice(5, 7) - 1) / 3) + 1} ${s.slice(2, 4)}`;
    chart("p-hub", { data: { labels: qs.map(qLabel), datasets: [
      ...names.map((n, i) => ({ type: "bar", label: n.replace(/ \(.*\)/, ""), data: qs.map(x => q.find(r => r.q === x && r.name === n)?.rev ?? 0), backgroundColor: GI.series(i), stack: "s", borderRadius: 3, yAxisID: "y" })),
      { type: "line", label: "Sensors per hub order", data: qs.map(x => att.find(r => r.q === x)?.s ?? null), borderColor: GI.css("text"), backgroundColor: GI.css("text"), tension: .3, pointRadius: 3, borderWidth: 2, yAxisID: "y2" }] },
      options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: GI.moneyTick }, y2: { position: "right", grid: { display: false }, border: { display: false }, ticks: { callback: v => v.toFixed(1) }, min: 0 } },
        plugins: { tooltip: { callbacks: { label: c => c.dataset.yAxisID === "y2" ? ` ${c.dataset.label}: ${c.parsed.y.toFixed(2)}` : ` ${c.dataset.label}: ${fmt.money(c.parsed.y, "full")}` } } } } });
    const [nw] = await sql(`SELECT sku, product_name, CAST(launch_date AS VARCHAR) AS d FROM products WHERE launch_date <= ${D(GI.asOf)} ORDER BY launch_date DESC LIMIT 1`);
    const ramp = await sql(`SELECT CAST(week_start AS VARCHAR) AS w, SUM(units) AS u, SUM(revenue) AS rev FROM sales WHERE sku = '${nw.sku}' AND week_start < date_trunc('week', ${D(GI.asOf)}) GROUP BY 1 ORDER BY 1`);
    chart("p-launch", { type: "bar", data: { labels: ramp.map(r => fmt.date(r.w).replace(/, \d{4}/, "")), datasets: [{ label: `${nw.product_name} — units / week`, data: ramp.map(r => r.u), backgroundColor: GI.series(1), borderRadius: 3 }] },
      options: { scales: { x: { ticks: { maxTicksLimit: 8 } } } } });
  },
};

// ═════════════════════════ Customers (DTC) ═════════════════════════
GI.views.customers = {
  title: "Customers", intro: "Direct-to-consumer customers: acquisition, retention and what a good first order looks like", filters: ["period"],
  async html() {
    const p = P();
    const [k] = await sql(`SELECT COUNT(*) FILTER (WHERE first_date BETWEEN ${D(p.start)} AND ${D(p.end)}) AS new_c,
        COUNT(*) FILTER (WHERE first_date BETWEEN ${D(p.pStart)} AND ${D(p.pEnd)}) AS prev_new,
        AVG(first_revenue) FILTER (WHERE first_date BETWEEN ${D(p.start)} AND ${D(p.end)}) AS first_aov FROM dtc_customers`);
    const [s] = await sql(`SELECT SUM(spend) FILTER (WHERE month BETWEEN date_trunc('month', ${D(p.start)}) AND ${D(p.end)}) AS cur,
        SUM(spend) FILTER (WHERE month BETWEEN date_trunc('month', ${D(p.pStart)}) AND ${D(p.pEnd)}) AS prev FROM marketing_spend`);
    const [r] = await sql(`SELECT COUNT(DISTINCT customer_id) AS buyers, COUNT(DISTINCT customer_id) FILTER (WHERE n > 1) AS repeaters
      FROM (SELECT customer_id, COUNT(*) AS n FROM order_summary WHERE channel = 'Web Store' AND ${inCur(p)} GROUP BY 1)`);
    const [ret] = await sql(`SELECT COUNT(*) FILTER (WHERE first_date < ${D(p.start)}) AS returning FROM (SELECT DISTINCT o.customer_id, c.first_date FROM order_summary o JOIN dtc_customers c USING (customer_id) WHERE o.channel = 'Web Store' AND ${inCur(p)})`);
    const st = await GI.starterStats();
    return `<div class="kpis">
        ${kpi("New customers", fmt.int(k.new_c), deltaOr(p, k.new_c, k.prev_new))}
        ${kpi("Blended CAC", fmt.money(s.cur / k.new_c), p.hasPrior ? `${fmt.delta(s.cur / k.new_c, s.prev / k.prev_new)} vs prior year` : "")}
        ${kpi("First-order value", fmt.money(k.first_aov), "average first DTC order")}
        ${kpi("Returning buyers", fmt.int(ret.returning), `${fmt.pct(ret.returning / r.buyers, 0)} of buyers this period`)}
        ${kpi("Ordered 2+ times", fmt.pct(r.repeaters / r.buyers), "of buyers, within the period")}
      </div>
      ${await callout("starter")}
      ${card("What a great first order looks like", "DTC customers grouped by their first order · first-year value uses customers who started at least 12 months ago",
        table([{ k: "starter_type", l: "First order" }, { k: "customers", l: "Customers", r: 1, f: fmt.int }, { k: "first_order", l: "First order", r: 1, f: v => fmt.money(v) },
          { k: "value_12m", l: "First-year value", r: 1, f: v => fmt.money(v), bar: 1 }, { k: "repeat_12m", l: "Reordered in 12 mo", r: 1, f: v => fmt.pct(v, 0) },
          { k: "sub_rate", l: "Grow Cloud subscriber", r: 1, f: v => fmt.pct(v, 0) }], st))}
      <div style="margin-top:16px">${card("Repeat purchase by cohort", "Share of each month's new DTC customers who have placed a second order, by months since their first", '<div class="tw" id="c-cohort"><div class="skel"></div></div>')}</div>
      <div class="grid g2" style="margin-top:16px">
        ${card("Customer acquisition cost by source", "Monthly marketing spend ÷ new customers from that source", GI.chartBox("c-cac"))}
        ${card("New customers by source", "Monthly, all history", GI.chartBox("c-src"))}
      </div>`;
  },
  async after() {
    const K = 12;
    const rows = await sql(`SELECT CAST(date_trunc('month', first_date) AS VARCHAR) AS cohort, COUNT(*) AS n,
        ${Array.from({ length: K }, (_, i) => `COUNT(*) FILTER (WHERE date_diff('day', first_date, second_date) / 30.44 < ${i + 1}) AS m${i + 1}`).join(", ")}
      FROM dtc_customers GROUP BY 1 ORDER BY 1`);
    const [lo, hi] = GI.theme.heat;
    const mix = (a, b, t) => { const h = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16)); const A = h(a), B = h(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",")})`; };
    const asOfM = GI.asOf.slice(0, 7);
    const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
    const body = rows.filter(r => r.cohort.slice(0, 7) < asOfM).map(r => {
      const maxK = monthsBetween(r.cohort, GI.asOf) - 1;
      const cells = Array.from({ length: K }, (_, i) => {
        const k = i + 1; if (k > maxK) return `<td></td>`;
        const v = r[`m${k}`] / r.n, t = Math.min(1, v / .45);
        return `<td style="background:${mix(lo, hi, t)};color:${t > .55 ? "#fff" : "inherit"}">${(v * 100).toFixed(0)}%</td>`;
      }).join("");
      return `<tr><td class="c0">${fmt.mon(r.cohort)}</td><td class="r">${fmt.int(r.n)}</td>${cells}</tr>`;
    }).join("");
    GI.$("#c-cohort").innerHTML = `<table class="t heat"><thead><tr><th>Cohort</th><th class="r">Customers</th>${Array.from({ length: K }, (_, i) => `<th class="r">M${i + 1}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
    const cac = await sql(`WITH n AS (SELECT CAST(date_trunc('month', first_date) AS DATE) AS month, acquisition_source AS source, COUNT(*) AS n FROM dtc_customers GROUP BY ALL)
      SELECT CAST(s.month AS VARCHAR) AS m, s.source, s.spend / n.n AS cac, n.n FROM marketing_spend s JOIN n USING (month, source)
      WHERE s.month < date_trunc('month', ${D(GI.asOf)}) ORDER BY 1`);
    const months = [...new Set(cac.map(r => r.m))], srcs = ["Paid Social", "Paid Search", "Affiliates", "Organic & Email"];
    chart("c-cac", { type: "line", data: { labels: months.map(fmt.mon), datasets: srcs.map((s, i) => ({ label: s, data: months.map(m => cac.find(r => r.m === m && r.source === s)?.cac ?? null), borderColor: GI.series(i), backgroundColor: GI.series(i), tension: .3, pointRadius: 0, borderWidth: 2 })) },
      options: { scales: { y: { ticks: { callback: v => "$" + v } } }, plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: $${c.parsed.y.toFixed(2)}` } } } } });
    chart("c-src", { type: "bar", data: { labels: months.map(fmt.mon), datasets: srcs.map((s, i) => ({ label: s, data: months.map(m => cac.find(r => r.m === m && r.source === s)?.n ?? 0), backgroundColor: GI.series(i), borderRadius: 2 })) },
      options: { scales: { x: { stacked: true }, y: { stacked: true } } } });
  },
};

// ═════════════════════════ Accounts (B2B) ═════════════════════════
GI.views.accounts = {
  title: "Accounts", intro: "Retail partners, pro installers and distributors — who's growing, who's due, who's gone quiet", filters: [],
  async html() {
    const a = await GI.accountHealth();
    const n = s => a.filter(x => x.status === s).length;
    const t12 = a.reduce((s, x) => s + x.t12, 0), p12 = a.reduce((s, x) => s + x.p12, 0);
    this.rows = a;
    return `<div class="kpis">
        ${kpi("B2B revenue, last 12 months", fmt.money(t12), `${fmt.delta(t12, p12)} vs the 12 months before`)}
        ${kpi("Accounts on track", fmt.int(n("On track")), `of ${a.length} accounts`)}
        ${kpi("Overdue", fmt.int(n("Overdue")), "past their usual reorder interval")}
        ${kpi("At risk or lapsed", fmt.int(n("At risk") + n("Lapsed")), fmt.money(a.filter(x => ["At risk", "Lapsed"].includes(x.status)).reduce((s, x) => s + x.p12, 0)) + " of prior-year sales")}
        ${kpi("New accounts", fmt.int(n("New")), "first order in the last 150 days")}
      </div>
      ${await callout("acct")}
      <div class="grid g-12">
        ${card("Reorder cadence", "Days between orders for the account flagged above — the gap keeps widening", GI.chartBox("a-gap", "tall"))}
        ${card("Account health", "Status compares days since the last order with the account's own median reorder interval", `<div class="scroll">${table([
          { k: "name", l: "Account" }, { k: "type", l: "Type" }, { k: "rep", l: "Rep" },
          { k: "status", l: "Status", f: (v, r) => `<span class="pill ${r.status_cls}">${v}</span>` },
          { k: "since", l: "Days since", r: 1, f: fmt.int }, { k: "cadence", l: "Usual gap", r: 1, f: v => (v ? Math.round(v) + " d" : "–") },
          { k: "t12", l: "Last 12 mo", r: 1, f: v => fmt.money(v), bar: 1 }, { k: "change", l: "vs prior 12", r: 1, f: (v, r) => (r.p12 ? fmt.delta(r.t12, r.p12) : '<span class="pill info">new</span>') },
          { k: "orders", l: "Orders", r: 1, f: fmt.int }], a, { sort: "t12" })}</div>`)}
      </div>`;
  },
  async after() {
    const risk = this.rows.filter(x => ["At risk", "Lapsed"].includes(x.status)).sort((a, b) => b.p12 + b.t12 - (a.p12 + a.t12))[0];
    if (!risk) return;
    const o = await sql(`SELECT CAST(order_date AS VARCHAR) AS d, revenue, date_diff('day', LAG(order_date) OVER (ORDER BY order_date), order_date) AS gap
      FROM order_summary o JOIN customers c USING (customer_id) WHERE c.customer_name = '${risk.name.replace(/'/g, "''")}' ORDER BY order_date`);
    chart("a-gap", { data: { labels: o.map(r => fmt.date(r.d)), datasets: [
      { type: "bar", label: "Order value", data: o.map(r => r.revenue), backgroundColor: GI.series(0) + "88", borderRadius: 3, yAxisID: "y" },
      { type: "line", label: "Days since previous order", data: o.map(r => r.gap), borderColor: GI.css("bad"), backgroundColor: GI.css("bad"), pointRadius: 2.5, tension: .25, yAxisID: "y2" }] },
      options: { plugins: { title: { display: true, text: risk.name, align: "start", color: GI.css("text"), font: { weight: 600 } } },
        scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { ticks: GI.moneyTick }, y2: { position: "right", grid: { display: false }, border: { display: false }, ticks: { callback: v => v + " d" } } } } });
  },
};

// ═════════════════════════ Grow Cloud ═════════════════════════
GI.views.cloud = {
  title: "Grow Cloud", intro: "Subscription software attached to the hardware: Plus ($4.99/mo) and Pro ($9.99/mo)", filters: [],
  async html() {
    const a = D(GI.asOf);
    const [k] = await sql(`SELECT SUM(mrr) FILTER (WHERE start_date <= ${a} AND (end_date IS NULL OR end_date > ${a})) AS mrr,
        COUNT(*) FILTER (WHERE start_date <= ${a} AND (end_date IS NULL OR end_date > ${a})) AS subs,
        SUM(mrr) FILTER (WHERE start_date <= ${a} - 365 AND (end_date IS NULL OR end_date > ${a} - 365)) AS mrr_ly,
        COUNT(*) FILTER (WHERE end_date BETWEEN ${a} - 90 AND ${a}) AS churned_90,
        COUNT(*) FILTER (WHERE start_date <= ${a} - 90 AND (end_date IS NULL OR end_date > ${a} - 90)) AS base_90,
        COUNT(*) FILTER (WHERE plan = 'Grow Cloud Pro' AND start_date <= ${a} AND (end_date IS NULL OR end_date > ${a})) AS pro
      FROM subscriptions`);
    const [att] = await sql(`SELECT AVG(CASE WHEN subscribed THEN 1 ELSE 0 END) AS rate FROM dtc_customers WHERE starter_type <> 'No hub' AND first_date > ${a} - 365`);
    const churn = 1 - Math.pow(1 - k.churned_90 / k.base_90, 1 / 3);
    return `<div class="kpis">
        ${kpi("MRR", fmt.money(k.mrr), `${fmt.delta(k.mrr, k.mrr_ly)} vs a year ago`)}
        ${kpi("ARR run-rate", fmt.money(k.mrr * 12), "MRR × 12")}
        ${kpi("Active subscribers", fmt.int(k.subs), `${fmt.pct(k.pro / k.subs, 0)} on Pro`)}
        ${kpi("Monthly churn", fmt.pct(churn), "average of the last 3 months")}
        ${kpi("Hub attach rate", fmt.pct(att.rate), "new hub customers (last 12 mo) who subscribe")}
      </div>
      <div class="grid g2">
        ${card("MRR by plan", "Month-end recurring revenue", GI.chartBox("g-mrr", "tall"))}
        ${card("Subscriber movement", "New subscriptions vs cancellations each month", GI.chartBox("g-move", "tall"))}
      </div>`;
  },
  async after() {
    const rows = await sql(`WITH m AS (SELECT CAST(range AS DATE) AS m FROM range(DATE '2024-01-01', ${D(GI.asOf)}, INTERVAL 1 MONTH))
      SELECT CAST(m.m AS VARCHAR) AS m,
        SUM(mrr) FILTER (WHERE plan = 'Grow Cloud Plus' AND start_date <= m.m + INTERVAL 1 MONTH - INTERVAL 1 DAY AND (end_date IS NULL OR end_date > m.m + INTERVAL 1 MONTH - INTERVAL 1 DAY)) AS plus,
        SUM(mrr) FILTER (WHERE plan = 'Grow Cloud Pro' AND start_date <= m.m + INTERVAL 1 MONTH - INTERVAL 1 DAY AND (end_date IS NULL OR end_date > m.m + INTERVAL 1 MONTH - INTERVAL 1 DAY)) AS pro,
        COUNT(*) FILTER (WHERE date_trunc('month', start_date) = m.m) AS new_s, COUNT(*) FILTER (WHERE date_trunc('month', end_date) = m.m) AS lost
      FROM m, subscriptions GROUP BY 1 ORDER BY 1`);
    const L = rows.map(r => fmt.mon(r.m));
    chart("g-mrr", { type: "line", data: { labels: L, datasets: [
      { label: "Grow Cloud Plus", data: rows.map(r => r.plus || 0), borderColor: GI.series(0), backgroundColor: GI.series(0) + "55", fill: true, pointRadius: 0, tension: .3 },
      { label: "Grow Cloud Pro", data: rows.map(r => r.pro || 0), borderColor: GI.series(1), backgroundColor: GI.series(1) + "55", fill: "-1", pointRadius: 0, tension: .3 }] },
      options: { scales: { y: { stacked: true, ticks: GI.moneyTick } }, plugins: { tooltip: GI.moneyTip } } });
    chart("g-move", { type: "bar", data: { labels: L, datasets: [
      { label: "New", data: rows.map(r => r.new_s), backgroundColor: GI.series(1), borderRadius: 3 },
      { label: "Cancelled", data: rows.map(r => -r.lost), backgroundColor: GI.css("bad") + "bb", borderRadius: 3 }] },
      options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => Math.abs(v) } } }, plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${fmt.int(Math.abs(c.parsed.y))}` } } } } });
  },
};

// ═════════════════════════ Promotions ═════════════════════════
GI.views.promotions = {
  title: "Promotions", intro: "Did the discount pay for itself? Lift, margin and whether the customers it bought came back", filters: [],
  async html() {
    const pr = await GI.promoStats();
    this.promos = pr;
    const worst = (await GI.findings()).find(f => f.key === "promo");
    this.sel = this.sel || (worst ? worst.title.split(" ")[0] : pr[0].promo_code);
    return `${await callout("promo")}
      ${card("Promotion scorecard", "Web Store only · baseline = the 28 days before each promo · repeat = second order within 180 days, vs non-promo customers who started within 90 days of the promo",
        table([{ k: "promo_code", l: "Code" }, { k: "start_date", l: "Dates", f: (v, r) => `${fmt.date(v).replace(/, \d{4}/, "")} – ${fmt.date(r.end_date)}` },
          { k: "discount_pct", l: "Off", r: 1, f: v => fmt.pct(v, 0) }, { k: "lift", l: "Order lift", r: 1, f: v => `<span class="${v > 0 ? "up" : "down"}">${v > 0 ? "+" : ""}${fmt.pct(v, 0)}</span>` },
          { k: "rev", l: "Revenue", r: 1, f: v => fmt.money(v), bar: 1 }, { k: "disc", l: "Discount cost", r: 1, f: v => fmt.money(v) },
          { k: "gm_pct", l: "GM %", r: 1, f: (v, r) => `${fmt.pct(v, 0)} <small>(${fmt.pp(v, r.base_gm_pct)})</small>` },
          { k: "new_customers", l: "New customers", r: 1, f: fmt.int },
          { k: "repeat_180", l: "Repeat 180d", r: 1, f: (v, r) => (v == null ? '<span class="pill info">too soon</span>' : `${fmt.pct(v, 0)} <small>vs ${fmt.pct(r.base_repeat_180, 0)}</small>`) },
          { k: "repeat_index", l: "Quality", r: 1, f: v => (v == null ? "–" : v < .8 ? '<span class="pill bad">Low</span>' : v < .95 ? '<span class="pill warn">Below</span>' : '<span class="pill good">Healthy</span>') }], pr))}
      <div style="margin-top:16px">${card("Daily Web Store revenue around the promo", "Four weeks before through six weeks after · gross margin % on the right axis", GI.chartBox("pr-day", "tall"), GI.seg("pr-sel", pr.map(r => r.promo_code), this.sel))}</div>`;
  },
  async after() {
    GI.onSeg("pr-sel", v => { this.sel = v; this.drawDay(); });
    await this.drawDay();
  },
  async drawDay() {
    const p = this.promos.find(r => r.promo_code === this.sel);
    const rows = await sql(`SELECT CAST(order_date AS VARCHAR) AS d, SUM(revenue) AS rev, SUM(gross_margin) / SUM(revenue) AS gm
      FROM sales WHERE channel = 'Web Store' AND order_date BETWEEN ${D(p.start_date)} - 28 AND LEAST(${D(p.end_date)} + 42, ${D(GI.asOf)}) GROUP BY 1 ORDER BY 1`);
    GI.$("#pr-day").parentElement.innerHTML = '<canvas id="pr-day"></canvas>';
    chart("pr-day", { data: { labels: rows.map(r => fmt.date(r.d).replace(/, \d{4}/, "")), datasets: [
      { type: "bar", label: "Revenue", data: rows.map(r => r.rev), backgroundColor: rows.map(r => (r.d >= p.start_date && r.d <= p.end_date ? GI.series(0) : GI.series(0) + "55")), borderRadius: 2, yAxisID: "y" },
      { type: "line", label: "Gross margin %", data: rows.map(r => r.gm), borderColor: GI.css("text"), pointRadius: 0, tension: .3, borderWidth: 1.6, yAxisID: "y2" }] },
      options: { scales: { x: { ticks: { maxTicksLimit: 12 } }, y: { ticks: GI.moneyTick }, y2: { position: "right", grid: { display: false }, border: { display: false }, ticks: GI.pctTick, min: 0, max: .8 } },
        plugins: { tooltip: { callbacks: { label: c => c.dataset.yAxisID === "y2" ? ` GM: ${fmt.pct(c.parsed.y)}` : ` Revenue: ${fmt.money(c.parsed.y, "full")}` } } } } });
  },
};

// ═════════════════════════ Inventory ═════════════════════════
GI.views.inventory = {
  title: "Inventory", intro: "Weeks of cover, reorder alerts and what stock-outs cost", filters: [],
  async html() {
    const [inv, oos] = await Promise.all([GI.inventoryPosition(), GI.stockouts()]);
    const st = r => (r.cover_weeks == null ? ["No sales", "info"] : r.cover_weeks < 3 ? ["Reorder now", "bad"] : r.cover_weeks < 5 ? ["Watch", "warn"] : r.cover_weeks > 20 ? ["Overstock", "warn"] : ["Healthy", "good"]);
    inv.forEach(r => { [r.status, r.cls] = st(r); });
    const val = inv.reduce((a, r) => a + r.stock_value, 0), over = inv.filter(r => r.status === "Overstock");
    this.oos = oos;
    return `<div class="kpis">
        ${kpi("Stock on hand (at cost)", fmt.money(val), `${fmt.int(inv.reduce((a, r) => a + r.on_hand_units, 0))} units across ${inv.length} SKUs`)}
        ${kpi("Reorder now", fmt.int(inv.filter(r => r.status === "Reorder now").length), "under 3 weeks of cover")}
        ${kpi("Overstock", fmt.int(over.length), over.length ? `${fmt.money(over.reduce((a, r) => a + r.stock_value, 0))} tied up` : "over 20 weeks of cover")}
        ${kpi("Lost to stock-outs", fmt.money(oos.reduce((a, r) => a + r.lost_revenue, 0)), "estimated, all history")}
      </div>
      ${await callout("low")}
      <div class="grid g-21">
        ${card("Stock position", "On hand vs the last 8 weeks' sell-through · lead time ~8 weeks", `<div class="scroll">${table([
          { k: "product_name", l: "Product" }, { k: "category", l: "Category" }, { k: "on_hand_units", l: "On hand", r: 1, f: fmt.int },
          { k: "weekly_units", l: "Sells / wk", r: 1, f: fmt.int }, { k: "cover_weeks", l: "Weeks of cover", r: 1, f: v => (v == null ? "–" : v.toFixed(1)), bar: 1 },
          { k: "inbound_units", l: "Inbound", r: 1, f: v => (v ? fmt.int(v) : "–") }, { k: "status", l: "Status", f: (v, r) => `<span class="pill ${r.cls}">${v}</span>` }], inv)}</div>`)}
        ${card("Stock-outs", "Lost sales estimated from the run-rate 8 weeks either side", table([{ k: "product_name", l: "Product" }, { k: "days", l: "Days out", r: 1 }, { k: "lost_units", l: "Lost units", r: 1, f: fmt.int }, { k: "lost_revenue", l: "Lost revenue", r: 1, f: v => fmt.money(v) }], oos) + GI.chartBox("i-oos"))}
      </div>`;
  },
  async after() {
    const o = this.oos[0]; if (!o) return;
    const rows = await sql(`SELECT CAST(i.week_start AS VARCHAR) AS w, i.on_hand_units AS oh, COALESCE(SUM(s.units), 0) AS u
      FROM inventory_weekly i LEFT JOIN sales s ON s.sku = i.sku AND s.week_start = i.week_start
      WHERE i.sku = '${o.sku}' AND i.week_start BETWEEN ${D(o.start_week)} - 84 AND ${D(o.end_week)} + 84 GROUP BY 1, 2 ORDER BY 1`);
    chart("i-oos", { data: { labels: rows.map(r => fmt.date(r.w).replace(/, \d{4}/, "")), datasets: [
      { type: "bar", label: "Units sold", data: rows.map(r => r.u), backgroundColor: GI.series(0), borderRadius: 2 },
      { type: "line", label: "On hand", data: rows.map(r => r.oh), borderColor: GI.css("bad"), pointRadius: 0, tension: .2, borderWidth: 1.8 }] },
      options: { plugins: { title: { display: true, text: o.product_name, align: "start", color: GI.css("text"), font: { weight: 600 } } }, scales: { x: { ticks: { maxTicksLimit: 6 } } } } });
  },
};

// ═════════════════════════ Channel P&L ═════════════════════════
GI.views.margin = {
  title: "Channel P&L", intro: "Revenue → COGS → gross margin → channel costs (fees, fulfilment, freight, marketplace ads) → contribution", filters: ["period"],
  async html() {
    const p = P();
    const rows = await GI.channelMonthly();
    const m0 = p.start.slice(0, 7) + "-01";
    const cur = rows.filter(r => r.month >= m0 && r.month <= p.end);
    const by = {};
    cur.forEach(r => { const b = (by[r.channel] ??= { channel: r.channel, rev: 0, cogs: 0, gm: 0, cost: 0, contribution: 0 }); for (const k of ["rev", "cogs", "gm", "cost", "contribution"]) b[k] += r[k] || 0; });
    const list = Object.values(by).map(b => ({ ...b, gm_pct: b.gm / b.rev, cm_pct: b.contribution / b.rev })).sort((a, b) => b.rev - a.rev);
    const tot = list.reduce((a, b) => { for (const k of ["rev", "cogs", "gm", "cost", "contribution"]) a[k] = (a[k] || 0) + b[k]; return a; }, { channel: "Total" });
    tot.gm_pct = tot.gm / tot.rev; tot.cm_pct = tot.contribution / tot.rev;
    const costs = await sql(`SELECT channel, cost_type, SUM(amount) AS amt FROM channel_costs WHERE month BETWEEN ${D(m0)} AND ${D(p.end)} GROUP BY ALL ORDER BY channel, amt DESC`);
    return `${await callout("shift")}
      ${card("Contribution by channel", `${p.label} (whole months)`, table([{ k: "channel", l: "Channel" }, { k: "rev", l: "Revenue", r: 1, f: v => fmt.money(v), bar: 1 },
        { k: "cogs", l: "COGS", r: 1, f: v => fmt.money(v) }, { k: "gm", l: "Gross margin", r: 1, f: v => fmt.money(v) }, { k: "gm_pct", l: "GM %", r: 1, f: v => fmt.pct(v) },
        { k: "cost", l: "Channel costs", r: 1, f: v => fmt.money(v) }, { k: "contribution", l: "Contribution", r: 1, f: v => fmt.money(v) }, { k: "cm_pct", l: "CM %", r: 1, f: v => `<b>${fmt.pct(v)}</b>` }], list, { foot: tot }))}
      <div class="grid g2" style="margin-top:16px">
        ${card("Contribution margin % by month", "All history — watch for steps, not wiggles", GI.chartBox("m-cm", "tall"))}
        ${card("Where channel costs go", `${p.label}`, table([{ k: "channel", l: "Channel" }, { k: "cost_type", l: "Cost" }, { k: "amt", l: "Amount", r: 1, f: v => fmt.money(v), bar: 1 }], costs))}
      </div>`;
  },
  async after() {
    const rows = (await GI.channelMonthly()).filter(r => r.month.slice(0, 7) < GI.asOf.slice(0, 7));
    const months = [...new Set(rows.map(r => r.month))];
    const chans = ["Web Store", "Amazon", "Retail Partners", "Pro Installers", "Distributors"];
    chart("m-cm", { type: "line", data: { labels: months.map(fmt.mon), datasets: chans.map((c, i) => ({ label: c, data: months.map(m => { const r = rows.find(x => x.month === m && x.channel === c); return r && r.rev ? r.contribution / r.rev : null; }), borderColor: GI.series(i), backgroundColor: GI.series(i), pointRadius: 0, tension: .25, borderWidth: c === "Amazon" ? 3 : 1.6, spanGaps: true })) },
      options: { scales: { y: { ticks: GI.pctTick } }, plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${fmt.pct(c.parsed.y)}` } } } } });
  },
};
