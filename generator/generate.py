#!/usr/bin/env python3
"""
Grow Computer — synthetic commerce data for the Grow Insights demo.

Everything here is invented: the company's products, accounts, customers, prices and numbers.
Seeded, so every run produces the same data. Writes Parquet files to site/data/.

The data carries a handful of planted stories the dashboard is expected to find on its own:
  1. SPRING25 promo (Apr 14-27 2025): big order spike, deep margin hit, and the customers it brought in rarely came back.
  2. Grow Hub Mini launch (Mar 3 2025): hub units up, but it cannibalised the Grow Hub 8 and hub revenue fell.
  3. Brightline Electronics (retail account): reorder cadence stretching since mid-2025, last order in June 2026.
  4. Soil Moisture Sensor stock-out (Aug 4 - Sep 14 2025): six weeks with nothing to sell.
  5. Amazon fulfilment fee increase (Feb 1 2026): Amazon contribution margin steps down.
  6. Positive: customers who start with a hub plus 3+ sensors are worth far more and subscribe to Grow Cloud more often.

  python3 generate.py
"""
import datetime as dt
import math
import os

import duckdb
import numpy as np
import pandas as pd

SEED = 20261109
rng = np.random.default_rng(SEED)
START, END = dt.date(2024, 1, 1), dt.date(2026, 11, 8)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "data")
D = lambda s: dt.date.fromisoformat(s)

# ── product catalog ─────────────────────────────────────────────────────────────
# sku, name, category, msrp, unit_cost, launch, size (amazon fee tier), return rate
CATALOG = [
    ("GC-HUB8", "Grow Hub 8", "Hubs & Controllers", 249, 96, "2023-01-01", "L", .040),
    ("GC-HUBM", "Grow Hub Mini", "Hubs & Controllers", 149, 63, "2025-03-03", "M", .060),
    ("GC-KIT-ST", "Starter Kit (Hub 8 + 3 sensors + 2 plugs)", "Kits", 349, 148, "2023-01-01", "L", .035),
    ("GC-KIT-GD", "Garden Kit (Hub 8 + 2 soil + valve)", "Kits", 399, 171, "2024-03-04", "L", .035),
    ("GC-PLG1", "Smart Plug", "Plugs & Power", 29, 9.5, "2023-01-01", "S", .030),
    ("GC-PLG2", "Smart Plug 2-Pack", "Plugs & Power", 49, 17, "2023-01-01", "S", .030),
    ("GC-PLGO", "Outdoor Smart Plug", "Plugs & Power", 39, 13, "2023-01-01", "S", .035),
    ("GC-STRP", "Smart Power Strip", "Plugs & Power", 79, 29, "2023-01-01", "M", .035),
    ("GC-SNS-TH", "Temp & Humidity Sensor", "Sensors", 34, 10.5, "2023-01-01", "S", .025),
    ("GC-SNS-SM", "Soil Moisture Sensor", "Sensors", 39, 12, "2023-01-01", "S", .025),
    ("GC-SNS-LK", "Leak Sensor", "Sensors", 29, 8.5, "2023-01-01", "S", .020),
    ("GC-SNS-MO", "Motion Sensor", "Sensors", 32, 9.8, "2023-01-01", "S", .025),
    ("GC-SNS-DW", "Door & Window Sensor", "Sensors", 24, 7, "2023-01-01", "S", .020),
    ("GC-SNS-LX", "Light (Lux) Sensor", "Sensors", 29, 8.8, "2023-01-01", "S", .020),
    ("GC-SNS-AQ", "Air Quality Sensor (CO2/VOC)", "Sensors", 89, 31, "2026-04-06", "S", .030),
    ("GC-BLB1", "Smart Bulb A19", "Lighting", 19, 6.2, "2023-01-01", "S", .030),
    ("GC-BLB4", "Smart Bulb 4-Pack", "Lighting", 64, 22, "2023-01-01", "M", .030),
    ("GC-LTS", "Light Strip 2m", "Lighting", 59, 19, "2023-01-01", "M", .040),
    ("GC-GRW", "LED Grow Light Bar", "Lighting", 129, 47, "2023-01-01", "L", .045),
    ("GC-THM", "Smart Thermostat", "Climate", 169, 66, "2023-01-01", "M", .050),
    ("GC-FAN", "Fan & Vent Controller", "Climate", 59, 21, "2023-01-01", "S", .035),
    ("GC-VLV", "Smart Irrigation Valve", "Water", 89, 33, "2023-01-01", "M", .040),
    ("GC-FLW", "Water Flow Meter", "Water", 69, 24, "2023-01-01", "S", .035),
    ("GC-CAM-IN", "Indoor Camera", "Security", 79, 31, "2023-01-01", "M", .080),
    ("GC-CAM-OUT", "Outdoor Camera", "Security", 129, 52, "2023-01-01", "M", .085),
    ("GC-DBL", "Video Doorbell", "Security", 149, 58, "2023-01-01", "M", .070),
    ("GC-BAT4", "Sensor Battery 4-Pack", "Accessories", 12, 2.6, "2023-01-01", "S", .010),
    ("GC-MNT", "Mounting Kit", "Accessories", 15, 3.1, "2023-01-01", "S", .010),
    ("GC-EXT", "Sensor Extension Cable", "Accessories", 9, 1.9, "2023-01-01", "S", .010),
]
P = {r[0]: dict(sku=r[0], name=r[1], category=r[2], msrp=float(r[3]), cost=float(r[4]), launch=D(r[5]), size=r[6], ret=r[7])
     for r in CATALOG}
SENSORS = [s for s in P if P[s]["category"] == "Sensors"]
HUB_LIKE = {"GC-HUB8", "GC-HUBM", "GC-KIT-ST", "GC-KIT-GD"}
KIT_SENSORS = {"GC-KIT-ST": 3, "GC-KIT-GD": 2}
STOCKOUT = (D("2025-08-04"), D("2025-09-14"))        # soil moisture sensor
MINI_LAUNCH = D("2025-03-03")
AMZ_FEE_CHANGE = D("2026-02-01")
TARIFF = D("2025-07-01")                              # +6% landed cost on security hardware

PROMOS = [  # code, name, start, end, pct, channels
    ("SPRING25", "Spring sitewide 25% off", "2025-04-14", "2025-04-27", .25, "DTC"),
    ("BFCM24", "Black Friday / Cyber Monday 2024", "2024-11-25", "2024-12-02", .20, "DTC"),
    ("BFCM25", "Black Friday / Cyber Monday 2025", "2025-11-24", "2025-12-01", .20, "DTC"),
    ("SUMMER10", "Summer garden 10% off", "2024-06-10", "2024-06-23", .10, "DTC"),
    ("GARDEN15", "Garden season 15% off kits", "2026-04-13", "2026-04-26", .15, "DTC"),
    ("WELCOME10", "New-subscriber welcome code", "2023-01-01", "2026-12-31", .10, "DTC"),
]
PROMO_ROWS = [dict(promo_code=c, promo_name=n, start_date=D(s), end_date=D(e), discount_pct=p, channel_group=g)
              for c, n, s, e, p, g in PROMOS]
PRIME_DAYS = [(D("2024-07-16"), D("2024-07-17")), (D("2025-07-08"), D("2025-07-11")), (D("2026-07-14"), D("2026-07-15"))]

SEASON = {1: .85, 2: .80, 3: .97, 4: 1.08, 5: 1.12, 6: .96, 7: .90, 8: .90, 9: .95, 10: 1.0, 11: 1.45, 12: 1.62}
WEEKDAY = [1.10, 1.06, 1.03, 1.0, .97, .88, .96]


def years(d):
    return (d - START).days / 365.25


def active_promo(d, group="DTC"):
    for p in PROMO_ROWS:
        if p["promo_code"] != "WELCOME10" and p["channel_group"] == group and p["start_date"] <= d <= p["end_date"]:
            return p
    return None


def available(sku, d):
    if d < P[sku]["launch"]:
        return False
    if sku == "GC-SNS-SM" and STOCKOUT[0] <= d <= STOCKOUT[1]:
        return False
    return True


def unit_cost(sku, d):
    c = P[sku]["cost"] * (1 + 0.012 * years(d))                    # gentle creep
    if d >= TARIFF and P[sku]["category"] == "Security":
        c *= 1.06
    return round(c, 2)


def pick(weights):
    keys = [k for k, w in weights.items() if w > 0]
    w = np.array([weights[k] for k in keys], dtype=float)
    return keys[rng.choice(len(keys), p=w / w.sum())]


def sensor_weights(d):
    w = {"GC-SNS-TH": 30, "GC-SNS-SM": 22, "GC-SNS-LK": 14, "GC-SNS-MO": 12, "GC-SNS-DW": 10, "GC-SNS-LX": 7, "GC-SNS-AQ": 22}
    if d.month in (4, 5, 6, 7):
        w["GC-SNS-SM"] *= 1.6
    return {k: v for k, v in w.items() if available(k, d)}


def sensors_into(lines, d, n):
    for _ in range(n):
        w = sensor_weights(d)
        if not w:
            continue
        s = pick(w)
        lines[s] = lines.get(s, 0) + 1


# ── DTC baskets ─────────────────────────────────────────────────────────────────
STANDALONE = {"GC-PLG2": 20, "GC-PLG1": 14, "GC-BLB4": 14, "GC-CAM-IN": 10, "GC-DBL": 8, "GC-THM": 8, "GC-CAM-OUT": 7,
              "GC-LTS": 7, "GC-STRP": 6, "GC-PLGO": 6}


def first_basket(d):
    lines = {}
    hub_p = .62 if d < MINI_LAUNCH else .66
    if rng.random() < hub_p:
        if d < MINI_LAUNCH:
            hub = pick({"GC-HUB8": 62, "GC-KIT-ST": 24, "GC-KIT-GD": 14 if available("GC-KIT-GD", d) else 0})
        else:
            hub = pick({"GC-HUB8": 38, "GC-HUBM": 38, "GC-KIT-ST": 15, "GC-KIT-GD": 9})
        if hub == "GC-KIT-GD" and not available("GC-SNS-SM", d):
            hub = "GC-KIT-ST"
        lines[hub] = 1
        lam = {"GC-HUB8": 1.9, "GC-HUBM": 0.8, "GC-KIT-ST": 0.5, "GC-KIT-GD": 0.6}[hub]
        sensors_into(lines, d, rng.poisson(lam))
        if rng.random() < .45:
            lines["GC-PLG2" if rng.random() < .6 else "GC-PLG1"] = 1
        if d.month in (4, 5, 6, 7) and rng.random() < .18:
            lines["GC-VLV"] = 1
        if d.month in (10, 11, 12, 1, 2) and rng.random() < .12:
            lines["GC-GRW"] = 1
    else:
        for _ in range(1 + (rng.random() < .35)):
            s = pick(STANDALONE)
            lines[s] = lines.get(s, 0) + 1
    return lines


def repeat_basket(d, has_hub):
    lines = {}
    n = 1 + rng.poisson(.7)
    for _ in range(n):
        r = rng.random()
        if has_hub and r < .45:
            sensors_into(lines, d, 1 + rng.poisson(.6))
        elif r < .62:
            s = pick({"GC-PLG1": 10, "GC-PLG2": 12, "GC-BLB4": 8, "GC-BLB1": 6, "GC-PLGO": 4})
            lines[s] = lines.get(s, 0) + 1
        elif r < .74:
            lines["GC-BAT4"] = lines.get("GC-BAT4", 0) + 1 + rng.poisson(.4)
        else:
            w = {"GC-CAM-IN": 8, "GC-CAM-OUT": 6, "GC-DBL": 5, "GC-THM": 5, "GC-FAN": 4, "GC-LTS": 4, "GC-MNT": 3, "GC-EXT": 3,
                 "GC-VLV": 10 if d.month in (4, 5, 6, 7) else 2, "GC-FLW": 3,
                 "GC-GRW": 9 if d.month in (10, 11, 12, 1, 2) else 2}
            s = pick(w)
            lines[s] = lines.get(s, 0) + 1
    return {k: v for k, v in lines.items() if available(k, d)} or {"GC-BAT4": 1}


# ── simulation ──────────────────────────────────────────────────────────────────
orders, lines, customers, subs = [], [], [], []
oid = 0
REGIONS = [("US", .80), ("CA", .08), ("UK", .06), ("EU", .06)]
US_STATES = ["CA", "TX", "FL", "NY", "WA", "CO", "OR", "IL", "NC", "GA", "AZ", "MA", "PA", "MI", "MN", "VA", "NJ", "OH", "UT", "TN"]
SOURCES = {"Paid Social": .34, "Paid Search": .28, "Affiliates": .10, "Organic & Email": .28}


def new_order(d, channel, cust, region, promo, basket, price_factor=1.0, extra_disc=0.0):
    global oid
    oid += 1
    o = f"GC{oid:07d}"
    gross_total = 0
    for i, (sku, q) in enumerate(basket.items(), 1):
        unit = round(P[sku]["msrp"] * price_factor, 2)
        gross = round(unit * q, 2)
        disc = round(gross * extra_disc, 2)
        ret_rate = P[sku]["ret"] * (1.5 if channel == "Amazon" else (.4 if price_factor < .8 else 1))
        ret = int(rng.binomial(q, min(ret_rate, .9)))
        net = round(gross - disc, 2)
        lines.append(dict(order_id=o, line_no=i, sku=sku, units=q, unit_price=unit, gross_sales=gross, discount=disc,
                          net_sales=net, cogs=round(unit_cost(sku, d) * q, 2), returned_units=ret,
                          refund=round(net / q * ret, 2) if q else 0))
        gross_total += gross - disc
    ship = 0.0 if channel != "Web Store" or gross_total >= 75 else 7.95
    orders.append(dict(order_id=o, order_date=d, channel=channel, customer_id=cust, region=region,
                       promo_code=promo, shipping_charged=ship))
    return o


# DTC: event-driven — new customers arrive daily, each schedules (maybe) a next order
pending = {}   # date -> list of (customer_id, state)
cust_seq = 0
day = START
while day <= END:
    t = years(day)
    promo = active_promo(day)
    lift = 1.0
    if promo:
        lift = {"SPRING25": 2.5, "BFCM24": 2.3, "BFCM25": 2.4, "SUMMER10": 1.25, "GARDEN15": 1.35}[promo["promo_code"]]
    lam = 31 * math.exp(.33 * t) * SEASON[day.month] * WEEKDAY[day.weekday()] * lift
    for _ in range(rng.poisson(lam)):
        cust_seq += 1
        cid = f"C{cust_seq:06d}"
        region = pick(dict(REGIONS))
        src = pick(SOURCES) if not (promo and promo["promo_code"] == "SPRING25") else pick({"Paid Social": .55, "Paid Search": .2, "Affiliates": .15, "Organic & Email": .1})
        basket = first_basket(day)
        code, pct = None, 0.0
        if promo:
            code, pct = promo["promo_code"], promo["discount_pct"]
            if code == "GARDEN15" and not (HUB_LIKE & set(basket)):
                code, pct = None, 0.0
        elif rng.random() < .22:
            code, pct = "WELCOME10", .10
        new_order(day, "Web Store", cid, region, code, basket, extra_disc=pct)
        n_sensors = sum(q for s, q in basket.items() if s in SENSORS) + sum(KIT_SENSORS.get(s, 0) for s in basket)
        has_hub = bool(HUB_LIKE & set(basket))
        engaged = has_hub and n_sensors >= 3
        customers.append(dict(customer_id=cid, customer_type="Consumer", customer_name=None, region=region,
                              state=pick({s: 1 for s in US_STATES}) if region == "US" else None,
                              acquisition_source=src, first_order_date=day, account_tier=None))
        # Grow Cloud subscription
        if has_hub:
            p_sub = .40 if engaged else .14
            if "GC-HUBM" in basket:
                p_sub *= .8
            if rng.random() < p_sub:
                start = day + dt.timedelta(days=int(rng.integers(0, 30)))
                if start <= END:
                    plan = "Grow Cloud Pro" if rng.random() < (.42 if engaged else .22) else "Grow Cloud Plus"
                    hazard = .016 if engaged else .031
                    life = int(rng.geometric(hazard)) * 30
                    end = start + dt.timedelta(days=life)
                    subs.append(dict(subscription_id=f"S{len(subs) + 1:06d}", customer_id=cid, plan=plan,
                                     mrr=9.99 if plan == "Grow Cloud Pro" else 4.99, start_date=start,
                                     end_date=end if end <= END else None))
        # schedule next order
        p_rep = .36 * (1.7 if engaged else 1) * (.42 if code == "SPRING25" else 1) * (.85 if "GC-HUBM" in basket else 1)
        if rng.random() < min(p_rep, .9):
            gap = int(rng.exponential(55 if engaged else 85)) + 7
            pending.setdefault(day + dt.timedelta(days=gap), []).append((cid, region, has_hub, engaged, 1, code == "SPRING25"))
    for cid, region, has_hub, engaged, k, spring in pending.pop(day, []):
        promo_now = active_promo(day)
        code, pct = (promo_now["promo_code"], promo_now["discount_pct"]) if promo_now and promo_now["promo_code"] != "GARDEN15" else (None, 0.0)
        basket = repeat_basket(day, has_hub)
        new_order(day, "Web Store", cid, region, code, basket, extra_disc=pct)
        p_rep = (.55 if engaged else .40) * (.55 if spring else 1) * (.92 ** k)
        if rng.random() < p_rep:
            gap = int(rng.exponential(60 if engaged else 95)) + 7
            pending.setdefault(day + dt.timedelta(days=gap), []).append((cid, region, has_hub, engaged, k + 1, spring))
    day += dt.timedelta(days=1)

# Amazon: anonymous orders, 1-2 units of hardware
AMZ_MIX = {"GC-PLG2": 18, "GC-PLG1": 12, "GC-BLB4": 10, "GC-BLB1": 6, "GC-SNS-TH": 8, "GC-SNS-SM": 6, "GC-SNS-LK": 6,
           "GC-SNS-MO": 4, "GC-HUB8": 8, "GC-HUBM": 7, "GC-CAM-IN": 6, "GC-PLGO": 4, "GC-BAT4": 5, "GC-LTS": 4, "GC-SNS-AQ": 4}
day = START
while day <= END:
    lam = 46 * math.exp(.27 * years(day)) * SEASON[day.month] * WEEKDAY[day.weekday()]
    if any(a <= day <= b for a, b in PRIME_DAYS):
        lam *= 3.2
    for _ in range(rng.poisson(lam)):
        mix = {k: v for k, v in AMZ_MIX.items() if available(k, day)}
        basket = {}
        for _ in range(1 + (rng.random() < .22)):
            s = pick(mix)
            basket[s] = basket.get(s, 0) + 1
        deal = .15 if any(a <= day <= b for a, b in PRIME_DAYS) else (.10 if rng.random() < .08 else 0)
        new_order(day, "Amazon", None, "US", "AMAZON DEAL" if deal else None, basket, extra_disc=deal)
    day += dt.timedelta(days=1)

# ── B2B accounts ────────────────────────────────────────────────────────────────
RETAIL = ["Brightline Electronics", "Hearth & Home Supply", "Northfield Hardware Co.", "Urban Roots Garden Centers",
          "Maple & Main Home", "Cascade Outdoor Supply", "Summit Electronics Outlet", "Greenleaf Nursery Group",
          "Harbor Lane Hardware", "Prairie Home & Garden", "Copperline Appliances", "Bluewater Home Centers",
          "Redwood Garden Supply", "Lakeside Living Stores", "Pacific Smart Living"]
PRO_A = ["Brightwire", "Clearpath", "Ironwood", "Northstar", "Keystone", "Silverline", "Bluefin", "Cedar", "Oakridge",
         "Riverbend", "Granite", "Evergreen", "Highland", "Lumen", "Vertex", "Pioneer", "Sterling", "Westfield", "Harbor",
         "Summit", "Aspen", "Beacon", "Cobalt", "Driftwood", "Falcon", "Juniper", "Meridian", "Orchard", "Quarry", "Sable"]
PRO_B = ["Home Automation", "Smart Homes", "Integrations", "Electric", "AV & Smart Home", "Systems", "Home Tech"]
DISTS = [("EuroConnect Distribution", "EU"), ("Southern Cross Smart", "AU"), ("MapleLink Distribution", "CA"),
         ("Albion Smart Supply", "UK")]
REPS = ["Avery Chen", "Jordan Blake", "Sam Ortiz", "Riley Patel"]

RETAIL_MIX = {"GC-HUB8": 14, "GC-HUBM": 10, "GC-KIT-ST": 12, "GC-KIT-GD": 6, "GC-PLG2": 14, "GC-PLGO": 5, "GC-STRP": 4,
              "GC-SNS-TH": 8, "GC-SNS-SM": 6, "GC-SNS-LK": 5, "GC-SNS-MO": 4, "GC-BLB4": 8, "GC-GRW": 5, "GC-VLV": 5,
              "GC-CAM-IN": 4, "GC-SNS-AQ": 5}
PRO_MIX = {"GC-HUB8": 16, "GC-THM": 14, "GC-DBL": 12, "GC-CAM-OUT": 12, "GC-CAM-IN": 8, "GC-SNS-MO": 8, "GC-SNS-DW": 8,
           "GC-SNS-LK": 6, "GC-STRP": 4, "GC-FAN": 4, "GC-MNT": 6, "GC-SNS-AQ": 6}


def b2b_basket(d, mix, target):
    basket, total = {}, 0.0
    m = {k: v for k, v in mix.items() if available(k, d)}
    while total < target:
        s = pick(m)
        case = 6 if P[s]["msrp"] < 60 else (4 if P[s]["msrp"] < 150 else 2)
        basket[s] = basket.get(s, 0) + case
        total += P[s]["msrp"] * case * .5
    return basket


acct_seq = 0


def add_account(name, ctype, region, tier, start, cadence, size, price_factor, mix, story=None):
    global acct_seq
    acct_seq += 1
    cid = f"A{acct_seq:04d}"
    customers.append(dict(customer_id=cid, customer_type=ctype, customer_name=name, region=region,
                          state=pick({s: 1 for s in US_STATES}) if region == "US" else None,
                          acquisition_source="Sales team", first_order_date=None, account_tier=tier,
                          sales_rep=REPS[acct_seq % len(REPS)]))
    d = start
    k = 0
    while d <= END:
        mult_gap, mult_size = 1.0, 1.0
        if story == "churn" and d >= D("2025-06-01"):
            months = (d - D("2025-06-01")).days / 30
            mult_gap, mult_size = 1 + .085 * months, max(.4, 1 - .045 * months)
            if d > D("2026-06-20"):
                break
        if story == "ramp":
            mult_size = min(2.2, .5 + .15 * k)
        seas = SEASON[d.month] ** .6
        if available("GC-HUB8", d):
            basket = b2b_basket(d, mix, size * seas * mult_size * math.exp(.18 * years(d)) * rng.lognormal(0, .25))
            new_order(d, ctype if ctype != "Retail Account" else "Retail Partners", cid, region, None, basket, price_factor=price_factor)
        k += 1
        d += dt.timedelta(days=max(5, int(rng.normal(cadence, cadence * .18) * mult_gap)))
    return cid


for i, name in enumerate(RETAIL):
    tier = "A" if i < 4 else ("B" if i < 10 else "C")
    size = {"A": 16000, "B": 7000, "C": 3000}[tier] * rng.uniform(.8, 1.25)
    start = START + dt.timedelta(days=int(rng.integers(0, 40))) if i < 12 else D(["2024-09-09", "2025-05-12", "2026-02-02"][i - 12])
    story = "churn" if name == "Brightline Electronics" else ("ramp" if name == "Pacific Smart Living" else None)
    if story == "churn":
        size = 19000
    add_account(name, "Retail Account", "US" if i % 7 else "CA", tier, start, rng.uniform(24, 34), size, .52, RETAIL_MIX, story)

pro_names = set()
while len(pro_names) < 42:
    pro_names.add(f"{PRO_A[rng.integers(len(PRO_A))]} {PRO_B[rng.integers(len(PRO_B))]}")
for name in sorted(pro_names):
    start = START + dt.timedelta(days=int(rng.integers(0, 900)))
    add_account(name, "Pro Installers", "US", "Pro", start, rng.uniform(18, 55), rng.uniform(700, 3200), .70, PRO_MIX)
for name, region in DISTS:
    start = START + dt.timedelta(days=int(rng.integers(10, 300)))
    add_account(name, "Distributors", region, "Distributor", start, rng.uniform(55, 80), rng.uniform(28000, 60000), .56, RETAIL_MIX)

# ── frames ──────────────────────────────────────────────────────────────────────
o_df = pd.DataFrame(orders)
l_df = pd.DataFrame(lines)
c_df = pd.DataFrame(customers)
first = o_df.dropna(subset=["customer_id"]).groupby("customer_id")["order_date"].min()
c_df["first_order_date"] = c_df["customer_id"].map(first)
c_df = c_df[c_df["first_order_date"].notna()]
s_df = pd.DataFrame(subs)

CHANNELS = pd.DataFrame([
    ("Web Store", "DTC", "Direct to consumer (growcomputer web store)"),
    ("Amazon", "Marketplace", "Amazon US (FBA)"),
    ("Retail Partners", "B2B", "Retail chains and garden centers, wholesale"),
    ("Pro Installers", "B2B", "Smart-home installers and integrators"),
    ("Distributors", "B2B", "International distributors (CA, UK, EU, AU)"),
], columns=["channel", "channel_group", "description"])

prod_df = pd.DataFrame([dict(sku=p["sku"], product_name=p["name"], category=p["category"], msrp=p["msrp"],
                             base_unit_cost=p["cost"], launch_date=max(p["launch"], dt.date(2023, 1, 1)),
                             is_hub=p["sku"] in HUB_LIKE, included_sensors=KIT_SENSORS.get(p["sku"], 0), fee_tier=p["size"]) for p in P.values()])

# ── channel costs (fees, fulfilment, ad spend on marketplace) ───────────────────
m = l_df.merge(o_df[["order_id", "order_date", "channel"]], on="order_id")
m["month"] = pd.to_datetime(m["order_date"]).dt.to_period("M").dt.to_timestamp().dt.date
m = m.merge(prod_df[["sku", "fee_tier"]], on="sku")
fees = []
for (month, ch), g in m.groupby(["month", "channel"]):
    net = g["net_sales"].sum()
    n_orders = g["order_id"].nunique()
    units = g["units"].sum()
    if ch == "Amazon":
        new = month >= AMZ_FEE_CHANGE
        per_unit = {"S": 4.95 if new else 3.22, "M": 7.10 if new else 4.75, "L": 11.20 if new else 7.40}
        fba = float(sum(per_unit[t] * u for t, u in g.groupby("fee_tier")["units"].sum().items()))
        fees += [(month, ch, "Marketplace referral fee", round(net * .15, 2)), (month, ch, "FBA fulfilment fee", round(fba, 2)),
                 (month, ch, "Sponsored ads", round(net * rng.uniform(.085, .105), 2))]
    elif ch == "Web Store":
        fees += [(month, ch, "Payment processing", round(net * .029 + .30 * n_orders, 2)),
                 (month, ch, "3PL pick & pack", round(4.25 * n_orders + .35 * units, 2)),
                 (month, ch, "Outbound shipping", round(8.10 * n_orders, 2))]
    else:
        fees += [(month, ch, "Freight out", round(net * (.035 if ch == "Distributors" else .028), 2)),
                 (month, ch, "3PL pick & pack", round(14.0 * n_orders + .18 * units, 2))]
fee_df = pd.DataFrame(fees, columns=["month", "channel", "cost_type", "amount"])

# ── DTC marketing spend (drives CAC) ────────────────────────────────────────────
cc = c_df[c_df["customer_type"] == "Consumer"].copy()
cc["month"] = pd.to_datetime(cc["first_order_date"]).dt.to_period("M").dt.to_timestamp().dt.date
spend = []
CAC = {"Paid Social": 48, "Paid Search": 39, "Affiliates": 27, "Organic & Email": 4.5}
for (month, src), g in cc.groupby(["month", "acquisition_source"]):
    t = years(month)
    base = CAC[src] * (1 + .09 * t)
    if src == "Paid Social" and month == dt.date(2025, 4, 1):
        base *= 1.35
    spend.append((month, src, round(len(g) * base * rng.uniform(.9, 1.1), 2)))
spend_df = pd.DataFrame(spend, columns=["month", "source", "spend"])

# ── weekly inventory position ───────────────────────────────────────────────────
ow = l_df.merge(o_df[["order_id", "order_date"]], on="order_id")
ow["week_start"] = pd.to_datetime(ow["order_date"]).dt.to_period("W-SUN").dt.start_time.dt.date
weekly = ow.groupby(["week_start", "sku"])["units"].sum().reset_index()
inv = []
weeks = sorted(weekly["week_start"].unique())
for sku in P:
    w = weekly[weekly["sku"] == sku].set_index("week_start")["units"].reindex(weeks, fill_value=0)
    avg = w.rolling(8, min_periods=1).mean()
    phase = rng.uniform(0, 6.28)
    for i, wk in enumerate(weeks):
        if wk < P[sku]["launch"] - dt.timedelta(days=7):
            continue
        cover = 7 + 4.5 * math.sin(i / 2.2 + phase) + rng.normal(0, .6)
        on_hand = max(0, int(avg.iloc[i] * cover))
        days_oos = 0
        if sku == "GC-SNS-SM":
            if STOCKOUT[0] - dt.timedelta(days=6) <= wk <= STOCKOUT[1]:
                on_hand, days_oos = 0, min(7, max(0, (min(STOCKOUT[1], wk + dt.timedelta(days=6)) - max(STOCKOUT[0], wk)).days + 1))
            elif STOCKOUT[0] - dt.timedelta(days=21) <= wk < STOCKOUT[0] - dt.timedelta(days=6):
                on_hand = int(avg.iloc[i] * .6)
        if i == len(weeks) - 1:
            on_hand = int(avg.iloc[i] * {"GC-SNS-AQ": 1.6, "GC-CAM-OUT": 31, "GC-HUBM": 2.4}.get(sku, max(cover, 5)))
        inbound = int(avg.iloc[i] * 8) if cover < 4.5 and sku != "GC-SNS-SM" else 0
        inv.append((wk, sku, on_hand, inbound, days_oos))
inv_df = pd.DataFrame(inv, columns=["week_start", "sku", "on_hand_units", "inbound_units", "days_out_of_stock"])

# ── write ───────────────────────────────────────────────────────────────────────
os.makedirs(OUT, exist_ok=True)
con = duckdb.connect()
frames = {"orders": o_df, "order_lines": l_df, "customers": c_df, "products": prod_df, "channels": CHANNELS,
          "promotions": pd.DataFrame(PROMO_ROWS), "subscriptions": s_df, "channel_costs": fee_df,
          "marketing_spend": spend_df, "inventory_weekly": inv_df}
for name, df in frames.items():
    con.register("df", df)
    con.execute(f"COPY (SELECT * FROM df) TO '{OUT}/{name}.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)")
    con.unregister("df")
    print(f"{name:<18} {len(df):>9,} rows  {os.path.getsize(f'{OUT}/{name}.parquet') / 1e6:6.2f} MB")
import hashlib, json
digest = hashlib.sha1(b"".join(open(f"{OUT}/{n}.parquet", "rb").read() for n in frames)).hexdigest()[:12]
json.dump({"version": digest, "seed": SEED, "through": str(END), "tables": {n: len(df) for n, df in frames.items()}},
          open(f"{OUT}/manifest.json", "w"), indent=1)
print("orders through", o_df["order_date"].max(), "| net sales", f"${l_df['net_sales'].sum():,.0f}", "| data version", digest)
